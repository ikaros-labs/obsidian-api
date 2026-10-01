import type { FastifyInstance } from 'fastify';
import type { FilterExpression } from 'obsidian-bases-expression';
import { z } from 'zod';
import { baseDiagnostics, displayName, parseBase, SortSchema, type BaseFile } from '../bases/base-file.js';
import { BasesEngine, plainValue, type ViewSpec } from '../bases/engine.js';
import { ApiError, invalidRequest, notFound } from '../errors.js';
import { splitFrontmatter } from '../markdown.js';
import { isPrefix, join, parsePlainPath } from '../paths.js';
import { revOf, type Entry } from '../vault-index.js';
import { Ctx, etag, parse, type Services } from './context.js';
import { cursorKey, page, sample } from './paging.js';

const PREFIX = '/v1/bases/';

/** A number per config object, so a reload (which may change access) invalidates cached state. */
const generations = new WeakMap<object, number>();
let nextGeneration = 0;
function configGeneration(config: object): number {
  if (!generations.has(config)) generations.set(config, nextGeneration++);
  return generations.get(config)!;
}

const QueryCommon = {
  filters: z.unknown().optional(),
  sort: z.array(SortSchema).optional(),
  select: z.array(z.string().min(1)).min(1).optional(),
  limit: z.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
  sample: z.number().int().min(1).max(100).optional(),
  seed: z.string().optional(),
  count_only: z.boolean().default(false),
  include: z.array(z.enum(['frontmatter', 'body'])).default([]),
};

const BaseQueryBody = z.strictObject({ view: z.string().optional(), this: z.string().optional(), ...QueryCommon });

const AdhocQueryBody = z.strictObject({
  from: z.array(z.string()).min(1).default(['']),
  formulas: z.record(z.string(), z.string()).default({}),
  group_by: SortSchema.optional(),
  ...QueryCommon,
});

type CommonBody = z.output<z.ZodObject<typeof QueryCommon>>;

const withBaseExtension = (segs: string[]) =>
  segs.length === 0 || segs.at(-1)!.toLowerCase().endsWith('.base') ? segs : [...segs.slice(0, -1), `${segs.at(-1)}.base`];

/** Every file the account can read under `folders` (vault-relative), as rows for a view. */
function universe(ctx: Ctx, folders: string[][] = [ctx.account.root]): Entry[] {
  const out = new Map<string, Entry>();
  const visit = (dir: string) => {
    for (const child of ctx.s.index.childrenOf(dir)) {
      if (child.kind === 'folder') {
        if (ctx.visible(child) || ctx.traversable(child)) visit(child.path);
      } else if (ctx.visible(child)) {
        out.set(child.path, child);
      }
    }
  };
  for (const f of folders) visit(join(f));
  return [...out.values()];
}

