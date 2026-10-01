import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Account } from '../config.js';
import { ApiError } from '../errors.js';
import { hashToken, isExpired } from '../tokens.js';
import { baseRoutes } from './bases.js';
import { Ctx, sendError, type Services } from './context.js';
import { fileRoutes } from './files.js';
import { folderRoutes } from './folders.js';
import { noteRoutes } from './notes.js';

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
  });
  const limiter = new RateLimiter();

  app.decorateRequest('auth', null);

  app.addContentTypeParser(['text/markdown', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/') && req.url.split('?')[0] !== '/v1') return;
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) throw new ApiError(401, 'unauthorized', 'Missing bearer token');
    const found = s.config().tokensByHash.get(hashToken(m[1]!));
    if (!found) throw new ApiError(401, 'unauthorized', 'Invalid token');
    if (isExpired(found.token.expires)) throw new ApiError(401, 'unauthorized', 'Token expired');
    const wait = limiter.take(found.account);
    if (wait > 0) throw new ApiError(429, 'rate_limited', `Rate limit of ${found.account.rateLimit.spec} exceeded`, { retry_after: wait });
    req.auth = found;
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

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/v1/me', async (req) => {
    const ctx = new Ctx(req, s);
    const a = ctx.account;
    return {
      account: a.name,
      description: a.description ?? null,
      root: a.rootPath,
      access: a.grants,
      rate_limit: a.rateLimit.spec,
      token: { name: ctx.token.name, expires: ctx.token.expires ?? null },
    };
  });

  noteRoutes(app, s);
  folderRoutes(app, s);
  baseRoutes(app, s);
  app.register(async (scope) => fileRoutes(scope, s));

  return app;
}
