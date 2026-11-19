import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientMain } from '../src/cli/client.js';
import { ACCOUNTS, setup, type TestEnv } from './helpers.js';
import { injectFetch } from './mcp-helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ accounts: { ...ACCOUNTS, agent: { ...ACCOUNTS.agent, rate_limit: '10000/min' } } });
});
afterAll(() => env.cleanup());

/** Runs `spall <argv>` in-process against the test app. */
async function spall(account: string | null, argv: string[], stdin = '') {
  let out = '';
  let err = '';
  const code = await clientMain(argv, {
    env: account ? { SPALL_URL: 'http://spall.test', SPALL_TOKEN: `tok-${account}` } : {},
    out: (s) => (out += s),
    err: (s) => (err += s),
    stdin: async () => stdin,
    fetch: injectFetch(env),
  });
  return { code, out, err };
}

const note = (rel: string) => readFileSync(path.join(env.vault, rel), 'utf8');

describe('spall client commands', () => {
  it('whoami, human and --json', async () => {
    const h = await spall('agent', ['whoami']);
    expect(h).toMatchObject({ code: 0, err: '' });
    expect(h.out).toContain('account: agent\nroot: (vault root)\n');
    expect(h.out).toMatch(/^Research +read, create, update$/m);
    expect(h.out).not.toContain('Notes/Private');
    expect(h.out).toContain('MCP tools: spall_whoami, spall_search,');
    const j = await spall('agent', ['whoami', '--json']);
    expect(JSON.parse(j.out)).toMatchObject({ account: 'agent', mcp: { enabled: true } });
  });

  it('takes the token only from SPALL_TOKEN; --url can replace SPALL_URL', async () => {
    const run = (argv: string[], env: Record<string, string>) =>
      clientMain(argv, { env, out: () => {}, err: (s) => (err += s), stdin: async () => '', fetch: injectFetch(env_) });
    let err = '';
    const env_ = env;
    expect(await run(['whoami', '--url', 'http://spall.test'], { SPALL_TOKEN: 'tok-eink' })).toBe(0);
    // --token is not an option: the token must never be in argv
    err = '';
    expect(await run(['whoami', '--url', 'http://spall.test', '--token', 'tok-eink'], {})).toBe(2);
    expect(err).toContain('There is no --token option: set SPALL_TOKEN');
    err = '';
    expect(await run(['whoami', '--url', 'http://spall.test'], {})).toBe(2);
    expect(err).toContain('SPALL_TOKEN');
    expect((await spall(null, ['whoami'])).code).toBe(2);
  });

  it('search, search --related, ls, tags', async () => {
    expect((await spall('agent', ['search', 'existing', 'highlight'])).out).toMatch(
      /^Research\/Plan\.md {2}score [\d.]+\n {4}§ Plan > Notes > Highlights: - existing highlight\n\(1 match\)\n$/,
    );
    const rel = await spall('agent', ['search', '--related', 'Research/Plan', '--json']);
    expect(JSON.parse(rel.out).results.map((r: { path: string }) => r.path)).toContain('Notes/Ideas.md');
    expect((await spall('agent', ['ls', 'Research'])).out).toBe('Research/Plan.md\nResearch/inbox/\n(2 entries: 1 note, 0 files, 1 folder)\n');
    expect((await spall('agent', ['ls', 'Research', '--all'])).out).toBe(
      'Research/Plan.md\nResearch/inbox/\nResearch/inbox/Draft.md\n(3 entries: 2 notes, 0 files, 1 folder)\n',
    );
    expect((await spall('agent', ['tags'])).out).toContain('#research');
  });

  it('read prints the raw note (pipeable), --outline, --frontmatter, --section', async () => {
    expect((await spall('agent', ['read', 'Research/Plan'])).out).toBe(note('Research/Plan.md'));
    expect((await spall('agent', ['read', 'Research/Plan', '--outline'])).out).toMatch(/^rev: sha256:\w+\n# Plan {2}\(line 6\)\n {2}## Notes {2}\(line 10\)\n {4}### Highlights/);
    expect((await spall('agent', ['read', 'Research/Plan', '--frontmatter'])).out).toMatch(/^rev: sha256:\w+\nproject: spall\n/);
    expect((await spall('agent', ['read', 'Research/Plan', '--section', 'Notes > Highlights'])).out).toBe('### Highlights\n\n- existing highlight\n\n');
  });

  it('new, with typed --fm values and the body from stdin', async () => {
    const r = await spall('agent', ['new', 'Research', 'CLI note', '--fm', 'n=3', '--fm', 'tags=[a, b]', '--fm', 'flag=true', '--body', '-'], 'from stdin\n');
    expect(r).toMatchObject({ code: 0, out: expect.stringMatching(/^Research\/CLI note\.md\nrev: sha256:/) });
    expect(note('Research/CLI note.md')).toBe('---\nn: 3\ntags:\n  - a\n  - b\nflag: true\n---\nfrom stdin\n');
    expect((await spall('agent', ['new', 'Research', 'CLI note', '--fail'])).code).toBe(1);
  });

  it('edit combines changes atomically, with --rev', async () => {
    const rev = JSON.parse((await spall('agent', ['read', 'Research/Plan', '--outline', '--json'])).out).rev;
    const r = await spall('agent', ['edit', 'Research/Plan', '--rev', rev, '--set', 'status=done', '--append-to', 'Tasks', '--content', '- [ ] from the cli', '--replace', 'Intro paragraph.', '--with', 'Intro.']);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^Research\/Plan\.md\nrev: sha256:\w+ {2}\(changed lines: \+3 −1\)\n$/);
    const text = note('Research/Plan.md');
    expect(text).toContain('status: done');
    expect(text).toContain('Intro.\n');
    expect(text).toContain('and [[Secret]].\n- [ ] from the cli\n');
    // the old rev is now stale: exit 5
    const stale = await spall('agent', ['edit', 'Research/Plan', '--rev', rev, '--unset', 'status']);
    expect(stale.code).toBe(5);
    expect(stale.err).toContain('rev_mismatch');
    expect(stale.err).toContain('current_rev');
  });

  it('edit --ops reads a JSON array of ops from stdin (-) or a file', async () => {
    const r = await spall('agent', ['edit', 'Research/inbox/Draft', '--ops', '-'], JSON.stringify([{ op: 'append', content: 'more' }]));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(note('Research/inbox/Draft.md')).toBe('Draft text.\nmore\n');
    const file = path.join(env.dir, 'ops.json');
    writeFileSync(file, JSON.stringify([{ op: 'append', content: 'from a file' }]));
    const f = await spall('agent', ['edit', 'Research/inbox/Draft', '--ops', file]);
    expect(f).toMatchObject({ code: 0, err: '' });
    expect(note('Research/inbox/Draft.md')).toBe('Draft text.\nmore\nfrom a file\n');
    const missing = await spall('agent', ['edit', 'Research/inbox/Draft', '--ops', path.join(env.dir, 'nope.json')]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('--ops: ENOENT');
    expect((await spall('agent', ['edit', 'Research/inbox/Draft'])).code).toBe(2);
    expect((await spall('agent', ['edit', 'Research/inbox/Draft', '--append-to', 'X'])).code).toBe(2);
  });

  it('mv and trash', async () => {
    await spall('agent', ['new', 'Research/inbox', 'Temp']);
    expect((await spall('agent', ['mv', 'Research/inbox/Temp', 'Research/inbox/Temp2'])).out).toBe('Research/inbox/Temp.md → Research/inbox/Temp2.md\n');
    expect((await spall('agent', ['mv', 'Research/inbox/Temp2', 'Research/inbox/Folder/'])).out).toBe('Research/inbox/Temp2.md → Research/inbox/Folder/Temp2.md\n');
    expect((await spall('agent', ['mv', 'Research/inbox/Folder/Temp2', 'Research/inbox'])).out).toBe('Research/inbox/Folder/Temp2.md → Research/inbox/Temp2.md\n');
    expect((await spall('agent', ['trash', 'Research/inbox/Temp2'])).out).toBe('trashed Research/inbox/Temp2.md\n');
  });

  it('base: a missing .base file exits 3', async () => {
    const r = await spall('agent', ['base', 'Nope.base']);
    expect(r.code).toBe(3);
  });

  it('base pages with --cursor', async () => {
    writeFileSync(path.join(env.vault, 'Research/All.base'), 'views:\n  - type: table\n    name: All\n    order: [file.name]\n');
    const first = await spall('agent', ['base', 'Research/All', '--limit', '1', '--json']);
    expect(first.code).toBe(0);
    const p1 = JSON.parse(first.out);
    expect(p1.next_cursor).toBeTruthy();
    const human = await spall('agent', ['base', 'Research/All', '--limit', '1']);
    expect(human.out).toContain(`(more: --cursor ${p1.next_cursor})`);
    const second = await spall('agent', ['base', 'Research/All', '--limit', '1', '--cursor', p1.next_cursor, '--json']);
    expect(second.code).toBe(0);
    const p2 = JSON.parse(second.out);
    expect(p2.results[0].path).not.toBe(p1.results[0].path);
  });

  it('exit codes: 3 not found (hidden or missing), 4 forbidden, 6 rate limited, 7 auth, 2 usage', async () => {
    const hidden = await spall('agent', ['read', 'Notes/Private/Secret']);
    const missing = await spall('agent', ['read', 'Notes/Private/Nope']);
    expect(hidden.code).toBe(3);
    expect(hidden.err).toBe(missing.err);
    expect(hidden.err).toContain('spall whoami');
    const forbidden = await spall('agent', ['edit', 'Notes/Ideas', '--set', 'x=1']);
    expect(forbidden.err).toContain('forbidden');
    expect(forbidden.code).toBe(4);
    expect((await spall('nobody', ['whoami'])).code).toBe(7);
    expect((await spall('agent', ['read'])).code).toBe(2);
    expect((await spall('agent', ['read', 'x', '--bogus'])).code).toBe(2);
    expect((await spall('agent', ['ls', '--limit', 'many'])).code).toBe(2);
    for (let i = 0; i < 3; i++) await spall('limited', ['whoami']);
    expect((await spall('limited', ['whoami'])).code).toBe(6);
  });

  it('--json errors go to stderr as JSON', async () => {
    const r = await spall('agent', ['read', 'Nope', '--json']);
    expect(r.out).toBe('');
    expect(JSON.parse(r.err)).toMatchObject({ error: { code: 'not_found' } });
  });

  it('--help per command needs no credentials', async () => {
    const r = await spall(null, ['edit', '--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--append-to');
    expect(r.out).not.toContain('whoami');
  });

  it('doctor checks the server, token, grants and MCP', async () => {
    const ok = await spall('eink', ['doctor']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^ok {4}server: http:\/\/spall\.test \(HTTP 200, spall \d+\.\d+\.\d+\)\nok {4}token: account eink, token test\nok {4}grants: Dashboards\/eink\.md: read\nok {4}mcp: enabled\n$/);
    const bad = await spall('nobody', ['doctor']);
    expect(bad.code).toBe(7);
    expect(bad.out).toContain('FAIL  token: unauthorized');
  });
});

describe('spall mcp (stdio)', () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');

  async function stdioClient(account: string, extra: string[] = []) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', cli, 'mcp', ...extra],
      env: { ...process.env, SPALL_URL: url, SPALL_TOKEN: `tok-${account}` } as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(transport);
    return client;
  }

  let url: string;
  beforeAll(async () => {
    url = await env.app.server.listen({ host: '127.0.0.1', port: 0 });
  });

  it('serves the same tools, filtered by the account, over stdio', async () => {
    const reader = await stdioClient('eink');
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(['spall_whoami', 'spall_search', 'spall_list', 'spall_read', 'spall_query_base']);
    const r = (await reader.callTool({ name: 'spall_read', arguments: { path: 'Dashboards/eink' } })) as { content: { text: string }[] };
    expect(r.content[0]!.text).toContain('<untrusted-content source="spall" path="Dashboards/eink.md"');
    await reader.close();

    const agent = await stdioClient('agent', ['--tools', 'spall_read,spall_edit,spall_trash', '--read-only']);
    expect((await agent.listTools()).tools.map((t) => t.name)).toEqual(['spall_read']);
    await agent.close();
  }, 30_000);

  it('audits stdio edits like REST ones (no via: the server cannot tell)', async () => {
    const agent = await stdioClient('agent', ['--tools', 'spall_edit']);
    const r = (await agent.callTool({ name: 'spall_edit', arguments: { path: 'Research/inbox/Draft', ops: [{ op: 'append', content: 'stdio' }] } })) as { isError?: boolean };
    await agent.close();
    expect(r.isError).toBeFalsy();
    const last = JSON.parse(readFileSync(env.auditPath, 'utf8').trim().split('\n').at(-1)!);
    expect(last).toMatchObject({ account: 'agent', op: 'patch', path: 'Research/inbox/Draft.md' });
    expect(last).not.toHaveProperty('via');
  }, 30_000);
});
