import { Document, isMap, parseDocument } from 'yaml';
import { z } from 'zod';
import { ApiError, invalidRequest } from './errors.js';
import {
  BLOCK_ALONE_RE,
  BLOCK_INLINE_RE,
  findBlocks,
  findHeadings,
  headingOf,
  joinFrontmatter,
  scanLines,
  splitFrontmatter,
  type Line,
} from './markdown.js';

const TargetSchema = z.union([
  z.strictObject({ heading: z.array(z.string()).min(1), index: z.number().int().min(0).optional() }),
  z.strictObject({ block: z.string().regex(/^[A-Za-z0-9-]+$/) }),
]);
type Target = z.infer<typeof TargetSchema>;

const ContentOp = (op: 'append' | 'prepend' | 'replace') =>
  z.strictObject({ op: z.literal(op), target: TargetSchema.optional(), content: z.string() });

export const PatchOpSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('frontmatter.set'), key: z.string().min(1), value: z.unknown() }),
  z.strictObject({ op: z.literal('frontmatter.unset'), key: z.string().min(1) }),
  z.strictObject({ op: z.literal('frontmatter.merge'), value: z.record(z.string(), z.unknown()) }),
  ContentOp('append'),
  ContentOp('prepend'),
  ContentOp('replace'),
  z.strictObject({
    op: z.literal('replace_text'),
    old: z.string().min(1),
    new: z.string(),
    count: z.number().int().min(1).default(1),
  }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const PatchBodySchema = z.strictObject({
  if_match: z.string().optional(),
  ops: z.array(PatchOpSchema).min(1).max(100),
});

const targetNotFound = (what: string) => new ApiError(422, 'patch_target_not_found', `Target not found: ${what}`);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Lists concatenate (skipping primitives already present), objects merge, anything else is replaced. */
export function mergeValue(current: unknown, incoming: unknown): unknown {
  if (Array.isArray(current) && Array.isArray(incoming)) {
    const isPrimitive = (x: unknown) => x === null || typeof x !== 'object';
    return [...current, ...incoming.filter((x) => !(isPrimitive(x) && current.includes(x)))];
  }
  if (isPlainObject(current) && isPlainObject(incoming)) {
    const out: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(incoming)) out[k] = mergeValue(current[k], v);
    return out;
  }
  return incoming;
}

function applyFrontmatterOp(text: string, op: Extract<PatchOp, { op: `frontmatter.${string}` }>): string {
  const { frontmatterRaw, body } = splitFrontmatter(text);
  const doc = frontmatterRaw === null ? new Document({}) : parseDocument(frontmatterRaw);
  if (doc.errors.length > 0) throw invalidRequest('The note has invalid frontmatter YAML; fix it with PUT or replace_text');
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw invalidRequest('The note frontmatter is not a key/value mapping');

  if (op.op === 'frontmatter.set') doc.set(op.key, op.value);
  else if (op.op === 'frontmatter.unset') doc.delete(op.key);
  else {
    const current = (doc.toJS() ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(op.value)) doc.set(k, mergeValue(current[k], v));
  }
  const raw = isMap(doc.contents) && doc.contents.items.length === 0 ? null : String(doc);
  return joinFrontmatter(raw, body);
}

const withNl = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
const withoutNl = (s: string) => s.replace(/\n+$/, '');

/** A region of the body: [start, end) offsets, plus whether something (a heading) follows it. */
interface Region {
  start: number;
  end: number;
  followed: boolean;
}

function headingRegion(body: string, lines: Line[], target: Extract<Target, { heading: string[] }>): Region {
  const path = target.heading;
  const matches = findHeadings(lines).filter(
    (h) => h.chain.length >= path.length && path.every((p, i) => h.chain[h.chain.length - path.length + i] === p),
  );
  if (matches.length === 0 || (target.index !== undefined && target.index >= matches.length)) {
    throw targetNotFound(`heading ${JSON.stringify(path)}`);
  }
  if (matches.length > 1 && target.index === undefined) {
    throw new ApiError(422, 'patch_target_ambiguous', `Heading ${JSON.stringify(path)} matches ${matches.length} headings`, {
      candidates: matches.map((h, index) => ({ heading: h.chain, index, line: h.line + 1 })),
    });
  }
  const h = matches[target.index ?? 0]!;
  let endLine = lines.length;
  for (let i = h.line + 1; i < lines.length; i++) {
    const other = headingOf(lines[i]!);
    if (other && other.level <= h.level) {
      endLine = i;
      break;
    }
  }
  return {
    start: lines[h.line]!.next,
    end: endLine < lines.length ? lines[endLine]!.start : body.length,
    followed: endLine < lines.length,
  };
}

