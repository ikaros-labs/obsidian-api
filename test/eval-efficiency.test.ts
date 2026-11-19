import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientMain, quotePath } from '../src/cli/client.js';
import { snippetOf } from '../src/search/index.js';
import { tokenize } from '../src/search/tokenize.js';
import { ACCOUNTS, enc, setup, type TestEnv } from './helpers.js';
import { callTool, injectFetch, mcpClient } from './mcp-helpers.js';

/** Spall 1.2 agent-efficiency items: paths, did-you-mean, where/missing, search, paging, tree. */

const PROJECTS: Record<string, string> = {
  'Tram Board': 'Status: Active\nScore: 4\nDue: 2026-12-01\nCategory: [software, hardware]',
  Bookshelf: 'Status: Done\nScore: 2\nDue: 2026-05-01\nCompleted: 2026-05-18\nCategory: [hardware]',
  'Pixel Clock': 'Status: Done\nScore: 5\nCategory: [hardware]',
  Sourdough: 'Status: Parked\nCategory: []',
};

let env: TestEnv;
beforeAll(async () => {
  env = await setup({
    accounts: {
      ...ACCOUNTS,
      agent: { ...ACCOUNTS.agent, rate_limit: '10000/min' },
      pm: { rate_limit: '10000/min', access: { '1. Projects': 'read', 'Research/inbox': 'read', 'Notes/Private': 'none', Notes: 'read' } },
    },
    prepare: (vault) => {
      mkdirSync(path.join(vault, '1. Projects/Archive/2025'), { recursive: true });
      for (const [name, fm] of Object.entries(PROJECTS)) {
        writeFileSync(path.join(vault, `1. Projects/${name}.md`), `---\n${fm}\n---\n# ${name}\n\nAbout ${name}.\n\n## Log\n- worked on it\n`);
      }
      writeFileSync(path.join(vault, '1. Projects/Archive/Old.md'), '---\nStatus: Archived\n---\nold\n');
      writeFileSync(path.join(vault, '1. Projects/Archive/2025/Older.md'), 'older\n');
    },
  });
});
afterAll(() => env.cleanup());

const get = async (account: string, url: string) => {
  const res = await env.req(account, { method: 'GET', url });
  return { status: res.statusCode, body: res.json(), text: res.body };
};

async function spall(account: string, argv: string[]) {
  let out = '';
  let err = '';
  const code = await clientMain(argv, {
    env: { SPALL_URL: 'http://spall.test', SPALL_TOKEN: `tok-${account}` },
    out: (s) => (out += s),
    err: (s) => (err += s),
    stdin: async () => '',
    fetch: injectFetch(env),
  });
  return { code, out, err };
}

