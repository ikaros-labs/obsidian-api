import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseWhere } from '../src/http/where.js';
import { setup, type TestEnv } from './helpers.js';

// F-03: parsing a `where` value must not backtrack on operator-free input.
describe('where parsing cost', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({ accounts: { ro: { access: { '.': 'read' } } } });
  });
  afterAll(() => env.cleanup());

  it('rejects a long operator-free value quickly', async () => {
    const t0 = performance.now();
    const res = await env.req('ro', { method: 'GET', url: `/v1/folders?where=${'+'.repeat(1500)}` });
    expect(res.statusCode).toBe(400);
    expect(performance.now() - t0).toBeLessThan(400);
    const t1 = performance.now();
    expect(() => parseWhere([' '.repeat(16000)])).toThrow(/Cannot parse where|too long/);
    expect(() => parseWhere([`${'a '.repeat(8000)}`])).toThrow(/Cannot parse where|too long/);
    expect(performance.now() - t1).toBeLessThan(400);
  });

  it('still parses the documented forms', () => {
    expect(parseWhere([' Status = Done ', 'Score>=4', 'Due<2026-12-01', 'Title!="a = b"'])).toEqual([
      { source: ' Status = Done ', key: 'Status', op: '=', value: 'Done' },
      { source: 'Score>=4', key: 'Score', op: '>=', value: '4' },
      { source: 'Due<2026-12-01', key: 'Due', op: '<', value: '2026-12-01' },
      { source: 'Title!="a = b"', key: 'Title', op: '!=', value: 'a = b' },
    ]);
    for (const bad of ['Status', '=x', 'Status==x', 'Score=>3', 'Score>abc']) expect(() => parseWhere([bad])).toThrow();
  });
});
