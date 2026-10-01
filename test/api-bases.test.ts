import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASES_FIXTURE, setup, type TestEnv } from './helpers.js';

const ALL = ['read', 'create', 'update', 'delete'];
const ACCOUNTS = {
  admin: { access: { '.': ALL } },
  // Can read the library and both bases, but not Deep Work or Private.
  reader: {
    access: {
      'datasources/Library': 'read',
      'datasources/Library/Deep Work.md': 'none',
      'Library.base': 'read',
      'Formulas.base': 'read',
      'Hub.md': 'read',
    },
  },
  nobase: { access: { 'datasources/Library': 'read' } },
  rooted: { root: 'datasources/Library', access: { '.': 'read' } },
};

let env: TestEnv;
beforeEach(async () => {
  env = await setup({ fixture: BASES_FIXTURE, accounts: ACCOUNTS });
});
afterEach(() => env.cleanup());

const query = async (account: string, base: string, body: Record<string, unknown> = {}) => {
  const res = await env.req(account, { method: 'POST', url: `/v1/bases/${encodeURIComponent(base)}/query`, payload: body });
  return { status: res.statusCode, body: res.json() };
};
const names = (body: { results: { values: Record<string, unknown> }[] }) => body.results.map((r) => r.values['file.name']);

describe('GET /v1/bases', () => {
  it('returns the parsed base', async () => {
    const res = await env.req('reader', { method: 'GET', url: '/v1/bases/Library' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"sha256:/);
    const b = res.json();
    expect(b).toMatchObject({
      path: 'Library.base',
      filters: { and: ['file.folder == "datasources/Library"'] },
      properties: { 'file.name': { displayName: 'Name' } },
      diagnostics: [],
    });
    expect(b.views.map((v: { name: string }) => v.name)).toEqual(['To read', 'All items', 'Done articles']);
    expect(b.views[0]).toMatchObject({ type: 'table', group_by: { property: 'Type', direction: 'ASC' }, order: ['file.name', 'Score', 'Status', 'Type'] });
  });

  it('reports expressions that do not parse', async () => {
    const b = (await env.req('admin', { method: 'GET', url: '/v1/bases/Formulas.base' })).json();
    expect(b.diagnostics.length).toBeGreaterThan(0);
    expect(new Set(b.diagnostics.map((d: { where: string }) => d.where))).toEqual(new Set(['views[2].filters']));
  });

  it('needs read on the base file', async () => {
    expect((await env.req('nobase', { method: 'GET', url: '/v1/bases/Library' })).statusCode).toBe(404);
    expect((await env.req('rooted', { method: 'GET', url: '/v1/bases/Library' })).statusCode).toBe(404);
  });
});

describe('POST /v1/bases/{path}/query', () => {
  it('runs the first view: filters, grouping, columns and display names', async () => {
    const { status, body } = await query('admin', 'Library.base');
    expect(status).toBe(200);
    expect(body.base).toBe('Library.base');
    expect(body.view).toEqual({ name: 'To read', type: 'table' });
    expect(body.columns).toEqual([
      { key: 'file.name', name: 'Name' },
      { key: 'Score', name: 'Score' },
      { key: 'Status', name: 'Status' },
      { key: 'Type', name: 'Type' },
    ]);
    // Archive/ is excluded by file.folder ==, Private/Diary by the folder filter.
    expect(names(body)).toEqual(['Attention', 'Deep Work', 'Rust Book']);
    expect(body.groups).toEqual([
      { key: 'Article', count: 1 },
      { key: 'Book', count: 2 },
    ]);
    expect(body.results[0]).toEqual({
      path: 'datasources/Library/Attention.md',
      group: 'Article',
      values: { 'file.name': 'Attention', Score: 5, Status: 'Not started', Type: 'Article' },
    });
    expect(body.total).toBe(3);
    expect(body.diagnostics).toEqual([]);
  });

  it('sorts by a date property (typed via .obsidian/types.json)', async () => {
    const { body } = await query('admin', 'Library.base', { view: 'Done articles' });
    expect(names(body)).toEqual(['New Post', 'Old Post']);
    expect(body.results[0].values.Completed).toBe('2026-09-20');
  });

  it('also sorts dates correctly without types.json, by recognising ISO dates', async () => {
    rmSync(path.join(env.vault, '.obsidian/types.json'));
    const { body } = await query('admin', 'Library.base', { view: 'Done articles', filters: 'Completed > date("2026-08-01")' });
    expect(names(body)).toEqual(['New Post', 'Old Post']);
  });

  it('includes non-note files, like Obsidian', async () => {
    const { body } = await query('admin', 'Library.base', { view: 'All items' });
    expect(body.results.map((r: { path: string }) => r.path)).toContain('datasources/Library/cover.png');
    expect(body.total).toBe(8);
  });

  it('takes extra filters, sort and select', async () => {
    const { body } = await query('admin', 'Library.base', {
      view: 'All items',
      filters: 'Score >= 4',
      sort: [{ property: 'Score', direction: 'desc' }],
      select: ['file.name', 'Score'],
    });
    expect(body.results.map((r: { values: unknown }) => r.values)).toEqual([
      { 'file.name': 'Attention', Score: 5 },
      { 'file.name': 'Deep Work', Score: 4 },
      { 'file.name': 'New Post', Score: 4 },
    ]);
  });

  it('pages with cursors, samples, counts and includes', async () => {
    const first = await query('admin', 'Library.base', { view: 'All items', limit: 3 });
    expect(first.body.results).toHaveLength(3);
    const second = await query('admin', 'Library.base', { view: 'All items', limit: 3, cursor: first.body.next_cursor });
    expect(names(second.body).some((n) => names(first.body).includes(n))).toBe(false);
    expect((await query('admin', 'Library.base', { view: 'To read', limit: 3, cursor: first.body.next_cursor })).status).toBe(400);

    const a = await query('admin', 'Library.base', { view: 'All items', sample: 2, seed: 'x', include: ['frontmatter', 'body'] });
    const b = await query('admin', 'Library.base', { view: 'All items', sample: 2, seed: 'x' });
    expect(names(a.body)).toEqual(names(b.body));
    expect(a.body.results[0]).toHaveProperty('frontmatter');

    const count = await query('admin', 'Library.base', { count_only: true });
    expect(count.body).toMatchObject({ total: 3, groups: [{ key: 'Article', count: 1 }, { key: 'Book', count: 2 }] });
    expect(count.body.results).toBeUndefined();
  });

  it('applies formulas, formula sorting and the view limit', async () => {
    const { body } = await query('admin', 'Formulas.base');
    expect(body.results.map((r: { values: unknown }) => r.values)).toEqual([
      { 'file.name': 'Attention', 'formula.double': 10 },
      { 'file.name': 'Deep Work', 'formula.double': 8 },
    ]);
    expect(body.total).toBe(2);
  });

  it('evaluates `this`, defaulting to the base itself', async () => {
    const hub = await query('admin', 'Formulas.base', { view: 'Linked from this', this: 'Hub.md' });
    expect(names(hub.body).sort()).toEqual(['Attention', 'Deep Work']);
    const self = await query('admin', 'Formulas.base', { view: 'Linked from this' });
    expect(self.body.total).toBe(0);
    expect((await query('reader', 'Formulas.base', { view: 'Linked from this', this: 'Private/Diary.md' })).status).toBe(404);
  });

  it('reports a broken view filter and returns no rows', async () => {
    const { status, body } = await query('admin', 'Formulas.base', { view: 'Broken' });
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.diagnostics[0]).toMatchObject({ where: 'views.Broken.filters' });
  });

  it('counts runtime errors per expression', async () => {
    const { body } = await query('admin', 'Library.base', { view: 'All items', filters: 'Status.lower() != "x"' });
    // Rows without a Status (No Status, cover.png) fail at runtime and are filtered out.
    expect(body.total).toBe(6);
    expect(body.diagnostics).toEqual([{ where: 'request.filters', message: expect.any(String), rows: 2 }]);
  });

  it('rejects unknown views and invalid request filters', async () => {
    const view = await query('admin', 'Library.base', { view: 'Nope' });
    expect(view.status).toBe(400);
    expect(view.body.error.details.available_views).toEqual(['To read', 'All items', 'Done articles']);
    const filter = await query('admin', 'Library.base', { filters: 'Score >' });
    expect(filter.status).toBe(400);
    expect(filter.body.error.details.diagnostics[0]).toMatchObject({ where: 'filters', message: expect.any(String) });
  });
});

describe('scoping', () => {
  it('only returns rows the account can read, in counts and groups too', async () => {
    const { body } = await query('reader', 'Library.base');
    expect(names(body)).toEqual(['Attention', 'Rust Book']);
    expect(body.groups).toEqual([
      { key: 'Article', count: 1 },
      { key: 'Book', count: 1 },
    ]);
  });

  it('scopes file lookups and backlinks', async () => {
    const formulas = { diary: 'file("Private/Diary.md").properties.Status', backlinked: 'file.backlinks.length' };
    const run = (account: string) =>
      env.req(account, {
        method: 'POST',
        url: '/v1/query',
        payload: { from: ['datasources/Library'], filters: 'file.name == "Attention"', formulas },
      });
    const admin = (await run('admin')).json();
    expect(admin.results[0].values).toEqual({ 'file.name': 'Attention', 'formula.diary': 'Private thoughts', 'formula.backlinked': 2 });
    const reader = (await run('reader')).json();
    // For a file it doesn't know, the library falls back to the current note's own properties.
    expect(reader.results[0].values).toEqual({ 'file.name': 'Attention', 'formula.diary': 'Not started', 'formula.backlinked': 1 });
  });
});

describe('POST /v1/query', () => {
  it('runs an ad-hoc view over folders', async () => {
    const res = await env.req('reader', {
      method: 'POST',
      url: '/v1/query',
      payload: {
        from: ['datasources/Library'],
        filters: { and: ['file.ext == "md"', 'Status == "Done"'] },
        group_by: { property: 'Type' },
        sort: [{ property: 'Completed', direction: 'DESC' }],
        select: ['file.name', 'Completed'],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from).toEqual(['datasources/Library']);
    expect(names(body)).toEqual(['New Post', 'Old Post', 'Podcast']);
    expect(body.groups).toEqual([
      { key: 'Article', count: 2 },
      { key: 'Podcast', count: 1 },
    ]);
  });

  it('searches subfolders and the whole scope by default', async () => {
    const res = await env.req('rooted', { method: 'POST', url: '/v1/query', payload: { filters: 'file.ext == "md"', select: ['file.name', 'file.path'] } });
    const body = res.json();
    expect(body.total).toBe(8); // seven notes plus Archive/Archived
    const archived = body.results.find((r: { path: string }) => r.path === 'Archive/Archived.md');
    // Expressions see vault paths; responses use paths relative to the account root.
    expect(archived.values['file.path']).toBe('datasources/Library/Archive/Archived.md');
  });

  it('returns 404 for folders outside the scope', async () => {
    expect((await env.req('reader', { method: 'POST', url: '/v1/query', payload: { from: ['Private'] } })).statusCode).toBe(404);
    expect((await env.req('reader', { method: 'POST', url: '/v1/query', payload: { from: ['Nope'] } })).statusCode).toBe(404);
  });
});
