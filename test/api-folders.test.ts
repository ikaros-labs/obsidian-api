import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enc, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.cleanup());

const get = async (account: Parameters<TestEnv['req']>[0], url: string) => {
  const res = await env.req(account, { method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
};
const paths = (body: { results: { path: string }[] }) => body.results.map((r) => r.path);

describe('GET /v1/folders', () => {
  it('lists one level with totals, hiding dotfiles', async () => {
    const { body } = await get('admin', '/v1/folders/');
    expect(paths(body)).toEqual(['Dashboards', 'Inbox.md', 'Notes', 'Reading List', 'Research', 'Templates']);
    expect(body.total).toEqual({ notes: 1, files: 0, folders: 5 });
    expect(body.results.find((r: { path: string }) => r.path === 'Inbox.md')).toMatchObject({
      kind: 'note',
      name: 'Inbox',
      rev: expect.stringMatching(/^sha256:/),
      created: expect.any(String),
      modified: expect.any(String),
      size: expect.any(Number),
    });
    expect((await get('admin', '/v1/folders')).body.path).toBe('');
  });

  it('lists recursively and filters by kind', async () => {
    const { body } = await get('bot', '/v1/folders/?depth=all&kind=note');
    expect(paths(body)).toEqual(['Archive/Old.md', 'Article One.md', 'Article Two.md']);
    expect(body.total).toEqual({ notes: 3 });
    expect(paths((await get('bot', '/v1/folders/?kind=file')).body)).toEqual(['cover.png']);
  });

  it('shows parent folders only as a way to granted paths', async () => {
    const root = await get('agent', '/v1/folders/');
    expect(paths(root.body)).toEqual(['Notes', 'Research']);
    expect(root.body.total).toEqual({ notes: 0, files: 0, folders: 2 });

    const env2 = await get('eink', '/v1/folders/');
    expect(env2.body.results).toEqual([expect.objectContaining({ path: 'Dashboards', traverse_only: true })]);
    expect(env2.body.total).toEqual({ notes: 0, files: 0, folders: 0 });
    const dash = await get('eink', '/v1/folders/Dashboards');
    expect(paths(dash.body)).toEqual(['Dashboards/eink.md']);
    expect(dash.body.total.notes).toBe(1);
  });

  it('hides folders overridden with none', async () => {
    const { body } = await get('agent', '/v1/folders/Notes?depth=all');
    expect(paths(body)).toEqual(['Notes/Ideas.md']);
    expect((await get('agent', '/v1/folders/Notes/Private')).status).toBe(404);
  });

  it('paginates with cursors bound to the query', async () => {
    const first = await get('admin', '/v1/folders/?depth=all&kind=note&limit=3');
    expect(first.body.results).toHaveLength(3);
    expect(first.body.has_more).toBe(true);
    const seen = [...paths(first.body)];
    let cursor = first.body.next_cursor;
    while (cursor) {
      const page = await get('admin', `/v1/folders/?depth=all&kind=note&limit=3&cursor=${cursor}`);
      seen.push(...paths(page.body));
      cursor = page.body.next_cursor;
    }
    expect(seen).toHaveLength(first.body.total.notes);
    expect(new Set(seen).size).toBe(seen.length);
    const wrong = await get('admin', `/v1/folders/?depth=all&limit=3&cursor=${first.body.next_cursor}`);
    expect(wrong.status).toBe(400);
  });

  it('sorts by modified time', async () => {
    await env.req('admin', { method: 'PATCH', url: '/v1/notes/Inbox', payload: { ops: [{ op: 'append', content: 'x' }] } });
    const { body } = await get('admin', '/v1/folders/?depth=all&kind=note&sort=-modified');
    expect(body.results[0].path).toBe('Inbox.md');
  });

  it('samples randomly, repeatably with a seed, with bodies', async () => {
    const a = await get('bot', '/v1/folders/?depth=all&kind=note&sample=2&seed=x&include=body,frontmatter');
    const b = await get('bot', '/v1/folders/?depth=all&kind=note&sample=2&seed=x&include=body,frontmatter');
    expect(a.body.results).toHaveLength(2);
    expect(paths(a.body)).toEqual(paths(b.body));
    expect(a.body.results[0]).toHaveProperty('body');
    expect(a.body.results[0]).toHaveProperty('frontmatter');
    expect(a.body.total).toEqual({ notes: 3 });
  });

  it('limits include=body to small pages', async () => {
    expect((await get('bot', '/v1/folders/?include=body&limit=50')).status).toBe(400);
    expect((await get('bot', '/v1/folders/?include=body&limit=20')).status).toBe(200);
  });

  it('returns 404 for files and missing folders', async () => {
    expect((await get('admin', `/v1/folders/${enc('Inbox.md')}`)).status).toBe(404);
    expect((await get('admin', '/v1/folders/Nope')).status).toBe(404);
  });
});

describe('GET /v1/count', () => {
  it('counts what the account can see', async () => {
    expect((await get('bot', '/v1/count/?depth=all')).body).toEqual({ path: '', depth: 'all', notes: 3, files: 1, folders: 1 });
    expect((await get('bot', '/v1/count?kind=note')).body).toEqual({ path: '', depth: '1', notes: 2 });
    expect((await get('agent', '/v1/count/?depth=all&kind=note')).body.notes).toBe(3); // Plan, Draft, Ideas
    expect((await get('admin', '/v1/count/?depth=all&kind=note')).body.notes).toBe(10);
    expect((await get('agent', '/v1/count/Notes/Private')).status).toBe(404);
  });
});

describe('folder writes', () => {
  it('creates folders', async () => {
    const res = await env.req('agent', { method: 'POST', url: '/v1/folders/Research/new/deep' });
    expect(res.statusCode).toBe(201);
    expect(existsSync(path.join(env.vault, 'Research/new/deep'))).toBe(true);
    expect((await env.req('agent', { method: 'POST', url: '/v1/folders/Research/new/deep' })).statusCode).toBe(409);
    expect((await env.req('agent', { method: 'POST', url: '/v1/folders/Notes/x' })).statusCode).toBe(403);
  });

  it('deletes empty folders, and full ones only with recursive=true', async () => {
    mkdirSync(path.join(env.vault, 'Research/inbox/empty'));
    await env.app.index.refresh('Research/inbox/empty');
    expect((await env.req('agent', { method: 'DELETE', url: '/v1/folders/Research/inbox/empty' })).statusCode).toBe(204);
    const full = await env.req('agent', { method: 'DELETE', url: '/v1/folders/Research/inbox' });
    expect(full.statusCode).toBe(409);
    expect(full.json().error.code).toBe('folder_not_empty');
    expect((await env.req('agent', { method: 'DELETE', url: '/v1/folders/Research/inbox?recursive=true' })).statusCode).toBe(204);
    expect(existsSync(path.join(env.vault, '.trash/Research/inbox/Draft.md'))).toBe(true);
  });

  it('refuses recursive deletes over things the account cannot delete or see', async () => {
    expect((await env.req('agent', { method: 'DELETE', url: '/v1/folders/Research?recursive=true' })).statusCode).toBe(403);
    writeFileSync(path.join(env.vault, 'Reading List/Archive/.hidden'), 'x');
    const res = await env.req('admin', { method: 'DELETE', url: `/v1/folders/${enc('Reading List/Archive')}?recursive=true` });
    expect(res.statusCode).toBe(409);
    expect(existsSync(path.join(env.vault, 'Reading List/Archive/Old.md'))).toBe(true);
  });

  it('never deletes the root', async () => {
    expect((await env.req('admin', { method: 'DELETE', url: '/v1/folders/?recursive=true' })).statusCode).toBe(400);
  });
});

describe('GET /v1/tags', () => {
  it('counts tags over visible notes', async () => {
    const agent = (await get('agent', '/v1/tags')).body.results;
    expect(agent).toEqual([
      { tag: 'research', count: 2 },
      { tag: 'idea', count: 1 },
    ]);
    const admin = (await get('admin', '/v1/tags')).body.results.map((t: { tag: string }) => t.tag);
    expect(admin).toContain('private');
    expect((await get('admin', `/v1/tags?folder=${encodeURIComponent('Reading List')}`)).body.results.map((t: { tag: string }) => t.tag).sort()).toEqual([
      'ai',
      'llm',
      'longread',
    ]);
  });
});
