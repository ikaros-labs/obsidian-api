import { createHash } from 'node:crypto';
import { invalidRequest } from '../errors.js';

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function rng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle, then the first `n`. */
export function sample<T>(items: T[], n: number, seed?: string): T[] {
  const pool = [...items];
  const random = seed !== undefined ? rng(seed) : Math.random;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, n);
}

const hash = (x: unknown, n: number) => createHash('sha256').update(JSON.stringify(x ?? null)).digest('base64url').slice(0, n);

/**
 * Ties a cursor to the account and target (`scope`) and to every parameter that changes the result
 * set (`params`; leave out the cursor, `limit` and `fields`, which only shape the page). Each
 * parameter gets its own short hash, so a mismatch can name the parameter that changed.
 */
export interface CursorKey {
  scope: string;
  params: Record<string, string>;
}

/** Unset and empty parameters are left out, which keeps cursors short. */
const isSet = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);

export function cursorKey(scope: unknown[], params: Record<string, unknown> = {}): CursorKey {
  return { scope: hash(scope, 10), params: Object.fromEntries(Object.entries(params).filter(([, v]) => isSet(v)).map(([k, v]) => [k, hash(v, 4)])) };
}

export const encodeCursor = (offset: number, key: CursorKey) =>
  Buffer.from(JSON.stringify({ o: offset, k: key.scope, p: key.params })).toString('base64url');

export function decodeCursor(cursor: string, key: CursorKey): number {
  let c: { o?: unknown; k?: unknown; p?: Record<string, string> } = {};
  try {
    c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    // fall through
  }
  const offset = c.o;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || typeof c.k !== 'string') {
    throw invalidRequest('Invalid cursor: pass next_cursor exactly as returned, or drop it to start over');
  }
  if (c.k !== key.scope) throw invalidRequest('Invalid cursor: it belongs to another folder, path or query. Drop it to start over');
  const old = c.p ?? {};
  const changed = [...new Set([...Object.keys(old), ...Object.keys(key.params)])].filter((k) => old[k] !== key.params[k]).sort();
  if (changed.length > 0) {
    throw invalidRequest(`Invalid cursor: ${changed.join(', ')} changed since it was made. Use the same values, or drop the cursor to start over`, {
      changed,
    });
  }
  return offset;
}

/** Slices one page and builds the cursor for the next; no cursor once everything was returned. */
export function page<T>(items: T[], limit: number, cursor: string | undefined, key: CursorKey) {
  const offset = cursor ? decodeCursor(cursor, key) : 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit, key) : null;
  return { slice, offset, next_cursor: next, has_more: next !== null };
}
