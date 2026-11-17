import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ToolError } from './errors.js';

/** One call into the Spall REST API. `tool` names the MCP tool making it (for the audit log). */
export interface CallRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON-encoded unless it is a string. */
  body?: unknown;
  tool?: string;
}

export interface CallResult {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/**
 * How tools reach Spall: in-process through Fastify's inject (the /mcp endpoint) or over HTTP
 * (`spall mcp`, the CLI). Either way every call goes through the REST layer's auth, scoping, rate
 * limits, rev checks and audit log.
 */
export type Caller = (req: CallRequest) => Promise<CallResult>;

const dotSegment = () => new ToolError('invalid_path', 'Relative path segments ("." and "..") are not allowed');

/**
 * `Research/Some note` → `Research/Some%20note`; leading and trailing slashes are dropped. `.` and
 * `..` are rejected: URL normalisation would resolve them, so the call would reach another resource.
 */
export const encPath = (p: string): string =>
  p
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      if (s === '.' || s === '..') throw dotSegment();
      return encodeURIComponent(s);
    })
    .join('/');

/** Both callers check the final URL too, before inject or fetch can normalise it. */
function checkUrl(url: string): void {
  for (const seg of url.split(/[?#]/)[0]!.split('/')) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // REST rejects malformed encoding itself
    }
    if (decoded === '.' || decoded === '..') throw dotSegment();
  }
}

/** `{a: 1, b: undefined}` → `?a=1`. */
export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s === '' ? '' : `?${s}`;
}

/**
 * A per-process secret on injected requests. Only requests carrying it may set `x-spall-via`, so a
 * client can't put `via: mcp/...` into the audit log by sending the header itself.
 */
const INJECT_SECRET = randomBytes(24).toString('base64url');

export const VIA_HEADER = 'x-spall-via';
export const INJECT_HEADER = 'x-spall-inject';

export function isInjected(value: string | string[] | undefined): boolean {
  if (typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(INJECT_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const flatHeaders = (h: Record<string, string | string[] | number | undefined>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v === undefined ? undefined : String(v)]));

/** Calls the server in-process with the MCP request's own Authorization header. */
export function injectCaller(app: FastifyInstance, authorization: string): Caller {
  return async (r) => {
    checkUrl(r.url);
    const headers: Record<string, string> = { authorization, ...r.headers };
    if (r.tool) Object.assign(headers, { [VIA_HEADER]: `mcp/${r.tool}`, [INJECT_HEADER]: INJECT_SECRET });
    let payload: string | undefined;
    if (r.body !== undefined) {
      payload = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      headers['content-type'] ??= typeof r.body === 'string' ? 'text/markdown' : 'application/json';
    }
    const res = await app.inject({ method: r.method, url: r.url, headers, payload });
    return { status: res.statusCode, headers: flatHeaders(res.headers), body: res.body };
  };
}

/** Calls a Spall server over HTTP. */
export function fetchCaller(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): Caller {
  const base = baseUrl.replace(/\/+$/, '');
  return async (r) => {
    checkUrl(r.url);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...r.headers };
    let body: string | undefined;
    if (r.body !== undefined) {
      body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      headers['content-type'] ??= typeof r.body === 'string' ? 'text/markdown' : 'application/json';
    }
    const res = await fetchImpl(base + r.url, { method: r.method, headers, body });
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  };
}
