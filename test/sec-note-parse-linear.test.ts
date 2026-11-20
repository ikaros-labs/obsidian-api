import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { analyzeNote, outline, parseFrontmatter, parseYaml } from '../src/markdown.js';
import { snippetOf } from '../src/search/index.js';

const timed = <T>(fn: () => T): [T, number] => {
  const t0 = performance.now();
  const out = fn();
  return [out, performance.now() - t0];
};

const libraryDuplicateMessage = parseDocument('a: 1\na: 2\n', { prettyErrors: false }).errors[0]!.message;

// F-04, F-05, F-16: analysing a stored note must cost time linear in its size.
describe('note analysis cost', () => {
  it('F-04: a long run of "[" does not slow link extraction', () => {
    for (const text of ['['.repeat(40000), `${'[]('.repeat(13000)}`, `${']('.repeat(20000)}`, `[a](${'x '.repeat(1)}${'[a](b "'.repeat(6000)}`, `[a](${']('.repeat(10000)}${' '.repeat(20000)}`]) {
      const [, ms] = timed(() => analyzeNote(`${text}\n`));
      expect(ms).toBeLessThan(300);
    }
  });

  it('F-04: markdown links are found exactly as before', () => {
    const text =
      'See [one](Notes/One.md), ![img](<img/a b.png> "title"), [ext](https://x.test/a), [anchor](#h), [enc](A%20B.md#sec)\n' +
      '[[Wiki|alias]] and [nested [x]](Y.md) and [broken](no close\n[t]( Z.md "t" )\n' +
      '[q](<Q.md>) [r](R.md "t") [e]() [s](S.md)x[u](U.md\n[a](b)[c](d) ](e) [f]](g) [h](i j) [k](l "m" n) [o](<p>q)\n';
    expect(analyzeNote(text).links.map((l) => `${l.kind}:${l.target}`)).toEqual(
      ['md:Notes/One.md', 'md:A B.md', 'wiki:Wiki', 'md:Z.md', 'md:Q.md', 'md:R.md', 'md:S.md', 'md:b', 'md:d'],
    );
  });

  it('F-05: frontmatter with many keys parses in linear time, duplicates still invalid', () => {
    const yaml = Array.from({ length: 20000 }, (_, i) => `k${i}: 1`).join('\n');
    const [fm, ms] = timed(() => parseFrontmatter(`${yaml}\n`));
    expect(Object.keys(fm!).length).toBe(20000);
    expect(ms).toBeLessThan(1500);
    expect(parseFrontmatter('a: 1\na: 2\n')).toBeNull();
    expect(parseFrontmatter('a:\n  b: 1\n  b: 2\n')).toBeNull();
    expect(parseFrontmatter('a: 1\nb: {c: 1, d: 2}\n')).toEqual({ a: 1, b: { c: 1, d: 2 } });
  });

  it('F-16: a heading followed by a long run of spaces is cheap for outline and snippets', () => {
    const body = `# zebra${' '.repeat(40000)}b\n\ntext zebra\n`;
    const [o, ms1] = timed(() => outline(body));
    expect(o.headings[0]!.text).toBe(`zebra${' '.repeat(40000)}b`);
    const [s, ms2] = timed(() => snippetOf(body, new Set(['zebra'])));
    expect(s.text).toContain('zebra');
    expect(ms1 + ms2).toBeLessThan(300);
  });

  it('F-16: headings keep their text', () => {
    const o = outline('# One #\n\n##   Two ## \n\n### Three#\n\n####\n\n#nospace\n');
    const flat = (hs: { text: string; level: number; children: unknown[] }[]): [number, string][] =>
      hs.flatMap((h) => [[h.level, h.text] as [number, string], ...flat(h.children as never)]);
    expect(flat(o.headings as never)).toEqual([[1, 'One'], [2, 'Two'], [3, 'Three#'], [4, '']]);
    expect(snippetOf('## Sec ##  \n\nalpha beta\n', new Set(['alpha'])).heading).toBe('Sec');
  });

  // Review round: every candidate `](` used to rescan the same run of spaces.
  it('F-04: many link candidates before one long run of spaces stay linear', () => {
    for (const text of [`${'[]('.repeat(10000)}${' '.repeat(20000)}x`, `${'[]('.repeat(10000)}a${' '.repeat(10000)}"${'b'.repeat(10000)}`, `${'[](a "'.repeat(8000)}`]) {
      const [, ms] = timed(() => analyzeNote(`${text}\n`));
      expect(ms).toBeLessThan(300);
    }
  });

  it('F-04: finds the same links as the regex it replaced, on generated lines', () => {
    const OLD = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
    const alphabet = ['[', ']', '(', ')', '<', '>', '"', ' ', '\t', 'a', 'b', '!', '](', '[x](', ' "t"', ')'];
    let seed = 12345;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let i = 0; i < 20000; i++) {
      const line = Array.from({ length: 1 + rand(14) }, () => alphabet[rand(alphabet.length)]).join('');
      const expected = [...new Set([...line.matchAll(OLD)].map((m) => m[1]!))];
      const got = analyzeNote(`${line}\n`).links.filter((l) => l.kind === 'md').map((l) => l.target);
      expect(got, JSON.stringify(line)).toEqual(expected);
    }
  });

  // Review round: keys are duplicates exactly when the YAML library says so.
  it('F-05: duplicate keys follow the library (=== on scalars), and the error quotes nothing', () => {
    expect(parseFrontmatter('.nan: 1\n.NaN: 2\n')).not.toBeNull();
    expect(parseFrontmatter('1: a\n"1": b\n')).not.toBeNull();
    expect(parseFrontmatter('1: a\n1: b\n')).toBeNull();
    expect(parseFrontmatter('~: a\nnull: b\n')).toBeNull();
    const errors = parseYaml('"secret words": 1\n"secret words": 2\n').errors;
    expect(errors.map((e) => e.code)).toEqual(['DUPLICATE_KEY']);
    expect(errors[0]!.message).toBe(libraryDuplicateMessage);
  });
});
