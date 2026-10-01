import { ApiError } from './errors.js';

/** A path as a list of segments. `[]` is the root. Always NFC-normalised. */
export type Segs = readonly string[];

const invalid = (message: string) => new ApiError(400, 'invalid_path', message);

export const join = (segs: Segs): string => segs.join('/');
export const split = (path: string): string[] => (path === '' ? [] : path.split('/'));

function checkSegment(seg: string): string {
  if (seg === '') throw invalid('Empty path segment');
  if (seg === '.' || seg === '..') throw invalid('Relative path segments are not allowed');
  if (/[/\\]/.test(seg)) throw invalid('Path segments may not contain slashes or backslashes');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(seg)) throw invalid('Path segments may not contain control characters');
  return seg.normalize('NFC');
}

/**
 * Parses the still-percent-encoded tail of a request URL, e.g. `Research/Some%20note.md`.
 * One trailing slash is allowed. An encoded `/` inside a segment is rejected.
 */
export function parseUrlPath(raw: string): string[] {
  const s = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (s === '') return [];
  return s.split('/').map((seg) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw invalid('Malformed percent-encoding in path');
    }
    return checkSegment(decoded);
  });
}

/** Parses a plain path from a JSON body or the config. Leading/trailing slashes are ignored; `''` and `.` are the root. */
export function parsePlainPath(path: string): string[] {
  const s = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '' || s === '.') return [];
  return s.split('/').map(checkSegment);
}

/**
 * The form a segment is compared in for access decisions: NFC, case-folded, without leading spaces
 * and trailing dots/spaces. This way `.Git`, `.git.` and `Private ` can't slip past a rule.
 */
export const matchKey = (seg: string): string =>
  seg.normalize('NFC').toLowerCase().replace(/^ +/, '').replace(/[. ]+$/, '');

export const matchKeys = (segs: Segs): string[] => segs.map(matchKey);

/** Dotfiles and dot-folders (`.obsidian`, `.git`, `.trash`, …) are never visible to any account. */
export function hasDotSegment(segs: Segs): boolean {
  return segs.some((s) => {
    const k = matchKey(s);
    return k === '' || k.startsWith('.');
  });
}

export function isPrefix(prefix: readonly string[], of: readonly string[]): boolean {
  if (prefix.length > of.length) return false;
  return prefix.every((s, i) => s === of[i]);
}

export const isNote = (segs: Segs): boolean => (segs.at(-1) ?? '').toLowerCase().endsWith('.md');

/** `foo` → `foo.md`, `foo.md` stays. */
export function withMdExtension(segs: string[]): string[] {
  if (segs.length === 0 || isNote(segs)) return segs;
  return [...segs.slice(0, -1), `${segs.at(-1)}.md`];
}

/** Turns a title into a safe note file name (without extension). */
export function sanitizeTitle(title: string): string {
  let name = title
    .normalize('NFC')
    .replace(/[/\\]/g, '-')
    .replace(/[*"<>:|?#^[\]]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > 150) name = name.slice(0, 150).trim();
  return name === '' ? 'Untitled' : name;
}