describe('item 4: copy-pasteable paths and did-you-mean', () => {
  it('quotes paths with spaces or a leading number, escaping shell specials', () => {
    expect(quotePath('Research/Plan.md')).toBe('Research/Plan.md');
    expect(quotePath('1. Projects/Tram Board.md')).toBe('"1. Projects/Tram Board.md"');
    expect(quotePath('1.md')).toBe('"1.md"');
    expect(quotePath('a "b" $c`d`.md')).toBe('"a \\"b\\" \\$c\\`d\\`.md"');
  });

  it('prints search hits and ls entries as quoted paths, never with rank numbers', async () => {
    const s = await spall('pm', ['search', 'tram']);
    expect(s.out).toMatch(/^"1\. Projects\/Tram Board\.md" {2}score [\d.]+\n/);
    const ls = await spall('pm', ['ls', '1. Projects']);
    expect(ls.out.split('\n')[0]).toBe('"1. Projects/Archive/"');
  });

  it('suggests the path without the number prefix, from visible paths only', async () => {
    const r = await get('pm', `/v1/notes/${enc('Projects/Tram Board.md')}`);
    expect(r.status).toBe(404);
    expect(r.body.error.details).toEqual({ did_you_mean: ['1. Projects/Tram Board.md'] });
    const typo = await get('pm', `/v1/folders/${enc('1. Projetcs')}`);
    expect(typo.body.error.details.did_you_mean).toContain('1. Projects');
    // Same name elsewhere.
    expect((await get('pm', `/v1/notes/${enc('Bookshelf')}`)).body.error.details.did_you_mean).toEqual(['1. Projects/Bookshelf.md']);
  });

  it('never suggests a hidden path: hidden and missing read the same', async () => {
    // Notes/Private/Secret.md exists but pm can't read it.
    const hidden = await get('pm', `/v1/notes/${enc('Notes/Private/Secret.md')}`);
    const missing = await get('pm', `/v1/notes/${enc('Notes/Private/Secrex.md')}`);
    expect(hidden.status).toBe(404);
    expect(hidden.text).not.toContain('Secret');
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, request_id: null });
    expect(strip(hidden.body)).toEqual(strip(missing.body));
    // A near-miss of a hidden name suggests nothing hidden either.
    expect((await get('pm', `/v1/notes/${enc('Notes/Private/Secre')}`)).text).not.toContain('Secret');
    // An account that can't see 1. Projects gets no suggestion into it.
    expect((await get('agent', `/v1/notes/${enc('Projects/Tram Board.md')}`)).body.error.details).toBeUndefined();
  });

  it('carries suggestions into MCP and CLI errors', async () => {
    const pm = await mcpClient(env, 'pm');
    const r = await callTool(pm, 'spall_read', { path: 'Projects/Tram Board' });
    await pm.close();
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Did you mean "1. Projects/Tram Board.md"?');
    const cli = await spall('pm', ['read', 'Projects/Tram Board']);
    expect(cli.code).toBe(3);
    expect(cli.err).toBe('spall: not_found: Not found, or not visible to this account. Did you mean "1. Projects/Tram Board.md"?\n');
  });
});

describe('item 5: frontmatter where/missing on listings', () => {
  const ls = (q: string) => get('pm', `/v1/folders/${enc('1. Projects')}?depth=all&${q}`);
  const paths = (b: { results: { path: string }[] }) => b.results.map((r) => r.path);

  it('filters by =, != (list items too), numbers, dates and missing keys, notes only', async () => {
    expect(paths((await ls('where=Status=Done')).body)).toEqual(['1. Projects/Bookshelf.md', '1. Projects/Pixel Clock.md']);
    expect(paths((await ls('where=Status=done')).body)).toHaveLength(2); // values ignore case, keys don't (below)
    expect(paths((await ls('where=Category=software')).body)).toEqual(['1. Projects/Tram Board.md']);
    expect(paths((await ls('where=Score>=4')).body)).toEqual(['1. Projects/Pixel Clock.md', '1. Projects/Tram Board.md']);
    expect(paths((await ls('where=Due<2026-06-01')).body)).toEqual(['1. Projects/Bookshelf.md']);
    expect(paths((await ls('where=Status=Done&missing=Completed')).body)).toEqual(['1. Projects/Pixel Clock.md']);
    expect(paths((await ls('where=Category=')).body)).toContain('1. Projects/Sourdough.md');
    // != also matches notes without the key.
    expect(paths((await ls('where=Status!=Done&where=Status!=Archived')).body)).toEqual([
      '1. Projects/Archive/2025/Older.md',
      '1. Projects/Sourdough.md',
      '1. Projects/Tram Board.md',
    ]);
    expect((await ls('where=Status=Done')).body.total).toEqual({ entries: 2, notes: 2, files: 0, folders: 0 });
  });

  it('rejects unknown properties (suggesting the case) and unparseable conditions', async () => {
    const r = await ls('where=status%3DDone');
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('did you mean "Status"?');
    expect(r.body.error.details.unknown_properties).toEqual([{ property: 'status', did_you_mean: 'Status' }]);
    expect((await ls('missing=Nope')).status).toBe(400);
    expect((await ls('where=Status')).status).toBe(400);
    expect((await ls('where=Status>=soon')).body.error.message).toContain('needs a number');
    for (const w of ['Status==', 'Score=>3', 'Score=<3', 'Status!==Done']) {
      const r = await ls(`where=${encodeURIComponent(w)}`);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('use one operator');
    }
    const text = await ls('where=Status%3E%3D5');
    expect(text.status).toBe(400);
    expect(text.body.error.message).toBe('Status has no number or date values in the listed notes; use = for text');
    expect((await ls('where=Status%3E%3D2026-01-01')).body.error.message).toBe('Status has no number or date values in the listed notes; use = for text');
    expect((await ls('where=Due%3E%3D5')).body.error.message).toContain('Due has no number values');
    expect((await ls('where=Score%3E%3D5')).status).toBe(200);
  });

  it('works through spall_list and spall ls --where --missing', async () => {
    const pm = await mcpClient(env, 'pm');
    const r = await callTool(pm, 'spall_list', { folder: '1. Projects', where: ['Status=Done'], missing: ['Completed'] });
    const bad = await callTool(pm, 'spall_list', { folder: '1. Projects', where: ['status=Done'] });
    await pm.close();
    expect((r.data.results as { path: string }[]).map((x) => x.path)).toEqual(['1. Projects/Pixel Clock.md']);
    expect(bad.isError).toBe(true);
    const cli = await spall('pm', ['ls', '1. Projects', '--where', 'Status=Done', '--missing', 'Completed']);
    expect(cli.out).toBe('"1. Projects/Pixel Clock.md"\n(1 entry: 1 note, 0 files, 0 folders)\n');
    const badCli = await spall('pm', ['ls', '1. Projects', '--where', 'status=Done']);
    expect(badCli).toMatchObject({ code: 1, err: 'spall: invalid_request: Unknown property "status" (did you mean "Status"? names are case-sensitive): no listed note has it\n' });
  });
});

