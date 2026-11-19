import { readFile } from 'node:fs/promises';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { parse as parseYaml, stringify } from 'yaml';
import { fetchCaller, type Caller } from '../mcp/caller.js';
import { ToolError } from '../mcp/errors.js';
import { buildMcpServer, runTool, visibleTools, type ToolName } from '../mcp/tools.js';

export const CLIENT_COMMANDS = ['whoami', 'search', 'ls', 'tags', 'read', 'new', 'edit', 'mv', 'trash', 'base', 'mcp', 'doctor'];

export const CLIENT_USAGE = `Client commands (need SPALL_TOKEN in the environment, and SPALL_URL or --url):
  whoami                                Your account, root and grants
  search <query> [--folder F] [--any] [--limit N] [--cursor C]
  search --related <path>               Notes similar to a note
  ls [folder] [--all] [--sort -modified] [--frontmatter] [--limit N]
  tags [folder]
  read <path>                           Print the note (raw markdown), or a .base file's YAML
  read <path> --outline | --frontmatter | --section "A > B" [--index N]
  read <path> --backlinks               Notes that link to this note
  read <file.base> --outline            The base's views (same as base --views)
  new <folder> <title> [--body text|-] [--fm key=value ...] [--fail]
  edit <path> [--rev R] <change>...     Atomic; --rev fails if the note changed. Changes:
      --set key=value  --unset key  --append  --append-to "A > B"  --prepend-to H
      --replace-section H  (these take --content text|-)  --replace OLD --with NEW
      --replace-all (whole file)  --ops file.json|-  (a JSON array of spall_edit ops)
      A .base file takes --replace/--with and --replace-all, and must stay a valid base
  mv <path> <destination> [--rename]   A destination ending in / or an existing folder: move into it
  trash <path> [--rev R]
  base <file.base> [--view V] [--limit N] [--cursor C]
  base <file.base> --views              Its views: filters, sort, columns, default view
  mcp [--read-only] [--tools a,b]       MCP server over stdio
  doctor                                Check the URL, token and grants

  --json   print JSON        "-" reads stdin        values in key=value are YAML (3, true, [a, b])
Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 forbidden, 5 rev conflict, 6 rate limited, 7 auth
`;

export interface IO {
  env: Record<string, string | undefined>;
  out(s: string): void;
  err(s: string): void;
  stdin(): Promise<string>;
  fetch?: typeof fetch;
}

const EXIT: Record<string, number> = { not_found: 3, forbidden: 4, rev_mismatch: 5, rate_limited: 6, unauthorized: 7 };

class UsageError extends Error {}

