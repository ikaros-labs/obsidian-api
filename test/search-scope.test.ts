import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.js';

/**
 * Search, related notes, stats and metrics must never reveal anything from a note the account
 * can't read. Every hidden note here shares the word "quokka" with the one readable note
 * (Notes/Zoo.md) and carries the secret word "xylophone".
 */
const SECRET = 'xylophone';

let env: TestEnv;
beforeEach(async () => {
  env = await setup({
    vault: { exclude: ['Notes/Excluded'], follow_symlinks: true },
    stats: {
      folders: { private: 'Notes/Private', excluded: 'Notes/Excluded', notes: 'Notes' },
      properties: { secrets: { folder: 'Notes', property: 'secret' } },
    },
    accounts: {
      admin: { access: { '.': 'full' } },
      // Deepest grant wins: Notes is readable, Notes/Private is not.
      scoped: { root: 'Notes', access: { '.': 'read', Private: 'none' } },
      // Can only read one note; Notes is traverse-only.
      single: { access: { 'Notes/Zoo.md': 'read' } },
    },
    prepare(vault) {
      const w = (rel: string, text: string) => {
        mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
        writeFileSync(path.join(vault, rel), text);
      };
      w('Notes/Zoo.md', '# Zoo\n\nWe saw a quokka at the zoo. The quokka smiled.\n');
      w('Notes/Private/Quokka secret.md', `---\nsecret: ${SECRET}\n---\n# Quokka secret\n\nThe quokka password is ${SECRET}.\n`);
      w('Notes/.hidden.md', `# Hidden\n\nquokka ${SECRET} dotfile\n`);
      w('Notes/.stash/Stashed.md', `# Stashed\n\nquokka ${SECRET} dotfolder\n`);
      w('Notes/Excluded/Ex.md', `---\nsecret: ${SECRET}\n---\n# Ex\n\nquokka ${SECRET} excluded\n`);
      // A readable path that resolves into the unreadable folder.
      symlinkSync(path.join(vault, 'Notes/Private/Quokka secret.md'), path.join(vault, 'Notes/Link.md'));
    },
  });
});
afterEach(() => env.cleanup());

const get = async (account: string, url: string, query: Record<string, string> = {}) => {
  const res = await env.req(account, { method: 'GET', url, query });
  return { status: res.statusCode, text: res.body, body: res.headers['content-type']?.includes('json') ? res.json() : null };
};
const paths = (body: { results: { path: string }[] }) => body.results.map((r) => r.path);

describe('search scope', () => {
  it('admin sees the private note and its link, never dotfiles or excluded notes', async () => {
    const { body } = await get('admin', '/v1/search', { q: SECRET });
    expect(paths(body).sort()).toEqual(['Notes/Link.md', 'Notes/Private/Quokka secret.md']);
    expect((await get('admin', '/v1/search', { q: 'dotfile' })).body.total).toBe(0);
    expect((await get('admin', '/v1/search', { q: 'dotfolder' })).body.total).toBe(0);
    expect((await get('admin', '/v1/search', { q: 'excluded' })).body.total).toBe(0);
  });

  it('returns only readable notes, with snippets and matches from them alone', async () => {
    for (const q of ['quokka', 'quok*', 'quokka password', 'password', SECRET, 'xylo*', `"quokka password"`]) {
      const { status, body } = await get('scoped', '/v1/search', { q, match: 'any' });
      expect(status, q).toBe(200);
      expect(paths(body).every((p) => p === 'Zoo.md'), q).toBe(true);
      const results = JSON.stringify(body.results);
      expect(results, q).not.toContain(SECRET);
      expect(results, q).not.toContain('password');
    }
    expect((await get('scoped', '/v1/search', { q: 'quokka' })).body.results[0].snippet).toContain('quokka');
  });

  it('narrows to a traverse-only folder without widening the scope', async () => {
    const { body } = await get('single', '/v1/search', { q: 'quokka', folder: 'Notes' });
    expect(paths(body)).toEqual(['Notes/Zoo.md']);
    expect((await get('single', '/v1/search', { q: 'quokka', folder: 'Notes/Private' })).status).toBe(404);
    expect((await get('scoped', '/v1/search', { q: 'quokka', folder: 'Excluded' })).status).toBe(404);
    expect((await get('scoped', '/v1/search', { q: 'quokka', folder: '.stash' })).status).toBe(404);
  });
});

describe('related scope', () => {
  it('admin gets the hidden neighbours (the fixture is meaningful)', async () => {
    const { body } = await get('admin', '/v1/related', { path: 'Notes/Zoo.md' });
    expect(body.terms).toContain('quokka');
    expect(paths(body)).toContain('Notes/Private/Quokka secret.md');
  });

  it('never surfaces unreadable neighbours or terms only they share', async () => {
    for (const [account, p] of [['scoped', 'Zoo.md'], ['single', 'Notes/Zoo.md']] as const) {
      const { status, body, text } = await get(account, '/v1/related', { path: p });
      expect(status).toBe(200);
      expect(body.results).toEqual([]);
      expect(body.terms).toEqual([]); // "quokka" is only shared with hidden notes
      expect(text).not.toContain(SECRET);
    }
  });

  it('404s on unreadable sources, including through a symlink', async () => {
    for (const p of ['Link.md', 'Private/Quokka secret.md', '.hidden.md', 'Excluded/Ex.md']) {
      expect((await get('scoped', '/v1/related', { path: p })).status, p).toBe(404);
    }
  });
});

describe('stats and metrics scope', () => {
  it('counts only readable notes and hides unreachable counters and hidden property values', async () => {
    const { body, text } = await get('scoped', '/v1/stats');
    expect(body.notes).toBe(2); // Ideas.md, Zoo.md
    expect(body.folders).toEqual({ notes: { path: '', notes: 2 } });
    expect(body.properties).toEqual({ secrets: { path: '', property: 'secret', counts: { '(none)': 2 } } });
    expect(text).not.toContain(SECRET);
  });

  it('traverse-only accounts see a counter only with their readable notes', async () => {
    const { body } = await get('single', '/v1/stats');
    expect(body.notes).toBe(1);
    expect(body.folders).toEqual({ notes: { path: 'Notes', notes: 1 } });
    expect(body.properties.secrets.counts).toEqual({ '(none)': 1 });
  });

  it('metrics expose nothing hidden', async () => {
    const { status, text } = await get('scoped', '/v1/stats/metrics');
    expect(status).toBe(200);
    expect(text).toContain('spall_notes 2\n');
    for (const leak of [SECRET, 'Private', 'Excluded', 'excluded', 'private', '.stash']) expect(text).not.toContain(leak);
    const admin = await get('admin', '/v1/stats/metrics');
    expect(admin.text).toContain(`value="${SECRET}"`); // the fixture is meaningful
  });
});