describe('item 5: query_base diagnostics', () => {
  const query = (body: unknown) => env.req('pm', { method: 'POST', url: '/v1/query', payload: body as object });

  it('rejects a filter that is a quoted string instead of matching every row', async () => {
    const r = await query({ from: ['1. Projects'], filters: '"Status == \\"Done\\""' });
    expect(r.statusCode).toBe(400);
    expect(JSON.stringify(r.json())).toContain('quoted string');
  });

  it('names unknown properties, with the right case', async () => {
    const r = (await query({ from: ['1. Projects'], filters: 'status == "Done"' })).json();
    expect(r.total).toBe(0);
    expect(r.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('Unknown property "status"') })]);
    expect(r.diagnostics[0].message).toContain('Did you mean "Status"?');
    const ok = (await query({ from: ['1. Projects'], filters: { and: ['Status == "Done"', 'note["Score"] > 1', 'list(Category).contains("hardware")'] } })).json();
    expect(ok.diagnostics).toEqual([]);
    expect(ok.total).toBe(2);
  });
});

describe('item 6: search', () => {
  it('says what was searched, and the CLI prints "No matches"', async () => {
    const r = await get('pm', '/v1/search?q=zebra&folder=1.%20Projects');
    expect(r.body).toMatchObject({ total: 0, results: [], scope: { folder: '1. Projects', notes: 6 } });
    const pm = await mcpClient(env, 'pm');
    const m = await callTool(pm, 'spall_search', { query: 'zebra' });
    await pm.close();
    expect(m.text).toMatch(/^No matches for "zebra" in all folders you can read \(\d+ notes\)\./);
    expect((await spall('pm', ['search', 'zebra', '--folder', '1. Projects'])).out).toBe(
      'No matches for "zebra" in "1. Projects/" (6 notes searched).\n',
    );
  });

  it('matches folder names and frontmatter values, with a snippet that shows why', async () => {
    const byFolder = (await get('pm', '/v1/search?q=archive')).body;
    expect(byFolder.results.map((h: { path: string }) => h.path).sort()).toEqual(['1. Projects/Archive/2025/Older.md', '1. Projects/Archive/Old.md']);
    const fm = (await get('pm', '/v1/search?q=parked')).body.results[0];
    expect(fm).toMatchObject({ path: '1. Projects/Sourdough.md', snippet: 'Status: Parked', heading: null });
  });

  it('picks the line with the most matched terms and gives its heading path', () => {
    const body = '# T\n\nprinter intro\n\n## Notes\n\n```\n# not a heading\n```\n### Deep\n\nthe printer nozzle line\n';
    expect(snippetOf(body, new Set(tokenize('printer nozzle')))).toEqual({ text: 'the printer nozzle line', heading: 'T > Notes > Deep' });
    expect(snippetOf(body, new Set(tokenize('printer')))).toEqual({ text: 'printer intro', heading: 'T' });
    const long = `## H\n${'word '.repeat(60)}needle ${'word '.repeat(60)}`;
    expect(snippetOf(long, new Set(tokenize('needle'))).text).toMatch(/^….*needle.*…$/);
  });
});

