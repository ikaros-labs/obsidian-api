import type { CallToolResult } from '@modelcontextprotocol/server';
import { ToolError } from './errors.js';

/** What a tool handler returns: `data` becomes structuredContent; `text` (default: data as JSON) the text content. */
export interface ToolOutput {
  data: Record<string, unknown>;
  text?: string;
}

export function toResult(out: ToolOutput): CallToolResult {
  return {
    content: [{ type: 'text', text: out.text ?? JSON.stringify(out.data) }],
    structuredContent: out.data,
  };
}

export function errorResult(e: ToolError): CallToolResult {
  const error = { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  return {
    isError: true,
    content: [{ type: 'text', text: `${e.code}: ${e.message}${e.details ? `\n${JSON.stringify(e.details)}` : ''}` }],
    structuredContent: { error },
  };
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
