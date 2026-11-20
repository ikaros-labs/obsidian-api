import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { project } from '../src/http/context.js';
import { setup, type TestEnv } from './helpers.js';

// F-01: `fields` must only address the response's own data, never Object.prototype.
describe('fields projection and object prototypes', () => {
  let env: TestEnv;
  beforeEach(async () => {
    env = await setup({ accounts: { writer: { access: { '.': 'edit' } }, reader: { access: { '.': 'read' } } } });
  });
  afterEach(async () => {
    delete (Object.prototype as Record<string, unknown>).polluted;
    delete (Object.prototype as Record<string, unknown>).authorization;
    await env.cleanup();
  });

  it('a __proto__ frontmatter key cannot be projected onto Object.prototype', async () => {
    const put = await env.req('writer', {
      method: 'PUT',
      url: '/v1/notes/evil.md',
      headers: { 'content-type': 'text/markdown' },
      payload: '---\n__proto__:\n  polluted: PWNED\n  authorization: "Bearer tok-writer"\n---\nhi\n',
    });
    expect(put.statusCode).toBe(201);
    for (const key of ['polluted', 'authorization']) {
      const res = await env.req('reader', { method: 'GET', url: `/v1/notes/evil.md?fields=frontmatter.__proto__.${key}`, headers: { accept: 'application/json' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({});
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(Object.prototype, 'authorization')).toBe(false);
    // A request without credentials stays unauthenticated.
    expect((await env.req(null, { method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
  });

  it('project() only follows own properties', () => {
    const obj = { a: { b: 1 }, tags: ['x'] };
    expect(project(obj, 'a.b,tags')).toEqual({ a: { b: 1 }, tags: ['x'] });
    expect(project(obj, 'a.constructor.name,a.toString,a.__proto__.toString,constructor')).toEqual({});
  });
});
