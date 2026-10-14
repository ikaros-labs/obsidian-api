import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventually, setup, writeConfig, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await setup({
    prepare(vault) {
      writeFileSync(
        path.join(vault, 'Notes/Принтер.md'),
        '---\nauthor: Иван\n---\n# Принтер\n\nНастройка 3д принтера и печать деталей для башни.\n',
      );
      writeFileSync(path.join(vault, 'Notes/Private/Printer secrets.md'), '# Printer secrets\n\nThe printer password is hunter2.\n');
      mkdirSync(path.join(vault, 'Research/inbox/deep'), { recursive: true });
      writeFileSync(path.join(vault, 'Research/inbox/deep/Printers.md'), '# Printers\n\nComparing printers: Prusa vs Bambu printer.\n');
      writeFileSync(path.join(vault, 'Research/Resin.md'), '# Resin\n\nResin printers vs filament: Prusa SL1, Elegoo. Resin smell.\n');
    },
  });
});
afterEach(() => env.cleanup());

const search = async (account: Parameters<TestEnv['req']>[0], query: Record<string, string>) => {
  const res = await env.req(account, { method: 'GET', url: '/v1/search', query });
  return { status: res.statusCode, body: res.json() };
};
const paths = (body: { results: { path: string }[] }) => body.results.map((r) => r.path);

describe('GET /v1/search', () => {
  it('ranks by BM25 with title matches first and returns snippets', async () => {
    const { status, body } = await search('admin', { q: 'printer' });
    expect(status).toBe(200);
    expect(body.query).toBe('printer');
    // Both have it in the title; "Printers" repeats it in the body too.
    expect(paths(body)).toEqual(['Research/inbox/deep/Printers.md', 'Notes/Private/Printer secrets.md', 'Research/Resin.md']);
    expect(body.total).toBe(3);
    expect(body.results[0]).toMatchObject({
      name: 'Printers',
      score: expect.any(Number),
      matched: ['printer'],
      snippet: 'Comparing printers: Prusa vs Bambu printer.',
      tags: [],
      modified: expect.any(String),
    });
    expect(body.results[0].score).toBeGreaterThan(body.results[1].score);
    // A title match outranks a body-only one.
    const ranked = paths((await search('admin', { q: 'secret' })).body);
    expect(ranked).toEqual(['Notes/Private/Secret.md', 'Notes/Private/Printer secrets.md', 'Research/Plan.md']);
  });

  it('matches Russian inflections and frontmatter values', async () => {
    for (const q of ['принтер', 'принтеры', 'ПРИНТЕРОМ', 'печать', 'Иван']) {
      expect(paths((await search('admin', { q })).body)).toEqual(['Notes/Принтер.md']);
    }
    const { body } = await search('admin', { q: 'башни' });
    expect(body.results[0].snippet).toBe('Настройка 3д принтера и печать деталей для башни.');
  });

  it('matches tags and inline tags', async () => {
    expect(paths((await search('admin', { q: 'longread' })).body)).toEqual(['Reading List/Article One.md']);
    expect(paths((await search('admin', { q: 'private' })).body)).toEqual(['Notes/Private/Secret.md']);
    expect(paths((await search('admin', { q: 'research' })).body).sort()).toEqual(['Notes/Ideas.md', 'Research/Plan.md']);
  });

  it('requires every word by default and any word with match=any', async () => {
    expect(paths((await search('admin', { q: 'article links' })).body)).toEqual(['Reading List/Article Two.md']);
    const any = await search('admin', { q: 'article links', match: 'any' });
    expect(paths(any.body)).toEqual(['Reading List/Article Two.md', 'Reading List/Article One.md', 'Reading List/Archive/Old.md', 'Research/Plan.md']);
  });

  it('supports prefix queries', async () => {
    expect(paths((await search('admin', { q: 'прин*' })).body)).toEqual(['Notes/Принтер.md']);
    expect(paths((await search('admin', { q: 'longr*' })).body)).toEqual(['Reading List/Article One.md']);
    expect((await search('admin', { q: 'artic*' })).body.total).toBe((await search('admin', { q: 'article' })).body.total);
  });

  it('never returns notes outside the account grants', async () => {
    const agent = await search('agent', { q: 'printer' });
    expect(paths(agent.body)).toEqual(['Research/inbox/deep/Printers.md', 'Research/Resin.md']);
    expect(agent.body.total).toBe(2);
    expect((await search('agent', { q: 'hunter2' })).body.total).toBe(0);
    expect((await search('eink', { q: 'printer' })).body.total).toBe(0);
    expect(paths((await search('eink', { q: 'scheduled' })).body)).toEqual(['Dashboards/eink.md']);
  });

  it('computes scores from visible notes only', async () => {
    // With the private note hidden, "printer" is rarer for the agent than for admin, so the
    // shared note must score differently: hidden documents don't feed the statistics.
    const admin = (await search('admin', { q: 'printer' })).body.results.find((r: { path: string }) => r.path.endsWith('deep/Printers.md'));
    const agent = (await search('agent', { q: 'printer' })).body.results[0];
    expect(agent.score).not.toBe(admin.score);
  });

  it('returns paths relative to the account root', async () => {
    const { body } = await search('bot', { q: 'article' });
    expect(paths(body).sort()).toEqual(['Archive/Old.md', 'Article One.md', 'Article Two.md']);
  });

  it('narrows to a folder and 404s on folders the account cannot see', async () => {
    expect(paths((await search('admin', { q: 'printer', folder: 'Research/inbox' })).body)).toEqual(['Research/inbox/deep/Printers.md']);
    expect((await search('agent', { q: 'printer', folder: 'Notes/Private' })).status).toBe(404);
    expect((await search('agent', { q: 'printer', folder: 'Nope' })).status).toBe(404);
  });

  it('paginates with cursors and projects fields', async () => {
    const first = await search('admin', { q: 'plan', limit: '2', fields: 'path' });
    expect(first.body.total).toBe(3);
    expect(first.body.results).toEqual([{ path: expect.any(String) }, { path: expect.any(String) }]);
    expect(first.body.has_more).toBe(true);
    const second = await search('admin', { q: 'plan', limit: '2', fields: 'path', cursor: first.body.next_cursor });
    expect(second.body.results).toHaveLength(1);
    expect(paths(first.body)).not.toContain(second.body.results[0].path);
    expect(second.body.has_more).toBe(false);
    const wrong = await search('admin', { q: 'other', cursor: first.body.next_cursor });
    expect(wrong.status).toBe(400);
  });

  it('validates the query', async () => {
    expect((await search('admin', {})).status).toBe(400);
    expect((await search('admin', { q: '   ' })).status).toBe(400);
    expect((await search('admin', { q: 'x', limit: '1000' })).status).toBe(400);
    expect((await search(null, { q: 'printer' })).status).toBe(401);
    expect((await search('admin', { q: 'и в на' })).body).toMatchObject({ total: 0, results: [] });
  });

  it('follows API writes', async () => {
    expect((await search('admin', { q: 'zeppelin' })).body.total).toBe(0);
    const put = await env.req('admin', {
      method: 'PUT',
      url: '/v1/notes/Notes/Airships.md',
      headers: { 'content-type': 'text/markdown' },
      payload: '# Airships\n\nA zeppelin note.\n',
    });
    expect(put.statusCode).toBe(201);
    expect(paths((await search('admin', { q: 'zeppelin' })).body)).toEqual(['Notes/Airships.md']);
    await env.req('admin', {
      method: 'PUT',
      url: '/v1/notes/Notes/Airships.md',
      headers: { 'content-type': 'text/markdown' },
      payload: '# Airships\n\nBlimps only.\n',
    });
    expect((await search('admin', { q: 'zeppelin' })).body.total).toBe(0);
    expect((await search('admin', { q: 'blimp' })).body.total).toBe(1);
    await env.req('admin', { method: 'DELETE', url: '/v1/notes/Notes/Airships.md?permanent=true' });
    expect((await search('admin', { q: 'blimp' })).body.total).toBe(0);
  });
});