const COMMON = {
  url: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const OPTIONS: Record<string, ParseArgsConfig['options']> = {
  whoami: {},
  search: { folder: { type: 'string' }, any: { type: 'boolean' }, limit: { type: 'string' }, cursor: { type: 'string' }, related: { type: 'string' } },
  ls: { all: { type: 'boolean' }, sort: { type: 'string' }, frontmatter: { type: 'boolean' }, limit: { type: 'string' }, cursor: { type: 'string' } },
  tags: {},
  read: { outline: { type: 'boolean' }, frontmatter: { type: 'boolean' }, section: { type: 'string' }, index: { type: 'string' }, backlinks: { type: 'boolean' } },
  new: { body: { type: 'string' }, fm: { type: 'string', multiple: true }, fail: { type: 'boolean' } },
  edit: {
    rev: { type: 'string' },
    set: { type: 'string', multiple: true },
    unset: { type: 'string', multiple: true },
    append: { type: 'boolean' },
    'append-to': { type: 'string' },
    'prepend-to': { type: 'string' },
    'replace-section': { type: 'string' },
    'replace-all': { type: 'boolean' },
    content: { type: 'string' },
    replace: { type: 'string' },
    with: { type: 'string' },
    ops: { type: 'string' },
  },
  mv: { rename: { type: 'boolean' } },
  trash: { rev: { type: 'string' } },
  base: { view: { type: 'string' }, limit: { type: 'string' }, cursor: { type: 'string' }, views: { type: 'boolean' } },
  mcp: { 'read-only': { type: 'boolean' }, tools: { type: 'string' } },
  doctor: {},
};

const int = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name}: expected a number`);
  return Number(v);
};

/** `key=value`, the value parsed as YAML so `n=3` is a number and `tags=[a, b]` a list. */
function keyValue(s: string): [string, unknown] {
  const i = s.indexOf('=');
  if (i <= 0) throw new UsageError(`Expected key=value, got "${s}"`);
  const raw = s.slice(i + 1);
  let value: unknown = raw;
  try {
    value = raw === '' ? '' : parseYaml(raw);
  } catch {
    // keep the string
  }
  return [s.slice(0, i), value];
}

/**
 * Runs a client command. Returns the exit code, or null for `spall mcp`, which keeps running until
 * stdin closes.
 */
export async function clientMain(argv: string[], io: IO): Promise<number | null> {
  const [cmd, ...rest] = argv;
  let json = argv.includes('--json');
  try {
    if (!cmd || !(cmd in OPTIONS)) throw new UsageError(`Unknown command: ${cmd}`);
    if (rest.some((a) => a === '--token' || a.startsWith('--token='))) {
      throw new UsageError('There is no --token option: set SPALL_TOKEN in the environment, so the token stays out of argv');
    }
    const options = { ...COMMON, ...OPTIONS[cmd] };
    const { values: v, positionals: pos } = parseArgs({ args: joinValues(rest, options), allowPositionals: true, options });
    json = v.json === true;
    if (v.help) {
      io.out(commandHelp(cmd));
      return 0;
    }
    const url = (v.url as string | undefined) ?? io.env.SPALL_URL;
    // The token only comes from the environment, never argv (process listings, shell history).
    const token = io.env.SPALL_TOKEN;
    if (!url || !token) throw new UsageError('Set SPALL_TOKEN, and SPALL_URL (or pass --url)');
    const caller = fetchCaller(url, token, io.fetch);
    const ctx = { caller, io, json, url };
    return await COMMANDS[cmd]!(ctx, v as Values, pos);
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      io.err(`spall: ${(e as Error).message}\n\n${CLIENT_USAGE}`);
      return 2;
    }
    if (e instanceof ToolError) {
      e.message = e.message
        .replace(/spall_(whoami|read|edit|trash)/g, 'spall $1')
        .replace(/spall_move/g, 'spall mv')
        .replace(/view=outline/g, '--outline');
      if (json) io.err(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } })}\n`);
      else io.err(`spall: ${e.code}: ${e.message}${e.details ? `\n${JSON.stringify(e.details, null, 2)}` : ''}\n`);
      return EXIT[e.code] ?? 1;
    }
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    io.err(`spall: ${(e as Error).message}${cause ? ` (${cause})` : ''}\n`);
    return 1;
  }
}

/**
 * `--content "- item"` → `--content=- item`: parseArgs refuses option values that start with "-",
 * which list items and "-" (stdin) do.
 */
function joinValues(args: string[], options: NonNullable<ParseArgsConfig['options']>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const opt = a.startsWith('--') && !a.includes('=') ? options[a.slice(2)] : undefined;
    if (opt?.type === 'string' && i + 1 < args.length) out.push(`${a}=${args[++i]}`);
    else out.push(a);
  }
  return out;
}

/** The usage lines of one command, plus the footer. */
function commandHelp(cmd: string): string {
  const all = CLIENT_USAGE.split('\n');
  const out: string[] = [];
  let inCmd = false;
  for (const l of all.slice(1)) {
    if (/^  \S/.test(l)) inCmd = l.startsWith(`  ${cmd} `) || l === `  ${cmd}`;
    else if (!/^ {6}/.test(l)) inCmd = false;
    if (inCmd) out.push(l);
  }
  const footer = all.slice(all.findIndex((l) => l.startsWith('  --json')));
  return `Usage:\n${out.join('\n')}\n\n${footer.join('\n')}`;
}

type Values = Record<string, string | boolean | string[] | undefined>;
interface Ctx {
  caller: Caller;
  io: IO;
  json: boolean;
  url: string;
}
type Command = (ctx: Ctx, v: Values, pos: string[]) => Promise<number | null>;

const tool = async (ctx: Ctx, name: ToolName, args: Record<string, unknown>) =>
  (await runTool(name, ctx.caller, args, { fence: false })).data;

const arg = (pos: string[], i: number, name: string) => {
  const a = pos[i];
  if (a === undefined) throw new UsageError(`Missing <${name}>`);
  return a;
};

