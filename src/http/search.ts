import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { invalidRequest, notFound } from '../errors.js';
import { join, parsePlainPath, withMdExtension } from '../paths.js';
import type { Hit, Scope } from '../search/index.js';
import { QueryError } from '../search/query.js';
import { entryName, type Entry } from '../vault-index.js';
import { Ctx, iso, parse, project, type Services } from './context.js';
import { doc } from './openapi.js';
import { listableFolder } from './folders.js';
import { cursorKey, page } from './paging.js';

const Paging = {
  folder: z.string().max(1024).default(''),
  cursor: z.string().max(512).optional(),
  fields: z.string().max(512).optional(),
};

const SearchQuery = z.object({
  q: z.string().trim().min(1, 'q is required').max(500),
  match: z.enum(['all', 'any']).default('all'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  ...Paging,
});

const RelatedQuery = z.object({
  path: z.string().min(1, 'path is required').max(1024),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  terms: z.coerce.number().int().min(1).max(100).default(25),
  ...Paging,
});

/** The scope for a request: the account's grants, narrowed to `folder`. */
async function scopeOf(ctx: Ctx, folder: string): Promise<Scope> {
  const f = await listableFolder(ctx, ctx.toVault(parsePlainPath(folder)));
  return { key: ctx.account, folder: f.path, visible: ctx.visible };
}

async function results(
  ctx: Ctx,
  scope: Scope,
  hits: Hit[],
  q: { limit: number; cursor?: string; fields?: string },
  kind: string,
  params: Record<string, unknown>,
) {
  const p = page(hits, q.limit, q.cursor, cursorKey([ctx.account.name, kind], params));
  return {
    // What was searched, so an empty result says where nothing matched.
    scope: { folder: ctx.toApi(scope.folder), notes: await ctx.s.search.count(scope) },
    total: hits.length,
    results: p.slice.map((h) => {
      const snip = h.snippet();
      return project(
        {
          path: ctx.toApi(h.entry.path),
          name: entryName(h.entry),
          score: Math.round(h.score * 1000) / 1000,
          matched: h.matched,
          snippet: snip.text,
          heading: snip.heading,
          tags: h.entry.meta?.tags ?? [],
          modified: iso(h.entry.modified),
        },
        q.fields,
      );
    }),
    next_cursor: p.next_cursor,
    has_more: p.has_more,
  };
}

const LANGUAGE_NAMES = { en: 'English', ru: 'Russian' } as const;

/**
 * For an empty search: which languages the notes in scope are in, since search matches words and
 * doesn't translate. Agents tend to search only in English.
 */
async function noMatchHint(ctx: Ctx, scope: Scope, notes: number): Promise<string> {
  const head = `No matches in ${notes} ${notes === 1 ? 'note' : 'notes'}.`;
  const langs = await ctx.s.search.languages(scope);
  if (langs.length === 0) return head;
  const list = langs.map((l) => `${LANGUAGE_NAMES[l.language]} (≈${Math.round(l.share * 100)}%)`).join(' and ');
  const tail = langs.length > 1 ? 'so try the terms in those languages too' : 'so try the terms in that language';
  return `${head} Notes in this scope are in ${list}; search is word-based and doesn't translate, ${tail}.`;
}

export function searchRoutes(app: FastifyInstance, s: Services) {
  app.get('/v1/search', { schema: doc({ summary: 'Full-text search (BM25, English and Russian) over readable notes', tag: 'Search', query: SearchQuery }) }, async (req) => {
    const ctx = new Ctx(req, s);
    const q = parse(SearchQuery, req.query, 'query');
    const scope = await scopeOf(ctx, q.folder);
    let hits: Hit[];
    try {
      hits = await s.search.search(q.q, scope, { any: q.match === 'any' });
    } catch (e) {
      if (e instanceof QueryError) throw invalidRequest(e.message);
      throw e;
    }
    const { cursor: _c, fields: _f, limit: _l, ...rest } = q;
    const body = await results(ctx, scope, hits, q, 'search', rest);
    return { query: q.q, ...body, ...(hits.length === 0 ? { hint: await noMatchHint(ctx, scope, body.scope.notes) } : {}) };
  });

  app.get('/v1/related', { schema: doc({ summary: 'Readable notes most similar to a note', tag: 'Search', query: RelatedQuery }) }, async (req) => {
    const ctx = new Ctx(req, s);
    const q = parse(RelatedQuery, req.query, 'query');
    const segs = ctx.toVault(parsePlainPath(q.path));
    const source = [segs, withMdExtension(segs)]
      .map((x) => s.index.get(join(x)))
      .find((e): e is Entry => e?.kind === 'note' && ctx.visible(e));
    if (!source) throw notFound();
    const scope = await scopeOf(ctx, q.folder);
    const related = await s.search.related(source.path, scope, { terms: q.terms });
    if (!related) throw notFound();
    const { cursor: _c, fields: _f, limit: _l, ...rest } = q;
    return { path: ctx.toApi(source.path), terms: related.terms, ...(await results(ctx, scope, related.hits, q, 'related', rest)) };
  });
}
