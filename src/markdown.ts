import { isScalar, parseDocument, visit, YAMLParseError, type Document } from 'yaml';

export type Frontmatter = Record<string, unknown>;

export interface SplitNote {
  /** Raw YAML between the `---` fences (with its trailing newline), or null when there is none. */
  frontmatterRaw: string | null;
  body: string;
  /** Number of lines before the body starts. */
  bodyLineOffset: number;
  /** The fence lines as written (with their line endings), so edits can keep them. */
  fences?: { open: string; close: string };
}

export function splitFrontmatter(text: string): SplitNote {
  const none = { frontmatterRaw: null, body: text, bodyLineOffset: 0 };
  const firstNl = text.indexOf('\n');
  if (firstNl === -1 || text.slice(0, firstNl).replace(/\r$/, '').trimEnd() !== '---') return none;
  let pos = firstNl + 1;
  let lineNo = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end).replace(/\r$/, '').trimEnd();
    lineNo++;
    if (line === '---' || line === '...') {
      return {
        frontmatterRaw: text.slice(firstNl + 1, pos),
        body: nl === -1 ? '' : text.slice(nl + 1),
        bodyLineOffset: lineNo,
        fences: { open: text.slice(0, firstNl + 1), close: nl === -1 ? text.slice(pos) : text.slice(pos, nl + 1) },
      };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return none;
}

/** `fences` (from splitFrontmatter) keeps the original fence lines, e.g. CRLF or a `...` closing fence. */
export function joinFrontmatter(frontmatterRaw: string | null, body: string, fences?: { open: string; close: string }): string {
  if (frontmatterRaw === null) return body;
  const eol = fences?.open.endsWith('\r\n') ? '\r\n' : '\n';
  const fm = frontmatterRaw === '' || frontmatterRaw.endsWith('\n') ? frontmatterRaw : `${frontmatterRaw}${eol}`;
  let close = fences?.close ?? '---\n';
  if (body !== '' && !close.endsWith('\n')) close += eol;
  return `${fences?.open ?? '---\n'}${fm}${close}${body}`;
}

/**
 * Parses YAML written by an account. The library's own duplicate-key check compares every key of a
 * map with every other one, which is quadratic; here duplicates are found with one Set per map and
 * reported as errors in the same way.
 */
export function parseYaml(text: string): Document.Parsed {
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length > 0) return doc;
  let duplicate: string | null = null;
  visit(doc, {
    Map(_, map) {
      const seen = new Set<string>();
      for (const { key } of map.items) {
        if (!isScalar(key)) continue;
        const id = `${typeof key.value}:${String(key.value)}`;
        if (seen.has(id)) {
          duplicate = String(key.value);
          return visit.BREAK;
        }
        seen.add(id);
      }
      return undefined;
    },
  });
  if (duplicate !== null) doc.errors.push(new YAMLParseError([0, 0], 'DUPLICATE_KEY', `Map keys must be unique: ${duplicate}`));
  return doc;
}

/** Parses frontmatter YAML. Returns null if it is not valid YAML or not a mapping. */
export function parseFrontmatter(raw: string | null): Frontmatter | null {
  if (raw === null) return {};
  const doc = parseYaml(raw);
  if (doc.errors.length > 0) return null;
  const value: unknown = doc.toJS();
  if (value === null || value === undefined) return {};
  return typeof value === 'object' && !Array.isArray(value) ? (value as Frontmatter) : null;
}

export interface Line {
  text: string;
  start: number;
  /** Offset of the next line's first character. */
  next: number;
  /** Inside a fenced code block (fence lines included). */
  code: boolean;
}

export function scanLines(s: string): Line[] {
  const out: Line[] = [];
  let fence: { char: string; len: number } | null = null;
  let pos = 0;
  while (pos < s.length) {
    const nl = s.indexOf('\n', pos);
    const next = nl === -1 ? s.length : nl + 1;
    const text = s.slice(pos, nl === -1 ? s.length : nl).replace(/\r$/, '');
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    let code = fence !== null;
    if (fence) {
      if (m && m[1]![0] === fence.char && m[1]!.length >= fence.len && m[2]!.trim() === '') fence = null;
    } else if (m && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
      fence = { char: m[1]![0]!, len: m[1]!.length };
      code = true;
    }
    out.push({ text, start: pos, next, code });
    pos = next;
  }
  return out;
}

export interface Heading {
  text: string;
  level: number;
  /** Index into the scanned lines. */
  line: number;
  /** Texts of the enclosing headings, outermost first, ending with this heading. */
  chain: string[];
}

