import { invalidRequest } from '../errors.js';

/**
 * Simple frontmatter filters for listings: `Key=Value`, `Key!=Value`, `Key>=3`, `Key<2026-01-01`,
 * and `missing` keys. Property names are case-sensitive, as in Obsidian.
 */
export interface Condition {
  source: string;
  key: string;
  op: '=' | '!=' | '>' | '>=' | '<' | '<=';
  value: string;
}

const COND = /^\s*([^=!<>]+?)\s*(!=|>=|<=|=|>|<)\s*(.*?)\s*$/s;
const NUM = /^-?\d+(\.\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}/;

export function parseWhere(list: string[]): Condition[] {
  return list.map((source) => {
    const m = COND.exec(source);
    if (!m) throw invalidRequest(`Cannot parse where "${source}": expected Key=Value, Key!=Value, or Key>=, >, <=, < a number or date`);
    const [, key, op, raw] = m as unknown as [string, string, Condition['op'], string];
    // "Status==" or "Score=>3": a second operator character, not a value.
    if (/^[=!<>]/.test(raw)) throw invalidRequest(`Cannot parse where "${source}": use one operator: =, !=, >=, >, <=, <`);
    const value = raw.replace(/^(["'])(.*)\1$/s, '$2');
    if (op !== '=' && op !== '!=' && !NUM.test(value) && !DATE.test(value)) {
      throw invalidRequest(`Cannot parse where "${source}": ${op} needs a number or a YYYY-MM-DD date`);
    }
    return { source, key, op, value };
  });
}

/** Scalars a value stands for: a list's items, or the value itself. */
const scalars = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const text = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function compare(v: unknown, c: Condition): boolean {
  const s = text(v);
  if (NUM.test(c.value)) {
    if (typeof v !== 'number' && !NUM.test(s)) return false;
    const d = Number(s) - Number(c.value);
    return c.op === '>' ? d > 0 : c.op === '>=' ? d >= 0 : c.op === '<' ? d < 0 : d <= 0;
  }
  if (!DATE.test(s)) return false;
  const d = s.slice(0, c.value.length) < c.value ? -1 : s.slice(0, c.value.length) > c.value ? 1 : 0;
  return c.op === '>' ? d > 0 : c.op === '>=' ? d >= 0 : c.op === '<' ? d < 0 : d <= 0;
}

/** `=` matches a value, or any item of a list, ignoring case; `Key=` matches empty values. */
export function matches(fm: Record<string, unknown>, c: Condition): boolean {
  const has = Object.hasOwn(fm, c.key);
  const v = fm[c.key];
  if (c.op === '=' || c.op === '!=') {
    const want = c.value.toLowerCase();
    const empty = !has || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    const eq = want === '' ? empty : has && scalars(v).some((x) => text(x).toLowerCase() === want);
    return c.op === '=' ? eq : !eq;
  }
  return has && scalars(v).some((x) => compare(x, c));
}

/**
 * Rejects ordered conditions (`>=` …) on a property that has no value of that kind (number or
 * date) in any listed note: they could only match nothing.
 */
export function checkOrdered(conds: Condition[], frontmatters: Record<string, unknown>[]): void {
  for (const c of conds) {
    if (c.op === '=' || c.op === '!=') continue;
    const numeric = NUM.test(c.value);
    const values = frontmatters.flatMap((fm) => scalars(fm[c.key]));
    const isNum = (x: unknown) => typeof x === 'number' || NUM.test(text(x));
    const isDate = (x: unknown) => DATE.test(text(x));
    if (values.some(numeric ? isNum : isDate)) continue;
    // Name the kind it lacks when it has the other kind, else say it has neither.
    const lacks = values.some(numeric ? isDate : isNum) ? (numeric ? 'number' : 'date') : 'number or date';
    throw invalidRequest(`${c.key} has no ${lacks} values in the listed notes; use = for text`);
  }
}

/**
 * Rejects property names that no note in `keys` (every key used in the listed notes) has, naming
 * the property with the same name in another case when there is one.
 */
export function checkKeys(names: string[], keys: Set<string>): void {
  const unknown = [...new Set(names)].filter((k) => !keys.has(k));
  if (unknown.length === 0) return;
  const lower = new Map([...keys].map((k) => [k.toLowerCase(), k]));
  const problems = unknown.map((k) => {
    const alt = lower.get(k.toLowerCase());
    return { property: k, ...(alt ? { did_you_mean: alt } : {}) };
  });
  const msg = problems.map((p) => `"${p.property}"${p.did_you_mean ? ` (did you mean "${p.did_you_mean}"? names are case-sensitive)` : ''}`).join(', ');
  throw invalidRequest(`Unknown property ${msg}: no listed note has it`, { unknown_properties: problems });
}
