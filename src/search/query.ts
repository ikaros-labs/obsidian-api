import { isIndexable, stem, words } from './tokenize.js';

/**
 * One clause of a search query:
 * - `term`: a single word (stemmed).
 * - `prefix`: `word*`, expanded against the index later.
 * - `phrase`: `"several words"` (or a hyphenated `pcb-плата`): stems that must appear in order.
 * A leading `-` negates any of them: notes that match are excluded.
 */
export type Clause =
  | { kind: 'term'; negate: boolean; text: string; term: string }
  | { kind: 'prefix'; negate: boolean; text: string; prefixes: string[] }
  | { kind: 'phrase'; negate: boolean; text: string; terms: string[] };

export class QueryError extends Error {}

/** Limits that keep one query cheap; prefix clauses cost the most. */
export const MAX_CLAUSES = 32;
export const MAX_PREFIX_CLAUSES = 5;

const normalize = (s: string) => s.normalize('NFC').toLowerCase().replace(/ё/g, 'е');

/** Splits a query into chunks: quoted phrases and whitespace-separated words, each maybe negated. */
function chunks(query: string): { negate: boolean; quoted: boolean; text: string }[] {
  const out: { negate: boolean; quoted: boolean; text: string }[] = [];
  const re = /(-?)(?:"([^"]*)"?|(\S+))/gu;
  for (const m of query.matchAll(re)) {
    if (m[2] !== undefined) out.push({ negate: m[1] === '-', quoted: true, text: m[2] });
    else if (m[3] !== undefined) out.push({ negate: m[1] === '-', quoted: false, text: m[3] });
  }
  return out;
}

export function parseQuery(query: string): Clause[] {
  const clauses: Clause[] = [];
  const seen = new Set<string>();
  const push = (c: Clause) => {
    const key = `${c.negate ? '-' : ''}${c.kind}:${c.kind === 'term' ? c.term : c.kind === 'prefix' ? c.prefixes.join('|') : c.terms.join(' ')}`;
    if (seen.has(key)) return;
    seen.add(key);
    clauses.push(c);
  };
  for (const { negate, quoted, text } of chunks(query)) {
    const prefix = !quoted && text.endsWith('*');
    const ws = words(prefix ? text.slice(0, -1) : text);
    if (prefix && ws.length > 0) {
      // `pcb-пла*`: the leading words as a phrase-free AND, the last as the prefix.
      for (const w of ws.slice(0, -1)) if (isIndexable(w)) push({ kind: 'term', negate, text: w, term: stem(w) });
      const last = ws.at(-1)!;
      if (last.length >= 2) push({ kind: 'prefix', negate, text: `${last}*`, prefixes: [...new Set([last, stem(last)])] });
      continue;
    }
    const terms = ws.filter(isIndexable).map(stem);
    if (terms.length === 0) continue;
    if (terms.length === 1) push({ kind: 'term', negate, text: normalize(text), term: terms[0]! });
    else push({ kind: 'phrase', negate, text: normalize(text), terms });
  }
  if (clauses.length > MAX_CLAUSES) throw new QueryError(`A query can have at most ${MAX_CLAUSES} words or phrases`);
  if (clauses.filter((c) => c.kind === 'prefix').length > MAX_PREFIX_CLAUSES) {
    throw new QueryError(`A query can have at most ${MAX_PREFIX_CLAUSES} prefix* terms`);
  }
  if (clauses.length > 0 && clauses.every((c) => c.negate)) {
    throw new QueryError('A query needs at least one word that is not excluded');
  }
  return clauses;
}

/** Whether `phrase` occurs as consecutive terms in `seq`. */
export function containsPhrase(seq: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0) return false;
  outer: for (let i = 0; i + phrase.length <= seq.length; i++) {
    for (let j = 0; j < phrase.length; j++) if (seq[i + j] !== phrase[j]) continue outer;
    return true;
  }
  return false;
}
