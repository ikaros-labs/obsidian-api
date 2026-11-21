import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolError } from './errors.js';

/**
 * What a tool handler returns: `text` (default: `data` as JSON) is the text content; `data` is
 * also structuredContent when the account doesn't fence (see toResult).
 */
export interface ToolOutput {
  data: Record<string, unknown>;
  text?: string;
}

/**
 * The MCP result. With fencing on there is no structuredContent: clients (Claude Code among them)
 * show the model structuredContent instead of the text when both are present, and it can't be
 * fenced, so the text, which carries the same data, is the only copy.
 */
export function toResult(out: ToolOutput, opts: { fence: boolean }): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'text', text: out.text ?? JSON.stringify(out.data) }];
  return opts.fence ? { content } : { content, structuredContent: out.data };
}

/**
 * Error details that never hold text from the vault: paths (plain everywhere), revs, numbers and what
 * the caller itself sent. Everything else (heading candidates, view names, diagnostics…) can.
 */
const PLAIN_DETAILS = ['did_you_mean', 'retry_after', 'current_rev', 'changed', 'path', 'kind', 'use', 'issues'];

export function errorResult(e: ToolError, opts: { fence: boolean }): CallToolResult {
  const error = { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  let details = e.details ? `\n${JSON.stringify(e.details)}` : '';
  if (opts.fence && e.details) {
    // An invalid base is described in the file's own words (its keys, its YAML): nothing is plain.
    const [plain, note] = split(e.details, e.code === 'invalid_base' ? [] : PLAIN_DETAILS);
    details = `${Object.keys(plain).length > 0 ? `\n${JSON.stringify(plain)}` : ''}${Object.keys(note).length > 0 ? `\n${fence(JSON.stringify(note), {})}` : ''}`;
  }
  const content: CallToolResult['content'] = [{ type: 'text', text: `${e.code}: ${e.message}${details}` }];
  return opts.fence ? { isError: true, content } : { isError: true, content, structuredContent: { error } };
}

/** Cuts `text` to at most `max` characters, at a line boundary when there is one. */
export function truncateLines(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.lastIndexOf('\n', max - 1);
  return { text: text.slice(0, cut > 0 ? cut + 1 : max), truncated: true };
}

const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Wraps note content in `<untrusted-content>` markers. A closing marker inside the note is
 * escaped, so the note can't end the fence early.
 */
export function fence(content: string, attrs: Record<string, string>): string {
  const a = Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${attr(v)}"`)
    .join('');
  const safe = content.replace(/<\/(untrusted-content)/gi, '<\\/$1');
  return `<untrusted-content source="spall"${a}>\n${safe}${safe.endsWith('\n') || safe === '' ? '' : '\n'}</untrusted-content>`;
}

type Obj = Record<string, unknown>;

/** Splits `o` into the fields named in `keys` and the rest, in that order. */
function split(o: Obj, keys: readonly string[]): [Obj, Obj] {
  const named: Obj = {};
  const rest: Obj = {};
  for (const [k, v] of Object.entries(o)) (keys.includes(k) ? named : rest)[k] = v;
  return [named, rest];
}

/**
 * The text of a result that carries note text: the fields named in `noteKeys` (at the top, and in
 * each of `results`) go as JSON inside one fence per note, path in its attrs; everything else stays
 * plain JSON, one line for the result (if it has other fields) and one per item. Undefined when there is no note text, so
 * the caller keeps the plain JSON.
 */
export function fencedText(data: Obj, noteKeys: { top?: readonly string[]; item?: readonly string[] }): string | undefined {
  const { results, ...rest } = data;
  const items = noteKeys.item && Array.isArray(results) ? (results as Obj[]) : null;
  const out: string[] = [];
  let fenced = false;
  const add = (o: Obj, keys: readonly string[]) => {
    const [note, plain] = split(o, keys);
    if (Object.keys(plain).length > 0) out.push(JSON.stringify(plain));
    if (Object.keys(note).length === 0) return;
    fenced = true;
    out.push(fence(JSON.stringify(note), typeof o.path === 'string' ? { path: o.path } : {}));
  };
  add(items ? rest : data, noteKeys.top ?? []);
  for (const r of items ?? []) add(r, noteKeys.item!);
  return fenced ? `${out.join('\n')}\n` : undefined;
}

export interface TreeData {
  path: string;
  notes: number;
  total_folders: number;
  folders: { name: string; depth: number; notes: number; traverse_only?: boolean; more_folders?: number }[];
  truncated: boolean;
  omitted?: number;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** An indented folder tree, one folder per line with its note count. */
export function treeText(t: TreeData): string {
  const lines = [`${t.path === '' ? '(root)' : `${t.path}/`}  ${plural(t.notes, 'note')}, ${plural(t.total_folders, 'folder')}`];
  for (const f of t.folders) {
    const extra = [
      ...(f.traverse_only ? ['traverse only'] : []),
      plural(f.notes, 'note'),
      ...(f.more_folders ? [`${plural(f.more_folders, 'subfolder')} below`] : []),
    ];
    lines.push(`${'  '.repeat(f.depth)}${f.name}/  ${extra.join(', ')}`);
  }
  if (t.truncated) lines.push(`[truncated: ${plural(t.omitted ?? 0, 'more folder')} not shown; raise limit or list a subfolder]`);
  return `${lines.join('\n')}\n`;
}
