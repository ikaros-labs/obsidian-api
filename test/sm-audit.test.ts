import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every audited write is logged in two lines: an intent before the vault is touched, and a result
 * after it. See B9 and I12 in docs/STATE-MACHINES.md.
 */

const hooks = vi.hoisted(() => ({
  /** Audit appends whose line this returns true for fail with EIO. */
  failAppend: null as null | ((line: string) => boolean),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const appendFile = (async (file: Parameters<typeof fs.appendFile>[0], data: string | Uint8Array, opts?: Parameters<typeof fs.appendFile>[2]) => {
    if (hooks.failAppend?.(String(data))) throw Object.assign(new Error('EIO: injected'), { code: 'EIO' });
    return fs.appendFile(file, data, opts);
  }) as typeof fs.appendFile;
  return { ...fs, default: { ...fs, appendFile }, appendFile };
});

const { setup } = await import('./helpers.js');

let env: Awaited<ReturnType<typeof setup>>;
afterEach(async () => {
  hooks.failAppend = null;
  await env?.cleanup();
});

const auditLines = () =>
  existsSync(env.auditPath) ? readFileSync(env.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const create = () => env.req('admin', { method: 'POST', url: '/v1/notes', payload: { folder: 'Research', title: 'Retry me', body: 'x\n' } });

describe('B9 audit log that cannot be written', () => {
  it('changes nothing and returns 500 audit_unavailable, so a retried POST makes no duplicate', async () => {
    env = await setup();
    mkdirSync(env.auditPath); // appending to a directory fails (EISDIR), as with a full or read-only disk
    const before = readdirSync(path.join(env.vault, 'Research')).sort();
    const first = await create();
    expect(first.statusCode).toBe(500);
    expect(first.json().error.code).toBe('audit_unavailable');
    expect(readdirSync(path.join(env.vault, 'Research')).sort()).toEqual(before);
    expect(env.app.index.get('Research/Retry me.md')).toBeUndefined();

    rmSync(env.auditPath, { recursive: true }); // the sink recovers
    const retry = await create();
    expect(retry.statusCode).toBe(201);
    expect(retry.json().path).toBe('Research/Retry me.md');
    expect(readdirSync(path.join(env.vault, 'Research')).filter((n) => n.startsWith('Retry me'))).toEqual(['Retry me.md']);
    const [intent, result] = auditLines();
    expect(intent).toMatchObject({ phase: 'intent', op: 'create', path: 'Research/Retry me.md', request: expect.any(String) });
    expect(result).toMatchObject({ phase: 'result', request: intent.request, outcome: 'ok', path: 'Research/Retry me.md' });
  });

  it('leaves a note unchanged when the intent line fails', async () => {
    env = await setup();
    const file = path.join(env.vault, 'Inbox.md');
    const before = readFileSync(file, 'utf8');
    hooks.failAppend = (line) => line.includes('"phase":"intent"');
    const r = await env.req('admin', { method: 'PATCH', url: '/v1/notes/Inbox', payload: { ops: [{ op: 'append', content: 'more' }] } });
    expect(r.statusCode).toBe(500);
    expect(r.json().error.code).toBe('audit_unavailable');
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(auditLines()).toEqual([]);
  });

  it('returns the real outcome when only the result line fails; the intent is on record', async () => {
    env = await setup();
    hooks.failAppend = (line) => line.includes('"phase":"result"');
    const r = await create();
    expect(r.statusCode).toBe(201);
    expect(existsSync(path.join(env.vault, 'Research/Retry me.md'))).toBe(true);
    expect(auditLines()).toEqual([expect.objectContaining({ phase: 'intent', op: 'create', path: 'Research/Retry me.md' })]);
  });

  it('returns the change’s own error when the change and the result line both fail', async () => {
    env = await setup();
    hooks.failAppend = (line) => line.includes('"phase":"result"');
    const r = await env.req('admin', { method: 'POST', url: '/v1/notes', payload: { folder: 'Research', title: 'Plan', on_conflict: 'fail' } });
    expect(r.statusCode).toBe(409);
    expect(auditLines()).toEqual([expect.objectContaining({ phase: 'intent', op: 'create', path: 'Research/Plan.md' })]);
  });

  it('records a change that fails as a failed result with its error code', async () => {
    env = await setup();
    const r = await env.req('admin', { method: 'POST', url: '/v1/notes', payload: { folder: 'Research', title: 'Plan', on_conflict: 'fail' } });
    expect(r.statusCode).toBe(409);
    const [intent, result] = auditLines();
    expect(intent).toMatchObject({ phase: 'intent', op: 'create' });
    expect(result).toMatchObject({ phase: 'result', request: intent.request, outcome: 'failed', error: 'already_exists' });
  });
});
