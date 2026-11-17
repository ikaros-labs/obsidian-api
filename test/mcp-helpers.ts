import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestEnv } from './helpers.js';

/** A fetch that serves requests from the app in-process. */
export function injectFetch(env: TestEnv): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const res = await env.app.server.inject({
      method: req.method as 'POST',
      url: u.pathname + u.search,
      headers: Object.fromEntries(req.headers),
      payload: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
    });
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return new Response(res.statusCode === 204 || res.statusCode === 202 ? null : res.body, { status: res.statusCode, headers });
  }) as typeof fetch;
}

export type Era = 'legacy' | 'modern';

/** An MCP client for `account`, talking to /mcp in-process. */
export async function mcpClient(env: TestEnv, account: string, opts: { query?: string; era?: Era } = {}): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://spall.test/mcp${opts.query ?? ''}`), {
    fetch: injectFetch(env),
    requestInit: { headers: { authorization: `Bearer tok-${account}` } },
  });
  const client = new Client(
    { name: 'spall-test', version: '0' },
    opts.era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns its text, structured content and error flag. */
export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  return { text: r.content.map((c) => c.text).join('\n'), data: r.structuredContent ?? {}, isError: r.isError === true };
}
