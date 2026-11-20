import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASES_FIXTURE, setup, unfenced, type TestEnv } from './helpers.js';

// `Completed` is a date and `Score` a number (types.json), each set, null, "" or missing.
// Obsidian: `<`, `>`, `<=`, `>=` with a Null side give Null (falsy; `!` of it is true); otherwise
// plain JS comparison, so `"" < date(...)` is `"" < <ms>`, which is true.
const NOTES: Record<string, string> = {
  'Early.md': '---\nCompleted: 2025-12-24\nScore: 3\n---\n',
  'Late.md': '---\nCompleted: 2026-03-01\nScore: 7\n---\n',
  'Null.md': '---\nCompleted:\nScore:\n---\n',
  'Blank.md': '---\nCompleted: ""\n---\n',
  'Missing.md': '---\nTitle: none\n---\n',
};
// Expected rows, derived from Obsidian's algorithm (see the comment above).
const CASES: [filter: string, names: string[]][] = [
  ['Completed < date("2026-01-01")', ['Blank', 'Early']],
  ['Completed >= date("2026-01-01")', ['Late']],
  ['!(Completed < date("2026-01-01"))', ['Late', 'Missing', 'Null']],
  ['Score < 5', ['Early']],
  ['Score >= 5', ['Late']],
];
const BASE = `filters:
  and:
    - file.inFolder("Cmp")
formulas:
  band: 'if(Score > 4, "hi", "lo")'
  lt: 'Score < 5'
views:
${CASES.map(([f], i) => `  - type: table\n    name: v${i}\n    filters: ${JSON.stringify(f)}\n    order: [file.name, formula.band, formula.lt]\n    sort:\n      - property: file.name\n        direction: ASC`).join('\n')}
`;

let env: TestEnv;
beforeAll(async () => {
  env = await setup({
    fixture: BASES_FIXTURE,
    accounts: unfenced({ reader: { access: { '.': 'read' } } }),
    prepare(vault) {
      mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
      writeFileSync(path.join(vault, '.obsidian/types.json'), JSON.stringify({ types: { Completed: 'date', Score: 'number' } }));
      mkdirSync(path.join(vault, 'Cmp'), { recursive: true });
      for (const [name, text] of Object.entries(NOTES)) writeFileSync(path.join(vault, 'Cmp', name), text);
      writeFileSync(path.join(vault, 'Cmp.base'), BASE);
    },
  });
});
afterAll(() => env.cleanup());

type Result = { results: { values: Record<string, unknown> }[]; diagnostics: unknown[] };
const query = async (url: string, payload: Record<string, unknown>) => {
  const res = await env.req('reader', { method: 'POST', url, payload });
  expect(res.statusCode).toBe(200);
  const body = res.json() as Result;
  expect(body.diagnostics).toEqual([]);
  return body;
};
const names = (b: Result) => b.results.map((r) => r.values['file.name']);
const SORT = [{ property: 'file.name', direction: 'ASC' }];

describe('ordering comparisons with empty values (as in Obsidian)', () => {
  it.each(CASES)('ad-hoc /v1/query: %s', async (filters, expected) => {
    expect(names(await query('/v1/query', { from: ['Cmp'], select: ['file.name'], filters, sort: SORT }))).toEqual(expected);
  });

  it.each(CASES.map(([f, e], i) => [f, e, `v${i}`] as const))('.base view: %s', async (_f, expected, view) => {
    expect(names(await query('/v1/bases/Cmp.base/query', { view }))).toEqual(expected);
  });

  it('formulas: a Null comparison is Null, and falsy in if()', async () => {
    const body = await query('/v1/query', {
      from: ['Cmp'],
      select: ['file.name', 'formula.band', 'formula.lt'],
      formulas: { band: 'if(Score > 4, "hi", "lo")', lt: 'Score < 5' },
      sort: SORT,
    });
    expect(body.results.map((r) => r.values)).toEqual([
      { 'file.name': 'Blank', 'formula.band': 'lo', 'formula.lt': null },
      { 'file.name': 'Early', 'formula.band': 'lo', 'formula.lt': true },
      { 'file.name': 'Late', 'formula.band': 'hi', 'formula.lt': false },
      { 'file.name': 'Missing', 'formula.band': 'lo', 'formula.lt': null },
      { 'file.name': 'Null', 'formula.band': 'lo', 'formula.lt': null },
    ]);
    // Same formulas from the .base file.
    const base = await query('/v1/bases/Cmp.base/query', { view: 'v3' });
    expect(base.results.map((r) => r.values)).toEqual([{ 'file.name': 'Early', 'formula.band': 'lo', 'formula.lt': true }]);
  });

  const run = async (filters: string) => names(await query('/v1/query', { from: ['Cmp'], select: ['file.name'], filters, sort: SORT }));

  it('a string right of a date is read as a date', async () => {
    expect(await run('Completed < "2026-01-01"')).toEqual(['Blank', 'Early']);
  });

  // Obsidian's looseEquals: primitives (String, Number, Boolean) compare with JS `==`; null equals
  // only null.
  it('==/!= between primitives are JS loose equality; null equals only null', async () => {
    expect(await run('Score == "3"')).toEqual(['Early']);
    expect(await run('Score != "3"')).toEqual(['Blank', 'Late', 'Missing', 'Null']);
    expect(await run('Score != 3')).toEqual(['Blank', 'Late', 'Missing', 'Null']);
    expect(await run('Completed == null')).toEqual(['Missing', 'Null']); // "" == null is false
    expect(await run('Completed != null')).toEqual(['Blank', 'Early', 'Late']);
    expect(await run('"" == null')).toEqual([]);
    expect(await run('null == null')).toHaveLength(5);
    expect(await run('true == 1 && "" == 0')).toHaveLength(5);
  });
});