describe('related ignores folder names', () => {
  it('neither picks nor scores terms that only come from folder names', async () => {
    const env2 = await setup({
      accounts: { probe: { root: 'Corpus', access: { '.': 'read' } } },
      prepare: (v) => {
        mkdirSync(path.join(v, 'Corpus/Quantum'), { recursive: true });
        writeFileSync(path.join(v, 'Corpus/Source.md'), 'quantum quantum quantum\n');
        writeFileSync(path.join(v, 'Corpus/Quantum/Cooking.md'), 'bread baking\n');
        writeFileSync(path.join(v, 'Corpus/Quantum/Physics.md'), 'quantum physics\n');
      },
    });
    try {
      const r = await env2.req('probe', { method: 'GET', url: '/v1/related?path=Source.md' });
      expect(r.json().results.map((h: { path: string; matched: string[] }) => [h.path, h.matched])).toEqual([['Quantum/Physics.md', ['quantum']]]);
      // Ordinary search still matches folder names.
      const s = await env2.req('probe', { method: 'GET', url: '/v1/search?q=quantum' });
      expect(s.json().results.map((h: { path: string }) => h.path).sort()).toEqual(['Quantum/Cooking.md', 'Quantum/Physics.md', 'Source.md']);
    } finally {
      await env2.cleanup();
    }
  });
});

describe('item 7: paging', () => {
  it('has no next_cursor when everything was returned, and totals count every entry', async () => {
    const all = await get('pm', `/v1/folders/${enc('1. Projects')}?depth=all&limit=8`);
    expect(all.body).toMatchObject({ total: { entries: 8, notes: 6, files: 0, folders: 2 }, next_cursor: null, has_more: false });
    const pm = await mcpClient(env, 'pm');
    const r = await callTool(pm, 'spall_list', { folder: '1. Projects', depth: 'all' });
    await pm.close();
    expect(r.data).not.toHaveProperty('next_cursor');
    expect(r.data.total).toMatchObject({ entries: 8 });
  });

  it('keeps a cursor valid when only limit changes, and names the parameter that did', async () => {
    const first = (await get('pm', `/v1/folders/${enc('1. Projects')}?depth=all&limit=2`)).body;
    const next = await get('pm', `/v1/folders/${enc('1. Projects')}?depth=all&limit=50&cursor=${first.next_cursor}`);
    expect(next.status).toBe(200);
    expect(next.body.results).toHaveLength(6);
    const bad = await get('pm', `/v1/folders/${enc('1. Projects')}?depth=1&sort=-modified&limit=2&cursor=${first.next_cursor}`);
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/^Invalid cursor: depth, sort changed/);
    expect(bad.body.error.details).toEqual({ changed: ['depth', 'sort'] });
    const s1 = (await get('pm', '/v1/search?q=hardware&limit=1')).body;
    expect((await get('pm', `/v1/search?q=hardware&match=any&cursor=${s1.next_cursor}`)).body.error.message).toContain('match changed');
  });

  it('rejects malformed cursors of any JSON shape with 400, never 500', async () => {
    const b64 = (v: string) => Buffer.from(v).toString('base64url');
    const shapes = ['null', '3', '"x"', '[1]', 'true', '{}', '{"o":-1,"k":"a"}', '{"o":0,"k":1}', '{"o":0,"k":"a","p":null}', '{"o":0,"k":"a","p":[1]}', '{"o":0,"k":"a","p":{"x":1}}'];
    for (const cur of [...shapes.map(b64), 'not-base64!', 'bnVsbA']) {
      for (const url of [`/v1/folders?cursor=${cur}`, `/v1/search?q=hardware&cursor=${cur}`]) {
        const r = await get('pm', url);
        expect([url, r.status, r.body.error?.code]).toEqual([url, 400, 'invalid_request']);
      }
      const q = await env.req('pm', { method: 'POST', url: '/v1/query', payload: { from: ['1. Projects'], cursor: cur } });
      expect([cur, q.statusCode]).toEqual([cur, 400]);
    }
  });

  it('prints totals and where the next page is in the CLI', async () => {
    const r = await spall('pm', ['ls', '1. Projects', '--all', '--limit', '3']);
    expect(r.out).toMatch(/\n\(3 shown of 8 entries: 6 notes, 0 files, 2 folders; more: --cursor \S+\)\n$/);
  });
});

