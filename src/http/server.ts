import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Account } from '../config.js';
import { ApiError } from '../errors.js';
import { INJECT_HEADER, isInjected, VIA_HEADER } from '../mcp/caller.js';
import { hashToken, isExpired } from '../tokens.js';
import { baseRoutes } from './bases.js';
import { Ctx, sendError, type Services } from './context.js';
import { fileRoutes } from './files.js';
import { folderRoutes } from './folders.js';
import { mcpRoutes } from './mcp.js';
import { noteRoutes } from './notes.js';
import { doc, registerOpenApi } from './openapi.js';
import { searchRoutes } from './search.js';
import { statsRoutes } from './stats.js';

/** Routes that need a bearer token: the REST API and the MCP endpoint. */
export function isAuthed(url: string): boolean {
  const pathname = url.split('?')[0]!;
  return url.startsWith('/v1/') || pathname === '/v1' || pathname === '/mcp';
}

/** Longest accepted request URL (path plus query string). */
const MAX_URL = 16 * 1024;

/** Fixed-window rate limit per account. */
class RateLimiter {
  private windows = new Map<string, { start: number; count: number; limit: number }>();

  /** Returns 0 when allowed, otherwise seconds until the window resets. */
  take(account: Account, now = Date.now()): number {
    const { limit, windowMs } = account.rateLimit;
    let w = this.windows.get(account.name);
    if (!w || now - w.start >= windowMs || w.limit !== limit) {
      w = { start: now, count: 0, limit };
      this.windows.set(account.name, w);
    }
    if (w.count >= limit) return Math.max(1, Math.ceil((w.start + windowMs - now) / 1000));
    w.count++;
    return 0;
  }
}

export function buildServer(s: Services, opts: { logger?: FastifyServerOptions['logger'] } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: s.config().server.maxBody,
    routerOptions: { maxParamLength: 10_000 },
    genReqId: () => randomUUID(),
    // Requests Node can't even parse (e.g. raw non-ASCII bytes in the URL) get the usual envelope.
    clientErrorHandler: (err, socket) => {
      if (!socket.writable) return socket.destroy(err);
      const body = JSON.stringify({ error: { code: 'invalid_request', message: 'Malformed HTTP request (percent-encode non-ASCII URLs)' } });
      socket.end(
        `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    },
  });
  const limiter = new RateLimiter();

  app.decorateRequest('auth', null);
  app.decorateRequest('via', null);

  app.addContentTypeParser(['text/markdown', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req) => {
    if (req.url.length > MAX_URL) throw new ApiError(414, 'invalid_request', `URL is longer than ${MAX_URL} characters`);
    if (!isAuthed(req.url)) return;
    const mcp = req.url.split('?')[0] === '/mcp';
    if (mcp && !s.config().mcp.enabled) throw new ApiError(404, 'not_found', 'No such endpoint');
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
    const found = s.config().tokensByHash.get(hashToken(m[1]!));
    if (!found) throw new ApiError(401, 'unauthorized', 'Invalid token');
    if (isExpired(found.token.expires)) throw new ApiError(401, 'unauthorized', 'Token expired');
    // An MCP request isn't counted itself: the REST calls its tools make are.
    const wait = mcp ? 0 : limiter.take(found.account);
    if (wait > 0) throw new ApiError(429, 'rate_limited', `Rate limit of ${found.account.rateLimit.spec} exceeded`, { retry_after: wait });
    req.auth = found;
    if (isInjected(req.headers[INJECT_HEADER])) {
      const via = req.headers[VIA_HEADER];
      if (typeof via === 'string') req.via = via;
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      if (err.code === 'rate_limited') reply.header('retry-after', String(err.details?.retry_after ?? 1));
      return sendError(reply, err, req.id);
    }
    const e = err as { code?: string; statusCode?: number; message: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return sendError(reply, new ApiError(413, 'payload_too_large', 'Request body is too large'), req.id);
    }
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return sendError(reply, new ApiError(415, 'invalid_request', 'Unsupported Content-Type'), req.id);
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      return sendError(reply, new ApiError(e.statusCode, 'invalid_request', e.message), req.id);
    }
    req.log.error(err);
    return sendError(reply, new ApiError(500, 'internal', 'Internal error'), req.id);
  });

  app.setNotFoundHandler((req, reply) => sendError(reply, new ApiError(404, 'not_found', 'No such endpoint'), req.id));

  registerOpenApi(app);

  app.register(async (api) => routes(api, s));

  return app;
}

/** The OpenAPI document. It depends only on the routes, not on the config or the vault. */
export async function openApiDocument() {
  const app = buildServer({ config: () => ({ server: { maxBody: 1 } }) } as unknown as Services);
  await app.ready();
  const document = app.swagger();
  await app.close();
  return document;
}

function routes(app: FastifyInstance, s: Services) {
  app.get('/healthz', { schema: doc({ summary: 'Liveness check', tag: 'System', public: true }) }, async () => ({ ok: true }));

  app.get('/openapi.json', { schema: doc({ summary: 'This OpenAPI document', tag: 'System', public: true }) }, async () => app.swagger());

  app.get('/v1/me', { schema: doc({ summary: 'The calling account, its root, grants and token', tag: 'System' }) }, async (req) => {
    const ctx = new Ctx(req, s);
    const a = ctx.account;
    return {
      account: a.name,
      description: a.description ?? null,
      root: a.rootPath,
      access: a.grants,
      rate_limit: a.rateLimit.spec,
      token: { name: ctx.token.name, expires: ctx.token.expires ?? null },
      mcp: { enabled: s.config().mcp.enabled, ...a.mcp },
    };
  });

  noteRoutes(app, s);
  folderRoutes(app, s);
  baseRoutes(app, s);
  searchRoutes(app, s);
  statsRoutes(app, s);
  mcpRoutes(app, s);
  app.register(async (scope) => fileRoutes(scope, s));
}
