import { readdir } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, alreadyExists, forbidden, invalidRequest, notFound } from '../errors.js';
import { splitFrontmatter } from '../markdown.js';
import { join, parsePlainPath, split } from '../paths.js';
import { entryName, type Entry, type Kind } from '../vault-index.js';
import { Ctx, iso, parse, project, type Services } from './context.js';
import { cursorKey, page as pageOf, sample } from './paging.js';

const PREFIX = '/v1/folders/';

const KindFilter = z.enum(['note', 'file', 'folder', 'all']).default('all');
const Depth = z.enum(['1', 'all']).default('1');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const ListQuery = z.object({
  depth: Depth,
  kind: KindFilter,
  sort: z.enum(['name', '-name', 'created', '-created', 'modified', '-modified']).default('name'),
  limit: int(1, 500).default(50),
  cursor: z.string().optional(),
  sample: int(1, 100).optional(),
  seed: z.string().optional(),
  include: z.string().optional(),
  fields: z.string().optional(),
});

const CountQuery = z.object({ depth: Depth, kind: KindFilter });
const TagsQuery = z.object({ folder: z.string().default('') });
const DeleteQuery = z.object({
  recursive: z.enum(['true', 'false']).optional(),
  permanent: z.enum(['true', 'false']).optional(),
});

interface Item {
  e: Entry;
  /** Shown only because it leads to something the account can read. */
  traverseOnly: boolean;
}

/** The folder entry to list, if the account may list it at all. */
async function listableFolder(ctx: Ctx, segs: string[]): Promise<Entry> {
  await ctx.s.vault.resolve(segs);
  const e = ctx.s.index.get(join(segs));
  if (!e || e.kind !== 'folder' || !(ctx.visible(e) || ctx.traversable(e))) throw notFound();
  return e;
}

function walk(ctx: Ctx, folder: Entry, all: boolean): Item[] {
  const out: Item[] = [];
  const visit = (dir: Entry) => {
    for (const child of ctx.s.index.childrenOf(dir.path)) {
      if (child.kind === 'folder') {
        const readable = ctx.visible(child);
        if (!readable && !ctx.traversable(child)) continue;
        out.push({ e: child, traverseOnly: !readable });
        if (all) visit(child);
      } else if (ctx.visible(child)) {
        out.push({ e: child, traverseOnly: false });
      }
    }
  };
  visit(folder);
  return out;
}

const PLURAL: Record<Kind, 'notes' | 'files' | 'folders'> = { note: 'notes', file: 'files', folder: 'folders' };

function counts(items: Item[], kind: z.infer<typeof KindFilter>) {
  const kinds: Kind[] = kind === 'all' ? ['note', 'file', 'folder'] : [kind];
  const out: Partial<Record<'notes' | 'files' | 'folders', number>> = {};
  for (const k of kinds) out[PLURAL[k]] = 0;
  for (const { e, traverseOnly } of items) {
    if (!traverseOnly && kinds.includes(e.kind)) out[PLURAL[e.kind]]!++;
  }
  return out;
}

