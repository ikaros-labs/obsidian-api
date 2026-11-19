import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientMain } from '../src/cli/client.js';
import { ACCOUNTS, enc, setup, unfenced, type TestEnv } from './helpers.js';
import { callTool, injectFetch, mcpClient } from './mcp-helpers.js';

const BASE = `filters:
  and:
    - file.inFolder("Research")
views:
  - type: table
    name: To read
    filters:
      and:
        - status == "to-read"
    order:
      - file.name
      - status
  - type: table
    name: All
    sort:
      - property: file.name
        direction: DESC
`;

const BOOKS_VIEW = `  - type: table
    name: Books
    filters:
      and:
        - Type == "Book"
    order:
      - file.name
      - Score
`;

let env: TestEnv;
let agent: Client;
const file = (rel: string) => readFileSync(path.join(env.vault, rel), 'utf8');

beforeAll(async () => {
  env = await setup({
    accounts: unfenced({ ...ACCOUNTS, agent: { ...ACCOUNTS.agent, rate_limit: '10000/min' } }),
    prepare: (vault) => {
      writeFileSync(path.join(vault, 'Research/Reading.base'), BASE);
      writeFileSync(path.join(vault, 'Research/cover.png'), 'png');
      mkdirSync(path.join(vault, 'Notes/Private'), { recursive: true });
      writeFileSync(path.join(vault, 'Notes/Private/Hidden.base'), BASE);
      writeFileSync(path.join(vault, 'Notes/.hidden.base'), BASE);
      mkdirSync(path.join(vault, 'Research/Topic'));
      writeFileSync(path.join(vault, 'Research/Topic/Topic.md'), 'folder note\n');
      writeFileSync(path.join(vault, 'Research/Linker.md'), 'See [[Topic]].\n');
    },
  });
  agent = await mcpClient(env, 'agent');
});
afterAll(async () => {
  await agent.close();
  await env.cleanup();
});

async function spall(argv: string[], stdin = '') {
  let out = '';
  let err = '';
  const code = await clientMain(argv, {
    env: { SPALL_URL: 'http://spall.test', SPALL_TOKEN: 'tok-agent' },
    out: (s) => (out += s),
    err: (s) => (err += s),
    stdin: async () => stdin,
    fetch: injectFetch(env),
  });
  return { code, out, err };
}

describe('REST: .base files', () => {
  it('the definition names the default view', async () => {
    const res = await env.req('agent', { method: 'GET', url: '/v1/bases/Research/Reading.base' });
    expect(res.json()).toMatchObject({ default_view: 'To read', views: [{ name: 'To read', order: ['file.name', 'status'] }, { name: 'All' }] });
  });

  it('PUT /v1/files validates a .base: YAML, structure and expressions', async () => {
    const put = (payload: string) =>
      env.req('agent', { method: 'PUT', url: '/v1/files/Research/Reading.base', headers: { 'content-type': 'text/yaml' }, payload });
    expect((await put('views: [unclosed')).json().error.code).toBe('invalid_base');
    expect((await put('views:\n  - type: table\n')).json().error.code).toBe('invalid_base');
    const badExpr = await put('views:\n  - name: X\n    filters: "status == ("\n');
    expect(badExpr.statusCode).toBe(422);
    expect(badExpr.json().error.details.diagnostics[0].where).toBe('views[0].filters');
    expect(file('Research/Reading.base')).toBe(BASE);
  });

  it('a visible non-note file asked for as a note is not_a_note; hidden ones stay 404', async () => {
    const r = await env.req('agent', { method: 'GET', url: `/v1/notes/${enc('Research/Reading.base')}` });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'not_a_note', details: { kind: 'base', path: 'Research/Reading.base' } });
    const png = await env.req('agent', { method: 'PATCH', url: '/v1/notes/Research/cover.png', payload: { ops: [{ op: 'append', content: 'x' }] } });
    expect(png.json().error).toMatchObject({ code: 'not_a_note', details: { kind: 'file' } });
    for (const p of ['Notes/Private/Hidden.base', 'Notes/.hidden.base', 'Research/Missing.base']) {
      expect((await env.req('agent', { method: 'GET', url: `/v1/notes/${enc(p)}` })).json().error.code).toBe('not_found');
    }
  });
});

