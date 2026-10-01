import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enc, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.cleanup());

const note = (p: string) => `/v1/notes/${enc(p)}`;
const read = (p: string) => readFileSync(path.join(env.vault, p), 'utf8');

describe('auth', () => {
  it('requires a valid, unexpired token', async () => {
    const none = await env.req(null, { method: 'GET', url: '/v1/me' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect(none.json().error).toMatchObject({ code: 'unauthorized', request_id: expect.any(String) });
    const bad = await env.app.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
    const expired = await env.req('expired', { method: 'GET', url: '/v1/me' });
    expect(expired.json().error.message).toMatch(/expired/);
  });

  it('serves /healthz without auth', async () => {
    expect((await env.req(null, { method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('describes the account at /v1/me', async () => {
    const res = await env.req('agent', { method: 'GET', url: '/v1/me' });
    expect(res.json()).toMatchObject({
      account: 'agent',
      root: '',
      access: expect.arrayContaining([{ path: 'Notes/Private', permissions: [] }, { path: 'Research', permissions: ['read', 'create', 'update'] }]),
      token: { name: 'test', expires: null },
    });
  });

  it('rate-limits per account', async () => {
    for (let i = 0; i < 3; i++) expect((await env.req('limited', { method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
    const res = await env.req('limited', { method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect((await env.req('admin', { method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
  });

  it('returns the error envelope for unknown endpoints', async () => {
    const res = await env.req('admin', { method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

describe('GET note', () => {
  it('returns raw markdown by default, with ETag and 304', async () => {
    const res = await env.req('agent', { method: 'GET', url: note('Research/Plan.md') });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/markdown/);
    expect(res.body).toBe(read('Research/Plan.md'));
    const etag = res.headers.etag as string;
    expect(etag).toMatch(/^"sha256:[0-9a-f]{16}"$/);
    const again = await env.req('agent', { method: 'GET', url: note('Research/Plan'), headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
  });

  it('returns JSON with frontmatter, tags and scoped links', async () => {
    const res = await env.req('agent', { method: 'GET', url: note('Research/Plan'), headers: { accept: 'application/json' } });
    const body = res.json();
    expect(body).toMatchObject({
      path: 'Research/Plan.md',
      name: 'Plan',
      rev: expect.stringMatching(/^sha256:/),
      frontmatter: { project: 'vault-api', tags: ['research'] },
      tags: ['research'],
    });
    expect(body.body.startsWith('# Plan')).toBe(true);
    expect(body.links).toEqual([
      { target: 'Article One', path: null, resolved: false }, // outside the agent's scope
      { target: 'Ideas', path: 'Notes/Ideas.md', resolved: true },
      { target: 'Secret', path: null, resolved: false }, // Notes/Private is none
    ]);
    expect(body.backlinks).toBeUndefined();
  });

  it('lists backlinks only from readable notes', async () => {
    const agent = await env.req('agent', { method: 'GET', url: `${note('Research/Plan')}?include=backlinks`, headers: { accept: 'application/json' } });
    expect(agent.json().backlinks).toEqual(['Notes/Ideas.md']);
    const admin = await env.req('admin', { method: 'GET', url: `${note('Research/Plan')}?include=backlinks`, headers: { accept: 'application/json' } });
    expect(admin.json().backlinks).toEqual(['Notes/Ideas.md', 'Notes/Private/Secret.md']);
  });

  it('supports fields= and the outline format', async () => {
    const f = await env.req('agent', { method: 'GET', url: `${note('Research/Plan')}?fields=path,frontmatter.project`, headers: { accept: 'application/json' } });
    expect(f.json()).toEqual({ path: 'Research/Plan.md', frontmatter: { project: 'vault-api' } });
    const o = await env.req('agent', { method: 'GET', url: note('Research/Plan'), headers: { accept: 'application/vnd.vault.outline+json' } });
    expect(o.json()).toMatchObject({ path: 'Research/Plan.md', blocks: [{ id: 'task1' }, { id: 'para' }], frontmatter_keys: ['project', 'tags'] });
  });

  it('uses paths relative to the account root', async () => {
    const res = await env.req('bot', { method: 'GET', url: note('Article One'), headers: { accept: 'application/json' } });
    expect(res.json()).toMatchObject({ path: 'Article One.md', frontmatter: { status: 'to-read' } });
    expect((await env.req('bot', { method: 'GET', url: note('Inbox') })).statusCode).toBe(404);
  });

  it('returns 404 for out-of-scope and missing notes alike', async () => {
    const hidden = await env.req('agent', { method: 'GET', url: note('Notes/Private/Secret') });
    const missing = await env.req('agent', { method: 'GET', url: note('Notes/Nope') });
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(hidden.json().error.message).toBe(missing.json().error.message);
    expect((await env.req('eink', { method: 'GET', url: note('Dashboards/eink') })).statusCode).toBe(200);
    expect((await env.req('eink', { method: 'GET', url: note('Inbox') })).statusCode).toBe(404);
  });
});

describe('PUT note', () => {
  it('creates from markdown, then replaces with If-Match', async () => {
    const created = await env.req('agent', { method: 'PUT', url: note('Research/New'), headers: { 'content-type': 'text/markdown' }, payload: '# New\n' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ path: 'Research/New.md', name: 'New' });
    expect(created.json().body).toBeUndefined();
    expect(read('Research/New.md')).toBe('# New\n');

    const stale = await env.req('agent', {
      method: 'PUT',
      url: note('Research/New'),
      headers: { 'content-type': 'text/markdown', 'if-match': '"sha256:0000000000000000"' },
      payload: 'x',
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error).toMatchObject({ code: 'rev_mismatch', details: { current_rev: created.json().rev } });

    const ok = await env.req('agent', {
      method: 'PUT',
      url: note('Research/New'),
      headers: { 'content-type': 'text/markdown', 'if-match': created.headers.etag as string },
      payload: '# Changed\n',
    });
    expect(ok.statusCode).toBe(200);
    expect(read('Research/New.md')).toBe('# Changed\n');
  });

  it('accepts JSON {frontmatter, body}', async () => {
    const res = await env.req('agent', { method: 'PUT', url: note('Research/J'), payload: { frontmatter: { a: 1 }, body: 'hi\n' } });
    expect(res.statusCode).toBe(201);
    expect(read('Research/J.md')).toBe('---\na: 1\n---\nhi\n');
  });

  it('honours If-None-Match: *', async () => {
    const res = await env.req('agent', { method: 'PUT', url: note('Research/Plan'), headers: { 'content-type': 'text/markdown', 'if-none-match': '*' }, payload: 'x' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_exists');
  });

  it('keeps the birth time when overwriting', async () => {
    const before = statSync(path.join(env.vault, 'Research/Plan.md'));
    await env.req('agent', { method: 'PUT', url: note('Research/Plan'), headers: { 'content-type': 'text/markdown' }, payload: 'new' });
    const after = statSync(path.join(env.vault, 'Research/Plan.md'));
    expect(after.ino).toBe(before.ino);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
  });

  it('distinguishes 403 (visible, not writable) from 404', async () => {
    const ro = await env.req('agent', { method: 'PUT', url: note('Notes/Ideas'), headers: { 'content-type': 'text/markdown' }, payload: 'x' });
    expect(ro.statusCode).toBe(403);
    expect(ro.json().error.code).toBe('forbidden');
    const hidden = await env.req('agent', { method: 'PUT', url: note('Notes/Private/Secret'), headers: { 'content-type': 'text/markdown' }, payload: 'x' });
    expect(hidden.statusCode).toBe(404);
    expect(read('Notes/Private/Secret.md')).toContain('# Secret');
  });

  it('rejects unsupported content types', async () => {
    const res = await env.req('agent', { method: 'PUT', url: note('Research/X'), headers: { 'content-type': 'image/png' }, payload: 'x' });
    expect(res.statusCode).toBe(415);
  });

  it('writes an audit log line', async () => {
    await env.req('agent', { method: 'PUT', url: note('Research/A'), headers: { 'content-type': 'text/markdown' }, payload: 'x' });
    const lines = readFileSync(env.auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ account: 'agent', token: 'test', op: 'create', path: 'Research/A.md', new_rev: expect.any(String) });
  });
});

describe('POST /v1/notes', () => {
  it('names the file from the title and renames on conflict', async () => {
    const body = { title: 'How LLMs work: part 1/3', frontmatter: { url: 'https://x', status: 'to-read' }, body: 'text\n' };
    const first = await env.req('bot', { method: 'POST', url: '/v1/notes', payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ path: 'How LLMs work part 1-3.md', frontmatter: { status: 'to-read' } });
    expect(read('Reading List/How LLMs work part 1-3.md')).toBe('---\nurl: https://x\nstatus: to-read\n---\ntext\n');
    const second = await env.req('bot', { method: 'POST', url: '/v1/notes', payload: body });
    expect(second.json().path).toBe('How LLMs work part 1-3 1.md');
    const fail = await env.req('bot', { method: 'POST', url: '/v1/notes', payload: { ...body, on_conflict: 'fail' } });
    expect(fail.statusCode).toBe(409);
  });

  it('creates in a subfolder', async () => {
    const res = await env.req('bot', { method: 'POST', url: '/v1/notes', payload: { folder: 'Archive', title: 'X' } });
    expect(res.json().path).toBe('Archive/X.md');
    expect(existsSync(path.join(env.vault, 'Reading List/Archive/X.md'))).toBe(true);
  });

  it('lets an append-only account create without reading anything', async () => {
    const res = await env.req('dropbox', { method: 'POST', url: '/v1/notes', payload: { title: 'Dropped' } });
    expect(res.statusCode).toBe(201);
    expect(Object.keys(res.json()).sort()).toEqual(['path', 'rev']);
    expect((await env.req('dropbox', { method: 'GET', url: note('Dropped') })).statusCode).toBe(404);
    const put = await env.req('dropbox', { method: 'PUT', url: note('Dropped'), headers: { 'content-type': 'text/markdown' }, payload: 'x' });
    expect(put.statusCode).toBe(409); // name taken; it can't overwrite
    expect((await env.req('dropbox', { method: 'GET', url: '/v1/folders/' })).statusCode).toBe(404);
  });
});

describe('PATCH note', () => {
  it('applies ops atomically and returns the new rev', async () => {
    const res = await env.req('bot', {
      method: 'PATCH',
      url: note('Article One'),
      payload: { ops: [{ op: 'frontmatter.set', key: 'status', value: 'read' }, { op: 'append', content: 'Done.' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().frontmatter.status).toBe('read');
    expect(res.headers.etag).toBe(`"${res.json().rev}"`);
    expect(read('Reading List/Article One.md')).toMatch(/status: read[\s\S]*models\.\nDone\.\n$/);
  });

  it('changes nothing when any op fails', async () => {
    const before = read('Reading List/Article One.md');
    const res = await env.req('bot', {
      method: 'PATCH',
      url: note('Article One'),
      payload: { ops: [{ op: 'frontmatter.set', key: 'status', value: 'read' }, { op: 'replace_text', old: 'missing', new: '' }] },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'patch_target_not_found', details: { op_index: 1 } });
    expect(read('Reading List/Article One.md')).toBe(before);
  });

  it('checks if_match', async () => {
    const res = await env.req('bot', {
      method: 'PATCH',
      url: note('Article One'),
      payload: { if_match: 'sha256:0000000000000000', ops: [{ op: 'append', content: 'x' }] },
    });
    expect(res.statusCode).toBe(412);
  });

  it('validates the body', async () => {
    const res = await env.req('bot', { method: 'PATCH', url: note('Article One'), payload: { ops: [{ op: 'explode' }] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('requires update', async () => {
    const res = await env.req('agent', { method: 'PATCH', url: note('Notes/Ideas'), payload: { ops: [{ op: 'append', content: 'x' }] } });
    expect(res.statusCode).toBe(403);
  });

  it('returns the body with return=full', async () => {
    const res = await env.req('bot', { method: 'PATCH', url: `${note('Article One')}?return=full`, payload: { ops: [{ op: 'append', content: 'x' }] } });
    expect(res.json().body).toContain('x');
  });
});

describe('DELETE and move', () => {
  it('moves deleted notes to the trash', async () => {
    const res = await env.req('agent', { method: 'DELETE', url: note('Research/inbox/Draft') });
    expect(res.statusCode).toBe(204);
    expect(existsSync(path.join(env.vault, 'Research/inbox/Draft.md'))).toBe(false);
    expect(read('.trash/Research/inbox/Draft.md')).toBe('Draft text.\n');
  });

  it('requires delete, and purge for permanent deletes', async () => {
    expect((await env.req('agent', { method: 'DELETE', url: note('Research/Plan') })).statusCode).toBe(403);
    expect((await env.req('agent', { method: 'DELETE', url: `${note('Research/inbox/Draft')}?permanent=true` })).statusCode).toBe(403);
    expect((await env.req('admin', { method: 'DELETE', url: `${note('Inbox')}?permanent=true` })).statusCode).toBe(204);
    expect(existsSync(path.join(env.vault, 'Inbox.md'))).toBe(false);
    expect(existsSync(path.join(env.vault, '.trash/Inbox.md'))).toBe(false);
  });

  it('numbers trash entries that would collide', async () => {
    await env.req('admin', { method: 'DELETE', url: note('Inbox') });
    await env.req('admin', { method: 'PUT', url: note('Inbox'), headers: { 'content-type': 'text/markdown' }, payload: 'again' });
    await env.req('admin', { method: 'DELETE', url: note('Inbox') });
    expect(read('.trash/Inbox 1.md')).toBe('again');
  });

  it('moves a note, keeping its inode and refusing to overwrite', async () => {
    const ino = statSync(path.join(env.vault, 'Research/inbox/Draft.md')).ino;
    const res = await env.req('agent', { method: 'POST', url: `${note('Research/inbox/Draft')}/move`, payload: { destination: 'Research/inbox/Final' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('Research/inbox/Final.md');
    expect(statSync(path.join(env.vault, 'Research/inbox/Final.md')).ino).toBe(ino);

    await env.req('agent', { method: 'PUT', url: note('Research/inbox/Other'), headers: { 'content-type': 'text/markdown' }, payload: 'o' });
    const clash = await env.req('agent', { method: 'POST', url: `${note('Research/inbox/Other')}/move`, payload: { destination: 'Research/inbox/Final.md' } });
    expect(clash.statusCode).toBe(409);
    const renamed = await env.req('agent', {
      method: 'POST',
      url: `${note('Research/inbox/Other')}/move`,
      payload: { destination: 'Research/inbox/Final.md', on_conflict: 'rename' },
    });
    expect(renamed.json().path).toBe('Research/inbox/Final 1.md');
  });

  it('needs update+delete on the source and create on the destination', async () => {
    const noDelete = await env.req('agent', { method: 'POST', url: `${note('Research/Plan')}/move`, payload: { destination: 'Research/inbox/Plan' } });
    expect(noDelete.statusCode).toBe(403);
    const outside = await env.req('agent', { method: 'POST', url: `${note('Research/inbox/Draft')}/move`, payload: { destination: 'Inbox2' } });
    expect(outside.statusCode).toBe(404);
    const readOnly = await env.req('agent', { method: 'POST', url: `${note('Research/inbox/Draft')}/move`, payload: { destination: 'Notes/Draft' } });
    expect(readOnly.statusCode).toBe(403);
    expect(existsSync(path.join(env.vault, 'Research/inbox/Draft.md'))).toBe(true);
  });
});
