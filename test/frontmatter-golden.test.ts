import { describe, expect, it } from 'vitest';
import { parseFrontmatter, splitFrontmatter } from '../src/markdown.js';
import { applyPatch, PatchOpSchema } from '../src/patch.js';

const patch = (text: string, ...raw: unknown[]) => applyPatch(text, raw.map((o) => PatchOpSchema.parse(o)));
const set = (key: string, value: unknown) => ({ op: 'frontmatter.set', key, value });

// The Reading List note from the agent evals (E01): no body, flow list, empty value.
const bitter = [
  '---',
  'Score: TBD',
  'Type: Article',
  'Status: Not started',
  'Link: http://www.incompleteideas.net/IncIdeas/BitterLesson.html',
  'Tags: [ai]',
  'Source: https://x.com/i/status/1897345120934761478',
  'Completed:',
  'Author: Rich Sutton',
  '---',
  '',
].join('\n');

// E03: quoted value, a key with a trailing space, a date.
const station = [
  '---',
  'Status: Active',
  'Category: [hardware]',
  'Next step: "Calibrate the humidity sensor"',
  'Repo: https://github.com/example/weather-station',
  'URL: ',
  'Last touched: 2026-11-12',
  '---',
  '',
  'Solar-powered weather station.',
  '',
].join('\n');

describe('frontmatter edits preserve untouched bytes (golden)', () => {
  it('E01: sets three keys, appends a review; only those lines change', () => {
    const out = patch(
      bitter,
      set('Status', 'Done'),
      set('Completed', '2026-11-20'),
      set('Score', '⭐️⭐️⭐️⭐️'),
      { op: 'append', content: '## Review\nThis changed how I think about scaling.' },
    );
    expect(out).toBe(
      [
        '---',
        'Score: ⭐️⭐️⭐️⭐️',
        'Type: Article',
        'Status: Done',
        'Link: http://www.incompleteideas.net/IncIdeas/BitterLesson.html',
        'Tags: [ai]',
        'Source: https://x.com/i/status/1897345120934761478',
        'Completed: 2026-11-20',
        'Author: Rich Sutton',
        '---',
        '',
        '## Review',
        'This changed how I think about scaling.',
        '',
      ].join('\n'),
    );
  });

  it('E03: keeps flow lists, quotes and trailing spaces on untouched keys, and the blank line', () => {
    const out = patch(station, set('Next step', 'Design the enclosure'), set('Last touched', '2026-11-20'));
    expect(out).toBe(
      station.replace('"Calibrate the humidity sensor"', '"Design the enclosure"').replace('2026-11-12', '2026-11-20'),
    );
  });

  it('a no-op set leaves the file byte-identical', () => {
    expect(patch(station, set('Status', 'Active'))).toBe(station);
  });

  it('keeps comments, key order, numbers, dates and odd spacing', () => {
    const text = '---\n# header comment\nb: 2   \na:   1 # inline\nwhen: 2024-01-02\nlist:\n  - x\n  - y\n\nlast: z\n---\n\nbody\n';
    expect(patch(text, set('a', 5))).toBe(text.replace('a:   1 # inline', 'a:   5 # inline'));
    expect(patch(text, set('last', 'q'))).toBe(text.replace('last: z', 'last: q'));
  });

  it('a flow list stays flow, without padding', () => {
    const out = patch(bitter, set('Tags', ['ai', 'ml']));
    expect(out).toBe(bitter.replace('Tags: [ai]', 'Tags: [ai, ml]'));
    const merged = patch(bitter, { op: 'frontmatter.merge', value: { Tags: ['scaling'] } });
    expect(merged).toBe(bitter.replace('Tags: [ai]', 'Tags: [ai, scaling]'));
  });

  it('a block list stays block, with its indentation replaced as a whole', () => {
    const text = '---\ntags:\n  - a\n  - b\nnext: 1\n---\nbody\n';
    expect(patch(text, { op: 'frontmatter.merge', value: { tags: ['c'] } })).toBe('---\ntags:\n  - a\n  - b\n  - c\nnext: 1\n---\nbody\n');
  });

  it('keeps the quoting style of a replaced string', () => {
    const text = "---\na: 'x'\nb: \"y\"\n---\n";
    expect(patch(text, set('a', 'p'), set('b', 'q'))).toBe("---\na: 'p'\nb: \"q\"\n---\n");
  });

  it('adds a new key at the end, leaving the rest alone', () => {
    expect(patch(station, set('Owner', 'me'))).toBe(station.replace('Last touched: 2026-11-12\n', 'Last touched: 2026-11-12\nOwner: me\n'));
  });

  it('unsets a key (and its block lines) only', () => {
    const text = '---\na: 1\nlist:\n  - x\n  - y\nb: [c]   \n---\n\nbody\n';
    expect(patch(text, { op: 'frontmatter.unset', key: 'list' })).toBe('---\na: 1\nb: [c]   \n---\n\nbody\n');
    expect(patch(text, { op: 'frontmatter.unset', key: 'a' })).toBe('---\nlist:\n  - x\n  - y\nb: [c]   \n---\n\nbody\n');
  });

  it('does not fold long strings', () => {
    const long = 'word '.repeat(30).trim();
    expect(patch('---\na: 1\n---\n', set('note', long))).toBe(`---\na: 1\nnote: ${long}\n---\n`);
  });

  it('keeps the blank line after the frontmatter for prepend and whole-body replace', () => {
    expect(patch(station, { op: 'prepend', content: 'First.' })).toContain('---\n\nFirst.\nSolar');
    expect(patch(station, { op: 'replace', content: 'New body.\n' })).toMatch(/---\n\nNew body\.\n$/);
  });
});

