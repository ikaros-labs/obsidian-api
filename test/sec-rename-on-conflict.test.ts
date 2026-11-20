import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

// F-20: the name on_conflict=rename picks must be one the account may create, and must not depend
// on whether a path it can't see exists.
describe('on_conflict=rename and denied siblings', () => {
  const envs: TestEnv[] = [];
  afterEach(async () => {
    for (const e of envs.splice(0)) await e.cleanup();
  });
  const accounts = {
    writer: { access: { Book: 'full', 'Book/Chapter 1': 'none', 'Book/Plan 1.md': 'none' } },
    only: { access: { 'Solo/One.md': 'full' } },
  };
  const md = { 'content-type': 'text/markdown' };

  async function run(hiddenExist: boolean) {
    const env = await setup({
      accounts,
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Book'), { recursive: true });
        mkdirSync(path.join(vault, 'Solo'), { recursive: true });
        writeFileSync(path.join(vault, 'Solo/One.md'), 'one');
        if (hiddenExist) {
          mkdirSync(path.join(vault, 'Book/Chapter 1'));
          writeFileSync(path.join(vault, 'Book/Plan 1.md'), 'hidden');
        }
      },
    });
    envs.push(env);
    await env.req('writer', { method: 'PUT', url: '/v1/files/Book/Chapter', payload: 'taken' });
    await env.req('writer', { method: 'PUT', url: '/v1/files/Book/tmp', payload: 'mine' });
    const move = await env.req('writer', { method: 'POST', url: '/v1/files/Book/tmp/move', payload: { destination: 'Book/Chapter', on_conflict: 'rename' } });
    await env.req('writer', { method: 'POST', url: '/v1/notes', payload: { folder: 'Book', title: 'Plan', body: 'a' } });
    const create = await env.req('writer', { method: 'POST', url: '/v1/notes', payload: { folder: 'Book', title: 'Plan', body: 'b' } });
    await env.req('writer', { method: 'PUT', url: '/v1/notes/Book/Draft.md', payload: 'd', headers: md });
    const moveNote = await env.req('writer', { method: 'POST', url: '/v1/notes/Book/Draft/move', payload: { destination: 'Book/Plan', on_conflict: 'rename' } });
    return { env, results: [move, create, moveNote].map((r) => `${r.statusCode} ${r.json().path}`) };
  }

  it('picks the same allowed name whether or not the denied names exist, and never writes them', async () => {
    const present = await run(true);
    const absent = await run(false);
    expect(present.results).toEqual(['200 Book/Chapter 2', '201 Book/Plan 2.md', '200 Book/Plan 3.md']);
    expect(absent.results).toEqual(present.results);
    expect(existsSync(path.join(absent.env.vault, 'Book/Chapter 1'))).toBe(false);
    expect(existsSync(path.join(absent.env.vault, 'Book/Plan 1.md'))).toBe(false);
  });

  it('answers already_exists when no numbered name is allowed', async () => {
    const { env } = await run(false);
    const res = await env.req('only', { method: 'POST', url: '/v1/notes', payload: { folder: 'Solo', title: 'One', body: 'x' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('already_exists');
    expect(existsSync(path.join(env.vault, 'Solo/One 1.md'))).toBe(false);
  });
});
