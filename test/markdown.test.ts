import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeNote, outline, splitFrontmatter } from '../src/markdown.js';
import { FIXTURE } from './helpers.js';

const plan = readFileSync(path.join(FIXTURE, 'Research/Plan.md'), 'utf8');

describe('markdown', () => {
  it('splits frontmatter', () => {
    expect(splitFrontmatter('---\na: 1\n---\nbody\n')).toEqual({ frontmatterRaw: 'a: 1\n', body: 'body\n', bodyLineOffset: 3 });
    expect(splitFrontmatter('---\n---\nbody')).toMatchObject({ frontmatterRaw: '', body: 'body' });
    expect(splitFrontmatter('no fm\n---\n')).toMatchObject({ frontmatterRaw: null });
    expect(splitFrontmatter('---\nunterminated\n')).toMatchObject({ frontmatterRaw: null });
  });

  it('extracts tags from frontmatter and body, skipping code', () => {
    const meta = analyzeNote(plan);
    expect(meta.frontmatter).toEqual({ project: 'vault-api', tags: ['research'] });
    expect(meta.tags).toEqual(['research']);
    expect(analyzeNote('---\ntags: a, b\n---\n#c and #d/e but not #123 or `#code`').tags).toEqual(['a', 'b', 'c', 'd/e']);
  });

  it('extracts wiki and markdown links', () => {
    expect(analyzeNote(plan).links.map((l) => l.target)).toEqual(['Article One', 'Ideas', 'Secret']);
    const links = analyzeNote('[[A|alias]] [[B#h]] ![[img.png]] [x](sub/C%20D.md#h) [web](https://x.y) [[A]]').links;
    expect(links).toEqual([
      { target: 'A', kind: 'wiki' },
      { target: 'B', kind: 'wiki' },
      { target: 'img.png', kind: 'wiki' },
      { target: 'sub/C D.md', kind: 'md' },
    ]);
  });

  it('builds an outline, ignoring headings in code blocks', () => {
    const o = outline(plan);
    expect(o.headings).toHaveLength(1);
    expect(o.headings[0]).toMatchObject({ text: 'Plan', level: 1, line: 6 });
    expect(o.headings[0]!.children.map((h) => h.text)).toEqual(['Notes', 'Tasks']);
    expect(o.headings[0]!.children[0]!.children[0]).toMatchObject({ text: 'Highlights', level: 3 });
    expect(o.blocks.map((b) => b.id)).toEqual(['task1', 'para']);
    expect(o.frontmatter_keys).toEqual(['project', 'tags']);
  });
});
