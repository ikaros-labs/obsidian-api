import { mkdirSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setup, writeConfig, type TestEnv } from './helpers.js';

// F-10: Bases state built with an account's old grants must not be served after a reload narrows them.
describe('Bases engine cache across a config reload', () => {
  let env: TestEnv;
  afterEach(() => env.cleanup());

  it('a query held open across the reload does not keep the old visibility', async () => {
    const wide = { inflight: { access: { '.': 'read' } }, control: { access: { '.': 'read' } } };
    env = await setup({
      accounts: wide,
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'VV/Hidden'), { recursive: true });
        writeFileSync(path.join(vault, 'VV/open.md'), '---\nk: 1\n---\nopen\n');
        writeFileSync(path.join(vault, 'VV/Hidden/h.md'), '---\nmarker: DUMMY-7\n---\nhidden\n');
      },
    });
    await env.app.server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = env.app.server.server.address() as AddressInfo;
    const probe = { filters: 'file.path == "VV/open.md"', formulas: { m: 'file("VV/Hidden/h.md").properties.marker' }, select: ['formula.m'] };
    const marker = async (account: string) => {
      const res = await env.req(account, { method: 'POST', url: '/v1/query', payload: probe });
      return res.json().results[0].values['formula.m'];
    };

    // Headers now (the request is authenticated with the wide grant), body after the reload.
    const body = JSON.stringify({ select: ['file.name'], limit: 1 });
    const socket = connect(port, '127.0.0.1');
    const response = new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (d) => (data += d.toString()));
      socket.on('close', () => resolve(data));
    });
    socket.write(`POST /v1/query HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer tok-inflight\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 100));

    const narrow = { access: { '.': 'read', 'VV/Hidden': 'none' } };
    writeConfig(env.configPath, env.vault, { audit: env.auditPath, accounts: { inflight: narrow, control: narrow } });
    expect(env.configs.reload()).toBe(true);
    socket.write(body);
    expect(await response).toMatch(/^HTTP\/1\.1 200/);

    expect((await env.req('inflight', { method: 'GET', url: '/v1/notes/VV/Hidden/h.md' })).statusCode).toBe(404);
    expect(await marker('control')).toBeNull();
    expect(await marker('inflight')).toBeNull();
  });
});