describe('MCP: .base files', () => {
  it('spall_read returns the raw YAML, and view=outline the views', async () => {
    const raw = await callTool(agent, 'spall_read', { path: 'Research/Reading.base' });
    expect(raw.data).toMatchObject({ path: 'Research/Reading.base', content: BASE });
    const views = await callTool(agent, 'spall_read', { path: 'Research/Reading.base', view: 'outline' });
    expect(views.data).toMatchObject({
      default_view: 'To read',
      views: [{ name: 'To read', filters: { and: ['status == "to-read"'] } }, { name: 'All', sort: [{ property: 'file.name', direction: 'DESC' }] }],
    });
    const section = await callTool(agent, 'spall_read', { path: 'Research/Reading.base', view: 'section', heading: 'x' });
    expect(section.isError).toBe(true);
  });

  it('spall_edit adds a view (B04) with replace_text; an invalid result writes nothing', async () => {
    const { data } = await callTool(agent, 'spall_read', { path: 'Research/Reading.base' });
    const ok = await callTool(agent, 'spall_edit', {
      path: 'Research/Reading.base',
      expected_rev: data.rev,
      ops: [{ op: 'replace_text', old: '        direction: DESC\n', new: `        direction: DESC\n${BOOKS_VIEW}` }],
    });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ path: 'Research/Reading.base', changed: true });
    expect(file('Research/Reading.base')).toBe(BASE + BOOKS_VIEW);
    const views = await callTool(agent, 'spall_read', { path: 'Research/Reading.base', view: 'outline' });
    expect((views.data.views as { name: string }[]).map((v) => v.name)).toEqual(['To read', 'All', 'Books']);

    const bad = await callTool(agent, 'spall_edit', { path: 'Research/Reading.base', ops: [{ op: 'replace_text', old: 'name: Books', new: 'name: [' }] });
    expect(bad.data.error).toMatchObject({ code: 'invalid_base' });
    const stale = await callTool(agent, 'spall_edit', { path: 'Research/Reading.base', expected_rev: data.rev, ops: [{ op: 'replace_all', content: BASE }] });
    expect(stale.data.error).toMatchObject({ code: 'rev_mismatch' });
    const fm = await callTool(agent, 'spall_edit', { path: 'Research/Reading.base', ops: [{ op: 'frontmatter.set', key: 'a', value: 1 }] });
    expect(fm.data.error).toMatchObject({ code: 'invalid_request' });
    expect(file('Research/Reading.base')).toBe(BASE + BOOKS_VIEW);
  });

  it('edits need update on the .base, like notes', async () => {
    const reader = await mcpClient(env, 'limited');
    const r = await callTool(reader, 'spall_read', { path: 'Research/Reading.base' });
    expect(r.isError).toBe(false);
    await reader.close();
    const res = await env.req('agent', { method: 'PUT', url: '/v1/files/Notes/New.base', headers: { 'content-type': 'text/yaml' }, payload: BASE });
    expect(res.statusCode).toBe(403);
  });

  it('spall_move and spall_trash handle .base files', async () => {
    writeFileSync(path.join(env.vault, 'Research/inbox/Tmp.base'), BASE);
    const m = await callTool(agent, 'spall_move', { path: 'Research/inbox/Tmp.base', destination: 'Research/inbox/Sub/' });
    expect(m.data).toMatchObject({ from: 'Research/inbox/Tmp.base', path: 'Research/inbox/Sub/Tmp.base' });
    expect((await callTool(agent, 'spall_trash', { path: 'Research/inbox/Sub/Tmp.base' })).data).toEqual({ trashed: 'Research/inbox/Sub/Tmp.base' });
  });

  it('spall_read view=backlinks lists the notes linking to a note, scoped', async () => {
    const r = await callTool(agent, 'spall_read', { path: 'Research/Plan', view: 'backlinks' });
    expect(r.data).toMatchObject({ path: 'Research/Plan.md', backlinks: ['Notes/Ideas.md'] });
    expect(JSON.stringify(r.data)).not.toContain('Private');
    // R05: [[Topic]] resolves to the folder note Topic/Topic.md, not to the folder Topic
    const folderNote = await callTool(agent, 'spall_read', { path: 'Research/Topic/Topic', view: 'backlinks' });
    expect(folderNote.data).toMatchObject({ backlinks: ['Research/Linker.md'] });
  });
});