describe('frontmatter edits: review regressions', () => {
  it('refuses to replace a value whose anchor other keys use, before anything changes', () => {
    const text = '---\na: &shared old\nb: *shared\n---\nbody\n';
    for (const op of [set('a', ['new']), set('a', 'x'), { op: 'frontmatter.unset', key: 'a' }]) {
      expect(() => patch(text, op)).toThrow(/anchor &shared/);
    }
    // the alias itself, and anchors nobody uses, are fine
    expect(patch(text, set('b', 'own'))).toBe('---\na: &shared old\nb: own\n---\nbody\n');
    expect(patch('---\na: &lonely old\n---\n', set('a', 'new'))).toMatch(/^---\na: (&lonely )?new\n---\n$/);
  });

  it('an empty value with a comment keeps the space before the comment', () => {
    const out = patch('---\na: # comment\nb: keep\n---\nbody\n', set('a', 'new'));
    expect(out).toBe('---\na: new # comment\nb: keep\n---\nbody\n');
  });

  it('the written value always parses back to the requested one', () => {
    for (const value of ['new', '# not a comment', 'a: b', '2026-11-20', 3, true, null, ['x', 'y z'], { k: [1] }, '']) {
      for (const text of ['---\na: # c\n---\n', '---\na: old # c\n---\n', '---\na: [o]\n---\n', '---\na:\n  - o\n---\n']) {
        const out = patch(text, set('a', value));
        expect(parseFrontmatter(splitFrontmatter(out).frontmatterRaw)).toEqual({ a: value });
      }
    }
  });

  it('keeps CRLF fences and line endings, and a "..." closing fence', () => {
    const crlf = '---\r\na: 1\r\nb: 2\r\n---\r\nbody\r\n';
    expect(patch(crlf, set('a', 3))).toBe('---\r\na: 3\r\nb: 2\r\n---\r\nbody\r\n');
    expect(patch(crlf, set('c', [1, 2]))).toBe('---\r\na: 1\r\nb: 2\r\nc:\r\n  - 1\r\n  - 2\r\n---\r\nbody\r\n');
    expect(patch('---\na: 1\n...\nbody\n', set('a', 2))).toBe('---\na: 2\n...\nbody\n');
    expect(patch('---\na: 1\n...\n', { op: 'append', content: 'x' })).toBe('---\na: 1\n...\n\nx\n');
  });
});
