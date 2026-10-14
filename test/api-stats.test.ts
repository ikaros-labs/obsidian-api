import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileConfig, ConfigError, parseConfigText } from '../src/config.js';
import { FIXTURE, setup, type TestEnv } from './helpers.js';

const STATS = {
  timezone: 'UTC',
  folders: { inbox: 'Research/inbox', x_inbox: 'X/inbox', private: 'Notes/Private' },
  properties: { reading: { folder: 'Reading List', property: 'status' } },
};

let env: TestEnv;
beforeEach(async () => {
  env = await setup({
    stats: STATS,
    prepare(vault) {
      mkdirSync(path.join(vault, 'X/inbox'), { recursive: true });
      for (let i = 1; i <= 3; i++) writeFileSync(path.join(vault, `X/inbox/post ${i}.md`), `post ${i}\n`);
      writeFileSync(path.join(vault, 'Reading List/Article Three.md'), '---\nstatus: to-read\n---\nThree.\n');
      // Pin modification times so the per-day buckets are predictable.
      const pin = (rel: string, iso: string) => utimesSync(path.join(vault, rel), new Date(iso), new Date(iso));
      pin('Reading List/Article One.md', '2026-09-02T10:00:00Z');
      pin('Reading List/Article Two.md', '2026-09-02T18:00:00Z');
      pin('Reading List/Article Three.md', '2026-09-04T09:00:00Z');
      pin('Reading List/Archive/Old.md', '2026-08-15T09:00:00Z');
    },
  });
});
afterEach(() => env.cleanup());

const get = async (account: Parameters<TestEnv['req']>[0], url: string) => {
  const res = await env.req(account, { method: 'GET', url });
  return { status: res.statusCode, headers: res.headers, text: res.body, body: res.headers['content-type']?.includes('json') ? res.json() : null };
};

describe('GET /v1/stats', () => {
  it('returns note totals, created/modified per day and the configured counters', async () => {
    const { status, body } = await get('admin', '/v1/stats?from=2026-09-01&to=2026-09-04');
    expect(status).toBe(200);
    expect(body).toMatchObject({ folder: '', notes: 14, interval: 'day', from: '2026-09-01', to: '2026-09-04', timezone: 'UTC' });
    expect(body.modified).toEqual([
      { t: '2026-09-01', count: 0 },
      { t: '2026-09-02', count: 2 },
      { t: '2026-09-03', count: 0 },
      { t: '2026-09-04', count: 1 },
    ]);
    expect(body.created).toHaveLength(4);
    expect(body.folders).toEqual({
      inbox: { path: 'Research/inbox', notes: 1 },
      x_inbox: { path: 'X/inbox', notes: 3 },
      private: { path: 'Notes/Private', notes: 1 },
    });
    expect(body.properties).toEqual({
      reading: { path: 'Reading List', property: 'status', counts: { read: 2, 'to-read': 2 } },
    });
  });

  it('defaults to the last 30 days ending today in the configured time zone', async () => {
    const { body } = await get('admin', '/v1/stats');
    expect(body.modified).toHaveLength(30);
    expect(body.to).toBe(new Date().toISOString().slice(0, 10));
    // Files were just copied, so their birth times are today.
    expect(body.created.at(-1).count).toBeGreaterThan(0);
  });

  it('returns a single Grafana-friendly series with metric=', async () => {
    const { body } = await get('admin', '/v1/stats?metric=modified&interval=month&from=2026-08-01&to=2026-09-30&folder=Reading%20List');
    expect(body).toEqual({
      metric: 'modified',
      folder: 'Reading List',
      interval: 'month',
      from: '2026-08-01',
      to: '2026-09-30',
      timezone: 'UTC',
      buckets: [
        { t: '2026-08-01', count: 1 },
        { t: '2026-09-01', count: 3 },
      ],
    });
  });

  it('buckets by the requested time zone', async () => {
    const utc = await get('admin', '/v1/stats?metric=modified&from=2026-09-02&to=2026-09-03');
    const tokyo = await get('admin', '/v1/stats?metric=modified&from=2026-09-02&to=2026-09-03&tz=Asia/Tokyo');
    expect(utc.body.buckets.map((b: { count: number }) => b.count)).toEqual([2, 0]);
    expect(tokyo.body.buckets.map((b: { count: number }) => b.count)).toEqual([1, 1]);
  });

  it('scopes every number to what the account can read', async () => {
    const { body } = await get('agent', '/v1/stats?from=2026-09-01&to=2026-09-04');
    // Research/Plan, Research/inbox/Draft, Notes/Ideas.
    expect(body.notes).toBe(3);
    expect(body.modified.every((b: { count: number }) => b.count === 0)).toBe(true);
    // Counters on folders the account can't reach are left out entirely.
    expect(body.folders).toEqual({ inbox: { path: 'Research/inbox', notes: 1 } });
    expect(body.properties).toEqual({});
  });

  it('uses root-relative paths and omits counters outside the root', async () => {
    const { body } = await get('bot', '/v1/stats');
    expect(body.notes).toBe(4);
    expect(body.folders).toEqual({});
    expect(body.properties).toEqual({ reading: { path: '', property: 'status', counts: { read: 2, 'to-read': 2 } } });
  });

  it('gives a single-file grant its one note and no counters', async () => {
    const { body } = await get('eink', '/v1/stats');
    expect(body.notes).toBe(1);
    expect(body.folders).toEqual({});
  });

  it('validates parameters', async () => {
    expect((await get('admin', '/v1/stats?interval=year')).status).toBe(400);
    expect((await get('admin', '/v1/stats?from=yesterday')).status).toBe(400);
    expect((await get('admin', '/v1/stats?from=2026-09-05&to=2026-09-01')).status).toBe(400);
    expect((await get('admin', '/v1/stats?tz=Mars/Olympus')).status).toBe(400);
    expect((await get('admin', '/v1/stats?from=1900-01-01&to=2026-01-01')).status).toBe(400);
    expect((await get('agent', '/v1/stats?folder=Notes/Private')).status).toBe(404);
    expect((await get(null, '/v1/stats')).status).toBe(401);
  });
});

