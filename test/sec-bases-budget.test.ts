import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Budget } from '../src/bases/engine.js';
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
    const regex = await query('one', { count_only: true, filters: `/(a+)+$/.matches("${'a'.repeat(28)}!")` });
    expect(regex.res.statusCode).toBe(400);
    expect(regex.res.json().error.message).toMatch(/too expensive/);
    expect(regex.ms).toBeLessThan(3000);
    // Ten million list items: stopped by the time budget or, sooner, by the allocation allowance.
    const nested = await query('one', { count_only: true, filters: `${lists(7)}.length > 0` });
    if (nested.res.statusCode === 400) expect(nested.res.json().error.message).toMatch(/too expensive/);
    else expect(JSON.stringify(nested.res.json().diagnostics)).toMatch(/too much data|too large/);
    expect(nested.ms).toBeLessThan(3000);
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

  // Review round: one budget for the whole query, not one per phase. The clock is simulated so the
  // result doesn't depend on the machine: every reading is `step` ms later than the one before, so
  // each piece of a query's work (compile, enumerate, filter and sort, columns) appears to take `step`.
  it('counts every phase of a query against the same budget', async () => {
    const real = performance.now.bind(performance);
    const payload = { filters: 'file.name != ""', formulas: { f: 'file.name.lower()' }, select: ['formula.f'], limit: 5 };
    const withPhases = async (step: number) => {
      let readings = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => real() + readings++ * step);
      try {
        return await env.req('admin', { method: 'POST', url: '/v1/query', payload });
      } finally {
        clock.mockRestore();
      }
    };
    // Four phases of 100 ms fit in the budget; four of 400 ms don't, though each one alone does.
    expect((await withPhases(100)).statusCode).toBe(200);
    const res = await withPhases(400);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/too expensive/);
  });

  it('Budget: time spent in one run is gone for the next', () => {
    const busy = (ms: number) => () => {
      const end = performance.now() + ms;
      while (performance.now() < end);
      return ms;
    };
    const budget = new Budget();
    expect(budget.run(busy(600))).toBe(600);
    const t0 = performance.now();
    expect(() => budget.run(busy(600))).toThrow(/too expensive/);
    expect(performance.now() - t0).toBeLessThan(550);
    expect(() => budget.run(busy(1))).toThrow(/too expensive/);
    expect(new Budget().run(busy(1))).toBe(1);
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
