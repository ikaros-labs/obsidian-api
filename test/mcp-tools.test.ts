import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { fetchCaller, injectCaller } from '../src/mcp/caller.js';
import { ToolError } from '../src/mcp/errors.js';
import { runTool, TOOL_NAMES, visibleTools } from '../src/mcp/tools.js';
import { fence, truncateLines } from '../src/mcp/format.js';
import { ACCOUNTS, setup, type TestEnv } from './helpers.js';
import { callTool, injectFetch, mcpClient } from './mcp-helpers.js';

const EDGE = `---
count: 5
done: false
ratio: 1.5
tags:
  - a
  - b
---
# Edge

## A

### X

a-x line

## B

### X

b-x line

## \`code\` heading 🚀

emoji body

## Заметки

Привет, мир.

## Table

| a | b |
| - | - |
| 1 | 2 |

## Para

Some paragraph text.

## Last

last body
`;

let env: TestEnv;
let agent: Client;

const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(env.vault, rel)), { recursive: true });
  writeFileSync(path.join(env.vault, rel), text);
};

beforeAll(async () => {
  env = await setup({
    accounts: { ...ACCOUNTS, agent: { ...ACCOUNTS.agent, rate_limit: '10000/min' } },
    prepare: (vault) => writeFileSync(path.join(vault, 'Research/Edge.md'), EDGE),
  });
  agent = await mcpClient(env, 'agent');
});
afterAll(async () => {
  await agent.close();
  await env.cleanup();
});

const read = async (p: string) => (await callTool(agent, 'spall_read', { path: p })).data as { content: string; rev: string };
const edit = (p: string, ops: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  callTool(agent, 'spall_edit', { path: p, ops, ...extra });

describe('tool schemas', () => {
  it('match the snapshots (test/__toolsnaps__)', async () => {
    const admin = await mcpClient(env, 'admin');
    const { tools } = await admin.listTools();
    await admin.close();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) {
      await expect(`${JSON.stringify(t, null, 2)}\n`).toMatchFileSnapshot(`__toolsnaps__/${t.name}.json`);
      expect(t.description!.length).toBeLessThan(1024);
      expect(t.annotations?.openWorldHint).toBe(false);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/oneOf|anyOf/);
    }
  });

  it('fit the token budget: tools/list ≤ 16 KB for an account that sees every tool', async () => {
    const admin = await mcpClient(env, 'admin');
    const list = await admin.listTools();
    await admin.close();
    expect(list.tools).toHaveLength(9);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(16 * 1024);
  });

  it('only trash is destructive', async () => {
    const admin = await mcpClient(env, 'admin');
    const { tools } = await admin.listTools();
    await admin.close();
    expect(tools.filter((t) => t.annotations?.destructiveHint).map((t) => t.name)).toEqual(['spall_trash']);
  });
});

describe('visibleTools', () => {
  const names = (...args: Parameters<typeof visibleTools>) => visibleTools(...args).map((t) => t.name);
  const READ = [{ permissions: ['read'] }];
  const APPEND = [{ permissions: ['create'] }];
  const EDIT = [{ permissions: ['read', 'create', 'update'] }];
  const FULL = [{ permissions: ['read', 'create', 'update', 'delete'] }];

  it('follows the grants', () => {
    expect(names(READ)).toEqual(['spall_whoami', 'spall_search', 'spall_list', 'spall_read', 'spall_query_base']);
    expect(names(APPEND)).toEqual(['spall_whoami', 'spall_create']);
    expect(names(EDIT)).toEqual(['spall_whoami', 'spall_search', 'spall_list', 'spall_read', 'spall_query_base', 'spall_create', 'spall_edit']);
    expect(names(FULL)).toEqual([...TOOL_NAMES]);
    expect(names([{ permissions: [] }])).toEqual(['spall_whoami']);
  });

  it('needs every permission of a tool in one grant', () => {
    // update in one folder and delete in another: no move
    expect(names([{ permissions: ['read', 'update'] }, { permissions: ['read', 'delete'] }])).not.toContain('spall_move');
  });

  it('narrowing only removes tools', () => {
    expect(names(FULL, { read_only: true })).toEqual(names(READ));
    expect(names(FULL, { tools: ['spall_read', 'spall_edit'] })).toEqual(['spall_read', 'spall_edit']);
    expect(names(READ, { tools: ['spall_edit'] })).toEqual([]);
    expect(names(FULL, { read_only: true }, { tools: ['spall_read', 'spall_edit'] })).toEqual(['spall_read']);
  });
});

