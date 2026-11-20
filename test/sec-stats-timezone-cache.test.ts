import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as stats from '../src/stats.js';
import { setup, type TestEnv } from './helpers.js';

// F-18: time-zone spellings from requests must not pile up in a process-lifetime cache.
describe('time-zone formatter cache', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ accounts: { ro: { rate_limit: '1000/min', access: { '.': 'read' } } } });
  });
  afterAll(() => env.cleanup());

  it('stays bounded over many spellings of one zone', async () => {
    const name = 'america/argentina/comodrivadavia';
    for (let i = 0; i < 200; i++) {
      // 200 letter-case spellings of the same zone.
      const spelled = [...name].map((c, k) => (k < 8 && (i >> k) & 1 ? c.toUpperCase() : c)).join('');
      const res = await env.req('ro', { method: 'GET', url: `/v1/stats?metric=created&tz=${encodeURIComponent(spelled)}` });
      expect(res.statusCode).toBe(200);
    }
    expect(stats.cachedFormatters()).toBeLessThanOrEqual(32);
  });
});
