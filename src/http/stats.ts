import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isTimeZone } from '../config.js';
import { invalidRequest } from '../errors.js';
import { join, parsePlainPath } from '../paths.js';
import { buckets, countByProperty, dateIn, defaultFrom, prometheusText, type Metric } from '../stats.js';
import type { Entry } from '../vault-index.js';
import { Ctx, parse, type Services } from './context.js';
import { listableFolder } from './folders.js';

/** A real calendar date: 2026-02-30 and 2026-13-45 are rejected, not rolled over. */
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((d) => {
    const ms = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
  }, 'not a valid date');

const StatsQuery = z.object({
  metric: z.enum(['created', 'modified']).optional(),
  interval: z.enum(['day', 'week', 'month']).default('day'),
  from: DATE.optional(),
  to: DATE.optional(),
  folder: z.string().max(1024).default(''),
  tz: z.string().max(64).optional(),
});

const MetricsQuery = z.object({ folder: z.string().max(1024).default('') });

const DAY_MS = 86_400_000;

/** Notes the account can read under a vault folder (recursive). */
function notesUnder(ctx: Ctx, folderPath: string): Entry[] {
  const prefix = folderPath === '' ? '' : `${folderPath}/`;
  const out: Entry[] = [];
  for (const e of ctx.s.index.notes()) if (e.path.startsWith(prefix) && ctx.visible(e)) out.push(e);
  return out;
}

/**
 * The configured counters the account can see. A counter whose folder the account can neither
 * read nor pass through is left out entirely, so its existence doesn't leak.
 */
function counters(ctx: Ctx) {
  const reachable = (segs: string[]) => {
    const e = ctx.s.index.get(join(segs));
    return e && e.kind === 'folder' && (ctx.visible(e) || ctx.traversable(e)) ? e : null;
  };
  const { stats } = ctx.s.config();
  const folders: Record<string, { path: string; notes: number }> = {};
  for (const c of stats.folders) {
    const e = reachable(c.segs);
    if (e) folders[c.name] = { path: ctx.toApi(e.path), notes: notesUnder(ctx, e.path).length };
  }
  const properties: Record<string, { path: string; property: string; counts: Record<string, number> }> = {};
  for (const c of stats.properties) {
    const e = reachable(c.segs);
    if (e) properties[c.name] = { path: ctx.toApi(e.path), property: c.property, counts: countByProperty(notesUnder(ctx, e.path), c.property) };
  }
  return { folders, properties };
}

const folderOf = (ctx: Ctx, folder: string) => listableFolder(ctx, ctx.toVault(parsePlainPath(folder)));

export function statsRoutes(app: FastifyInstance, s: Services) {
  app.get('/v1/stats', async (req) => {
    const ctx = new Ctx(req, s);
    const q = parse(StatsQuery, req.query, 'query');
    const tz = q.tz ?? s.config().stats.timezone;
    if (!isTimeZone(tz)) throw invalidRequest(`Unknown time zone: ${tz}`);
    const folder = await folderOf(ctx, q.folder);
    const notes = notesUnder(ctx, folder.path);
    const to = q.to ?? dateIn(Date.now(), tz);
    const from = q.from ?? defaultFrom(to, q.interval);
    if (from > to) throw invalidRequest('from must not be after to');
    const series = (metric: 'created' | 'modified') => {
      try {
        return buckets(
          notes.map((e) => e[metric]),
          { from, to, interval: q.interval, timeZone: tz },
        );
      } catch {
        throw invalidRequest('The window has too many buckets; use a larger interval or a shorter range');
      }
    };
    const window = { interval: q.interval, from, to, timezone: tz };
    // Grafana Infinity reads `buckets` directly.
    if (q.metric) return { metric: q.metric, folder: ctx.toApi(folder.path), ...window, buckets: series(q.metric) };
    return {
      folder: ctx.toApi(folder.path),
      notes: notes.length,
      ...window,
      created: series('created'),
      modified: series('modified'),
      ...counters(ctx),
    };
  });

  app.get('/v1/stats/metrics', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(MetricsQuery, req.query, 'query');
    const folder = await folderOf(ctx, q.folder);
    const notes = notesUnder(ctx, folder.path);
    const now = Date.now();
    const windows = { '24h': DAY_MS, '7d': 7 * DAY_MS, '30d': 30 * DAY_MS };
    const within = (metric: 'created' | 'modified') =>
      Object.entries(windows).map(([w, ms]) => ({ labels: { window: w }, value: notes.filter((e) => now - e[metric] <= ms).length }));
    const { folders, properties } = counters(ctx);
    const metrics: Metric[] = [
      { name: 'vault_notes', help: 'Notes the account can read.', type: 'gauge', samples: [{ value: notes.length }] },
      {
        name: 'vault_notes_created',
        help: 'Notes created within the window (filesystem birth time).',
        type: 'gauge',
        samples: within('created'),
      },
      { name: 'vault_notes_modified', help: 'Notes modified within the window.', type: 'gauge', samples: within('modified') },
      {
        name: 'vault_last_modified_timestamp_seconds',
        help: 'Modification time of the most recently changed note.',
        type: 'gauge',
        samples: notes.length ? [{ value: Math.floor(notes.reduce((m, e) => Math.max(m, e.modified), 0) / 1000) }] : [],
      },
      {
        name: 'vault_folder_notes',
        help: 'Notes in each configured folder counter (stats.folders).',
        type: 'gauge',
        samples: Object.entries(folders).map(([name, c]) => ({ labels: { counter: name, path: c.path }, value: c.notes })),
      },
      {
        name: 'vault_property_notes',
        help: 'Notes per property value in each configured property counter (stats.properties).',
        type: 'gauge',
        samples: Object.entries(properties).flatMap(([name, c]) =>
          Object.entries(c.counts).map(([value, n]) => ({ labels: { counter: name, property: c.property, value }, value: n })),
        ),
      },
    ];
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(prometheusText(metrics));
  });
}