const isBlank = (c: string | undefined) => c === ' ' || c === '\t';

/**
 * The text of an ATX heading line after its `#`s: surrounding spaces and a closing run of `#`s
 * (when a space precedes it) removed. Done by hand: a regex with a lazy group before the trailing
 * blanks rescans a long run of spaces from every position.
 */
function headingText(rest: string): string {
  let end = rest.length;
  while (end > 0 && isBlank(rest[end - 1])) end--;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === '#') hashes--;
  if (hashes < end && (hashes === 0 || isBlank(rest[hashes - 1]))) end = hashes;
  return rest.slice(0, end).trim();
}

const HEADING_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/;

export function headingOf(line: Line): { level: number; text: string } | null {
  if (line.code) return null;
  const m = HEADING_RE.exec(line.text);
  if (!m) return null;
  return { level: m[1]!.length, text: headingText(line.text.slice(m[0].length)) };
}

export function findHeadings(lines: Line[]): Heading[] {
  const out: Heading[] = [];
  const stack: Heading[] = [];
  lines.forEach((line, i) => {
    const h = headingOf(line);
    if (!h) return;
    while (stack.length > 0 && stack.at(-1)!.level >= h.level) stack.pop();
    const heading = { ...h, line: i, chain: [...stack.map((s) => s.text), h.text] };
    stack.push(heading);
    out.push(heading);
  });
  return out;
}

export const BLOCK_INLINE_RE = /\s\^([A-Za-z0-9-]+)\s*$/;
export const BLOCK_ALONE_RE = /^\s*\^([A-Za-z0-9-]+)\s*$/;

export function findBlocks(lines: Line[]): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  lines.forEach((line, i) => {
    if (line.code) return;
    const m = BLOCK_ALONE_RE.exec(line.text) ?? BLOCK_INLINE_RE.exec(line.text);
    if (m) out.push({ id: m[1]!, line: i });
  });
  return out;
}

