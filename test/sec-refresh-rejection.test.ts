import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

// F-06: a folder that disappears while the index is reading it must not end in an unhandled
// promise rejection (which stops a real server process).
describe('index refresh racing a delete', () => {
  let env: TestEnv;
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  beforeEach(async () => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    env = await setup({ accounts: { racer: { root: 'Research', access: { '.': 'full' } } } });
  });
  afterEach(async () => {
    process.off('unhandledRejection', onUnhandled);
    await env.cleanup();
  });

  it('creating and deleting the same folder at once never rejects unhandled', async () => {
    const turns = (n: number) => new Promise<void>((r) => { const step = (k: number) => (k === 0 ? r() : setImmediate(() => step(k - 1))); step(n); });
    const statuses = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const create = env.req('racer', { method: 'POST', url: `/v1/folders/F${i}` });
      const deletes = [];
      for (let k = 0; k < 6; k++) {
        deletes.push(env.req('racer', { method: 'DELETE', url: `/v1/folders/F${i}` }));
        await turns(2);
      }
      for (const res of await Promise.all([create, ...deletes])) statuses.add(res.statusCode);
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
    expect([...statuses].filter((s) => s >= 500)).toEqual([]);
  });
});
