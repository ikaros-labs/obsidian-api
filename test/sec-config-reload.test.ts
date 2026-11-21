import { readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigManager } from '../src/config.js';
import { eventually, setup, writeConfig, type TestEnv } from './helpers.js';

const me = (app: App, token: string) => app.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
const ACCOUNTS = { reader: { access: { '.': 'read' } }, other: { access: { '.': 'read' } } };

describe('revocation takes effect at reload', () => {
  let env: TestEnv;
  const closers: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    await env.cleanup();
  });

  // F-09: a pending restart-only change must not hold back token and grant changes.
  it('F-09: applies accounts and tokens even when a restart-only setting changed in the file', async () => {
    env = await setup({ accounts: ACCOUNTS });
    const errors: string[] = [];
    const configs = ConfigManager.load(env.configPath, { info() {}, error: (e) => errors.push(e) });
    const app = await createApp(configs);
    closers.push(() => app.close());
    expect((await me(app, 'tok-reader')).statusCode).toBe(200);

    const text = readFileSync(env.configPath, 'utf8');
    for (const edit of ['server:\n  port: 9999\n', 'server:\n  max_body: 5mb\n']) {
      // reader loses its token and its access to Notes/Private; the restart-only edit is not applied.
      writeConfig(env.configPath, env.vault, { accounts: { reader: { access: { '.': 'read' } }, other: { access: { '.': 'read', 'Notes/Private': 'none' } } } });
      const narrowed = readFileSync(env.configPath, 'utf8').replace(/( {2}reader:[\s\S]*?tokens:)[\s\S]*?(\n {2}other:)/, '$1 []$2');
      writeFileSync(env.configPath, edit + narrowed);
      expect(configs.reload()).toBe(true);
      expect(errors.at(-1)).toMatch(/restart/);
      expect(configs.current.server).toEqual({ host: '127.0.0.1', port: 8787, maxBody: 10 * 1024 * 1024 });
      expect((await me(app, 'tok-reader')).statusCode).toBe(401);
      const hidden = await app.server.inject({ method: 'GET', url: '/v1/notes/Notes/Private/Secret.md', headers: { authorization: 'Bearer tok-other' } });
      expect(hidden.statusCode).toBe(404);
      writeFileSync(env.configPath, text);
      expect(configs.reload()).toBe(true);
      expect((await me(app, 'tok-reader')).statusCode).toBe(200);
    }
    // A vault setting that differs is not applied either, and does not block the rest.
    writeConfig(env.configPath, env.vault, { vault: { follow_symlinks: true, trash: 'Trash' }, accounts: { other: { access: { '.': 'read' } } } });
    expect(configs.reload()).toBe(true);
    expect(configs.current.followSymlinks).toBe(false);
    expect(configs.current.trash).toEqual(['.trash']);
    expect((await me(app, 'tok-reader')).statusCode).toBe(401);
    expect((await me(app, 'tok-other')).statusCode).toBe(200);
  });

  // F-08: the path the operator gave is read again at each reload, also when it is a symlink.
  it('F-08: follows a config symlink that is re-pointed', async () => {
    env = await setup({ accounts: ACCOUNTS });
    const v1 = path.join(env.dir, 'rel-v1.yaml');
    const v2 = path.join(env.dir, 'rel-v2.yaml');
    const current = path.join(env.dir, 'current.yaml');
    writeConfig(v1, env.vault, { accounts: ACCOUNTS });
    writeConfig(v2, env.vault, { accounts: { other: ACCOUNTS.other } });
    symlinkSync(v1, current);
    const swap = (to: string) => {
      symlinkSync(to, `${current}.new`);
      renameSync(`${current}.new`, current);
    };
    const configs = ConfigManager.load(current, { info() {}, error() {} });
    const app = await createApp(configs);
    closers.push(() => app.close());
    expect((await me(app, 'tok-reader')).statusCode).toBe(200);

    swap(v2);
    expect(configs.reload()).toBe(true);
    expect((await me(app, 'tok-reader')).statusCode).toBe(401);
    expect((await me(app, 'tok-other')).statusCode).toBe(200);

    // The watcher sees the swap too, and then follows the new target.
    swap(v1);
    expect(configs.reload()).toBe(true);
    configs.watch();
    closers.push(() => configs.close());
    swap(v2);
    await eventually(async () => (await me(app, 'tok-reader')).statusCode === 401);
    writeConfig(v2, env.vault, { accounts: ACCOUNTS });
    await eventually(async () => (await me(app, 'tok-reader')).statusCode === 200);
  });

  // Review round: the proposed vault is never looked at, so a revocation in the same edit applies.
  it('F-09: a token change applies when the proposed vault path cannot be used', async () => {
    env = await setup({ accounts: ACCOUNTS });
    const configs = ConfigManager.load(env.configPath, { info() {}, error() {} });
    const app = await createApp(configs);
    closers.push(() => app.close());
    const running = configs.current.vaultPath;
    for (const vault of [path.join(env.dir, 'no-such-vault'), env.configPath, path.dirname(env.configPath)]) {
      writeConfig(env.configPath, vault, { accounts: { other: ACCOUNTS.other } });
      expect(configs.reload(), vault).toBe(true);
      expect(configs.current.vaultPath).toBe(running);
      expect((await me(app, 'tok-reader')).statusCode).toBe(401);
      expect((await me(app, 'tok-other')).statusCode).toBe(200);
      writeConfig(env.configPath, env.vault, { accounts: ACCOUNTS });
      expect(configs.reload()).toBe(true);
      expect((await me(app, 'tok-reader')).statusCode).toBe(200);
    }
  });
});
