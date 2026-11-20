import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enc, setup, type TestEnv } from './helpers.js';

const LONG = 'a'.repeat(300);
const answer = (r: { statusCode: number; json(): { error?: { code?: string } } }) => `${r.statusCode} ${r.json().error?.code ?? ''}`;

describe('hidden paths answer like missing ones', () => {
  let env: TestEnv;
  afterEach(() => env.cleanup());

  // F-13: a lookup failure below a hidden folder must not differ from a missing folder.
  it('F-13: an over-long segment gives the same answer below hidden and missing folders', async () => {
    env = await setup({
      prepare: (vault) => mkdirSync(path.join(vault, 'Notes/Private/Clients/AcmeCorp'), { recursive: true }),
    });
    const pairs: [string, string][] = [
      ['Notes/Private', 'Notes/Nope'],
      ['Notes/Private/Clients/AcmeCorp', 'Notes/Private/Clients/Globex'],
      ['Templates', 'Payroll'],
      ['.git', '.svn'],
    ];
    const requests = (folder: string) => [
      { method: 'GET' as const, url: `/v1/folders/${enc(folder)}/${LONG}` },
      { method: 'GET' as const, url: `/v1/tree/${enc(folder)}/${LONG}` },
      { method: 'GET' as const, url: `/v1/count/${enc(folder)}/${LONG}` },
      { method: 'GET' as const, url: `/v1/tags?folder=${encodeURIComponent(`${folder}/${LONG}`)}` },
      { method: 'GET' as const, url: `/v1/search?q=x&folder=${encodeURIComponent(`${folder}/${LONG}`)}` },
      { method: 'GET' as const, url: `/v1/stats?folder=${encodeURIComponent(`${folder}/${LONG}`)}` },
      { method: 'PUT' as const, url: `/v1/files/${enc(folder)}/${LONG}`, payload: 'x' },
      { method: 'PUT' as const, url: `/v1/notes/${enc(folder)}/${LONG}`, payload: 'x', headers: { 'content-type': 'text/markdown' } },
      { method: 'POST' as const, url: `/v1/folders/${enc(folder)}/${LONG}` },
      { method: 'POST' as const, url: '/v1/notes', payload: { folder: `${folder}/${LONG}`, title: 't' } },
      { method: 'POST' as const, url: '/v1/notes/Research/Plan/move', payload: { destination: `${folder}/${LONG}/x.md` } },
    ];
    for (const [hidden, missing] of pairs) {
      const a = requests(hidden);
      const b = requests(missing);
      for (let i = 0; i < a.length; i++) {
        const ra = await env.req('agent', a[i]!);
        const rb = await env.req('agent', b[i]!);
        expect(`${a[i]!.method} ${a[i]!.url.slice(0, 40)} -> ${answer(ra)}`).toBe(`${b[i]!.method} ${a[i]!.url.slice(0, 40)} -> ${answer(rb)}`);
        expect(ra.statusCode).toBeLessThan(500);
      }
    }
    // The longest name a filesystem takes still works where the account may write.
    const ok = await env.req('agent', { method: 'PUT', url: `/v1/files/Research/${'b'.repeat(255)}`, payload: 'x' });
    expect(ok.statusCode).toBe(201);
    expect((await env.req('agent', { method: 'PUT', url: `/v1/files/Research/${'b'.repeat(256)}`, payload: 'x' })).statusCode).toBe(400);
  });

  // F-14, F-15: with follow_symlinks, a symlink in a hidden folder must not be usable (or detectable)
  // through routes that create things.
  it('F-14, F-15: creating through a symlink in a hidden folder is 404, like a hidden folder or a missing name', async () => {
    env = await setup({
      vault: { follow_symlinks: true },
      accounts: { w: { access: { Work: 'full', Vaulted: 'none' } }, admin: { access: { '.': 'full' } } },
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Work/drop'), { recursive: true });
        writeFileSync(path.join(vault, 'Work/drop/f.md'), 'f');
        mkdirSync(path.join(vault, 'Vaulted/plain'), { recursive: true });
        symlinkSync(path.join(vault, 'Work/drop'), path.join(vault, 'Vaulted/jump'));
        symlinkSync(path.join(vault, 'Work/drop/f.md'), path.join(vault, 'Vaulted/jumpfile'));
      },
    });
    for (const name of ['jump', 'jumpfile', 'plain', 'absent']) {
      const note = await env.req('w', { method: 'POST', url: '/v1/notes', payload: { folder: `Vaulted/${name}`, title: 'Probe' } });
      expect(`${name}: ${answer(note)}`).toBe(`${name}: 404 not_found`);
      for (const url of [`/v1/folders/Vaulted/${name}/new`, `/v1/folders/Vaulted/${name}`]) {
        const dir = await env.req('w', { method: 'POST', url });
        expect(`${url}: ${answer(dir)}`).toBe(`${url}: 404 not_found`);
      }
    }
    expect(existsSync(path.join(env.vault, 'Work/drop/Probe.md'))).toBe(false);
    expect(existsSync(path.join(env.vault, 'Work/drop/new'))).toBe(false);
    // A symlink the account can see on both ends still works.
    expect((await env.req('admin', { method: 'POST', url: '/v1/notes', payload: { folder: 'Vaulted/jump', title: 'Ok' } })).statusCode).toBe(201);
    expect((await env.req('admin', { method: 'POST', url: '/v1/folders/Vaulted/jump/sub' })).statusCode).toBe(201);
  });
});
