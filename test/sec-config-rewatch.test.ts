import { mkdirSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../src/app.js';
import { ConfigManager } from '../src/config.js';
import { eventually, setup, writeConfig, type TestEnv } from './helpers.js';

const unwatchable = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const watch = ((dir: string, ...rest: unknown[]) => {
    if (dir === unwatchable.dir) throw Object.assign(new Error(`ENOSPC: no space left on device, watch '${dir}'`), { code: 'ENOSPC' });
    return (fs.watch as (...a: unknown[]) => unknown)(dir, ...rest);
  }) as typeof fs.watch;
  return { ...fs, default: { ...fs, watch }, watch };
});

const me = (app: App, token: string) => app.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
const ACCOUNTS = { reader: { access: { '.': 'read' } }, other: { access: { '.': 'read' } } };

// Review round (F-08): the reload has happened by the time the watch is moved; a folder that can't be
// watched must not turn it into an exception, or leave the config unwatched.
describe('reload when the new config location cannot be watched', () => {
  let env: TestEnv;
  const closers: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) await c();
    await env.cleanup();
  });

  it('applies the revocation, reports the watch problem and keeps the old watch', async () => {
    env = await setup({ accounts: ACCOUNTS });
    const v1 = path.join(env.dir, 'rel-v1.yaml');
    const v2 = path.join(env.dir, 'elsewhere', 'rel-v2.yaml');
    const current = path.join(env.dir, 'current.yaml');
    mkdirSync(path.dirname(v2));
    unwatchable.dir = path.dirname(v2);
    writeConfig(v1, env.vault, { accounts: ACCOUNTS });
    writeConfig(v2, env.vault, { accounts: { other: ACCOUNTS.other } });
    symlinkSync(v1, current);
    const swap = (to: string) => {
      symlinkSync(to, `${current}.new`);
      renameSync(`${current}.new`, current);
    };
    const errors: string[] = [];
    const configs = ConfigManager.load(current, { info() {}, error: (e) => errors.push(e) });
    const app = await createApp(configs);
    closers.push(() => app.close());
    configs.watch();
    closers.push(() => configs.close());

    swap(v2);
    expect(configs.reload()).toBe(true);
    expect((await me(app, 'tok-reader')).statusCode).toBe(401);
    expect(errors.join('\n')).toMatch(/can't be watched/);

    // The folder of the path as given is still watched: pointing the link back is picked up.
    swap(v1);
    await eventually(async () => (await me(app, 'tok-reader')).statusCode === 200);
  });
});
