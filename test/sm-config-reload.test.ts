import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { ConfigManager } from '../src/config.js';
import { hashToken } from '../src/tokens.js';
import { setup, type TestEnv } from './helpers.js';

/** Config reloads. See B4 and B13 in docs/STATE-MACHINES.md. */

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('B4 config reload with a restart-only change', () => {
  it('still applies a token revocation made in the same edit', async () => {
    env = await setup();
    expect((await env.req('bot', { method: 'GET', url: '/v1/me' })).statusCode).toBe(200);
    // The admin moved the port (needs a restart) and revoked bot's token in the same edit.
    const doc = parseDocument(readFileSync(env.configPath, 'utf8'));
    doc.setIn(['server', 'port'], 9999);
    doc.setIn(['accounts', 'bot', 'tokens'], []);
    writeFileSync(env.configPath, String(doc));
    env.configs.reload();
    expect((await env.req('bot', { method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    // The restart-only setting keeps its running value.
    expect(env.configs.current.server.port).toBe(8787);
  });
});

describe('B13 restart-only settings pinned to what the server runs on', () => {
  it('a pending invalid restart-only value does not hold back a revocation', async () => {
    env = await setup();
    const doc = parseDocument(readFileSync(env.configPath, 'utf8'));
    doc.setIn(['server', 'port'], 'not a port');
    doc.setIn(['accounts', 'bot', 'tokens'], []);
    writeFileSync(env.configPath, String(doc));
    expect(env.configs.reload()).toBe(true);
    expect((await env.req('bot', { method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect(env.configs.current.server.port).toBe(8787);
  });

  it('keeps the canonical vault root when the vault path is a symlink that was retargeted', async () => {
    env = await setup();
    const link = path.join(env.dir, 'vault-link');
    symlinkSync(env.vault, link);
    const other = path.join(env.dir, 'other');
    mkdirSync(other);
    const cfg = path.join(env.dir, 'linked.yaml');
    const text = (tokens: string) =>
      `version: 1\nvault: { path: ${link} }\naccounts:\n  bot:\n    access: { .: read }\n    tokens: ${tokens}\n`;
    writeFileSync(cfg, text(`[{ name: t, sha256: ${hashToken('t')} }]`));
    const m = ConfigManager.load(cfg, { info() {}, error() {} });
    const running = m.current.vaultPath;
    expect(running).toBe(realpathSync(env.vault));
    rmSync(link);
    symlinkSync(other, link); // retargeted; the running vault and index stay on the old directory
    writeFileSync(cfg, text('[]'));
    expect(m.reload()).toBe(true);
    expect(m.current.vaultPath).toBe(running);
    expect(m.current.tokensByHash.size).toBe(0);
  });
});