/** `-` reads stdin. */
const textArg = async (ctx: Ctx, s: string) => (s === '-' ? ctx.io.stdin() : s);

function print(ctx: Ctx, data: unknown, human: () => string) {
  ctx.io.out(ctx.json ? `${JSON.stringify(data, null, 2)}\n` : human());
}

const lines = (xs: string[]) => (xs.length ? `${xs.join('\n')}\n` : '');
const more = (d: Record<string, unknown>) => (d.next_cursor ? `(more: --cursor ${d.next_cursor})\n` : '');

interface BaseView {
  name: string;
  type: string;
  filters: unknown;
  order: string[] | null;
  sort: { property: string; direction: string }[];
  group_by: { property: string; direction: string } | null;
  limit: number | null;
}

const oneLine = (x: unknown) => (typeof x === 'string' ? x : JSON.stringify(x));

/** A base's views, as from spall_read view=outline on a .base file. */
function formatViews(d: Record<string, unknown>): string {
  const views = (d.views as BaseView[]) ?? [];
  return lines([
    `rev: ${d.rev}`,
    `default view: ${d.default_view ?? '(none)'}`,
    ...views.flatMap((v) => [
      `${v.name}  (${v.type})`,
      `  filters: ${v.filters === null ? '(none)' : oneLine(v.filters)}`,
      `  sort: ${v.sort.length ? v.sort.map((s) => `${s.property} ${s.direction}`).join(', ') : '(none)'}`,
      `  columns: ${v.order?.join(', ') ?? '(default)'}`,
      ...(v.group_by ? [`  group by: ${v.group_by.property} ${v.group_by.direction}`] : []),
      ...(v.limit !== null ? [`  limit: ${v.limit}`] : []),
    ]),
    ...((d.diagnostics as unknown[] | undefined)?.length ? [`diagnostics: ${JSON.stringify(d.diagnostics)}`] : []),
  ]);
}

interface Heading {
  text: string;
  level: number;
  line: number;
  children: Heading[];
}

