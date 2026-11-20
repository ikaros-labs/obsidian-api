import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Notes are overwritten in place (to keep the inode and birth time), with the old bytes journaled
 * first. These tests fail the write halfway, after it truncated the file, once or persistently;
 * and fail the write of a new file. See B3 and B12 in docs/STATE-MACHINES.md.
 */

const hooks = vi.hoisted(() => ({
  /** Paths whose writeFile writes 3 bytes and then fails; `once` clears it after the first hit. */
  failing: null as null | { file: string; once: boolean },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const fail = async (write: (b: Buffer) => Promise<unknown>, data: string | Buffer) => {
    await write(Buffer.from(data).subarray(0, 3));
    throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' });
  };
  const hit = (file: unknown) => {
    const f = hooks.failing;
    if (!f || file !== f.file) return false;
    if (f.once) hooks.failing = null;
    return true;
  };
  const writeFile = (async (file: Parameters<typeof fs.writeFile>[0], data: string | Buffer, opts?: Parameters<typeof fs.writeFile>[2]) => {
    if (hit(file)) return fail((b) => fs.writeFile(file, b, opts), data);
    return fs.writeFile(file, data, opts);
  }) as typeof fs.writeFile;
  const open = (async (file: Parameters<typeof fs.open>[0], ...rest: unknown[]) => {
    const fh = await (fs.open as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(file, ...rest);
    const orig = fh.writeFile.bind(fh);
    fh.writeFile = (async (data: string | Buffer) => (hit(file) ? fail((b) => orig(b), data) : orig(data))) as typeof fh.writeFile;
    return fh;
  }) as typeof fs.open;
  return { ...fs, default: { ...fs, writeFile, open }, writeFile, open };
});

const { setup } = await import('./helpers.js');
const { createApp } = await import('../src/app.js');

let env: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  hooks.failing = null;
  await env?.cleanup();
});

const md = { 'content-type': 'text/markdown' };
const append = (etag?: string) => ({
  method: 'PATCH' as const,
  url: '/v1/notes/Inbox',
  headers: etag ? { 'if-match': etag } : {},
  payload: { ops: [{ op: 'append', content: 'more' }] },
});

describe('B3 overwrite that fails halfway', () => {
  it('keeps the old content (PUT)', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    hooks.failing = { file, once: true };
    const r = await env.req('admin', { method: 'PUT', url: '/v1/notes/Inbox', headers: md, payload: 'new content' });
    expect(r.statusCode).toBe(500);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(path.join(env.vault, '.spall/journal'))).toEqual([]);
  });

  it('keeps the old content (PATCH), so a retry with the ETag from before the failure applies', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    const etag = (await env.req('admin', { method: 'GET', url: '/v1/notes/Inbox' })).headers.etag as string;
    hooks.failing = { file, once: true };
    expect((await env.req('admin', append(etag))).statusCode).toBe(500);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect((await env.req('admin', append(etag))).statusCode).toBe(200);
  });

  it('when even the rollback fails, restores the file before the next write', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    const etag = (await env.req('admin', { method: 'GET', url: '/v1/notes/Inbox' })).headers.etag as string;
    hooks.failing = { file, once: false }; // the disk keeps failing: write and rollback both fail
    expect((await env.req('admin', append(etag))).statusCode).toBe(500);
    expect(readFileSync(file, 'utf8')).not.toBe(before);
    hooks.failing = null; // the disk recovers
    const retry = await env.req('admin', append(etag));
    expect(retry.statusCode).toBe(200);
    const after = readFileSync(file, 'utf8');
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain('more');
  });

  it('when the server stops before it could roll back, restores the file at the next start', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    hooks.failing = { file, once: false };
    expect((await env.req('admin', append())).statusCode).toBe(500);
    hooks.failing = null;
    expect(readFileSync(file, 'utf8')).not.toBe(before);
    const app = await createApp(env.configs);
    try {
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(app.index.get('Inbox.md')?.size).toBe(Buffer.byteLength(before));
    } finally {
      await app.close();
    }
    expect(readdirSync(path.join(env.vault, '.spall/journal'))).toEqual([]);
  });
});

describe('B12 create that fails halfway', () => {
  it('leaves no partial file behind, so a retry creates it', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Research/New.md');
    hooks.failing = { file, once: true };
    const put = () => env.req('admin', { method: 'PUT', url: '/v1/notes/Research/New', headers: { ...md, 'if-none-match': '*' }, payload: 'hello' });
    expect((await put()).statusCode).toBe(500);
    expect(existsSync(file)).toBe(false);
    expect((await put()).statusCode).toBe(201);
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });
});
