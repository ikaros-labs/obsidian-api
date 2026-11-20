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

  // Review round: one budget for the whole query, not one per phase.
  it('counts filters and columns against the same budget', async () => {
    const slow = (k: number) => `!/(a+)+$/.matches("${'a'.repeat(k)}!")`;
    // Find an expression that takes 100 to 250 ms for one row on this machine.
    let k = 16;
    let one = 0;
    for (; k < 30; k++) {
      one = (await query('one', { count_only: true, filters: slow(k) })).ms;
      if (one >= 100) break;
    }
    const all = (await env.req('admin', { method: 'POST', url: '/v1/query', payload: { count_only: true } })).json().total as number;
    const rows = Math.min(all, Math.max(2, Math.round(700 / one)));
    const names = (await env.req('admin', { method: 'POST', url: '/v1/query', payload: { select: ['file.name'], limit: rows } })).json().results.map((r: { path: string }) => r.path);
    expect(names.length).toBe(rows);
    // About 0.7 s of filtering (the listed rows only) and 0.7 s of column values: each under a
    // second, together over it.
    const filters = `[${names.map((n: string) => JSON.stringify(n)).join(',')}].contains(file.path) && ${slow(k)}`;
    const { res } = await query('admin', { filters, formulas: { f: slow(k) }, select: ['formula.f'], limit: rows });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/too expensive/);
  });

  // Review round: sizes are checked before the operation that would build the value.
  it('refuses repeat, replace and join before they allocate', async () => {
    const cases: [string, RegExp][] = [
      ['"ab".repeat(400000000).length', /repeat\(\) is too large/],
      ['"a".repeat(20000).replace(/a/g, "b".repeat(20000)).length', /replace\(\) is too large/],
      ['"a".repeat(30000).replace(/a/g, "$`").length', /replace\(\) is too large/],
      ['"a,".repeat(10000).split(",").join("b".repeat(20000)).length', /join\(\) is too large/],
    ];
    for (const [formula, message] of cases) {
      const { res, ms } = await query('one', { formulas: { f: formula }, select: ['formula.f'] });
      expect(res.statusCode, formula).toBe(200);
      expect(res.json().diagnostics[0]?.message, formula).toMatch(message);
      expect(ms, formula).toBeLessThan(500);
    }
  });

  it('refuses many values that are each within the limit', async () => {
    const tens = '[0,1,2,3,4,5,6,7,8,9]';
    const { res } = await query('one', { formulas: { f: `${tens}.map(${tens}.map(${tens}.map("a".repeat(90000) + value))).length` }, select: ['formula.f'] });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json().diagnostics)).toMatch(/too large|too much data/);
    const ok = await query('one', { formulas: { f: '"a".repeat(1000).replace(/a/g, "$&$&").length', g: '["x","y"].join(", ")' }, select: ['formula.f', 'formula.g'] });
    expect(ok.res.json().diagnostics).toEqual([]);
    expect(ok.res.json().results[0].values).toEqual({ 'formula.f': 2000, 'formula.g': 'x, y' });
  });
});
