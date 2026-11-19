import type { FastifyRequest } from 'fastify';
import { join, parsePlainPath, parseUrlPath } from '../paths.js';
import { Ctx, type Services } from './context.js';
import { walk } from './folders.js';

/** Routes whose URL tail is a path, with an action segment to drop (`…/move`, `…/query`). */
const PATH_ROUTES = ['/v1/notes/', '/v1/folders/', '/v1/files/', '/v1/bases/', '/v1/count/', '/v1/tree/'];

/** The account-relative path a 404 was about, if the request named one. */
function requestedPath(req: FastifyRequest): string | null {
  const [pathname = '', query = ''] = req.url.split('?');
  // PUT and POST /v1/notes create; a 404 there is about a parent, not a typo.
  if (req.method === 'PUT') return null;
  try {
    const prefix = PATH_ROUTES.find((p) => pathname.startsWith(p));
    if (prefix) {
      let segs = parseUrlPath(pathname.slice(prefix.length));
      if (req.method === 'POST' && ['move', 'query'].includes(segs.at(-1) ?? '')) segs = segs.slice(0, -1);
      return segs.length > 0 ? join(segs) : null;
    }
    const params = new URLSearchParams(query);
    const p = params.get('path') ?? params.get('folder');
    return p ? join(parsePlainPath(p)) : null;
  } catch {
    return null;
  }
}

/** Lowercase, no ".md", no "1. "-style number prefixes, single spaces. */
const norm = (p: string) =>
  p
    .normalize('NFC')
    .toLowerCase()
    .replace(/\.md$/, '')
    .split('/')
    .map((s) => s.replace(/^\d+[.)]?\s+/, '').replace(/\s+/g, ' ').trim())
    .join('/');

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Up to three paths close to the one a 404 was about: the same path without "1. " prefixes, case
 * or ".md", the same name elsewhere, or a near-miss spelling. Only paths the account can see are
 * candidates, so a hidden path and a missing one get the same suggestions.
 */
export function suggestPaths(req: FastifyRequest, s: Services): string[] {
  if (!req.auth) return [];
  const wanted = requestedPath(req);
  if (wanted === null) return [];
  const ctx = new Ctx(req, s);
  const root = s.index.get(join(ctx.account.root));
  if (!root) return [];
  const candidates = walk(ctx, root, true).map((i) => ctx.toApi(i.e.path));
  // The path exists and is visible: the 404 was about something else (e.g. a move destination).
  if (candidates.some((c) => c === wanted || c === `${wanted}.md`)) return [];
  const w = norm(wanted);
  const wName = w.slice(w.lastIndexOf('/') + 1);
  const max = Math.max(2, Math.floor(w.length / 6));
  const scored: { path: string; score: number }[] = [];
  for (const c of candidates) {
    const n = norm(c);
    let score: number;
    if (n === w) score = 0;
    else if (n.slice(n.lastIndexOf('/') + 1) === wName) score = 1;
    else {
      const d = distance(w, n, max);
      if (d > max) continue;
      score = 2 + d;
    }
    scored.push({ path: c, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.path);
}
