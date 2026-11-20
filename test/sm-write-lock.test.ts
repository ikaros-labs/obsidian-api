import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Vault } from '../src/vault.js';
import { setup, type TestEnv } from './helpers.js';

/**
 * Controlled interleavings for the races documented in docs/STATE-MACHINES.md. Each test parks one
 * operation at a known point, runs the competing one, then lets the first continue.
 */

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

const md = { 'content-type': 'text/markdown' };
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Parks the first call of `proto[name]` until `release()`; later calls pass straight through. */
function park<T extends object>(proto: T, name: keyof T) {
  const orig = proto[name] as unknown as (...a: unknown[]) => Promise<unknown>;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const parked = new Promise<void>((r) => (reached = r));
  let first = true;
  (proto as Record<string, unknown>)[name as string] = async function (this: unknown, ...args: unknown[]) {
    if (first) {
      first = false;
      reached();
      await gate;
    }
    return orig.apply(this, args);
  };
  return { parked, release, restore: () => ((proto as Record<string, unknown>)[name as string] = orig) };
}

describe('B1 folder delete vs a concurrent write inside it', () => {
  it('does not purge a file another account wrote after the permission check', async () => {
    env = await setup({
      accounts: {
        cleaner: { access: { Box: ['read', 'create', 'update', 'delete', 'purge'], 'Box/Private': 'none' } },
        owner: { access: { 'Box/Private': 'edit' } },
      },
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Box'));
        writeFileSync(path.join(vault, 'Box/visible.md'), 'v');
      },
    });
    const p = park(Vault.prototype, 'purge');
    try {
      const del = env.req('cleaner', { method: 'DELETE', url: '/v1/folders/Box?recursive=true&permanent=true' });
      await p.parked; // the check passed: everything in Box is visible to cleaner and purgeable
      const put = env.req('owner', { method: 'PUT', url: '/v1/notes/Box/Private/secret', headers: md, payload: 'mine' });
      await Promise.race([put, tick()]);
      p.release();
      expect((await del).statusCode).toBe(204);
      expect((await put).statusCode).toBe(201);
    } finally {
      p.restore();
    }
    // owner's note must survive: cleaner may not see or purge Box/Private.
    expect(readFileSync(path.join(env.vault, 'Box/Private/secret.md'), 'utf8')).toBe('mine');
  });
});

describe('B2 two edits of one note through a symlink alias', () => {
  it('serialises them, so neither edit is lost', async () => {
    env = await setup({
      vault: { follow_symlinks: true },
      prepare: (vault) => symlinkSync(path.join(vault, 'Research'), path.join(vault, 'Alias')),
      accounts: { admin: { access: { '.': 'full' } } },
    });
    const patch = (url: string, value: string) =>
      env.req('admin', { method: 'PATCH', url, payload: { ops: [{ op: 'frontmatter.set', key: value, value: true }] } });
    const p = park(Vault.prototype, 'overwrite');
    try {
      const a = patch('/v1/notes/Research/Plan', 'from_real_path');
      await p.parked; // a read the note and is about to write it
      const b = patch('/v1/notes/Alias/Plan', 'from_alias');
      await Promise.race([b, tick()]);
      p.release();
      expect((await a).statusCode).toBe(200);
      expect((await b).statusCode).toBe(200);
    } finally {
      p.restore();
    }
    const text = readFileSync(path.join(env.vault, 'Research/Plan.md'), 'utf8');
    expect(text).toContain('from_real_path: true');
    expect(text).toContain('from_alias: true');
  });
});