const COMMANDS: Record<string, Command> = {
  async whoami(ctx) {
    const d = await tool(ctx, 'spall_whoami', {});
    const grants = d.access as { path: string; permissions: string[] }[];
    print(ctx, d, () =>
      lines([
        `account: ${d.account}`,
        `root: ${d.root === '' ? '(vault root)' : d.root}`,
        ...grants.map((g) => `  ${g.path}: ${g.permissions.join(', ') || 'none'}`),
        `rate limit: ${d.rate_limit}`,
      ]),
    );
    return 0;
  },

  async search(ctx, v, pos) {
    const args = { folder: v.folder, limit: int(v.limit as string, 'limit'), cursor: v.cursor };
    const d =
      v.related !== undefined
        ? await tool(ctx, 'spall_search', { related_to: v.related, ...args })
        : await tool(ctx, 'spall_search', { query: pos.join(' ') || arg(pos, 0, 'query'), match: v.any ? 'any' : 'all', ...args });
    const hits = d.results as { path: string; score: number; snippet: string }[];
    print(ctx, d, () => lines(hits.map((h) => `${h.path}  (${h.score})\n    ${h.snippet.replace(/\s+/g, ' ')}`)) + more(d));
    return 0;
  },

  async ls(ctx, v, pos) {
    const d = await tool(ctx, 'spall_list', {
      folder: pos[0] ?? '',
      depth: v.all ? 'all' : '1',
      sort: v.sort,
      limit: int(v.limit as string, 'limit'),
      cursor: v.cursor,
      frontmatter: v.frontmatter === true,
    });
    const items = d.results as { kind: string; path: string; frontmatter?: unknown }[];
    print(ctx, d, () =>
      lines(items.map((e) => `${e.path}${e.kind === 'folder' ? '/' : ''}${e.frontmatter ? `  ${JSON.stringify(e.frontmatter)}` : ''}`)) + more(d),
    );
    return 0;
  },

  async tags(ctx, _v, pos) {
    const d = await tool(ctx, 'spall_list', { view: 'tags', folder: pos[0] ?? '' });
    print(ctx, d, () => lines((d.results as { tag: string; count: number }[]).map((t) => `${String(t.count).padStart(5)}  #${t.tag}`)));
    return 0;
  },

  async read(ctx, v, pos) {
    const path = arg(pos, 0, 'path');
    if (v.backlinks) {
      const d = await tool(ctx, 'spall_read', { path, view: 'backlinks' });
      const back = d.backlinks as string[];
      print(ctx, d, () => (back.length ? lines(back) : `(no notes you can read link to ${d.path})\n`));
      return 0;
    }
    if (v.outline) {
      const d = await tool(ctx, 'spall_read', { path, view: 'outline' });
      if (d.views) {
        print(ctx, d, () => formatViews(d));
        return 0;
      }
      const walk = (hs: Heading[]): string[] => hs.flatMap((h) => [`${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text}  (line ${h.line})`, ...walk(h.children)]);
      print(ctx, d, () => lines([`rev: ${d.rev}`, ...walk(d.headings as Heading[])]));
      return 0;
    }
    if (v.frontmatter) {
      const d = await tool(ctx, 'spall_read', { path, view: 'frontmatter' });
      print(ctx, d, () => `rev: ${d.rev}\n${stringify(d.frontmatter ?? {})}`);
      return 0;
    }
    const d =
      v.section !== undefined
        ? await tool(ctx, 'spall_read', { path, view: 'section', heading: v.section, index: int(v.index as string, 'index'), max_chars: 200_000 })
        : await tool(ctx, 'spall_read', { path, max_chars: 200_000 });
    if (d.truncated) ctx.io.err(`spall: note cut at ${String(d.content).length} of ${d.total_chars} characters\n`);
    print(ctx, d, () => d.content as string);
    return 0;
  },

  async new(ctx, v, pos) {
    const folder = arg(pos, 0, 'folder');
    const title = arg(pos, 1, 'title');
    const frontmatter = v.fm ? Object.fromEntries((v.fm as string[]).map(keyValue)) : undefined;
    const body = v.body !== undefined ? await textArg(ctx, v.body as string) : '';
    const d = await tool(ctx, 'spall_create', { folder, title, body, frontmatter, on_conflict: v.fail ? 'fail' : 'rename' });
    print(ctx, d, () => `${d.path}\nrev: ${d.rev}\n`);
    return 0;
  },

  async edit(ctx, v, pos) {
    const path = arg(pos, 0, 'path');
    const content = async () => {
      if (v.content === undefined) throw new UsageError('This change needs --content text (or - for stdin)');
      return textArg(ctx, v.content as string);
    };
    let ops: Record<string, unknown>[] = [];
    if (v.ops !== undefined) {
      try {
        const src = v.ops as string;
        ops = JSON.parse(src === '-' ? await ctx.io.stdin() : await readFile(src, 'utf8'));
      } catch (e) {
        throw new UsageError(`--ops: ${(e as Error).message}`);
      }
      if (!Array.isArray(ops)) throw new UsageError('--ops: expected a JSON array of ops');
    }
    for (const s of (v.set as string[] | undefined) ?? []) {
      const [key, value] = keyValue(s);
      ops.push({ op: 'frontmatter.set', key, value });
    }
    for (const key of (v.unset as string[] | undefined) ?? []) ops.push({ op: 'frontmatter.unset', key });
    if (v.append) ops.push({ op: 'append', content: await content() });
    if (v['append-to'] !== undefined) ops.push({ op: 'append', heading: v['append-to'], content: await content() });
    if (v['prepend-to'] !== undefined) ops.push({ op: 'prepend', heading: v['prepend-to'], content: await content() });
    if (v['replace-section'] !== undefined) ops.push({ op: 'replace', heading: v['replace-section'], content: await content() });
    if (v['replace-all']) ops.push({ op: 'replace_all', content: await content() });
    if (v.replace !== undefined) {
      if (v.with === undefined) throw new UsageError('--replace needs --with');
      ops.push({ op: 'replace_text', old: v.replace, new: v.with });
    }
    if (ops.length === 0) throw new UsageError('Nothing to change: give --set, --append-to, --replace, --ops, …');
    const d = await tool(ctx, 'spall_edit', { path, expected_rev: v.rev, ops });
    print(ctx, d, () => `${d.path}\nrev: ${d.rev}${d.summary ? `  (${d.summary})` : ''}${d.changed ? '' : '  (unchanged)'}\n`);
    return 0;
  },

  async mv(ctx, v, pos) {
    const d = await tool(ctx, 'spall_move', { path: arg(pos, 0, 'path'), destination: arg(pos, 1, 'destination'), on_conflict: v.rename ? 'rename' : 'fail' });
    print(ctx, d, () => `${d.from} → ${d.path}\n`);
    return 0;
  },

  async trash(ctx, v, pos) {
    const d = await tool(ctx, 'spall_trash', { path: arg(pos, 0, 'path'), expected_rev: v.rev });
    print(ctx, d, () => `trashed ${d.trashed}\n`);
    return 0;
  },

  async base(ctx, v, pos) {
    if (v.views) {
      const p = arg(pos, 0, 'file.base');
      const d = await tool(ctx, 'spall_read', { path: /\.base$/i.test(p) ? p : `${p}.base`, view: 'outline' });
      print(ctx, d, () => formatViews(d));
      return 0;
    }
    const d = await tool(ctx, 'spall_query_base', { base: arg(pos, 0, 'file.base'), view: v.view, limit: int(v.limit as string, 'limit'), cursor: v.cursor });
    const cols = (d.columns as { key: string; name: string }[]) ?? [];
    const rows = d.results as { path: string; values: Record<string, unknown> }[];
    const cell = (x: unknown) => (x === null || x === undefined ? '' : typeof x === 'string' ? x : JSON.stringify(x));
    print(ctx, d, () =>
      lines([['path', ...cols.map((c) => c.name)].join('\t'), ...rows.map((r) => [r.path, ...cols.map((c) => cell(r.values[c.key]))].join('\t'))]) +
        more(d),
    );
    return 0;
  },

  async mcp(ctx, v) {
    const me = await tool(ctx, 'spall_whoami', {});
    const mcp = (me.mcp ?? {}) as { enabled?: boolean; read_only?: boolean; tools?: string[] | null; fence_untrusted?: boolean };
    if (mcp.enabled === false) throw new ToolError('forbidden', 'MCP is disabled on this server (mcp.enabled: false)');
    const tools = visibleTools(me.access as { permissions: string[] }[], mcp, {
      read_only: v['read-only'] === true,
      tools: typeof v.tools === 'string' ? v.tools.split(',').map((t) => t.trim()) : null,
    });
    serveStdio(() => buildMcpServer(tools, ctx.caller, { fence: mcp.fence_untrusted ?? true }), {
      onerror: (e) => ctx.io.err(`spall mcp: ${e.message}\n`),
    });
    return null;
  },

  async doctor(ctx) {
    const checks: { check: string; ok: boolean; detail: string }[] = [];
    const add = (check: string, ok: boolean, detail: string) => {
      checks.push({ check, ok, detail });
      if (!ctx.json) ctx.io.out(`${ok ? 'ok  ' : 'FAIL'}  ${check}: ${detail}\n`);
    };
    let health: CallResultLike | null = null;
    try {
      health = await ctx.caller({ method: 'GET', url: '/healthz' });
      const version = (JSON.parse(health.body) as { version?: string }).version;
      add('server', health.status === 200, `${ctx.url} (HTTP ${health.status}${version ? `, spall ${version}` : ''})`);
    } catch (e) {
      add('server', false, `${ctx.url} unreachable: ${(e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message}`);
    }
    let code = health?.status === 200 ? 0 : 1;
    if (code === 0) {
      try {
        const me = await tool(ctx, 'spall_whoami', {});
        add('token', true, `account ${me.account}, token ${(me.token as { name: string }).name}`);
        const grants = me.access as { path: string; permissions: string[] }[];
        add('grants', grants.length > 0, grants.map((g) => `${g.path}: ${g.permissions.join(',') || 'none'}`).join('; ') || 'none');
        const mcp = me.mcp as { enabled?: boolean } | undefined;
        add('mcp', mcp?.enabled !== false, mcp ? (mcp.enabled ? 'enabled' : 'disabled on the server') : 'server is older than 1.1 (no /mcp)');
      } catch (e) {
        if (!(e instanceof ToolError)) throw e;
        add('token', false, `${e.code}: ${e.message}`);
        code = EXIT[e.code] ?? 1;
      }
    }
    if (ctx.json) ctx.io.out(`${JSON.stringify({ ok: checks.every((c) => c.ok), checks }, null, 2)}\n`);
    return code !== 0 ? code : checks.every((c) => c.ok) ? 0 : 1;
  },
};

type CallResultLike = Awaited<ReturnType<Caller>>;