describe('visibility per account', () => {
  const listed = async (account: string) => {
    const c = await mcpClient(env, account);
    const { tools } = await c.listTools();
    await c.close();
    return tools.map((t) => t.name);
  };

  it('read-only sees 5 tools, append-only whoami + create, edit the edit tools', async () => {
    expect(await listed('eink')).toEqual(['spall_whoami', 'spall_search', 'spall_list', 'spall_read', 'spall_query_base']);
    expect(await listed('dropbox')).toEqual(['spall_whoami', 'spall_create']);
    expect(await listed('agent')).toEqual([...TOOL_NAMES]);
    expect(await listed('bot')).toEqual(['spall_whoami', 'spall_search', 'spall_list', 'spall_read', 'spall_query_base', 'spall_create', 'spall_edit']);
  });
});

describe('tools', () => {
  it('spall_whoami returns the grants', async () => {
    const r = await callTool(agent, 'spall_whoami');
    expect(r.data).toMatchObject({ account: 'agent', access: expect.arrayContaining([{ path: 'Notes/Private', permissions: [] }]) });
  });

  it('spall_search returns hits without bodies, and needs exactly one of query/related_to', async () => {
    const r = await callTool(agent, 'spall_search', { query: 'highlight' });
    expect(r.isError).toBe(false);
    expect((r.data.results as { path: string }[]).map((h) => h.path)).toContain('Research/Plan.md');
    expect(Object.keys((r.data.results as object[])[0]!).sort()).toEqual(['heading', 'modified', 'name', 'path', 'score', 'snippet']);
    expect((await callTool(agent, 'spall_search', {})).isError).toBe(true);
    expect((await callTool(agent, 'spall_search', { query: 'x', related_to: 'Research/Plan' })).isError).toBe(true);
  });

  it('spall_search pages with a cursor', async () => {
    const first = await callTool(agent, 'spall_search', { query: 'plan ideas', match: 'any', limit: 1 });
    expect(first.data.next_cursor).toBeTruthy();
    const second = await callTool(agent, 'spall_search', { query: 'plan ideas', match: 'any', limit: 1, cursor: first.data.next_cursor });
    expect((second.data.results as { path: string }[])[0]!.path).not.toBe((first.data.results as { path: string }[])[0]!.path);
  });

  it('spall_list lists entries and tags', async () => {
    const r = await callTool(agent, 'spall_list', { folder: 'Research' });
    expect((r.data.results as { path: string }[]).map((e) => e.path)).toEqual(expect.arrayContaining(['Research/Plan.md', 'Research/inbox']));
    const fm = await callTool(agent, 'spall_list', { folder: 'Research', frontmatter: true });
    expect((fm.data.results as { path: string; frontmatter?: unknown }[]).find((e) => e.path === 'Research/Plan.md')!.frontmatter).toMatchObject({ project: 'spall' });
    const tags = await callTool(agent, 'spall_list', { view: 'tags' });
    expect((tags.data.results as { tag: string }[]).map((t) => t.tag)).toContain('research');
  });

  it('spall_read views: markdown (fenced), outline, frontmatter, section', async () => {
    const md = await callTool(agent, 'spall_read', { path: 'Research/Plan' });
    expect(md.data.rev).toMatch(/^sha256:/);
    expect(md.text).toContain(`<untrusted-content source="spall" path="Research/Plan.md" rev="${md.data.rev}">\n---\nproject: spall`);
    expect(md.text.trimEnd().endsWith('</untrusted-content>')).toBe(true);

    const outline = await callTool(agent, 'spall_read', { path: 'Research/Plan.md', view: 'outline' });
    expect(outline.data).toMatchObject({ path: 'Research/Plan.md', rev: md.data.rev });
    expect(outline.data).not.toHaveProperty('body');
    expect(outline.data).not.toHaveProperty('content');

    const fm = await callTool(agent, 'spall_read', { path: 'Research/Plan', view: 'frontmatter' });
    expect(fm.data).toMatchObject({ rev: md.data.rev, frontmatter: { project: 'spall' }, tags: ['research'] });

    const section = await callTool(agent, 'spall_read', { path: 'Research/Plan', view: 'section', heading: 'Notes > Highlights' });
    expect(section.data.content).toBe('### Highlights\n\n- existing highlight\n\n');
    expect((await callTool(agent, 'spall_read', { path: 'Research/Plan', view: 'section' })).isError).toBe(true);
  });

  it('spall_read view=section reports ambiguity like spall_edit does', async () => {
    const r = await callTool(agent, 'spall_read', { path: 'Research/Edge', view: 'section', heading: 'X' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'patch_target_ambiguous', details: { candidates: [{ heading: ['Edge', 'A', 'X'], index: 0 }, { heading: ['Edge', 'B', 'X'], index: 1 }] } });
    const e = await edit('Research/Edge', [{ op: 'append', heading: 'X', content: 'x' }]);
    expect(e.data.error).toMatchObject({ code: 'patch_target_ambiguous', details: { candidates: (r.data.error as { details: { candidates: unknown } }).details.candidates } });
    const second = await callTool(agent, 'spall_read', { path: 'Research/Edge', view: 'section', heading: 'X', index: 1 });
    expect(second.data.content).toContain('b-x line');
  });

  it('spall_read truncates long notes at a line boundary', async () => {
    write('Research/Long.md', Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n'));
    const r = await callTool(agent, 'spall_read', { path: 'Research/Long', max_chars: 1000 });
    expect(r.data.truncated).toBe(true);
    expect((r.data.content as string).length).toBeLessThanOrEqual(1000);
    expect((r.data.content as string).endsWith('\n')).toBe(true);
    expect(r.text).toContain('use view=outline, then view=section');
  });

  it('spall_create creates by title or exact path, never overwrites', async () => {
    const a = await callTool(agent, 'spall_create', { folder: 'Research', title: 'New idea', body: 'hello', frontmatter: { n: 1 } });
    expect(a.data).toMatchObject({ path: 'Research/New idea.md', rev: expect.stringMatching(/^sha256:/) });
    const b = await callTool(agent, 'spall_create', { folder: 'Research', title: 'New idea' });
    expect(b.data.path).toBe('Research/New idea 1.md');
    const c = await callTool(agent, 'spall_create', { path: 'Research/Exact name', body: 'x' });
    expect(c.data.path).toBe('Research/Exact name.md');
    const d = await callTool(agent, 'spall_create', { path: 'Research/Exact name', body: 'y' });
    expect(d.data.error).toMatchObject({ code: 'already_exists' });
    expect((await read('Research/Exact name')).content).toBe('x');
  });

  it('spall_create works for an append-only account', async () => {
    const drop = await mcpClient(env, 'dropbox');
    const r = await callTool(drop, 'spall_create', { title: 'Dropped', body: 'hi' });
    await drop.close();
    expect(r.data).toMatchObject({ path: 'Dropped.md' });
  });

  it('spall_query_base runs an ad-hoc query', async () => {
    const r = await callTool(agent, 'spall_query_base', { from: ['Research'], select: ['file.name'], filters: 'file.hasTag("research")' });
    expect(r.isError).toBe(false);
    expect((r.data.results as { path: string }[]).map((x) => x.path)).toEqual(['Research/Plan.md']);
  });

  it('spall_move and spall_trash', async () => {
    write('Research/inbox/Movable.md', 'move me');
    const m = await callTool(agent, 'spall_move', { path: 'Research/inbox/Movable', destination: 'Research/inbox/Moved' });
    expect(m.data).toMatchObject({ from: 'Research/inbox/Movable.md', path: 'Research/inbox/Moved.md' });
    write('Research/inbox/Sub/keep.md', 'k');
    const into = await callTool(agent, 'spall_move', { path: 'Research/inbox/Moved', destination: 'Research/inbox/Sub/' });
    expect(into.data).toMatchObject({ path: 'Research/inbox/Sub/Moved.md' });
    const back = await callTool(agent, 'spall_move', { path: 'Research/inbox/Sub/Moved', destination: 'Research/inbox' });
    expect(back.data).toMatchObject({ path: 'Research/inbox/Moved.md' });
    const { rev } = await read('Research/inbox/Moved');
    const stale = await callTool(agent, 'spall_trash', { path: 'Research/inbox/Moved', expected_rev: 'sha256:0000000000000000' });
    expect(stale.data.error).toMatchObject({ code: 'rev_mismatch', details: { current_rev: rev } });
    const t = await callTool(agent, 'spall_trash', { path: 'Research/inbox/Moved', expected_rev: rev });
    expect(t.data).toEqual({ trashed: 'Research/inbox/Moved.md' });
    expect((await callTool(agent, 'spall_read', { path: 'Research/inbox/Moved' })).data.error).toMatchObject({ code: 'not_found' });
  });

  it('forbidden errors say what to do', async () => {
    const r = await edit('Notes/Ideas', [{ op: 'append', content: 'x' }]);
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'forbidden' });
    expect(r.text).toContain('spall_whoami');
  });
});

