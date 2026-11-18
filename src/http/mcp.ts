import { Readable } from 'node:stream';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, forbidden } from '../errors.js';
import { injectCaller } from '../mcp/caller.js';
import { buildMcpServer, visibleTools } from '../mcp/tools.js';
import { Ctx, parse, type Services } from './context.js';

const McpQuery = z.object({
  read_only: z.enum(['1', 'true', '0', 'false']).optional(),
  tools: z.string().optional(),
});

/**
 * POST /mcp: a stateless Streamable HTTP MCP endpoint. Each request gets a fresh MCP server with
 * only the tools the account may use; the tools call the REST routes in-process with the request's
 * own token, so auth, scoping, rate limits, rev checks and the audit log are exactly the REST ones.
 */
export function mcpRoutes(app: FastifyInstance, s: Services) {
  const handler = createMcpHandler(
    ({ authInfo }) => (authInfo?.extra?.build as () => McpServer)(),
    { legacy: 'stateless' },
  );

  app.post('/mcp', { schema: { hide: true } }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    const origin = req.headers.origin;
    if (origin !== undefined && !s.config().mcp.allowedOrigins.includes(origin)) throw forbidden('call /mcp from this Origin');
    const q = parse(McpQuery, req.query, 'query');
    const a = ctx.account;
    const tools = visibleTools(a.grants, a.mcp, {
      read_only: q.read_only === '1' || q.read_only === 'true',
      tools: q.tools ? q.tools.split(',').map((t) => t.trim()) : null,
    });
    const caller = injectCaller(app, req.headers.authorization!);
    const build = () => buildMcpServer(tools, caller, { fence: a.mcp.fence_untrusted });

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(`http://spall.local${req.url}`, { method: 'POST', headers, body: JSON.stringify(req.body ?? null) });
    const res = await handler.fetch(request, {
      authInfo: { token: '', clientId: a.name, scopes: [], extra: { build } },
      parsedBody: req.body,
    });
    reply.code(res.status);
    res.headers.forEach((v, k) => {
      if (k !== 'content-length') reply.header(k, v);
    });
    return reply.send(res.body ? Readable.fromWeb(res.body as never) : '');
  });

  const notAllowed = async () => {
    throw new ApiError(405, 'invalid_request', 'Method not allowed: this MCP endpoint is stateless, use POST');
  };
  app.get('/mcp', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('allow', 'POST');
    return notAllowed();
  });
  app.delete('/mcp', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('allow', 'POST');
    return notAllowed();
  });
}