describe('CLI: .base files and backlinks', () => {
  it('read prints the YAML; read --outline and base --views print the views', async () => {
    expect((await spall(['read', 'Research/Reading.base'])).out).toBe(file('Research/Reading.base'));
    const views = await spall(['base', 'Research/Reading', '--views']);
    expect(views.out).toContain('default view: To read\nTo read  (table)\n  filters: {"and":["status == \\"to-read\\""]}\n  sort: (none)\n  columns: file.name, status\n');
    expect(views.out).toContain('All  (table)\n  filters: (none)\n  sort: file.name DESC\n');
    expect((await spall(['read', 'Research/Reading.base', '--outline'])).out).toBe(views.out);
  });

  it('edit --replace-all - writes a whole .base from stdin, validated', async () => {
    const bad = await spall(['edit', 'Research/Reading.base', '--replace-all', '--content', '-'], 'views: [');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('invalid_base');
    expect(bad.err).toContain('spall read --outline');
    const ok = await spall(['edit', 'Research/Reading.base', '--replace-all', '--content', '-'], BASE);
    expect(ok).toMatchObject({ code: 0, err: '' });
    expect(file('Research/Reading.base')).toBe(BASE);
  });

  it('a non-note file through a note command names the right command', async () => {
    const r = await spall(['edit', 'Research/cover.png', '--set', 'a=1']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('not_a_note: Research/cover.png is a file, not a note');
    expect(r.err).toContain('spall read, spall edit, spall mv and spall trash take notes and .base files only');
  });

  it('read --backlinks prints one path per line', async () => {
    expect((await spall(['read', 'Research/Plan', '--backlinks'])).out).toBe('Notes/Ideas.md\n');
    expect((await spall(['read', 'Notes/Ideas', '--backlinks'])).out).toBe('Research/Plan.md\n');
    expect((await spall(['read', 'Research/inbox/Draft', '--backlinks'])).out).toBe('(no notes you can read link to Research/inbox/Draft.md)\n');
  });
});

describe('not_a_note does not reveal hidden siblings', () => {
  it('gives the same answer whether a hidden X.png.md exists or not, also behind a symlink', async () => {
    const outcomes: string[] = [];
    for (const sibling of ['none', 'hidden-file', 'symlink-to-hidden', 'dangling-symlink']) {
      const e = await setup({
        vault: { follow_symlinks: true },
        accounts: { probe: { access: { Research: 'read', 'Research/cover.png.md': 'none', 'Notes/Private': 'none' } } },
        prepare: (vault) => {
          writeFileSync(path.join(vault, 'Research/cover.png'), 'image');
          mkdirSync(path.join(vault, 'Notes/Private'), { recursive: true });
          writeFileSync(path.join(vault, 'Notes/Private/x.md'), 'secret');
          const link = path.join(vault, 'Research/cover.png.md');
          if (sibling === 'hidden-file') writeFileSync(link, 'hidden');
          if (sibling === 'symlink-to-hidden') symlinkSync(path.join(vault, 'Notes/Private/x.md'), link);
          if (sibling === 'dangling-symlink') symlinkSync(path.join(vault, 'nowhere.md'), link);
        },
      });
      try {
        const r = await e.req('probe', { method: 'GET', url: '/v1/notes/Research/cover.png' });
        const { request_id: _, ...err } = r.json().error;
        outcomes.push(JSON.stringify([r.statusCode, err]));
      } finally {
        await e.cleanup();
      }
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toContain('not_a_note');
  });

  it('a readable X.png.md note is served as the note', async () => {
    writeFileSync(path.join(env.vault, 'Research/pic.png'), 'image');
    writeFileSync(path.join(env.vault, 'Research/pic.png.md'), 'about the picture\n');
    const r = await env.req('agent', { method: 'GET', url: '/v1/notes/Research/pic.png', headers: { accept: 'text/markdown' } });
    expect([r.statusCode, r.body]).toEqual([200, 'about the picture\n']);
  });
});
