import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/errors.js';
import { applyPatch, PatchOpSchema, type PatchOp } from '../src/patch.js';
import { FIXTURE } from './helpers.js';

const plan = readFileSync(path.join(FIXTURE, 'Research/Plan.md'), 'utf8');
const ops = (...raw: unknown[]): PatchOp[] => raw.map((o) => PatchOpSchema.parse(o));
const patch = (text: string, ...raw: unknown[]) => applyPatch(text, ops(...raw));
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
};

describe('frontmatter ops', () => {
  it('sets, unsets and merges, keeping comments', () => {
    const text = '---\n# keep me\nstatus: to-read\ntags: [a]\nmeta: { x: 1 }\n---\nbody\n';
    const out = patch(
      text,
      { op: 'frontmatter.set', key: 'status', value: 'read' },
      { op: 'frontmatter.unset', key: 'nothing' },
      { op: 'frontmatter.merge', value: { tags: ['a', 'b'], meta: { y: 2 } } },
    );
    expect(out).toContain('# keep me');
    expect(out).toContain('status: read');
    expect(out).toMatch(/tags:[\s\S]*a[\s\S]*b/);
    expect(out.endsWith('---\nbody\n')).toBe(true);
    expect(out).toMatch(/x: 1[\s\S]*y: 2/);
  });

  it('creates frontmatter when there is none, and removes it when emptied', () => {
    const added = patch('body\n', { op: 'frontmatter.set', key: 'a', value: 1 });
    expect(added).toBe('---\na: 1\n---\nbody\n');
    expect(patch(added, { op: 'frontmatter.unset', key: 'a' })).toBe('body\n');
  });
});

describe('content ops', () => {
  it('appends under a nested heading, before the next section', () => {
    const out = patch(plan, { op: 'append', target: { heading: ['Notes', 'Highlights'] }, content: '- new highlight' });
    expect(out).toContain('- existing highlight\n- new highlight\n\n## Tasks');
  });

  it('matches a heading by its last path element', () => {
    const out = patch(plan, { op: 'prepend', target: { heading: ['Highlights'] }, content: 'first' });
    expect(out).toContain('### Highlights\nfirst\n\n- existing highlight');
  });

  it('replaces a section including its subsections', () => {
    const out = patch(plan, { op: 'replace', target: { heading: ['Plan', 'Notes'] }, content: 'Replaced.' });
    expect(out).toContain('## Notes\nReplaced.\n\n## Tasks');
    expect(out).not.toContain('Highlights');
  });

  it('writes heading levels exactly as given', () => {
    const out = patch(plan, { op: 'append', target: { heading: ['Tasks'] }, content: '# Top level' });
    expect(out).toContain('\n# Top level');
  });

  it('ignores headings inside code blocks', () => {
    const e = errorOf(() => patch(plan, { op: 'append', target: { heading: ['Not a heading'] }, content: 'x' }));
    expect(e.code).toBe('patch_target_not_found');
  });

  it('reports ambiguous headings with candidates, and accepts an index', () => {
    const text = '# A\n## Log\none\n# B\n## Log\ntwo\n';
    const e = errorOf(() => patch(text, { op: 'append', target: { heading: ['Log'] }, content: 'x' }));
    expect(e.code).toBe('patch_target_ambiguous');
    expect(e.details?.candidates).toEqual([
      { heading: ['A', 'Log'], index: 0, line: 2 },
      { heading: ['B', 'Log'], index: 1, line: 5 },
    ]);
    expect(patch(text, { op: 'append', target: { heading: ['Log'], index: 1 }, content: 'x' })).toBe('# A\n## Log\none\n# B\n## Log\ntwo\nx\n');
    expect(patch(text, { op: 'append', target: { heading: ['B', 'Log'] }, content: 'x' })).toBe('# A\n## Log\none\n# B\n## Log\ntwo\nx\n');
  });

  it('appends and prepends to the whole body, after frontmatter', () => {
    const text = '---\na: 1\n---\nline\n';
    expect(patch(text, { op: 'append', content: 'end' })).toBe('---\na: 1\n---\nline\nend\n');
    expect(patch(text, { op: 'prepend', content: 'start' })).toBe('---\na: 1\n---\nstart\nline\n');
    expect(patch(text, { op: 'replace', content: 'new\n' })).toBe('---\na: 1\n---\nnew\n');
  });

  it('targets list-item and paragraph blocks, keeping the id on replace', () => {
    expect(patch(plan, { op: 'replace', target: { block: 'task1' }, content: '- [x] wrote tests' })).toContain('- [x] wrote tests ^task1\n');
    const para = patch(plan, { op: 'replace', target: { block: 'para' }, content: 'One line now.' });
    expect(para).toContain('\nOne line now. ^para\n');
    expect(para).not.toContain('Second line of it');
    expect(patch(plan, { op: 'append', target: { block: 'para' }, content: 'after' })).toContain('Second line of it. ^para\nafter\n');
    expect(patch(plan, { op: 'prepend', target: { block: 'para' }, content: 'before' })).toContain('before\nA paragraph with an id.');
  });

  it('handles a block id on its own line', () => {
    const text = '| a | b |\n|---|---|\n| 1 | 2 |\n^tbl\n\nafter\n';
    expect(patch(text, { op: 'replace', target: { block: 'tbl' }, content: '| x |\n|---|' })).toBe('| x |\n|---|\n^tbl\n\nafter\n');
  });
});

describe('replace_text', () => {
  it('replaces an exact, unique string', () => {
    expect(patch(plan, { op: 'replace_text', old: 'Intro paragraph.', new: 'Intro!' })).toContain('Intro!');
  });

  it('fails when missing or not unique enough', () => {
    expect(errorOf(() => patch('a a', { op: 'replace_text', old: 'b', new: 'c' })).code).toBe('patch_target_not_found');
    const e = errorOf(() => patch('a a', { op: 'replace_text', old: 'a', new: 'c' }));
    expect(e.code).toBe('patch_target_ambiguous');
    expect(e.details?.occurrences).toBe(2);
    expect(patch('a a', { op: 'replace_text', old: 'a', new: 'c', count: 2 })).toBe('c c');
  });
});

it('reports which op failed', () => {
  const e = errorOf(() => patch(plan, { op: 'append', content: 'ok' }, { op: 'replace_text', old: 'nope', new: '' }));
  expect(e.details?.op_index).toBe(1);
  expect(e.message).toMatch(/^ops\[1\]/);
});
