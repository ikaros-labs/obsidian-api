import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientMain } from '../src/cli/client.js';
import { BASES_FIXTURE, setup, unfenced, type TestEnv } from './helpers.js';
import { callTool, injectFetch, mcpClient } from './mcp-helpers.js';

// A Reading List where `Completed` is a date property (types.json) and is empty in three ways.
const NOTES: Record<string, string> = {
  'Null.md': '---\nStatus: reading\nCompleted:\n---\n',
  'Blank.md': '---\nStatus: reading\nCompleted: ""\n---\n',
  'Missing.md': '---\nStatus: queued\n---\n',
  'Done.md': '---\nStatus: done\nCompleted: 2026-03-01\n---\n',
  'Early.md': '---\nStatus: done\nCompleted: 2025-12-24\n---\n',
};
const BASE = `filters:
  and:
    - file.inFolder("Reading List")
views:
  - type: table
    name: All
    order: [file.name, Status, Completed]
    sort:
      - property: Completed
        direction: ASC
`;

let env: TestEnv;
beforeAll(async () => {
  env = await setup({
    fixture: BASES_FIXTURE,
    accounts: unfenced({ reader: { access: { '.': 'read' } } }),
    prepare(vault) {
      mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
      writeFileSync(path.join(vault, '.obsidian/types.json'), JSON.stringify({ types: { Completed: 'date' } }));
      mkdirSync(path.join(vault, 'Reading List'), { recursive: true });
      for (const [name, text] of Object.entries(NOTES)) writeFileSync(path.join(vault, 'Reading List', name), text);
      writeFileSync(path.join(vault, 'Reading.base'), BASE);
    },
  });
});
afterAll(() => env.cleanup());

type Result = { results: { values: Record<string, unknown> }[] };
const completed = (body: Result) => Object.fromEntries(body.results.map((r) => [r.values['file.name'], r.values.Completed]));
const query = async (url: string, payload: Record<string, unknown>) => {
  const res = await env.req('reader', { method: 'POST', url, payload });
  expect(res.statusCode).toBe(200);
  return res.json() as Result & { diagnostics: unknown[] };
};
const EXPECTED = { Null: null, Blank: '', Missing: null, Done: '2026-03-01', Early: '2025-12-24' };

describe('empty date properties', () => {
  it('are empty, not the epoch, in REST base and ad-hoc queries; empties sort last', async () => {
    const base = await query('/v1/bases/Reading.base/query', {});
    expect(completed(base)).toEqual(EXPECTED);
    expect(base.results.map((r) => r.values['file.name'])).toEqual(['Early', 'Done', 'Blank', 'Missing', 'Null']);
    const desc = await query('/v1/query', { from: ['Reading List'], select: ['file.name', 'Completed'], sort: [{ property: 'Completed', direction: 'DESC' }] });
    expect(completed(desc)).toEqual(EXPECTED);
    expect(desc.results.map((r) => r.values['file.name'])).toEqual(['Done', 'Early', 'Blank', 'Missing', 'Null']);
  });

  it('are isEmpty()', async () => {
    const names = async (filters: string) =>
      (await query('/v1/query', { from: ['Reading List'], select: ['file.name'], filters, sort: [{ property: 'file.name', direction: 'ASC' }] })).results.map(
        (r) => r.values['file.name'],
      );
    expect(await names('Completed.isEmpty()')).toEqual(['Blank', 'Missing', 'Null']);
    expect(await names('!Completed.isEmpty()')).toEqual(['Done', 'Early']);
  });

  it('formulas reading an empty date give an empty value', async () => {
    const body = await query('/v1/query', {
      from: ['Reading List'],
      select: ['file.name', 'formula.year'],
      formulas: { year: 'if(Completed.isEmpty(), "", Completed.year)' },
    });
    expect(Object.fromEntries(body.results.map((r) => [r.values['file.name'], r.values['formula.year']]))).toEqual({
      Null: '',
      Blank: '',
      Missing: '',
      Done: 2026,
      Early: 2025,
    });
  });

  it('are empty over MCP', async () => {
    const c = await mcpClient(env, 'reader');
    try {
      const r = await callTool(c, 'spall_query_base', { base: 'Reading.base' });
      expect(r.isError).toBe(false);
      expect(completed(r.data as Result)).toEqual(EXPECTED);
      expect(r.text).not.toContain('1970');
    } finally {
      await c.close();
    }
  });

  it('are blank in the CLI table and null in --json', async () => {
    const run = async (argv: string[]) => {
      let out = '';
      const code = await clientMain(argv, {
        env: { SPALL_URL: 'http://spall.test', SPALL_TOKEN: 'tok-reader' },
        out: (s) => (out += s),
        err: () => {},
        stdin: async () => '',
        fetch: injectFetch(env),
      });
      expect(code).toBe(0);
      return out;
    };
    const human = await run(['base', 'Reading.base']);
    expect(human).not.toContain('1970');
    expect(human).not.toContain('Invalid');
    expect(completed(JSON.parse(await run(['base', 'Reading.base', '--json'])))).toEqual(EXPECTED);
  });
});
