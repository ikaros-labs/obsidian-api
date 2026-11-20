import { describe, expect, it } from 'vitest';
import { mergeValue } from '../src/patch.js';
import { setup } from './helpers.js';

// Review round (with F-01): frontmatter keys are data. A merge reads and writes own properties only.
describe('frontmatter merge and special keys', () => {
  it('keeps __proto__ as a key at every depth, and reads nothing inherited', () => {
    const incoming = JSON.parse('{"a": {"__proto__": {"x": 1}, "b": 2}}') as Record<string, unknown>;
    const out = mergeValue({ a: { b: 1 } }, incoming) as { a: Record<string, unknown> };
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(Object.keys(out.a).sort()).toEqual(['__proto__', 'b']);
    expect((out.a as { x?: unknown }).x).toBeUndefined();
    expect(({} as { x?: unknown }).x).toBeUndefined();
  });

  it('frontmatter.merge of a key named like an inherited property sets that key', async () => {
    const env = await setup({ accounts: { w: { access: { '.': 'edit' } } } });
    try {
      await env.req('w', { method: 'PUT', url: '/v1/notes/m.md', payload: '---\na: 1\n---\nx\n', headers: { 'content-type': 'text/markdown' } });
      const res = await env.req('w', { method: 'PATCH', url: '/v1/notes/m.md', payload: { ops: [{ op: 'frontmatter.merge', value: { constructor: { k: 1 }, a: 2 } }] } });
      expect(res.statusCode).toBe(200);
      expect(res.json().frontmatter).toEqual({ a: 2, constructor: { k: 1 } });
    } finally {
      await env.cleanup();
    }
  });
});
