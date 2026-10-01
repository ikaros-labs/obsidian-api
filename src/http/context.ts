import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Perm } from '../access.js';
import type { Account, Config, TokenInfo } from '../config.js';
import { ApiError, forbidden, invalidRequest, notFound } from '../errors.js';
import { isPrefix, join, parseUrlPath, split, type Segs } from '../paths.js';
import type { AuditLog, Vault } from '../vault.js';
import type { Entry, VaultIndex } from '../vault-index.js';

export interface Services {
  config: () => Config;
  index: VaultIndex;
  vault: Vault;
  audit: AuditLog;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: { account: Account; token: TokenInfo } | null;
  }
}

const VERBS: Record<Perm, string> = { read: 'read', create: 'create', update: 'update', delete: 'delete', purge: 'permanently delete' };

/** Per-request helpers bound to the authenticated account. */
export class Ctx {
  readonly account: Account;
  readonly token: TokenInfo;

  constructor(
    readonly req: FastifyRequest,
    readonly s: Services,
  ) {
    if (!req.auth) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
    this.account = req.auth.account;
    this.token = req.auth.token;
  }

  /** Account-relative URL path after `prefix` → vault-relative segments. */
  urlPath(prefix: string): string[] {
    const pathname = this.req.url.split('?')[0]!;
    if (!pathname.startsWith(prefix)) return [...this.account.root];
    return [...this.account.root, ...parseUrlPath(pathname.slice(prefix.length))];
  }

  toVault(rootRelative: string[]): string[] {
    return [...this.account.root, ...rootRelative];
  }

  /** Vault-relative path → path as the account sees it. */
  toApi(vaultPath: string | Segs): string {
    const segs = typeof vaultPath === 'string' ? split(vaultPath) : vaultPath;
    return join(isPrefix(this.account.root, segs) ? segs.slice(this.account.root.length) : segs);
  }

  perms(segs: Segs) {
    return this.account.access.perms(segs);
  }

  can(segs: Segs, perm: Perm): boolean {
    return this.account.access.can(segs, perm);
  }

  /** Whether the account can read an index entry (checked on the symlink target too). */
  visible = (e: Entry): boolean => this.can(e.segs, 'read') && (!e.real || this.can(e.real, 'read'));

  /** Folder the account can't read but must see to reach something it can. */
  traversable = (e: Entry): boolean =>
    this.account.access.leadsToReadable(e.segs) && (!e.real || this.account.access.leadsToReadable(e.real));

  /** Throws 404 when the account can't see the path, 403 when it can but lacks `perm`. */
  require(segs: Segs, ...perms: Perm[]): void {
    const has = this.perms(segs);
    const missing = perms.find((p) => !has.has(p));
    if (missing === undefined) return;
    if (!has.has('read')) throw notFound();
    throw forbidden(VERBS[missing]);
  }

  /** Follows symlinks and checks the permissions again on the real target. */
  async resolve(segs: string[], ...perms: Perm[]): Promise<string[]> {
    this.require(segs, ...perms);
    const real = await this.s.vault.resolve(segs);
    if (join(real) !== join(segs)) this.require(real, ...perms);
    return real;
  }

  audit(op: string, path: string | Segs, extra: Record<string, unknown> = {}): Promise<void> {
    return this.s.audit.write({
      account: this.account.name,
      token: this.token.name,
      op,
      path: typeof path === 'string' ? path : join(path),
      ...extra,
    });
  }
}

export function parse<S extends z.ZodType>(schema: S, data: unknown, where = 'body'): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  throw invalidRequest(`Invalid ${where}`, {
    issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** ETag header value for a rev. */
export const etag = (rev: string) => `"${rev}"`;

/** Strips quotes and a weak prefix from an If-Match / If-None-Match value. */
export function parseEtagList(header: string | undefined): string[] | null {
  if (header === undefined) return null;
  return header.split(',').map((t) => t.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
}

export function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(', ') : v;
}

/** Picks the best of `offers` for the Accept header (q-values, then specificity, then offer order). */
export function negotiate(accept: string | undefined, offers: string[]): string {
  if (!accept) return offers[0]!;
  const ranges = accept.split(',').map((part) => {
    const [type = '', ...params] = part.trim().split(';');
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return { type: type.trim().toLowerCase(), q: q ? Number(q.slice(2)) : 1 };
  });
  let best: { offer: string; q: number; spec: number } | null = null;
  for (const offer of offers) {
    const [major] = offer.split('/');
    for (const r of ranges) {
      const spec = r.type === offer ? 2 : r.type === `${major}/*` ? 1 : r.type === '*/*' ? 0 : -1;
      if (spec < 0 || !(r.q > 0)) continue;
      if (!best || r.q > best.q || (r.q === best.q && spec > best.spec)) best = { offer, q: r.q, spec };
    }
  }
  return best?.offer ?? offers[0]!;
}

/** `fields=path,frontmatter.status` → a copy of `obj` with only those (dotted) fields. */
export function project(obj: Record<string, unknown>, fields: string | undefined): Record<string, unknown> {
  if (!fields) return obj;
  const out: Record<string, unknown> = {};
  for (const field of fields.split(',').map((f) => f.trim()).filter(Boolean)) {
    const parts = field.split('.');
    let src: unknown = obj;
    for (const p of parts) src = src && typeof src === 'object' ? (src as Record<string, unknown>)[p] : undefined;
    if (src === undefined) continue;
    let dst = out;
    parts.slice(0, -1).forEach((p) => {
      dst[p] = dst[p] && typeof dst[p] === 'object' ? dst[p] : {};
      dst = dst[p] as Record<string, unknown>;
    });
    dst[parts.at(-1)!] = src;
  }
  return out;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export function sendError(reply: FastifyReply, err: ApiError, requestId: string) {
  if (err.status === 401) reply.header('www-authenticate', 'Bearer');
  return reply
    .code(err.status)
    .type('application/json')
    .send({ error: { code: err.code, message: err.message, request_id: requestId, ...(err.details ? { details: err.details } : {}) } });
}
