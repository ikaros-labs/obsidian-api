import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enc, eventually, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
afterEach(() => env.cleanup());

describe('files', () => {
  it('serves raw bytes with type, ETag and ranges', async () => {
    env = await setup();
    const url = `/v1/files/${enc('Reading List/cover.png')}`;
    const res = await env.req('admin', { method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(readFileSync(path.join(env.vault, 'Reading List/cover.png')))).toBe(true);
    const part = await env.req('admin', { method: 'GET', url, headers: { range: 'bytes=0-3' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-3/${res.rawPayload.length}`);
    expect(part.rawPayload.toString('latin1')).toBe('\x89PNG');
    expect((await env.req('admin', { method: 'GET', url, headers: { range: 'bytes=999-' } })).statusCode).toBe(416);
    expect((await env.req('admin', { method: 'GET', url, headers: { 'if-none-match': res.headers.etag as string } })).statusCode).toBe(304);
  });

  it('uploads raw bytes whatever the content type', async () => {
    env = await setup();
    const data = Buffer.from([0, 1, 2, 255]);
    const res = await env.req('bot', { method: 'PUT', url: '/v1/files/img.bin', headers: { 'content-type': 'application/json' }, payload: data });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ path: 'img.bin', size: 4 });
    expect(readFileSync(path.join(env.vault, 'Reading List/img.bin')).equals(data)).toBe(true);
  });

  it('moves and deletes files', async () => {
    env = await setup();
    const moved = await env.req('admin', {
      method: 'POST',
      url: `/v1/files/${enc('Reading List/cover.png')}/move`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ destination: 'Attachments/cover.png' }),
    });
    expect(moved.statusCode).toBe(200);
    expect(existsSync(path.join(env.vault, 'Attachments/cover.png'))).toBe(true);
    expect((await env.req('admin', { method: 'DELETE', url: '/v1/files/Attachments/cover.png' })).statusCode).toBe(204);
    expect(existsSync(path.join(env.vault, '.trash/Attachments/cover.png'))).toBe(true);
  });

  it('serves notes as plain bytes too, but never dotfiles', async () => {
    env = await setup();
    expect((await env.req('admin', { method: 'GET', url: '/v1/files/Inbox.md' })).body).toContain('# Inbox');
    for (const url of ['/v1/files/.obsidian/app.json', '/v1/files/.git/config', '/v1/files/.Git/config', '/v1/files/%2Egit/config']) {
      expect((await env.req('admin', { method: 'GET', url })).statusCode).toBe(404);
    }
    expect((await env.req('admin', { method: 'PUT', url: '/v1/files/.obsidian/evil.json', payload: 'x' })).statusCode).toBe(404);
  });
});

describe('path safety', () => {
  it('rejects traversal and encoded slashes', async () => {
    env = await setup();
    for (const url of ['/v1/notes/../secret', '/v1/notes/Notes%2F..%2F..%2Fetc', '/v1/files/Research%2FPlan.md', '/v1/notes/a//b', '/v1/notes/%2e%2e/x']) {
      const res = await env.req('admin', { method: 'GET', url });
      expect([400, 404]).toContain(res.statusCode);
      if (res.statusCode === 400) expect(res.json().error.code).toBe('invalid_path');
    }
  });

  it('ignores symlinks by default', async () => {
    env = await setup({
      prepare: (vault) => {
        symlinkSync('/etc', path.join(vault, 'etc-link'));
        symlinkSync(path.join(vault, 'Notes/Private'), path.join(vault, 'Research/private-link'));
      },
    });
    expect((await env.req('admin', { method: 'GET', url: '/v1/files/etc-link/hostname' })).statusCode).toBe(404);
    expect((await env.req('agent', { method: 'GET', url: '/v1/notes/Research/private-link/Secret' })).statusCode).toBe(404);
    const list = await env.req('admin', { method: 'GET', url: '/v1/folders/' });
    expect(list.json().results.map((r: { path: string }) => r.path)).not.toContain('etc-link');
  });

  it('with follow_symlinks, checks access on the target', async () => {
    env = await setup({
      vault: { follow_symlinks: true },
      prepare: (vault) => {
        symlinkSync('/etc', path.join(vault, 'etc-link'));
        symlinkSync(path.join(vault, 'Notes/Private'), path.join(vault, 'Research/private-link'));
        symlinkSync(path.join(vault, 'Notes/Ideas.md'), path.join(vault, 'Research/ideas-link.md'));
      },
    });
    expect((await env.req('admin', { method: 'GET', url: '/v1/files/etc-link/hostname' })).statusCode).toBe(404);
    expect((await env.req('agent', { method: 'GET', url: '/v1/notes/Research/private-link/Secret' })).statusCode).toBe(404);
    // Readable through the link (agent can read Notes/Ideas.md), but not writable: the target is read-only.
    expect((await env.req('agent', { method: 'GET', url: '/v1/notes/Research/ideas-link' })).statusCode).toBe(200);
    const put = await env.req('agent', { method: 'PUT', url: '/v1/notes/Research/ideas-link', headers: { 'content-type': 'text/markdown' }, payload: 'x' });
    expect(put.statusCode).toBe(403);
    const list = await env.req('agent', { method: 'GET', url: '/v1/folders/Research?depth=all' });
    const listed = list.json().results.map((r: { path: string }) => r.path);
    expect(listed).toContain('Research/ideas-link.md');
    expect(listed.some((p: string) => p.includes('private-link'))).toBe(false);
  });
});

describe('watcher', () => {
  it('picks up changes made outside the API', async () => {
    env = await setup({ watch: true });
    const count = async () => (await env.req('bot', { method: 'GET', url: '/v1/count/?kind=note' })).json().notes;
    expect(await count()).toBe(2);
    writeFileSync(path.join(env.vault, 'Reading List/External.md'), '---\ntags: [ext]\n---\nhi');
    await eventually(async () => (await count()) === 3);
    await eventually(async () => {
      const tags = (await env.req('bot', { method: 'GET', url: '/v1/tags' })).json().results;
      return tags.some((t: { tag: string }) => t.tag === 'ext');
    });
  });
});