describe('GET /v1/stats/metrics', () => {
  it('serves Prometheus text', async () => {
    const { status, headers, text } = await get('admin', '/v1/stats/metrics');
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(text).toContain('# TYPE vault_notes gauge\nvault_notes 14\n');
    expect(text).toContain('vault_notes_created{window="24h"} 14\n');
    expect(text).toContain('vault_folder_notes{counter="x_inbox",path="X/inbox"} 3\n');
    expect(text).toContain('vault_property_notes{counter="reading",property="status",value="to-read"} 2\n');
    expect(text).toMatch(/^vault_last_modified_timestamp_seconds \d+$/m);
    for (const line of text.trimEnd().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? (\d+|NaN))$/);
    }
  });

  it('is scoped to the account', async () => {
    const { text } = await get('agent', '/v1/stats/metrics');
    expect(text).toContain('vault_notes 3\n');
    expect(text).not.toContain('x_inbox');
    expect(text).not.toContain('private');
    expect(text).not.toContain('vault_property_notes{');
  });

  it('requires a token', async () => {
    expect((await get(null, '/v1/stats/metrics')).status).toBe(401);
  });
});

describe('stats config', () => {
  const base = `version: 1\nvault:\n  path: ${FIXTURE}\n`;
  it('defaults to UTC and no counters', () => {
    const cfg = compileConfig(parseConfigText(base), '/tmp/x/vault-api.yaml');
    expect(cfg.stats).toEqual({ timezone: 'UTC', folders: [], properties: [] });
  });

  it('rejects bad names, paths and time zones', () => {
    expect(() => parseConfigText(`${base}stats:\n  folders:\n    X-Inbox: inbox\n`)).toThrow(ConfigError);
    expect(() => compileConfig(parseConfigText(`${base}stats:\n  timezone: Mars/Olympus\n`), '/tmp/x/vault-api.yaml')).toThrow(/time zone/);
    expect(() => compileConfig(parseConfigText(`${base}stats:\n  folders:\n    up: ../outside\n`), '/tmp/x/vault-api.yaml')).toThrow(ConfigError);
  });
});
