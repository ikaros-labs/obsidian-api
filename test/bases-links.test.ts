import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

// Shaped like the eval vault's `datasources/Info Dump.base`: notes point back at their base
// through a wikilink-valued frontmatter property, and the base filters on it with `link()`.
const INFO_DUMP_BASE = `filters:
  and:
    - note["base"] == link("Info Dump.base")
views:
  - type: table
    name: Table View
    order:
      - file.name
`;

const NOTES: Record<string, string> = {
  'plain.md': '"[[Info Dump.base]]"',
  'alias.md': '"[[Info Dump.base|Info Dump]]"',
  'folder.md': '"[[datasources/Info Dump.base]]"',
  'list.md': '\n  - "[[Info Dump.base]]"',
  'other.md': '"[[Other.base]]"',
  'text.md': 'Info Dump.base is a plain string',
};

let env: TestEnv;
beforeAll(async () => {
  env = await setup({
    accounts: { agent: { access: { datasources: 'read' } }, narrow: { access: { 'datasources/Info Dump': 'read', 'datasources/Info Dump.base': 'read' } } },
    prepare: (vault) => {
      const dir = path.join(vault, 'datasources/Info Dump');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(vault, 'datasources/Info Dump.base'), INFO_DUMP_BASE);
      writeFileSync(path.join(vault, 'datasources/Other.base'), INFO_DUMP_BASE);
      for (const [name, base] of Object.entries(NOTES)) writeFileSync(path.join(dir, name), `---\nbase: ${base}\n---\n\nBody.\n`);
    },
  });
});
afterAll(() => env.cleanup());

const query = async (account: string, body: Record<string, unknown> = {}) => {
  const res = await env.req(account, { method: 'POST', url: `/v1/bases/${'datasources/Info%20Dump.base'}/query`, payload: body });
  expect(res.statusCode, res.body).toBe(200);
  const json = res.json();
  return (json.results as { values: Record<string, unknown> }[]).map((r) => r.values['file.name']).sort();
};

const adhoc = async (filters: string) => {
  const res = await env.req('agent', { method: 'POST', url: '/v1/query', payload: { filters: `file.inFolder("datasources/Info Dump") && ${filters}`, select: ['file.name'] } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().results as { values: Record<string, unknown> }[]).map((r) => r.values['file.name']).sort();
};

describe('link() against wikilink-valued frontmatter', () => {
  it('matches [[X]], [[X|alias]] and [[folder/X]] like Obsidian', async () => {
    expect(await query('agent')).toEqual(['alias', 'folder', 'plain']);
  });

  it('a list of wikilinks contains the link', async () => {
    expect(await adhoc('note["base"].contains(link("Info Dump.base"))')).toEqual(['list']);
  });

  it('file.hasLink sees frontmatter links', async () => {
    expect(await adhoc('file.hasLink(link("Info Dump.base"))')).toEqual(['alias', 'folder', 'list', 'plain']);
  });

  it('the property still reads as the link it was written as', async () => {
    const res = await env.req('agent', {
      method: 'POST',
      url: `/v1/bases/${'datasources/Info%20Dump.base'}/query`,
      payload: { select: ['base'], filters: 'file.name == "alias"' },
    });
    expect(res.json().results[0].values.base).toBe('[[Info Dump.base|Info Dump]]');
  });

  it('works for an account that cannot see the whole folder tree', async () => {
    expect(await query('narrow')).toEqual(['alias', 'folder', 'plain']);
  });
});
