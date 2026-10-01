import { describe, expect, it } from 'vitest';
import { Access, expandLevel, type Perm } from '../src/access.js';
import { hasDotSegment, parsePlainPath, parseUrlPath, sanitizeTitle, withMdExtension } from '../src/paths.js';

const access = (grants: Record<string, string | Perm[]>, opts: { root?: string; exclude?: string[] } = {}) => {
  const root = parsePlainPath(opts.root ?? '');
  return new Access(
    root,
    Object.entries(grants).map(([key, level]) => {
      const segs = [...root, ...parsePlainPath(key)];
      return { key, segs, match: segs.map((s) => s.toLowerCase()), perms: expandLevel(level as never) };
    }),
    (opts.exclude ?? []).map(parsePlainPath),
  );
};
const perms = (a: Access, p: string) => [...a.perms(parsePlainPath(p))].sort();

describe('paths', () => {
  it('parses percent-encoded URL paths', () => {
    expect(parseUrlPath('Research/Some%20note.md')).toEqual(['Research', 'Some note.md']);
    expect(parseUrlPath('Research/')).toEqual(['Research']);
    expect(parseUrlPath('')).toEqual([]);
  });

  it.each([
    ['../etc/passwd'],
    ['a/../b'],
    ['a/./b'],
    ['a%2Fb'],
    ['a%5Cb'],
    ['a//b'],
    ['a%00b'],
    ['%E0%A4%A'],
  ])('rejects %s', (raw) => {
    expect(() => parseUrlPath(raw)).toThrow();
  });

  it('normalises to NFC', () => {
    expect(parseUrlPath(encodeURIComponent('Café.md'))).toEqual(['Café.md']);
  });

  it('flags dot segments in all their disguises', () => {
    for (const p of [['.git'], ['a', '.obsidian', 'x'], ['.Git'], ['a', ' .git'], ['...']]) expect(hasDotSegment(p)).toBe(true);
    expect(hasDotSegment(['a.b', 'c.md'])).toBe(false);
  });

  it('adds .md only when missing', () => {
    expect(withMdExtension(['a', 'b'])).toEqual(['a', 'b.md']);
    expect(withMdExtension(['a', 'b.MD'])).toEqual(['a', 'b.MD']);
  });

  it('sanitises titles', () => {
    expect(sanitizeTitle('How LLMs work: part 1/3')).toBe('How LLMs work part 1-3');
    expect(sanitizeTitle('  ..hidden?  ')).toBe('hidden');
    expect(sanitizeTitle('[[#^|]]')).toBe('Untitled');
  });
});

describe('access', () => {
  const a = access({ Research: 'edit', 'Research/inbox': 'full', Notes: 'read', 'Notes/Private': 'none', 'Reading List.base': 'read' });

  it('uses the deepest matching key', () => {
    expect(perms(a, 'Research/Plan.md')).toEqual(['create', 'read', 'update']);
    expect(perms(a, 'Research/inbox/x.md')).toEqual(['create', 'delete', 'read', 'update']);
    expect(perms(a, 'Notes/Ideas.md')).toEqual(['read']);
    expect(perms(a, 'Notes/Private/Secret.md')).toEqual([]);
    expect(perms(a, 'Reading List.base')).toEqual(['read']);
  });

  it('denies anything without a key', () => {
    expect(perms(a, 'Inbox.md')).toEqual([]);
    expect(perms(a, 'Researcher/x.md')).toEqual([]);
  });

  it('matches case-insensitively and ignores trailing dots/spaces', () => {
    expect(perms(a, 'notes/private/Secret.md')).toEqual([]);
    expect(perms(a, 'Notes/Private./Secret.md')).toEqual([]);
    expect(perms(a, 'NOTES/Ideas.md')).toEqual(['read']);
  });

  it('always denies dotfiles, even under a full grant', () => {
    const all = access({ '.': 'full' });
    expect(perms(all, '.obsidian/app.json')).toEqual([]);
    expect(perms(all, 'a/.git/config')).toEqual([]);
    expect(perms(all, 'a/.Git/config')).toEqual([]);
  });

  it('applies vault.exclude', () => {
    const ex = access({ '.': 'full' }, { exclude: ['Private'] });
    expect(perms(ex, 'Private/x.md')).toEqual([]);
    expect(perms(ex, 'private/x.md')).toEqual([]);
    expect(perms(ex, 'Public/x.md')).toHaveLength(4);
  });

  it('confines an account to its root', () => {
    const r = access({ '.': 'read', sub: 'edit' }, { root: 'Reading List' });
    expect(perms(r, 'Reading List/a.md')).toEqual(['read']);
    expect(perms(r, 'Reading List/sub/a.md')).toEqual(['create', 'read', 'update']);
    expect(perms(r, 'Inbox.md')).toEqual([]);
    expect(r.decide(parsePlainPath('Inbox.md')).reason).toBe('outside_root');
  });

  it('shows parent folders of a read grant, but nothing else', () => {
    expect(a.leadsToReadable(parsePlainPath(''))).toBe(true);
    expect(a.leadsToReadable(parsePlainPath('Notes'))).toBe(false); // readable itself, no deeper read grant
    const deep = access({ 'A/B/C': 'read', 'X/Y': 'append' });
    expect(deep.leadsToReadable(parsePlainPath('A'))).toBe(true);
    expect(deep.leadsToReadable(parsePlainPath('A/B'))).toBe(true);
    expect(deep.leadsToReadable(parsePlainPath('A/Z'))).toBe(false);
    expect(deep.leadsToReadable(parsePlainPath('X'))).toBe(false); // append grants aren't navigable
  });

  it('append is create-only', () => {
    expect(perms(access({ '.': 'append' }), 'x.md')).toEqual(['create']);
  });
});
