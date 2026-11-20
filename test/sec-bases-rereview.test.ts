import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { compileExpression, type RuntimeValue } from 'obsidian-bases-expression';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../src/bases/engine.js';
import { BASES_FIXTURE, setup, type TestEnv } from './helpers.js';

const calls = vi.hoisted(() => ({ compileFilter: [] as unknown[] }));
vi.mock('obsidian-bases-expression', async (importOriginal) => {
  const lib = await importOriginal<typeof import('obsidian-bases-expression')>();
  return {
    ...lib,
    compileFilter: (filter: Parameters<typeof lib.compileFilter>[0]) => {
      calls.compileFilter.push(filter);
      return lib.compileFilter(filter);
    },
  };
});

const text = (s: string): RuntimeValue => ({ type: 'String', value: s });
const evaluate = (source: string, functions: Record<string, (...args: RuntimeValue[]) => RuntimeValue> = {}) =>
  compileExpression(source).evaluateValue({ functions } as never);
const message = (v: RuntimeValue) => (v.type === 'Error' ? v.value.message : `(${v.type})`);

// F-02, re-review: sizes are what a value renders to, and nothing large is built to find that out.
describe('Bases allocation: checked before building', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts links and other rendered values at their rendered size', () => {
    const big = () => text('p'.repeat(90000));
    // 900 links to one long target: 900 small objects, 81 million characters once rendered.
    expect(message(evaluate('"a,".repeat(900).split(",").map(link(big())).length', { big }))).toMatch(/too much data|too large/);
    expect(message(evaluate('[link(big()), link(big())]', { big }))).toMatch(/too large/);
    expect(message(evaluate('[html(big()), image(big())]', { big }))).toMatch(/too large/);
    expect(evaluate('[link("a", "b"), link("c")].length').value).toBe(2);
  });

  it('join: every form is checked first, and the separator is evaluated once', () => {
    let ticks = 0;
    const tick = () => (ticks++, text('-'));
    expect(evaluate('["a", "b", "c"].join(tick())', { tick }).value).toBe('a-b-c');
    expect(ticks).toBe(1);

    const joined = vi.spyOn(Array.prototype, 'join');
    const wide = () => joined.mock.contexts.filter((a) => Array.isArray(a) && a.length === 3334).length;
    // No separator: the library joins with the text of its own error, about 50 characters.
    expect(message(evaluate('"a,".repeat(3333).split(",").join()'))).toMatch(/join\(\) is too large/);
    expect(message(evaluate('"a,".repeat(3333).split(",").join("b".repeat(40))'))).toMatch(/join\(\) is too large/);
    expect(wide()).toBe(0);
    expect(evaluate('"a,".repeat(3333).split(",").join("")').value).toBe('a'.repeat(3333));
    expect(wide()).toBe(1);
  });

  it('replace: the size is worked out and charged without running the replacement', () => {
    const replaced = vi.spyOn(String.prototype, 'replace');
    const ran = () => replaced.mock.contexts.filter((s) => typeof s === 'string' && s.length === 20000).length;
    // 8 million characters: under the old transient allowance, so it was built and then refused.
    expect(message(evaluate('"a".repeat(20000).replace(/a/g, "b".repeat(400))'))).toMatch(/replace\(\) is too large/);
    expect(message(evaluate('"a".repeat(20000).replace("a", "b".repeat(400))'))).toMatch(/replace\(\) is too large/);
    expect(message(evaluate('"a".repeat(20000).replace(/a/g, "$`")'))).toMatch(/replace\(\) is too large/);
    expect(ran()).toBe(0);
    // Exact, not a worst case: one match in a long string is fine whatever the replacement refers to.
    expect((evaluate('("a".repeat(19999) + "b").replace(/b/g, "$&$&-".repeat(50)).length').value)).toBe(19999 + 150);
    expect((evaluate('"a-b-c".replace("-", "+")').value)).toBe('a+b+c');
    expect((evaluate('"abc".replace("", "-")').value)).toBe('a-b-c');
    expect((evaluate('"aXbXc".replace(/x/i, "$&$&")').value)).toBe('aXXbXc');
    // Many replaces whose results are thrown away still add up.
    const many = evaluate('"x,".repeat(400).split(",").map("a".repeat(20000).replace(/a/g, "bbbb").length).length');
    expect(message(many)).toMatch(/too much data/);
  });

  it('other conversions are refused from the size of their operands', () => {
    const big = () => text('&'.repeat(30000));
    const escaped = vi.spyOn(String.prototype, 'replace');
    expect(message(evaluate('escapeHTML(big())', { big }))).toMatch(/escapeHTML\(\) is too large/);
    expect(escaped.mock.contexts.filter((s) => typeof s === 'string' && s.length === 30000).length).toBe(0);
    expect(message(evaluate('big() + big() + big() + big()', { big }))).toMatch(/\+ is too large/);
    expect(message(evaluate('now().format("LLLL ".repeat(400))'))).toMatch(/format\(\) is too large/);
    expect(evaluate('escapeHTML("a&b")').value).toBe('a&amp;b');
  });
});

// F-02, re-review: the budget covers the whole query, and nothing is compiled twice.
describe('Bases time: one budget for the whole query', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup({
      fixture: BASES_FIXTURE,
      accounts: { admin: { access: { '.': 'read' } } },
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Big'), { recursive: true });
        writeFileSync(path.join(vault, 'Big/note.md'), `---\nbig: "${'x'.repeat(150000)}"\nsmall: 1\n---\nbody\n`);
      },
    });
  });
  afterAll(() => env.cleanup());

  it('compiles a request filter once', async () => {
    const filters = 'file.name != "zz-compile-once"';
    for (const [url, payload] of [['/v1/query', { filters, select: ['file.name'] }], ['/v1/bases/Library/query', { filters }]] as const) {
      calls.compileFilter.length = 0;
      const res = await env.req('admin', { method: 'POST', url, payload });
      expect(res.statusCode).toBe(200);
      expect(calls.compileFilter.filter((f) => f === filters).length, url).toBe(1);
    }
  });

  // Simulated clock: every reading is `step` ms after the one before, so each piece of work that is
  // timed appears to take `step`. A base query has six: parsing the base, enumerating, filtering and
  // sorting, paging, the page's columns, shaping the response.
  it('times parsing the base, paging and shaping the response too', async () => {
    const real = performance.now.bind(performance);
    const withPhases = async (step: number) => {
      let readings = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => real() + readings++ * step);
      try {
        return await env.req('admin', { method: 'POST', url: '/v1/bases/Library/query', payload: {} });
      } finally {
        clock.mockRestore();
      }
    };
    expect((await withPhases(100)).statusCode).toBe(200);
    // 3 timed pieces before this round (900 ms, allowed), 6 now.
    const res = await withPhases(300);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/too expensive/);
  });

  it('a property larger than the limit is an error where an expression reads it, and only there', async () => {
    const run = async (formula: string) => (await env.req('admin', { method: 'POST', url: '/v1/query', payload: { from: ['Big'], formulas: { f: formula }, select: ['formula.f', 'small'] } })).json();
    const read = await run('big.contains("x")');
    expect(JSON.stringify(read.diagnostics)).toMatch(/too large/);
    expect(read.results[0].values.small).toBe(1);
    const other = await run('small + 1');
    expect(other.diagnostics).toEqual([]);
    expect(other.results[0].values).toEqual({ 'formula.f': 2, small: 1 });
  });
});
