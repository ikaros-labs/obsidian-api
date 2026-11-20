import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

// F-02: a caller's filter or formula gets a fixed budget; it can't hold the shared event loop.
describe('Bases expression budget', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ accounts: { one: { access: { 'Dashboards/eink.md': 'read' } }, admin: { access: { '.': 'read' } } } });
  });
  afterAll(() => env.cleanup());
  const query = async (account: string, payload: Record<string, unknown>) => {
    const t0 = performance.now();
    const res = await env.req(account, { method: 'POST', url: '/v1/query', payload });
    return { res, ms: performance.now() - t0 };
  };

  it('stops an expression that runs too long', async () => {
    const lists = (depth: number): string => (depth === 0 ? 'value' : `[1,2,3,4,5,6,7,8,9,10].map(${lists(depth - 1)})`);
    for (const filters of [`/(a+)+$/.matches("${'a'.repeat(28)}!")`, `${lists(7)}.length > 0`]) {
      const { res, ms } = await query('one', { count_only: true, filters });
      expect(res.statusCode, filters.slice(0, 40)).toBe(400);
      expect(res.json().error.message).toMatch(/too expensive/);
      expect(ms).toBeLessThan(3000);
    }
    const formula = await query('one', { formulas: { f: `/(a+)+$/.matches("${'a'.repeat(28)}!")` }, select: ['formula.f'] });
    expect(formula.res.statusCode).toBe(400);
    expect(formula.ms).toBeLessThan(3000);
  });

  it('refuses strings and lists far beyond what a note holds', async () => {
    const big = await query('one', { filters: '"a".repeat(800000).split("").map(value + index).length > 0', select: ['file.name'] });
    expect(big.res.statusCode).toBe(200);
    expect(JSON.stringify(big.res.json().diagnostics)).toMatch(/too large/);
    expect(big.ms).toBeLessThan(1500);
  });

  it('leaves ordinary queries alone', async () => {
    const { res } = await query('admin', { filters: '/art/.matches(file.name.lower())', formulas: { n: 'file.name.repeat(3).length' }, select: ['file.name', 'formula.n'] });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBeGreaterThan(0);
    expect(res.json().diagnostics).toEqual([]);
  });
});