describe('item 8: folder tree', () => {
  it('lists folders only, to a depth, with recursive note counts', async () => {
    const r = await get('admin', `/v1/tree/${enc('1. Projects')}?depth=1`);
    expect(r.body).toEqual({
      path: '1. Projects',
      depth: 1,
      notes: 6,
      total_folders: 2,
      folders: [{ path: '1. Projects/Archive', name: 'Archive', depth: 1, notes: 2, more_folders: 1 }],
      truncated: false,
    });
  });

  it('caps the entries with a truncation marker', async () => {
    const r = (await get('admin', '/v1/tree?depth=5&limit=2')).body;
    expect(r.folders).toHaveLength(2);
    expect(r).toMatchObject({ truncated: true, omitted: r.total_folders - 2 });
  });

  it('respects scoping: traverse-only parents marked, hidden folders and notes not counted', async () => {
    const r = (await get('pm', '/v1/tree?depth=3')).body;
    const byPath = Object.fromEntries(r.folders.map((f: { path: string }) => [f.path, f]));
    expect(Object.keys(byPath)).toEqual(['1. Projects', '1. Projects/Archive', '1. Projects/Archive/2025', 'Notes', 'Research', 'Research/inbox']);
    expect(byPath.Research).toMatchObject({ traverse_only: true, notes: 1 });
    expect(byPath.Notes).toMatchObject({ notes: 1 }); // Notes/Private is hidden, and its note not counted
    expect(JSON.stringify(r)).not.toContain('Private');
    expect(r.notes).toBe(8);
    expect((await get('eink', '/v1/tree')).body.folders).toEqual([{ path: 'Dashboards', name: 'Dashboards', depth: 1, notes: 1, traverse_only: true }]);
  });

  it('renders as indented text in spall_list view=tree and spall tree', async () => {
    const pm = await mcpClient(env, 'pm');
    const r = await callTool(pm, 'spall_list', { view: 'tree', max_depth: 2 });
    await pm.close();
    const expected = [
      '(root)  8 notes, 6 folders',
      '  1. Projects/  6 notes',
      '    Archive/  2 notes, 1 subfolder below',
      '  Notes/  1 note',
      '  Research/  traverse only, 1 note',
      '    inbox/  1 note',
      '',
    ].join('\n');
    expect(r.text).toBe(expected);
    expect((await spall('pm', ['tree', '--depth', '2'])).out).toBe(expected);
    expect((await spall('pm', ['tree', '1. Projects', '--limit', '1', '--depth', '1'])).out).toBe('1. Projects/  6 notes, 2 folders\n  Archive/  2 notes, 1 subfolder below\n');
  });
});