const stripInlineCode = (s: string) => s.replace(/`[^`]*`/g, ' ');

const TAG_RE = /(?:^|[\s(,;])#([\p{L}\p{N}_/-]+)/gu;

function normalizeTag(t: string): string | null {
  const tag = t.replace(/^#/, '').trim();
  return tag !== '' && /[^\d/]/u.test(tag) ? tag : null;
}

/** Frontmatter `tags` first, then inline `#tags` outside code. Deduplicated case-insensitively. */
export function extractTags(frontmatter: Frontmatter | null, lines: Line[]): string[] {
  const found: string[] = [];
  const fmTags = frontmatter?.tags;
  const fmList = typeof fmTags === 'string' ? fmTags.split(/[,\s]+/) : Array.isArray(fmTags) ? fmTags : [];
  for (const t of fmList) if (typeof t === 'string') found.push(t);
  for (const line of lines) {
    if (line.code) continue;
    for (const m of stripInlineCode(line.text).matchAll(TAG_RE)) found.push(m[1]!);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of found) {
    const tag = normalizeTag(raw);
    if (tag === null || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

export interface RawLink {
  /** Link text as written, without alias and heading/block part. */
  target: string;
  kind: 'wiki' | 'md';
}

const WIKI_RE = /!?\[\[([^[\]]+?)\]\]/g;

/**
 * Targets of the inline markdown links in one line: `[label](target)`, `[label](<target> "title")`.
 * The label may not contain `]`. Equivalent to matching
 * `\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)` from left to right, but in one pass: the
 * regex rescans the rest of the line from every `[` (and every `](`), which is quadratic on a line an
 * account fills with them. Each kind of run is remembered, so no stretch of the line is read twice.
 */
function mdLinkTargets(text: string): string[] {
  const out: string[] = [];
  const isSpace = (i: number) => i < text.length && /\s/.test(text[i]!);
  const isTarget = (i: number) => i < text.length && !/[)\s>]/.test(text[i]!);
  /** `end(i)`: the first index at or after `i` where `test` fails, remembering the last run. */
  const runs = (test: (i: number) => boolean) => {
    let from = 0;
    let to = -1;
    return (i: number) => {
      if (i >= from && i <= to) return to;
      from = i;
      to = i;
      while (test(to)) to++;
      return to;
    };
  };
  const spaces = runs(isSpace);
  const target = runs(isTarget);
  const untilQuote = runs((i) => i < text.length && text[i] !== '"');

  /** Parses `(target "title")` at `open`; returns the target and the index after `)`, or null. */
  const tail = (open: number): { href: string; end: number } | null => {
    let i = spaces(open + 1);
    // `<` opens the target unless nothing follows it, in which case it is the target.
    if (text[i] === '<' && isTarget(i + 1)) i++;
    const end = target(i);
    if (end === i) return null;
    const href = text.slice(i, end);
    i = text[end] === '>' ? end + 1 : end;
    const afterSpaces = spaces(i);
    if (afterSpaces > i && text[afterSpaces] === '"') {
      const close = untilQuote(afterSpaces + 1);
      if (close < text.length) {
        const j = spaces(close + 1);
        if (text[j] === ')') return { href, end: j + 1 };
      }
    }
    return text[afterSpaces] === ')' ? { href, end: afterSpaces + 1 } : null;
  };

  let labelOpen = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[') labelOpen = true;
    else if (text[i] === ']') {
      const link = labelOpen && text[i + 1] === '(' ? tail(i + 1) : null;
      labelOpen = false;
      if (link) {
        out.push(link.href);
        i = link.end - 1;
      }
    }
  }
  return out;
}

/**
 * A property value that is a whole wikilink (`"[[X]]"`, `"[[X|alias]]"`), which Obsidian treats as a
 * link, not text. Returns the target without heading/block part, and the alias if any.
 */
export function propertyWikilink(value: unknown): { target: string; display?: string } | null {
  if (typeof value !== 'string') return null;
  const m = /^\s*\[\[([^[\]]+)\]\]\s*$/.exec(value);
  if (!m) return null;
  const [target, ...display] = m[1]!.split('|');
  const t = target!.split(/[#^]/)[0]!.trim();
  if (t === '') return null;
  return display.length ? { target: t, display: display.join('|') } : { target: t };
}

/** Wikilinks in frontmatter property values, including list items. */
function frontmatterLinks(frontmatter: Frontmatter | null): string[] {
  const out: string[] = [];
  for (const v of Object.values(frontmatter ?? {})) {
    for (const item of Array.isArray(v) ? v : [v]) {
      const link = propertyWikilink(item);
      if (link) out.push(link.target);
    }
  }
  return out;
}

export function extractLinks(lines: Line[], frontmatterTargets: string[] = []): RawLink[] {
  const out: RawLink[] = [];
  const seen = new Set<string>();
  const add = (target: string, kind: RawLink['kind']) => {
    const t = target.trim();
    if (t === '' || seen.has(`${kind}:${t}`)) return;
    seen.add(`${kind}:${t}`);
    out.push({ target: t, kind });
  };
  for (const t of frontmatterTargets) add(t, 'wiki');
  for (const line of lines) {
    if (line.code) continue;
    const text = stripInlineCode(line.text);
    for (const m of text.matchAll(WIKI_RE)) add(m[1]!.split('|')[0]!.split(/[#^]/)[0]!, 'wiki');
    for (const href of mdLinkTargets(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      let decoded = href.split('#')[0]!;
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        // keep as written
      }
      add(decoded, 'md');
    }
  }
  return out;
}

export interface NoteMeta {
  frontmatter: Frontmatter | null;
  tags: string[];
  links: RawLink[];
}

export function analyzeNote(text: string): NoteMeta {
  const { frontmatterRaw, body } = splitFrontmatter(text);
  const frontmatter = parseFrontmatter(frontmatterRaw);
  const lines = scanLines(body);
  return { frontmatter, tags: extractTags(frontmatter, lines), links: extractLinks(lines, frontmatterLinks(frontmatter)) };
}

export interface OutlineHeading {
  text: string;
  level: number;
  /** 1-based line number in the whole file. */
  line: number;
  children: OutlineHeading[];
}

export function outline(text: string) {
  const { frontmatterRaw, body, bodyLineOffset } = splitFrontmatter(text);
  const lines = scanLines(body);
  const roots: OutlineHeading[] = [];
  const stack: OutlineHeading[] = [];
  for (const h of findHeadings(lines)) {
    const node: OutlineHeading = { text: h.text, level: h.level, line: h.line + bodyLineOffset + 1, children: [] };
    while (stack.length > 0 && stack.at(-1)!.level >= h.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  const fm = parseFrontmatter(frontmatterRaw);
  return {
    headings: roots,
    blocks: findBlocks(lines).map((b) => ({ id: b.id, line: b.line + bodyLineOffset + 1 })),
    frontmatter_keys: fm ? Object.keys(fm) : [],
  };
}
