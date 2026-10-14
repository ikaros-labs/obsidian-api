/** Regression tests for the QA round (QA.md, obsidian-api section and cross-cutting issues). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoConfig, DEFAULT_HOST } from '../scripts/demo-config.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup({
    prepare(vault) {
      // 60 hidden notes whose 60 distinct "alph…" terms each occur in 2 notes, so by vault-wide
      // frequency they all outrank the one visible "alpha" (df 1).
      mkdirSync(path.join(vault, 'Notes/Private/alph'), { recursive: true });
      for (let i = 0; i < 60; i++) {
        const a = `alph${String(i).padStart(3, '0')}x`;
        const b = `alph${String((i + 1) % 60).padStart(3, '0')}x`;
        writeFileSync(path.join(vault, `Notes/Private/alph/n${i}.md`), `${a} ${b}\n`);
      }
      writeFileSync(path.join(vault, 'Notes/Alpha.md'), '# Alpha\n\nalpha release notes\n');
    },
  });
});
afterEach(() => env.cleanup());

const get = async (account: Parameters<TestEnv['req']>[0], url: string, query?: Record<string, string>) => {
  const res = await env.req(account, { method: 'GET', url, query });
  return { status: res.statusCode, body: res.json() as Record<string, any>, raw: res.body };
};

describe('bug 1 (high): prefix expansion is scoped to visible notes', () => {
  it('hidden vocabulary cannot crowd out visible terms', async () => {
    // Before the fix: total 0, because the top 50 expansions were all hidden terms.
    const agent = await get('agent', '/v1/search', { q: 'alph*' });
    expect(agent.body.total).toBe(1);
    expect(agent.body.results[0].path).toBe('Notes/Alpha.md');
    expect(agent.body.results[0].matched).toEqual(['alpha']);
  });

  it('hidden-only prefixes match nothing and are indistinguishable from absent ones', async () => {
    const hidden = await get('agent', '/v1/search', { q: 'alph0*' });
    const absent = await get('agent', '/v1/search', { q: 'zzzq*' });
    expect(hidden.body).toEqual({ ...absent.body, query: 'alph0*' });
    expect(hidden.body.total).toBe(0);
  });

  it('admin still sees the hidden terms', async () => {
    // 60 matching terms, capped at 50 expansions, which cover 51 of the 60 notes.
    expect((await get('admin', '/v1/search', { q: 'alph0*' })).body.total).toBe(51);
  });

  it('excluded prefixes are scoped the same way', async () => {
    expect((await get('agent', '/v1/search', { q: 'release -alph*' })).body.total).toBe(0);
    expect((await get('agent', '/v1/search', { q: 'release -alph0*' })).body.total).toBe(1);
  });
});

describe('bug 3 (medium): expensive queries are bounded', () => {
  it('rejects more than 5 prefix clauses', async () => {
    const q = Array.from({ length: 88 }, () => 'xx*').join(' ');
    // Duplicates collapse, so make them distinct.
    const distinct = Array.from({ length: 6 }, (_, i) => `x${String.fromCharCode(97 + i)}*`).join(' ');
    expect((await get('admin', '/v1/search', { q, match: 'any' })).status).toBe(200);
    const res = await get('admin', '/v1/search', { q: distinct, match: 'any' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/at most 5 prefix/);
    expect((await get('admin', '/v1/search', { q: 'aa* bb* cc* dd* ee*' })).status).toBe(200);
  });

  it('rejects more than 32 clauses', async () => {
    const q = Array.from({ length: 33 }, (_, i) => `word${i}`).join(' ');
    expect((await get('admin', '/v1/search', { q })).status).toBe(400);
  });

  it('answers 5 broad prefix clauses quickly', async () => {
    const t = Date.now();
    const res = await get('admin', '/v1/search', { q: 'a* b* c* d* e*', match: 'any' });
    expect(res.status).toBe(200);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('bug 4 (low): impossible dates are rejected', () => {
  it.each([
    ['from=2026-02-30&to=2026-03-02'],
    ['from=2026-01-01&to=2026-13-45'],
    ['from=2026-00-10'],
    ['to=2025-02-29'],
  ])('%s → 400', async (qs) => {
    const res = await get('admin', `/v1/stats?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].message).toMatch(/valid date/);
  });

  it('accepts real ones, including leap days', async () => {
    const res = await get('admin', '/v1/stats?metric=modified&from=2024-02-28&to=2024-03-01');
    expect(res.status).toBe(200);
    expect(res.body.buckets.map((b: { t: string }) => b.t)).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
  });
});

describe('cross-cutting: input caps', () => {
  it('rejects URLs over 16 KiB with 414', async () => {
    const res = await get('admin', `/v1/search?q=a&folder=${'x'.repeat(17_000)}`);
    expect(res.status).toBe(414);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('caps parameter lengths', async () => {
    expect((await get('admin', '/v1/search', { q: 'a'.repeat(501) })).status).toBe(400);
    expect((await get('admin', '/v1/search', { q: 'note', folder: 'x'.repeat(1025) })).status).toBe(400);
    expect((await get('admin', '/v1/search', { q: 'note', fields: 'x'.repeat(513) })).status).toBe(400);
    expect((await get('admin', '/v1/related', { path: 'x'.repeat(1025) })).status).toBe(400);
    expect((await get('admin', '/v1/stats', { tz: 'x'.repeat(65) })).status).toBe(400);
  });
});

describe('cross-cutting: no internals in error responses', () => {
  it('returns a bare 500 envelope without messages, stacks or paths', async () => {
    const search = env.app.search;
    const original = search.search.bind(search);
    search.search = async () => {
      throw new Error(`boom in ${env.vault}/Notes/Private/Secret.md`);
    };
    try {
      const res = await get('admin', '/v1/search', { q: 'x' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: { code: 'internal', message: 'Internal error', request_id: expect.any(String) } });
      expect(res.raw).not.toMatch(/boom|Secret|at .*\.ts|\/tmp\//);
    } finally {
      search.search = original;
    }
  });

  it('reports bad JSON bodies without parser internals', async () => {
    const res = await env.req('admin', { method: 'POST', url: '/v1/query', headers: { 'content-type': 'application/json' }, payload: '{"from": [' });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toMatch(/at .*\.(ts|js):\d+/);
  });
});

describe('bug 2 (medium) / cross-cutting: demo config', () => {
  it('binds the tailnet address by default, never 0.0.0.0', () => {
    expect(DEFAULT_HOST).toBe('100.66.44.47');
    expect(demoConfig({ vault: '/tmp/v' }).config.server.host).toBe('100.66.44.47');
    expect(demoConfig({ vault: '/tmp/v', host: '127.0.0.1' }).config.server.host).toBe('127.0.0.1');
  });

  it('generates fresh random tokens instead of published ones', () => {
    const a = demoConfig({ vault: '/tmp/v' });
    const b = demoConfig({ vault: '/tmp/v' });
    expect(a.tokens.admin).toMatch(/^vlt_[A-Za-z0-9_-]{43}$/);
    expect(a.tokens.admin).not.toBe(b.tokens.admin);
    expect(JSON.stringify(a.config)).not.toContain(a.tokens.admin);
    expect(Object.values(a.tokens).some((t) => t.includes('demo'))).toBe(false);
  });

  it('keeps every demo account read-only', () => {
    for (const a of Object.values(demoConfig({ vault: '/tmp/v' }).config.accounts)) {
      for (const level of Object.values(a.access)) expect(['read', 'none']).toContain(level);
    }
  });
});

describe('cross-cutting: malformed requests on a real socket', () => {
  it('answers raw non-ASCII URLs with the JSON envelope, not a stack trace', async () => {
    const { connect } = await import('node:net');
    await env.app.server.listen({ host: '127.0.0.1', port: 0 });
    const { port } = env.app.server.server.address() as { port: number };
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => {
        sock.write(Buffer.concat([Buffer.from('GET /v1/search?q='), Buffer.from('печать', 'utf8'), Buffer.from(' HTTP/1.1\r\nHost: x\r\n\r\n')]));
      });
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('end', () => resolve(data));
      sock.on('error', reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    expect(reply).toContain('"code":"invalid_request"');
    expect(reply).not.toMatch(/at .*:\d+:\d+/);
  });
});
