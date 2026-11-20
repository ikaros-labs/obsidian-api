import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A move is link(to) then unlink(from). These tests fail the second step and check that the vault
 * is left in a state the client can retry from. See B7 in docs/STATE-MACHINES.md.
 */

const hooks = vi.hoisted(() => ({ unlinkError: null as null | ((p: string) => NodeJS.ErrnoException | null) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const unlink = (async (p: Parameters<typeof fs.unlink>[0]) => {
    const err = typeof p === 'string' ? hooks.unlinkError?.(p) : null;
    if (err) throw err;
    return fs.unlink(p);
  }) as typeof fs.unlink;
  return { ...fs, default: { ...fs, unlink }, unlink };
});

const { setup } = await import('./helpers.js');
type Env = Awaited<ReturnType<typeof setup>>;

let env: Env;
afterEach(async () => {
  hooks.unlinkError = null;
  await env?.cleanup();
});

const errnoError = (code: string) => Object.assign(new Error(`${code}: injected`), { code });

describe('B7 move whose unlink of the source fails', () => {
  for (const code of ['EACCES', 'EPERM']) {
    it(`leaves only the source on ${code}, and a retry succeeds`, async () => {
      env = await setup();
      const from = path.join(env.vault, 'Research/Plan.md');
      const to = path.join(env.vault, 'Research/Moved.md');
      const original = readFileSync(from, 'utf8');
      hooks.unlinkError = (p) => (p === from ? errnoError(code) : null);
      const move = () => env.req('admin', { method: 'POST', url: '/v1/notes/Research/Plan/move', payload: { destination: 'Research/Moved' } });

      const first = await move();
      expect(first.statusCode).toBe(500);
      // No half-done move: the destination link was rolled back.
      expect(existsSync(to)).toBe(false);
      expect(readFileSync(from, 'utf8')).toBe(original);
      expect(env.app.index.get('Research/Moved.md')).toBeUndefined();

      hooks.unlinkError = null;
      const retry = await move();
      expect(retry.statusCode).toBe(200);
      expect(existsSync(from)).toBe(false);
      expect(readFileSync(to, 'utf8')).toBe(original);
    });
  }
});