async function readBase(ctx: Ctx, segs: string[]): Promise<{ real: string[]; base: BaseFile; rev: string }> {
  if (segs.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A base path is required');
  const real = await ctx.resolve(segs, 'read');
  if ((await ctx.s.vault.kindOf(real)) !== 'file') throw notFound();
  const buf = await ctx.s.vault.read(real);
  return { real, base: parseBase(buf.toString('utf8')), rev: revOf(buf) };
}

/** Rejects request filters that don't parse, instead of silently matching nothing. */
function checkRequestFilter(filter: unknown) {
  if (filter === undefined) return;
  const diagnostics = BasesEngine.compile({ filters: [{ where: 'filters', filter: filter as FilterExpression }], formulas: {}, sort: [], columns: [] }).diagnostics;
  if (diagnostics.length > 0) throw invalidRequest('Invalid filter expression', { diagnostics });
}

/** Runs a view and shapes the response. Shared by base queries and ad-hoc queries. */
async function respond(
  ctx: Ctx,
  rows: Entry[],
  spec: ViewSpec,
  body: CommonBody,
  meta: { cursorParts: unknown[]; names: (id: string) => string; thisFile?: Entry; head: Record<string, unknown> },
) {
  const propertyTypes = await ctx.s.propertyTypes.load();
  // Same index, types and access → the per-file inputs built by earlier queries are still valid.
  const stateKey = JSON.stringify([ctx.s.index.version, propertyTypes, configGeneration(ctx.s.config())]);
  const engine = new BasesEngine(
    { index: ctx.s.index, visible: ctx.visible, propertyTypes },
    ctx.s.engineCache.get(ctx.account.name, stateKey),
  );
  const toApiPath = (p: string) => ctx.toApi(p);
  const result = engine.run(rows, spec, { thisFile: meta.thisFile, toApiPath });
  const head = { ...meta.head, columns: spec.columns.map((key) => ({ key, name: meta.names(key) })) };

  if (body.count_only) {
    return { ...head, total: result.rows.length, ...(result.groups ? { groups: result.groups } : {}), diagnostics: result.diagnostics };
  }
  if (body.include.includes('body') && body.sample === undefined && body.limit > 20) {
    throw invalidRequest('include body needs sample, or a limit of 20 or less');
  }

  let selected = result.rows;
  let paging = { next_cursor: null as string | null, has_more: false };
  if (body.sample !== undefined) {
    selected = sample(result.rows, body.sample, body.seed);
  } else {
    const p = page(result.rows, body.limit, body.cursor, cursorKey(meta.cursorParts));
    selected = p.slice;
    paging = { next_cursor: p.next_cursor, has_more: p.has_more };
  }

  const columnFailures = new Map<string, { message: string; rows: number }>();
  const results = await Promise.all(
    selected.map(async (row) => {
      const values: Record<string, unknown> = {};
      for (const col of result.compiled.columns) {
        const v = col.compiled.evaluateValue(row.ctx);
        if (v.type === 'Error') {
          const f = columnFailures.get(col.id) ?? { message: v.value.message, rows: 0 };
          f.rows++;
          columnFailures.set(col.id, f);
        }
        values[col.id] = plainValue(v, toApiPath);
      }
      const out: Record<string, unknown> = { path: ctx.toApi(row.entry.path) };
      if (result.groups) out.group = row.group ? plainValue(row.group, toApiPath) : null;
      out.values = values;
      if (body.include.includes('frontmatter')) out.frontmatter = row.entry.meta?.frontmatter ?? null;
      if (body.include.includes('body') && row.entry.kind === 'note') {
        out.body = splitFrontmatter((await ctx.s.vault.read(row.entry.real ?? row.entry.segs)).toString('utf8')).body;
      }
      return out;
    }),
  );
  for (const [id, f] of columnFailures) result.diagnostics.push({ where: `columns.${id}`, message: f.message, rows: f.rows });

  return {
    ...head,
    total: result.rows.length,
    ...(result.groups ? { groups: result.groups } : {}),
    results,
    ...paging,
    diagnostics: result.diagnostics,
  };
}

export function baseRoutes(app: FastifyInstance, s: Services) {
  app.get('/v1/bases/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const { real, base, rev } = await readBase(ctx, withBaseExtension(ctx.urlPath(PREFIX)));
    reply.header('etag', etag(rev));
    return {
      path: ctx.toApi(real),
      rev,
      filters: base.filters ?? null,
      formulas: base.formulas,
      properties: base.properties,
      views: base.views.map((v) => ({
        name: v.name,
        type: v.type,
        filters: v.filters ?? null,
        order: v.order ?? null,
        sort: v.sort,
        group_by: v.groupBy ?? null,
        limit: v.limit ?? null,
      })),
      diagnostics: baseDiagnostics(base),
    };
  });

  app.post('/v1/bases/*', async (req) => {
    const ctx = new Ctx(req, s);
    const raw = ctx.urlPath(PREFIX);
    if (raw.length <= ctx.account.root.length + 1 || raw.at(-1) !== 'query') throw new ApiError(404, 'not_found', 'No such endpoint');
    const body = parse(BaseQueryBody, req.body ?? {});
    checkRequestFilter(body.filters);
    const { real, base, rev } = await readBase(ctx, withBaseExtension(raw.slice(0, -1)));

    const view = body.view === undefined ? base.views[0] : base.views.find((v) => v.name === body.view);
    if (body.view !== undefined && !view) {
      throw invalidRequest(`No view named "${body.view}"`, { available_views: base.views.map((v) => v.name) });
    }

    let thisFile: Entry | undefined = s.index.get(join(real));
    if (body.this !== undefined) {
      const segs = ctx.toVault(parsePlainPath(body.this));
      const e = s.index.get(join(segs)) ?? s.index.get(`${join(segs)}.md`);
      if (!e || e.kind === 'folder' || !ctx.visible(e)) throw new ApiError(404, 'not_found', '"this" note not found');
      thisFile = e;
    }

    const columns = body.select ?? view?.order ?? ['file.name', ...Object.keys(base.properties).filter((k) => k !== 'file.name')];
    const spec: ViewSpec = {
      filters: [
        { where: 'filters', filter: base.filters },
        ...(view ? [{ where: `views.${view.name}.filters`, filter: view.filters }] : []),
        ...(body.filters !== undefined ? [{ where: 'request.filters', filter: body.filters as FilterExpression }] : []),
      ].filter((f) => f.filter !== undefined && f.filter !== null),
      formulas: base.formulas,
      sort: body.sort ?? view?.sort ?? [],
      groupBy: view?.groupBy,
      columns,
      limit: view?.limit,
    };
    const { cursor: _c, ...rest } = body;
    return respond(ctx, universe(ctx), spec, body, {
      cursorParts: [ctx.account.name, join(real), rev, rest],
      names: (id) => displayName(base, id),
      thisFile,
      head: { base: ctx.toApi(real), view: view ? { name: view.name, type: view.type } : null },
    });
  });

  app.post('/v1/query', async (req) => {
    const ctx = new Ctx(req, s);
    const body = parse(AdhocQueryBody, req.body ?? {});
    checkRequestFilter(body.filters);
    const folders = body.from.map((f) => {
      const segs = ctx.toVault(parsePlainPath(f));
      const e = s.index.get(join(segs));
      if (!e || e.kind !== 'folder' || !(ctx.visible(e) || ctx.traversable(e))) throw new ApiError(404, 'not_found', `Folder not found: ${f}`);
      return segs;
    });
    // Overlapping folders (e.g. "" and "Notes") would list rows twice; keep the outermost.
    const outer = folders.filter((f, i) => !folders.some((g, j) => j !== i && g.length < f.length && isPrefix(g, f)));
    const spec: ViewSpec = {
      filters: body.filters !== undefined ? [{ where: 'request.filters', filter: body.filters as FilterExpression }] : [],
      formulas: body.formulas,
      sort: body.sort ?? [],
      groupBy: body.group_by,
      columns: body.select ?? ['file.name', ...Object.keys(body.formulas).map((f) => `formula.${f}`)],
    };
    const { cursor: _c, ...rest } = body;
    return respond(ctx, universe(ctx, outer), spec, body, {
      cursorParts: [ctx.account.name, 'query', rest],
      names: (id) => id,
      head: { from: outer.map((f) => ctx.toApi(f)) },
    });
  });
}