function applyRegion(body: string, region: Region, op: 'append' | 'prepend' | 'replace', content: string): string {
  let before = body.slice(0, region.start);
  const after = body.slice(region.end);
  const inside = body.slice(region.start, region.end);
  if (before !== '' && !before.endsWith('\n')) before += '\n';

  if (op === 'prepend') return before + withNl(content) + inside + after;
  if (op === 'replace') {
    const sep = region.followed && !content.endsWith('\n\n') ? (content.endsWith('\n') ? '\n' : '\n\n') : '';
    return before + (region.followed ? content + sep : content) + after;
  }
  // append: right after the last non-blank character of the region
  const trimmed = inside.replace(/\s+$/, '');
  if (trimmed === '') {
    return before + withNl(content) + inside + after;
  }
  const tail = inside.slice(trimmed.length);
  return before + trimmed + '\n' + withoutNl(content) + (tail === '' ? (content.endsWith('\n') ? '\n' : '') : tail) + after;
}

function applyBlockOp(body: string, lines: Line[], id: string, op: 'append' | 'prepend' | 'replace', content: string): string {
  const block = findBlocks(lines).find((b) => b.id === id);
  if (!block) throw targetNotFound(`block ^${id}`);
  const idLine = lines[block.line]!;
  const alone = BLOCK_ALONE_RE.test(idLine.text);
  const lastContent = alone ? block.line - 1 : block.line;
  let first = lastContent;
  const isList = /^\s*([-*+]|\d+[.)])\s/.test(lines[lastContent]?.text ?? '');
  if (!isList) {
    while (first > 0) {
      const prev = lines[first - 1]!;
      if (prev.code || prev.text.trim() === '' || headingOf(prev)) break;
      first--;
    }
  }
  if (first < 0 || lastContent < 0 || (lines[lastContent]?.text.trim() ?? '') === '') {
    // a standalone id with nothing before it: treat the id line itself as the block
    first = block.line;
  }
  const blockStart = lines[first]!.start;
  const blockEnd = idLine.next;
  const ensureBreak = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);

  if (op === 'prepend') return body.slice(0, blockStart) + withNl(content) + body.slice(blockStart);
  if (op === 'append') return ensureBreak(body.slice(0, blockEnd)) + withNl(content) + body.slice(blockEnd);
  // replace, keeping the block id
  if (alone && first < block.line) {
    return body.slice(0, blockStart) + withNl(content) + body.slice(idLine.start);
  }
  const replaced = `${withoutNl(content).replace(BLOCK_INLINE_RE, '')} ^${id}`;
  return body.slice(0, blockStart) + replaced + (idLine.next > idLine.start + idLine.text.length ? '\n' : '') + body.slice(blockEnd);
}

function applyContentOp(text: string, op: Extract<PatchOp, { op: 'append' | 'prepend' | 'replace' }>): string {
  const { frontmatterRaw, body } = splitFrontmatter(text);
  let next: string;
  if (!op.target) {
    if (op.op === 'replace') next = op.content;
    else next = applyRegion(body, { start: 0, end: body.length, followed: false }, op.op, op.content);
  } else {
    const lines = scanLines(body);
    if ('heading' in op.target) next = applyRegion(body, headingRegion(body, lines, op.target), op.op, op.content);
    else next = applyBlockOp(body, lines, op.target.block, op.op, op.content);
  }
  return joinFrontmatter(frontmatterRaw, next);
}

function applyReplaceText(text: string, op: Extract<PatchOp, { op: 'replace_text' }>): string {
  const occurrences = text.split(op.old).length - 1;
  if (occurrences === 0) throw targetNotFound('text');
  if (occurrences > op.count) {
    throw new ApiError(422, 'patch_target_ambiguous', `Text occurs ${occurrences} times, more than count (${op.count})`, {
      occurrences,
    });
  }
  return text.split(op.old).join(op.new);
}

/** Applies all operations in order. Throws on the first failing one; the input is never modified. */
export function applyPatch(text: string, ops: PatchOp[]): string {
  return ops.reduce((acc, op, i) => {
    try {
      switch (op.op) {
        case 'frontmatter.set':
        case 'frontmatter.unset':
        case 'frontmatter.merge':
          return applyFrontmatterOp(acc, op);
        case 'replace_text':
          return applyReplaceText(acc, op);
        default:
          return applyContentOp(acc, op);
      }
    } catch (e) {
      if (e instanceof ApiError) throw new ApiError(e.status, e.code, `ops[${i}]: ${e.message}`, { ...e.details, op_index: i });
      throw e;
    }
  }, text);
}
