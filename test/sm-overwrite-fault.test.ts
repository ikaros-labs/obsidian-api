import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Notes are overwritten in place (to keep the inode and birth time). This test fails the write
 * halfway, after it truncated the file. See B3 in docs/STATE-MACHINES.md.
 */

const hooks = vi.hoisted(() => ({ failOnce: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = (async (file: Parameters<typeof fs.writeFile>[0], data: string | Buffer, opts?: Parameters<typeof fs.writeFile>[2]) => {
    if (hooks.failOnce) {
      hooks.failOnce = false;
      // Disk full after the first few bytes.
      await fs.writeFile(file, Buffer.from(data).subarray(0, 3), opts);
      throw Object.assign(new Error('ENOSPC: injected'), { code: 'ENOSPC' });
    }
    return fs.writeFile(file, data, opts);
  }) as typeof fs.writeFile;
  return { ...fs, default: { ...fs, writeFile }, writeFile };
});

const { setup } = await import('./helpers.js');

let env: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  hooks.failOnce = false;
  await env?.cleanup();
});

describe('B3 overwrite that fails halfway', () => {
  it('keeps the old content (PUT)', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    hooks.failOnce = true;
    const r = await env.req('admin', { method: 'PUT', url: '/v1/notes/Inbox', headers: { 'content-type': 'text/markdown' }, payload: 'new content' });
    expect(r.statusCode).toBe(500);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps the old content (PATCH)', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    hooks.failOnce = true;
    const r = await env.req('admin', { method: 'PATCH', url: '/v1/notes/Inbox', payload: { ops: [{ op: 'append', content: 'more' }] } });
    expect(r.statusCode).toBe(500);
    expect(readFileSync(file, 'utf8')).toBe(before);
    // So a retry with the rev the client saw still applies.
    const rev = (await env.req('admin', { method: 'GET', url: '/v1/notes/Inbox' })).headers.etag as string;
    const retry = await env.req('admin', { method: 'PATCH', url: '/v1/notes/Inbox', headers: { 'if-match': rev }, payload: { ops: [{ op: 'append', content: 'more' }] } });
    expect(retry.statusCode).toBe(200);
  });
});