describe('scope parity: hidden and missing paths look the same', () => {
  const HIDDEN = 'Notes/Private/Secret';
  // a missing note inside the hidden folder, and one where the account has no grant at all
  const MISSING = ['Notes/Private/Nope', 'Elsewhere/Nope'];
  const cases: [string, (p: string) => Record<string, unknown>][] = [
    ['spall_read', (p) => ({ path: p })],
    ['spall_read', (p) => ({ path: p, view: 'outline' })],
    ['spall_read', (p) => ({ path: p, view: 'section', heading: 'Secret' })],
    ['spall_edit', (p) => ({ path: p, ops: [{ op: 'append', content: 'x' }] })],
    ['spall_trash', (p) => ({ path: p })],
    ['spall_move', (p) => ({ path: p, destination: 'Research/inbox/Stolen' })],
    ['spall_search', (p) => ({ related_to: p })],
    ['spall_search', (p) => ({ query: 'x', folder: p.replace(/\/[^/]+$/, '') })],
    ['spall_list', (p) => ({ folder: p.replace(/\/[^/]+$/, '') })],
    ['spall_list', (p) => ({ view: 'tags', folder: p.replace(/\/[^/]+$/, '') })],
    ['spall_query_base', (p) => ({ base: p })],
    ['spall_create', (p) => ({ path: `${p} copy`, body: 'x' })],
    ['spall_create', (p) => ({ folder: p.replace(/\/[^/]+$/, ''), title: 'x' })],
  ];

  for (const [name, args] of cases) {
    it(`${name} ${JSON.stringify(args('Folder/Note'))}`, async () => {
      const hidden = await callTool(agent, name, args(HIDDEN));
      expect(hidden.isError).toBe(true);
      expect(hidden.data.error).toMatchObject({ code: 'not_found' });
      for (const m of MISSING) {
        const missing = await callTool(agent, name, args(m));
        expect(missing.text).toBe(hidden.text);
        expect(missing.data).toEqual(hidden.data);
      }
    });
  }

  it('search, list, tags and related never surface hidden notes', async () => {
    const all = JSON.stringify([
      await callTool(agent, 'spall_search', { query: 'secret' }),
      await callTool(agent, 'spall_search', { query: 'mentions plan ideas private', match: 'any', limit: 50 }),
      await callTool(agent, 'spall_search', { related_to: 'Research/Plan', limit: 50 }),
      await callTool(agent, 'spall_search', { related_to: 'Notes/Ideas', limit: 50 }),
      await callTool(agent, 'spall_list', { folder: '', depth: 'all', limit: 200 }),
      await callTool(agent, 'spall_list', { folder: 'Notes', depth: 'all' }),
      await callTool(agent, 'spall_list', { view: 'tags' }),
      await callTool(agent, 'spall_query_base', { from: [''], limit: 100 }),
    ]);
    // Plan.md itself links [[Secret]]; what must not show up is the hidden note, its text or its tag.
    expect(all).not.toMatch(/Notes\/Private|Mentions \[\[Plan|\\"private\\"|"private"/);
    expect(all).toContain('Research/Plan.md');
  });
});

describe('edit regression suite (through MCP)', () => {
  const fresh = (name: string, text = EDGE) => {
    write(`Research/${name}.md`, text);
    return `Research/${name}`;
  };

  it('duplicate headings: ambiguous → retry with index; a parent path disambiguates', async () => {
    const p = fresh('Dup');
    const amb = await edit(p, [{ op: 'append', heading: 'X', content: 'new' }]);
    expect(amb.data.error).toMatchObject({ code: 'patch_target_ambiguous' });
    expect(amb.text).toContain('index');
    expect((await edit(p, [{ op: 'append', heading: 'X', index: 1, content: 'via index' }])).isError).toBe(false);
    expect((await edit(p, [{ op: 'append', heading: 'A > X', content: 'via path' }])).isError).toBe(false);
    const text = (await read(p)).content;
    expect(text).toContain('### X\n\na-x line\nvia path\n\n## B');
    expect(text).toContain('### X\n\nb-x line\nvia index\n\n## `code`');
  });

  it('headings with backticks and emoji; Cyrillic content', async () => {
    const p = fresh('Unicode');
    expect((await edit(p, [{ op: 'append', heading: '`code` heading 🚀', content: 'more emoji 🎉' }])).isError).toBe(false);
    expect((await edit(p, [{ op: 'append', heading: 'Заметки', content: 'Ещё строка.' }])).isError).toBe(false);
    const text = (await read(p)).content;
    expect(text).toContain('emoji body\nmore emoji 🎉\n\n## Заметки\n\nПривет, мир.\nЕщё строка.\n\n## Table');
    const section = await callTool(agent, 'spall_read', { path: p, view: 'section', heading: 'Заметки' });
    expect(section.data.content).toBe('## Заметки\n\nПривет, мир.\nЕщё строка.\n\n');
  });

  it('appending a paragraph after a table does not turn it into a table row', async () => {
    const p = fresh('Table');
    expect((await edit(p, [{ op: 'append', heading: 'Table', content: 'After the table.' }])).isError).toBe(false);
    expect((await read(p)).content).toContain('| 1 | 2 |\n\nAfter the table.\n\n## Para');
    // rows can still be added to the table explicitly
    expect((await edit(p, [{ op: 'append', heading: 'Table', content: '| 3 | 4 |' }])).isError).toBe(false);
  });

  it('keeps blank lines around headings', async () => {
    const p = fresh('Blank');
    await edit(p, [{ op: 'replace', heading: 'Para', content: 'Replaced.' }]);
    await edit(p, [{ op: 'prepend', heading: 'Last', content: 'first' }]);
    const text = (await read(p)).content;
    expect(text).toContain('## Para\nReplaced.\n\n## Last\nfirst\n\nlast body\n');
  });

  it('an appended --- does not turn the previous line into a setext heading', async () => {
    const p = fresh('Setext');
    await edit(p, [{ op: 'append', heading: 'Para', content: '---\nbelow the rule' }]);
    const text = (await read(p)).content;
    expect(text).toContain('Some paragraph text.\n\n---\nbelow the rule\n\n## Last');
    const outline = await callTool(agent, 'spall_read', { path: p, view: 'outline' });
    expect(JSON.stringify(outline.data)).not.toContain('Some paragraph text.');
    await edit(p, [{ op: 'append', content: '===' }]);
    expect((await read(p)).content).toMatch(/last body\n\n===\n$/);
  });

  it('frontmatter keeps value types', async () => {
    const p = fresh('Types');
    const r = await edit(p, [
      { op: 'frontmatter.set', key: 'n', value: 42 },
      { op: 'frontmatter.set', key: 'flag', value: true },
      { op: 'frontmatter.set', key: 'list', value: ['x', 2, false] },
      { op: 'frontmatter.set', key: 'num_string', value: '007' },
      { op: 'frontmatter.merge', value: { tags: ['c'] } },
      { op: 'frontmatter.unset', key: 'ratio' },
    ]);
    expect(r.isError).toBe(false);
    const fm = await callTool(agent, 'spall_read', { path: p, view: 'frontmatter' });
    expect(fm.data.frontmatter).toEqual({ count: 5, done: false, tags: ['a', 'b', 'c'], n: 42, flag: true, list: ['x', 2, false], num_string: '007' });
  });

  it('a stale expected_rev gives rev_mismatch with current_rev and the current section', async () => {
    const p = fresh('Stale');
    const { rev } = await read(p);
    await edit(p, [{ op: 'append', heading: 'Last', content: 'someone else' }], { expected_rev: rev });
    const current = await read(p);
    const r = await edit(p, [{ op: 'append', heading: 'Last', content: 'mine' }], { expected_rev: rev });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'rev_mismatch', details: { current_rev: current.rev } });
    expect((r.data.error as { details: { current_section: string } }).details.current_section).toContain('last body\nsomeone else');
    expect((await read(p)).content).not.toContain('mine');
  });

  it('a matching expected_rev applies the edit and returns the new rev and a diff summary', async () => {
    const p = fresh('Rev');
    const { rev } = await read(p);
    const r = await edit(p, [{ op: 'replace_text', old: 'last body', new: 'final body' }], { expected_rev: rev });
    expect(r.data).toMatchObject({ previous_rev: rev, changed: true, summary: 'changed lines: +1 −1' });
    expect(r.data.rev).toBe((await read(p)).rev);
  });

  it('is atomic: when op 2 fails, op 1 is not applied', async () => {
    const p = fresh('Atomic');
    const before = await read(p);
    const r = await edit(p, [
      { op: 'append', heading: 'Last', content: 'op one' },
      { op: 'append', heading: 'No such heading', content: 'op two' },
    ]);
    expect(r.data.error).toMatchObject({ code: 'patch_target_not_found', details: { op_index: 1 } });
    expect(await read(p)).toEqual(before);
  });

  it('replace_all replaces the whole file, only with a matching rev, and must be alone', async () => {
    const p = fresh('Whole');
    const { rev } = await read(p);
    expect((await edit(p, [{ op: 'replace_all', content: 'x' }, { op: 'append', content: 'y' }])).data.error).toMatchObject({ code: 'invalid_request' });
    expect((await edit(p, [{ op: 'replace_all', content: 'new' }], { expected_rev: 'sha256:0000000000000000' })).data.error).toMatchObject({ code: 'rev_mismatch' });
    const r = await edit(p, [{ op: 'replace_all', content: '# New\n' }], { expected_rev: rev });
    expect(r.isError).toBe(false);
    expect((await read(p)).content).toBe('# New\n');
  });

  it('reports a missing op field as a tool error', async () => {
    const r = await edit(fresh('Missing'), [{ op: 'append' }]);
    expect(r.data.error).toMatchObject({ code: 'invalid_request' });
    expect(r.text).toContain('needs content');
  });
});

