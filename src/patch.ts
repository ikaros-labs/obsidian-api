import { Document, isCollection, isMap, isScalar, parseDocument, Scalar, visit, type Node, type YAMLMap } from 'yaml';
import { z } from 'zod';
import { ApiError, invalidRequest } from './errors.js';
import {
  BLOCK_ALONE_RE,
  BLOCK_INLINE_RE,
  findBlocks,
  findHeadings,
  headingOf,
  joinFrontmatter,
  parseYaml,
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

const STRINGIFY = { flowCollectionPadding: false, lineWidth: 0 } as const;

/** `key: value` as YAML text, styled like `like` (flow collection, quote type) when given. */
function pairText(key: string, value: unknown, like?: unknown): string {
  const doc = new Document({ [key]: value });
  const node = (doc.contents as YAMLMap).items[0]!.value;
  if (isCollection(like) && like.flow && isCollection(node)) node.flow = true;
  if (isScalar(like) && isScalar(node) && typeof node.value === 'string') {
    if (like.type === Scalar.QUOTE_DOUBLE || like.type === Scalar.QUOTE_SINGLE) node.type = like.type;
  }
  return doc.toString(STRINGIFY);
}

const lineStart = (s: string, pos: number) => s.lastIndexOf('\n', pos - 1) + 1;
const lineEnd = (s: string, pos: number) => {
  const nl = s.indexOf('\n', pos);
  return nl === -1 ? s.length : nl + 1;
};

/**
 * Edits one top-level key in place, touching only that key's text, so untouched keys keep their
 * exact formatting (flow lists, quotes, comments, trailing spaces). Returns null when the YAML is
 * not a plain block mapping; the caller then falls back to re-serializing.
 */
function editRaw(raw: string, key: string, value: unknown | undefined): string | null {
  const doc = parseYaml(raw);
  const map = doc.contents;
  if (!isMap(map) || map.flow) return null;
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lf = (s: string) => s.replace(/\n/g, eol);
  const pair = map.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
  if (!pair) {
    if (value === undefined) return raw;
    return (raw === '' || raw.endsWith('\n') ? raw : `${raw}${eol}`) + lf(pairText(key, value));
  }
  const keyNode = pair.key as Scalar;
  const valueNode = pair.value as Node | null;
  const keyRange = keyNode.range!;
  const valueEnd = valueNode?.range ? valueNode.range[1] : keyRange[1];
  if (value === undefined) {
    const start = lineStart(raw, keyRange[0]);
    const end = raw[valueEnd - 1] === '\n' ? valueEnd : lineEnd(raw, valueEnd);
    return raw.slice(0, start) + raw.slice(end);
  }
  if (lineStart(raw, keyRange[0]) !== keyRange[0]) return null;
  // the generated text after the generated key: ": value\n" or ":\n  - a\n"
  const generated = pairText(key, value, valueNode);
  const genKey = (parseDocument(generated).contents as YAMLMap).items[0]!.key as Scalar;
  let rest = generated.slice(genKey.range![1]);
  const single = /^: ([^\n]*)\n$/.exec(rest);
  const r = valueNode?.range;
  if (single && r && r[0] < r[1] && !raw.slice(keyRange[1], r[1]).includes('\n')) {
    // one line to one line: swap the value only, keeping the spacing and any trailing comment
    return raw.slice(0, r[0]) + single[1] + raw.slice(r[1]);
  }
  let end = valueEnd;
  if (raw[end - 1] !== '\n') {
    rest = rest.replace(/\n$/, '');
    // a multi-line value can't keep a same-line trailing comment: replace through the end of the line
    if (rest.includes('\n')) end = raw.includes('\n', end) ? raw.indexOf('\n', end) : raw.length;
    if (end > 0 && raw[end - 1] === '\r') end--;
    // `a: # comment` has an empty value: keep a space before the comment
    else if (/^[^\s]/.test(raw.slice(end)) && !/\s$/.test(rest)) rest += ' ';
  }
  return raw.slice(0, keyRange[1]) + lf(rest) + raw.slice(end);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The frontmatter as plain data, or null when it doesn't parse fully (errors, dangling aliases). */
function plainData(raw: string): Record<string, unknown> | null {
  const doc = parseYaml(raw);
  if (doc.errors.length > 0) return null;
  try {
    const v: unknown = doc.toJS();
    if (v === null || v === undefined) return {};
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Whether `raw` holds exactly `before` with `changes` applied (undefined = key removed). */
function isExactly(raw: string, before: Record<string, unknown>, changes: Map<string, unknown>): boolean {
  const after = plainData(raw);
  if (after === null) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...changes.keys()]);
  return [...keys].every((k) => same(after[k], changes.has(k) ? changes.get(k) : before[k]));
}

/** Anchors defined in `node` (or below it) that an alias elsewhere in the document refers to. */
function referencedAnchors(doc: Document, node: unknown): string[] {
  const defined = new Set<string>();
  if (!isScalar(node) && !isCollection(node)) return [];
  visit(node as Node, (_k, n) => {
    if ((isScalar(n) || isCollection(n)) && n.anchor) defined.add(n.anchor);
  });
  const used: string[] = [];
  visit(doc, { Alias: (_k, a) => void (defined.has(a.source) && used.push(a.source)) });
  return [...new Set(used)];
}

function applyFrontmatterOp(text: string, op: Extract<PatchOp, { op: `frontmatter.${string}` }>): string {
  const { frontmatterRaw, body, fences } = splitFrontmatter(text);
  const doc = frontmatterRaw === null ? new Document({}) : parseYaml(frontmatterRaw);
  if (doc.errors.length > 0) throw invalidRequest('The note has invalid frontmatter YAML; fix it with PUT or replace_text');
  if (doc.contents === null) doc.contents = doc.createNode({});
  if (!isMap(doc.contents)) throw invalidRequest('The note frontmatter is not a key/value mapping');
  const before = frontmatterRaw === null ? {} : plainData(frontmatterRaw);
  if (before === null) throw invalidRequest('The note frontmatter has a YAML alias that does not resolve; fix it with replace_text');

  const changes = new Map<string, unknown>(
    op.op === 'frontmatter.set'
      ? [[op.key, op.value]]
      : op.op === 'frontmatter.unset'
        ? [[op.key, undefined]]
        : Object.entries(op.value).map(([k, v]) => [k, mergeValue(before[k], v)]),
  );
  // JSON in, JSON out: compare against what the value looks like after a round trip
  for (const [k, v] of changes) if (v !== undefined) changes.set(k, JSON.parse(JSON.stringify(v)));
  for (const key of changes.keys()) {
    const pair = doc.contents.items.find((p) => isScalar(p.key) && String(p.key.value) === key);
    const anchors = pair ? referencedAnchors(doc, pair.value) : [];
    if (anchors.length > 0) {
      throw invalidRequest(
        `Frontmatter key "${key}" defines the YAML anchor &${anchors[0]}, which other keys refer to; edit it with replace_text`,
      );
    }
  }

  let raw: string | null = frontmatterRaw ?? '';
  for (const [key, value] of changes) raw = raw === null ? null : editRaw(raw, key, value);
  if (raw === null || !isExactly(raw, before, changes)) {
    // not a plain block mapping (or the in-place edit didn't give exactly the change): re-serialize
    for (const [key, value] of changes) {
      if (value === undefined) doc.delete(key);
      else doc.set(key, value);
    }
    raw = doc.toString(STRINGIFY);
    if (!isExactly(raw, before, changes)) throw invalidRequest('The frontmatter change could not be applied exactly; nothing was written');
  }
  const after = parseYaml(raw).contents;
  return joinFrontmatter(after === null || (isMap(after) && after.items.length === 0) ? null : raw, body, fences);
}

const withNl = (s: string) => (s === '' || s.endsWith('\n') ? s : `${s}\n`);
const withoutNl = (s: string) => s.replace(/\n+$/, '');

/** A region of the body: [start, end) offsets, plus whether something (a heading) follows it. */
interface Region {
  start: number;
  end: number;
  followed: boolean;
  /** Offset of the heading line itself. */
  headingStart: number;
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
    headingStart: lines[h.line]!.start,
    start: lines[h.line]!.next,
    end: endLine < lines.length ? lines[endLine]!.start : body.length,
    followed: endLine < lines.length,
  };
}

/**
 * A heading's section (the heading line through the line before the next heading of the same or a
 * higher level), matched exactly like PATCH targets: same ambiguity and not-found errors.
 */
export function readSection(text: string, heading: string[], index?: number): string {
  const { body } = splitFrontmatter(text);
  const r = headingRegion(body, scanLines(body), { heading, index });
  return body.slice(r.headingStart, r.end);
}

const TABLE_ROW_RE = /^\s*\|/;
const UNDERLINE_RE = /^ {0,3}(=+|-+)[ \t]*$/;

/**
 * Whether appended text needs a blank line after `prev` to keep its meaning: a `---` or `===` right
 * under a paragraph would turn it into a heading, and text right under a table becomes a row.
 */
function needsBlankLine(prev: string, next: string): boolean {
  if (prev.trim() === '' || headingOf({ text: prev, start: 0, next: 0, code: false })) return false;
  if (UNDERLINE_RE.test(next)) return true;
  return TABLE_ROW_RE.test(prev) && !TABLE_ROW_RE.test(next);
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
  const sep = needsBlankLine(trimmed.slice(trimmed.lastIndexOf('\n') + 1), content.split('\n')[0]!) ? '\n\n' : '\n';
  return before + trimmed + sep + withoutNl(content) + (tail === '' ? (content.endsWith('\n') ? '\n' : '') : tail) + after;
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
  const split = splitFrontmatter(text);
  const { frontmatterRaw } = split;
  // Blank lines between the frontmatter and the body are kept as they are (one is added to an empty body).
  const eol = split.fences?.open.endsWith('\r\n') ? '\r\n' : '\n';
  const gap = frontmatterRaw === null ? '' : split.body === '' ? eol : (/^(?:\r?\n)*/.exec(split.body)![0] ?? '');
  const body = split.body === '' ? '' : split.body.slice(gap.length);
  let next: string;
  if (!op.target) {
    if (op.op === 'replace') next = op.content;
    else next = applyRegion(body, { start: 0, end: body.length, followed: false, headingStart: 0 }, op.op, op.content);
  } else {
    const lines = scanLines(body);
    if ('heading' in op.target) next = applyRegion(body, headingRegion(body, lines, op.target), op.op, op.content);
    else next = applyBlockOp(body, lines, op.target.block, op.op, op.content);
  }
  return joinFrontmatter(frontmatterRaw, next === '' || /^\r?\n/.test(next) ? next : gap + next, split.fences);
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
