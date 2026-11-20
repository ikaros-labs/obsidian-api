import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    // The fastest of three runs: other test files share the machine, and only the unloaded cost counts.
    const fastest = async (account: string, payload: Record<string, unknown>) => {
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const { res, ms } = await query(account, payload);
        if (res.statusCode === 200) best = Math.min(best, ms);
      }
      return best;
    };
    // An expression that takes 100 to 250 ms for one row on this machine.
    let k = 16;
    let one = 0;
    for (; k < 30; k++) {
      one = await fastest('one', { count_only: true, filters: slow(k) });
      if (one >= 100) break;
    }
    const paths = (await env.req('admin', { method: 'POST', url: '/v1/query', payload: { select: ['file.name'], limit: 50 } })).json().results.map((r: { path: string }) => r.path) as string[];
    let rows = Math.max(2, Math.round(800 / one));
    const only = (n: number) => `[${paths.slice(0, n).map((p) => JSON.stringify(p)).join(',')}].contains(file.path)`;
    // Filtering alone and the columns alone each fit the budget; together they are well over it.
    let filtering = 0;
    let columns = 0;
    for (let attempt = 0; attempt < 10; attempt++) {
      expect(rows).toBeLessThanOrEqual(paths.length);
      filtering = await fastest('admin', { count_only: true, filters: `${only(rows)} && ${slow(k)}` });
      columns = await fastest('admin', { filters: only(rows), formulas: { f: slow(k) }, select: ['formula.f'], limit: rows });
      if (Math.max(filtering, columns) === Infinity) rows = Math.max(2, Math.floor(rows * 0.8));
      else if (filtering + columns < 1500) rows = Math.max(rows + 1, Math.ceil((rows * 1600) / (filtering + columns)));
      else break;
    }
    expect(filtering + columns).toBeGreaterThan(1500);
    const { res } = await query('admin', { filters: `${only(rows)} && ${slow(k)}`, formulas: { f: slow(k) }, select: ['formula.f'], limit: rows });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/too expensive/);
  }, 60_000);

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
