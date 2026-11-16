import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(() => env.cleanup());

describe('GET /openapi.json', () => {
  it('is served without a token and matches the committed openapi.json (run `npm run openapi`)', async () => {
    const res = await env.req(null, { method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const committed = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
    expect(res.json()).toEqual(committed);
  });

  it('documents every route', async () => {
    const doc = (await env.req(null, { method: 'GET', url: '/openapi.json' })).json();
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/v1/notes/{path}', '/v1/notes', '/v1/folders/{path}', '/v1/bases/{path}/query', '/v1/query', '/v1/search', '/v1/stats/metrics']),
    );
    expect(doc.paths['/v1/notes/{path}'].patch.requestBody.content['application/json'].schema.properties.ops).toBeDefined();
  });
});