describe('dot segments never reach another resource', () => {
  // Review repro: "../files/…" normalised /v1/notes/../files/x to /v1/files/x, so spall_trash
  // deleted an attachment and reported a note.
  const PDF = 'Research/inbox/attachment.pdf';

  it('spall_trash ../files/… is a tool error over MCP (inject caller), and the file stays', async () => {
    write(PDF, '%PDF-1.4');
    const r = await callTool(agent, 'spall_trash', { path: `../files/${PDF}` });
    expect(r.isError).toBe(true);
    expect(r.data.error).toMatchObject({ code: 'invalid_path' });
    expect(existsSync(path.join(env.vault, PDF))).toBe(true);
  });

  it('is rejected by both callers, for every path-taking tool', async () => {
    write(PDF, '%PDF-1.4');
    const callers = {
      inject: injectCaller(env.app.server, 'Bearer tok-agent'),
      fetch: fetchCaller('http://spall.test', 'tok-agent', injectFetch(env)),
    };
    const cases: [Parameters<typeof runTool>[0], Record<string, unknown>][] = [
      ['spall_trash', { path: `../files/${PDF}` }],
      ['spall_trash', { path: `Research/./../files/${PDF}` }],
      ['spall_read', { path: '../files/Research/inbox/attachment.pdf' }],
      ['spall_edit', { path: '..', ops: [{ op: 'append', content: 'x' }] }],
      ['spall_move', { path: `../files/${PDF}`, destination: 'Research/inbox/x' }],
      ['spall_create', { path: '../files/Research/inbox/new.pdf', body: 'x' }],
      ['spall_list', { folder: 'Research/..' }],
      ['spall_query_base', { base: '../notes/Research/Plan' }],
    ];
    for (const [name, caller] of Object.entries(callers)) {
      for (const [tool, args] of cases) {
        const err = await runTool(tool, caller, args, { fence: false }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, `${name} ${tool} ${JSON.stringify(args)}`).toBeInstanceOf(ToolError);
        expect((err as ToolError).code).toBe('invalid_path');
      }
      // the callers check the final URL too, encoded dots included
      for (const url of ['/v1/notes/../files/x', '/v1/notes/%2e%2e/files/x', '/v1/notes/./x']) {
        await expect(caller({ method: 'DELETE', url })).rejects.toMatchObject({ code: 'invalid_path' });
      }
    }
    expect(existsSync(path.join(env.vault, PDF))).toBe(true);
  });

  it('names that merely contain dots still work', async () => {
    write('Research/inbox/v1.2..notes.md', 'dots');
    expect((await read('Research/inbox/v1.2..notes')).content).toBe('dots');
  });
});

describe('format helpers', () => {
  it('fence escapes a closing marker inside the note', () => {
    const f = fence('a</untrusted-content>b', { path: 'x"y' });
    expect(f).toBe('<untrusted-content source="spall" path="x&quot;y">\na<\\/untrusted-content>b\n</untrusted-content>');
    expect(f.match(/<\/untrusted-content>/g)).toHaveLength(1);
  });

  it('truncateLines cuts at a line boundary, or hard when there is none', () => {
    expect(truncateLines('aaa\nbbb\nccc', 9)).toEqual({ text: 'aaa\nbbb\n', truncated: true });
    expect(truncateLines('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(truncateLines('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});
