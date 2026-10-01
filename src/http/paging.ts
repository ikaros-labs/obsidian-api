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

/** A key that ties a cursor to the account, the target and every parameter except the cursor. */
export function cursorKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 12);
}

export const encodeCursor = (offset: number, key: string) =>
  Buffer.from(JSON.stringify({ o: offset, k: key })).toString('base64url');

export function decodeCursor(cursor: string, key: string): number {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o: unknown; k: unknown };
    if (c.k === key && typeof c.o === 'number' && Number.isInteger(c.o) && c.o >= 0) return c.o;
  } catch {
    // fall through
  }
  throw invalidRequest('Invalid cursor (cursors only work with the same path and parameters)');
}

/** Slices one page and builds the cursor for the next. */
export function page<T>(items: T[], limit: number, cursor: string | undefined, key: string) {
  const offset = cursor ? decodeCursor(cursor, key) : 0;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? encodeCursor(offset + limit, key) : null;
  return { slice, next_cursor: next, has_more: next !== null };
}
