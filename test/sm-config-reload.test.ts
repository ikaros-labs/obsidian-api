import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { setup, type TestEnv } from './helpers.js';

/** Config reloads. See B4 in docs/STATE-MACHINES.md. */

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
