import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

// F-18: time-zone spellings from requests must not pile up in a process-lifetime cache.
describe('time-zone formatter cache', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ accounts: { ro: { rate_limit: '1000/min', access: { '.': 'read' } } } });
  });
  afterAll(() => {
    vi.restoreAllMocks();
    return env.cleanup();
  });

  // Measured from outside, the same way on any revision: a formatter that is still cached is not
  // built again. After 200 other spellings the first one must have been dropped.
  it('does not keep a formatter for every spelling it has seen', async () => {
    const name = 'america/argentina/comodrivadavia';
    const spelling = (i: number) => [...name].map((c, k) => (k < 8 && (i >> k) & 1 ? c.toUpperCase() : c)).join('');
    const built = vi.spyOn(Intl, 'DateTimeFormat');
    const buildsFor = async (tz: string) => {
      const before = built.mock.calls.filter((c) => c[1]?.timeZone === tz).length;
      const res = await env.req('ro', { method: 'GET', url: `/v1/stats?metric=created&tz=${encodeURIComponent(tz)}` });
      expect(res.statusCode).toBe(200);
      return built.mock.calls.filter((c) => c[1]?.timeZone === tz).length - before;
    };
    await buildsFor(spelling(0));
    const whileCached = await buildsFor(spelling(0));
    for (let i = 1; i < 200; i++) await buildsFor(spelling(i));
    expect(await buildsFor(spelling(0))).toBeGreaterThan(whileCached);
  });
});