describe('phrases and exclusions', () => {
  it('matches phrases only when the words are consecutive', async () => {
    expect(paths((await search('admin', { q: '"bambu printer"' })).body)).toEqual(['Research/inbox/deep/Printers.md']);
    expect((await search('admin', { q: '"printer bambu"' })).body.total).toBe(0);
    // Stopwords inside a phrase are skipped on both sides.
    expect(paths((await search('admin', { q: '"call the bank"' })).body)).toEqual(['Inbox.md']);
    // A phrase doesn't run from one field (title) into the next (frontmatter).
    expect((await search('admin', { q: 'принтер иван' })).body.total).toBe(1);
    expect((await search('admin', { q: '"принтер иван"' })).body.total).toBe(0);
    // Russian phrases are stemmed.
    expect(paths((await search('admin', { q: '"печать деталями"' })).body)).toEqual(['Notes/Принтер.md']);
  });

  it('excludes words, phrases and prefixes', async () => {
    expect(paths((await search('admin', { q: 'printer -resin' })).body)).toEqual(['Research/inbox/deep/Printers.md', 'Notes/Private/Printer secrets.md']);
    expect(paths((await search('admin', { q: 'printer -"bambu printer"' })).body)).toEqual(['Notes/Private/Printer secrets.md', 'Research/Resin.md']);
    expect(paths((await search('admin', { q: 'printer -hunt* -res*' })).body)).toEqual(['Research/inbox/deep/Printers.md']);
    expect(paths((await search('admin', { q: 'prusa -elegoo', match: 'any' })).body)).toEqual(['Research/inbox/deep/Printers.md']);
  });

  it('rejects a query that only excludes', async () => {
    const res = await search('admin', { q: '-printer' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not excluded/);
  });
});

describe('statistics cache', () => {
  it('reuses statistics per account and folder until the index changes', async () => {
    const c = env.app.search.cacheCounters;
    await search('admin', { q: 'printer' });
    const misses = c.misses;
    await search('admin', { q: 'resin' });
    await search('admin', { q: 'prusa' });
    expect(c.misses).toBe(misses);
    await search('agent', { q: 'printer' });
    await search('admin', { q: 'printer', folder: 'Research' });
    expect(c.misses).toBe(misses + 2);
    await env.req('admin', { method: 'PUT', url: '/v1/notes/Notes/New.md', headers: { 'content-type': 'text/markdown' }, payload: 'printer\n' });
    const after = await search('admin', { q: 'printer' });
    expect(c.misses).toBe(misses + 3);
    expect(after.body.total).toBe(4);
  });

  it('is rebuilt when the config reloads with new grants', async () => {
    expect((await search('agent', { q: 'hunter2' })).body.total).toBe(0);
    const accounts = { agent: { access: { '.': 'read' } } };
    writeConfig(env.configPath, env.vault, { audit: env.auditPath, accounts });
    expect(env.configs.reload()).toBe(true);
    expect((await search('agent', { q: 'hunter2' })).body.total).toBe(1);
  });
});

describe('GET /v1/related', () => {
  const related = async (account: Parameters<TestEnv['req']>[0], query: Record<string, string>) => {
    const res = await env.req(account, { method: 'GET', url: '/v1/related', query });
    return { status: res.statusCode, body: res.json() };
  };

  it('ranks notes that share the most distinctive terms', async () => {
    const { status, body } = await related('admin', { path: 'Research/inbox/deep/Printers' });
    expect(status).toBe(200);
    expect(body.path).toBe('Research/inbox/deep/Printers.md');
    expect(body.terms).toEqual(expect.arrayContaining(['printer', 'prusa']));
    expect(body.terms).not.toContain('bambu'); // no other note has it
    expect(paths(body)[0]).toBe('Research/Resin.md');
    expect(paths(body)).not.toContain('Research/inbox/deep/Printers.md');
    expect(body.results[0].matched).toEqual(expect.arrayContaining(['printer', 'prusa']));
  });

  it('only uses and returns notes the account can read', async () => {
    const admin = await related('admin', { path: 'Research/Resin.md' });
    expect(paths(admin.body)).toContain('Notes/Private/Printer secrets.md');
    const agent = await related('agent', { path: 'Research/Resin.md' });
    expect(paths(agent.body)).not.toContain('Notes/Private/Printer secrets.md');
    expect((await related('agent', { path: 'Notes/Private/Printer secrets.md' })).status).toBe(404);
    expect((await related('agent', { path: 'Nope.md' })).status).toBe(404);
    expect((await related('agent', { path: 'Research' })).status).toBe(404);
  });

  it('narrows candidates to a folder, pages and limits terms', async () => {
    const { body } = await related('admin', { path: 'Research/Resin.md', folder: 'Research/inbox', limit: '1', terms: '2', fields: 'path' });
    expect(body.terms).toHaveLength(2);
    expect(body.results).toEqual([{ path: 'Research/inbox/deep/Printers.md' }]);
    expect(body.has_more).toBe(false);
  });

  it('uses root-relative paths', async () => {
    const { body } = await related('bot', { path: 'Article Two' });
    expect(body.path).toBe('Article Two.md');
    expect(paths(body)).toContain('Article One.md');
    // Both have https://example.com/… URLs: URL fragments aren't used as similarity terms.
    expect(body.terms).toContain('example');
    expect(body.terms).not.toContain('https');
    expect(body.terms).not.toContain('com');
  });

  it('validates parameters', async () => {
    expect((await related('admin', {})).status).toBe(400);
    expect((await related('admin', { path: 'Inbox', limit: '0' })).status).toBe(400);
    expect((await related(null, { path: 'Inbox' })).status).toBe(401);
  });
});

describe('GET /v1/search with the watcher', () => {
  it('picks up files changed outside the API', async () => {
    const w = await setup({ watch: true });
    try {
      writeFileSync(path.join(w.vault, 'Notes/Outside.md'), '# Outside\n\nquokka sighting\n');
      await eventually(async () => {
        const res = await w.req('admin', { method: 'GET', url: '/v1/search?q=quokka' });
        return res.json().total === 1;
      });
    } finally {
      await w.cleanup();
    }
  });
});
