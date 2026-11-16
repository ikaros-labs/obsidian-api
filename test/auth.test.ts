import { readFileSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToken, hashToken } from '../src/tokens.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup({ accounts: { reader: { access: { '.': 'read' } } } });
});
afterEach(() => env.cleanup());

describe('bearer auth', () => {
  it('looks tokens up by the hash of the whole value, whatever the prefix', async () => {
    const tokens = [generateToken(), 'vlt_minted-before-the-rename', 'no-prefix-at-all'];
    const cfg = parse(readFileSync(env.configPath, 'utf8'));
    cfg.accounts.reader.tokens = tokens.map((t, i) => ({ name: `t${i}`, sha256: hashToken(t) }));
    writeFileSync(env.configPath, stringify(cfg));
    expect(env.configs.reload()).toBe(true);

    expect(tokens[0]).toMatch(/^spl_/);
    for (const t of tokens) {
      const res = await env.app.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${t}` } });
      expect(res.statusCode, t).toBe(200);
    }
    const wrong = await env.app.server.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer spl_unknown' } });
    expect(wrong.statusCode).toBe(401);
  });
});
