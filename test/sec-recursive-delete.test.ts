import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

describe('recursive folder delete only removes what the account may delete', () => {
  let env: TestEnv;
  afterEach(() => env.cleanup());

  // F-11: a symlink whose target the account can't read is something it can't see.
  it('F-11: refuses when the folder holds a symlink to hidden content', async () => {
    env = await setup({
      vault: { follow_symlinks: true },
      accounts: { w: { access: { Work: 'full', Vaulted: 'none' } }, admin: { access: { '.': 'full' } } },
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Work/bin'), { recursive: true });
        mkdirSync(path.join(vault, 'Work/ok'), { recursive: true });
        mkdirSync(path.join(vault, 'Vaulted'), { recursive: true });
        writeFileSync(path.join(vault, 'Work/bin/keep.md'), 'k');
        writeFileSync(path.join(vault, 'Work/keep2.md'), 'k');
        writeFileSync(path.join(vault, 'Vaulted/secret.md'), 's');
        symlinkSync(path.join(vault, 'Vaulted/secret.md'), path.join(vault, 'Work/bin/ghost.md'));
        symlinkSync(path.join(vault, 'Work/keep2.md'), path.join(vault, 'Work/ok/link.md'));
      },
    });
    expect((await env.req('w', { method: 'DELETE', url: '/v1/files/Work/bin/ghost.md' })).statusCode).toBe(404);
    const res = await env.req('w', { method: 'DELETE', url: '/v1/folders/Work/bin?recursive=true' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('folder_not_empty');
    expect(existsSync(path.join(env.vault, 'Work/bin/keep.md'))).toBe(true);
    // A symlink the account can see and delete on both ends does not block the delete.
    expect((await env.req('w', { method: 'DELETE', url: '/v1/folders/Work/ok?recursive=true' })).statusCode).toBe(204);
  });

  // F-12: a write below the folder can't slip in between the per-child check and the removal.
  it('F-12: a concurrent write into a subfolder the deleter may not touch is never trashed', async () => {
    env = await setup({
      accounts: {
        cleaner: { access: { Shared: 'full', 'Shared/Private': 'none' } },
        writer: { access: { 'Shared/Private': 'full' } },
        admin: { access: { '.': ['read', 'create', 'update', 'delete', 'purge'] } },
      },
      // Many earlier trashed copies: the trash step then awaits long enough for the write to land.
      prepare: (vault) => {
        for (let n = 0; n < 40; n++) mkdirSync(path.join(vault, '.trash', n === 0 ? 'Shared' : `Shared ${n}`), { recursive: true });
      },
    });
    for (let i = 0; i < 8; i++) {
      expect((await env.req('admin', { method: 'PUT', url: '/v1/notes/Shared/a.md', payload: 'a', headers: { 'content-type': 'text/markdown' } })).statusCode).toBeLessThan(300);
      const del = env.req('cleaner', { method: 'DELETE', url: '/v1/folders/Shared?recursive=true' });
      const put = env.req('writer', { method: 'PUT', url: '/v1/notes/Shared/Private/secret.md', payload: `secret ${i}`, headers: { 'content-type': 'text/markdown' } });
      const [d, p] = await Promise.all([del, put]);
      expect(p.statusCode).toBe(201);
      expect([204, 403]).toContain(d.statusCode);
      // The writer was told 201: its note is in the vault, not in the trash.
      expect(existsSync(path.join(env.vault, 'Shared/Private/secret.md'))).toBe(true);
      expect((await env.req('writer', { method: 'GET', url: '/v1/notes/Shared/Private/secret.md' })).statusCode).toBe(200);
      expect((await env.req('admin', { method: 'DELETE', url: '/v1/folders/Shared?recursive=true&permanent=true' })).statusCode).toBe(204);
    }
  });
});
