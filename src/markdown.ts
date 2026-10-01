import { parseDocument } from 'yaml';

export type Frontmatter = Record<string, unknown>;

export interface SplitNote {
  /** Raw YAML between the `---` fences (with its trailing newline), or null when there is none. */
  frontmatterRaw: string | null;
  body: string;
  /** Number of lines before the body starts. */
  bodyLineOffset: number;
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
      };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return none;
}

export function joinFrontmatter(frontmatterRaw: string | null, body: string): string {
  if (frontmatterRaw === null) return body;
  const fm = frontmatterRaw === '' || frontmatterRaw.endsWith('\n') ? frontmatterRaw : `${frontmatterRaw}\n`;
  return `---\n${fm}---\n${body}`;
}

/** Parses frontmatter YAML. Returns null if it is not valid YAML or not a mapping. */
export function parseFrontmatter(raw: string | null): Frontmatter | null {
  if (raw === null) return {};
  const doc = parseDocument(raw);
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

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

export function headingOf(line: Line): { level: number; text: string } | null {
  if (line.code) return null;
  const m = HEADING_RE.exec(line.text);
  if (!m) return null;
  const text = (m[2] ?? '').replace(/(^|[ \t]+)#+$/, '').trim();
  return { level: m[1]!.length, text };
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
const MD_LINK_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function extractLinks(lines: Line[]): RawLink[] {
  const out: RawLink[] = [];
  const seen = new Set<string>();
  const add = (target: string, kind: RawLink['kind']) => {
    const t = target.trim();
    if (t === '' || seen.has(`${kind}:${t}`)) return;
    seen.add(`${kind}:${t}`);
    out.push({ target: t, kind });
  };
  for (const line of lines) {
    if (line.code) continue;
    const text = stripInlineCode(line.text);
    for (const m of text.matchAll(WIKI_RE)) add(m[1]!.split('|')[0]!.split(/[#^]/)[0]!, 'wiki');
    for (const m of text.matchAll(MD_LINK_RE)) {
      const href = m[1]!;
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
  return { frontmatter, tags: extractTags(frontmatter, lines), links: extractLinks(lines) };
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