export function folderRoutes(app: FastifyInstance, s: Services) {
  const list = async (ctx: Ctx) => {
    const q = parse(ListQuery, ctx.req.query, 'query');
    const folder = await listableFolder(ctx, ctx.urlPath(PREFIX));
    const include = new Set((q.include ?? '').split(',').map((x) => x.trim()).filter(Boolean));
    for (const inc of include) if (inc !== 'body' && inc !== 'frontmatter') throw invalidRequest(`Unknown include: ${inc}`);
    if (include.has('body') && q.sample === undefined && q.limit > 20) {
      throw invalidRequest('include=body needs sample, or a limit of 20 or less');
    }

    const items = walk(ctx, folder, q.depth === 'all');
    const matching = items.filter((i) => q.kind === 'all' || i.e.kind === q.kind);
    let page: Item[];
    let nextCursor: string | null = null;

    if (q.sample !== undefined) {
      page = sample(
        matching.filter((i) => !i.traverseOnly),
        q.sample,
        q.seed,
      );
    } else {
      const desc = q.sort.startsWith('-');
      const field = q.sort.replace('-', '') as 'name' | 'created' | 'modified';
      const byPath = (a: Item, b: Item) => (a.e.path < b.e.path ? -1 : a.e.path > b.e.path ? 1 : 0);
      matching.sort((a, b) => {
        const d = field === 'name' ? byPath(a, b) : a.e[field] - b.e[field] || byPath(a, b);
        return desc ? -d : d;
      });
      const { cursor: _c, ...rest } = q;
      const p = pageOf(matching, q.limit, q.cursor, cursorKey([ctx.account.name, folder.path, rest]));
      page = p.slice;
      nextCursor = p.next_cursor;
    }

    const results = await Promise.all(
      page.map(async ({ e, traverseOnly }) => {
        const item: Record<string, unknown> = { kind: e.kind, path: ctx.toApi(e.path), name: entryName(e) };
        if (traverseOnly) item.traverse_only = true;
        if (e.rev) item.rev = e.rev;
        item.created = iso(e.created);
        item.modified = iso(e.modified);
        if (e.kind !== 'folder') item.size = e.size;
        if (e.kind === 'note') {
          if (include.has('frontmatter')) item.frontmatter = e.meta?.frontmatter ?? null;
          if (include.has('body')) {
            const text = (await s.vault.read(e.real ?? e.segs)).toString('utf8');
            item.body = splitFrontmatter(text).body;
          }
        }
        return project(item, q.fields);
      }),
    );
    return {
      path: ctx.toApi(folder.path),
      total: counts(matching, q.kind),
      results,
      next_cursor: nextCursor,
      has_more: nextCursor !== null,
    };
  };

  app.get('/v1/folders', async (req) => list(new Ctx(req, s)));
  app.get('/v1/folders/*', async (req) => list(new Ctx(req, s)));

  const count = async (ctx: Ctx) => {
    const q = parse(CountQuery, ctx.req.query, 'query');
    const folder = await listableFolder(ctx, ctx.urlPath('/v1/count/'));
    return { path: ctx.toApi(folder.path), depth: q.depth, ...counts(walk(ctx, folder, q.depth === 'all'), q.kind) };
  };
  app.get('/v1/count', async (req) => count(new Ctx(req, s)));
  app.get('/v1/count/*', async (req) => count(new Ctx(req, s)));

  app.post('/v1/folders/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const segs = ctx.urlPath(PREFIX);
    if (segs.length === ctx.account.root.length) throw alreadyExists('');
    const real = await s.vault.resolve(segs);
    const perms = ctx.perms(real);
    if (!perms.has('create')) throw perms.has('read') ? forbidden('create') : notFound();
    if ((await s.vault.kindOf(real)) !== null) throw alreadyExists(ctx.toApi(real));
    await s.vault.mkdir(real);
    await ctx.audit('mkdir', real);
    reply.code(201);
    return { kind: 'folder', path: ctx.toApi(real) };
  });

  app.delete('/v1/folders/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(DeleteQuery, req.query, 'query');
    const permanent = q.permanent === 'true';
    const perm = permanent ? 'purge' : 'delete';
    const segs = ctx.urlPath(PREFIX);
    if (segs.length === ctx.account.root.length) throw invalidRequest('The root folder cannot be deleted');
    return s.vault.locks.run([join(segs)], async () => {
      const real = await ctx.resolve(segs, 'read', perm);
      if ((await s.vault.kindOf(real)) !== 'folder') throw notFound();
      if (q.recursive !== 'true') {
        await s.vault.rmdirEmpty(real);
        await ctx.audit('rmdir', real);
        return reply.code(204).send();
      }
      // Everything inside must be indexed (so: no dotfiles, no skipped symlinks) and deletable.
      const raw = await readdir(s.vault.abs(real), { recursive: true });
      for (const rel of raw) {
        const e = s.index.get(join([...real, ...split(rel.split('\\').join('/'))].map((x) => x.normalize('NFC'))));
        if (!e) throw new ApiError(409, 'folder_not_empty', 'The folder contains files this account cannot see');
        if (!ctx.perms(e.segs).has(perm)) throw forbidden(`${perm} everything`);
      }
      if (permanent) await s.vault.purge(real);
      else await s.vault.trash(real);
      await ctx.audit(permanent ? 'purge' : 'delete', real, { recursive: true });
      return reply.code(204).send();
    });
  });

  app.get('/v1/tags', async (req) => {
    const ctx = new Ctx(req, s);
    const q = parse(TagsQuery, req.query, 'query');
    const folder = await listableFolder(ctx, ctx.toVault(parsePlainPath(q.folder)));
    const prefix = folder.path === '' ? '' : `${folder.path}/`;
    const tally = new Map<string, { tag: string; count: number }>();
    for (const e of s.index.notes()) {
      if (!e.path.startsWith(prefix) || !ctx.visible(e)) continue;
      for (const tag of e.meta?.tags ?? []) {
        const k = tag.toLowerCase();
        const t = tally.get(k) ?? { tag, count: 0 };
        t.count++;
        tally.set(k, t);
      }
    }
    const results = [...tally.values()].sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
    return { results };
  });
}
