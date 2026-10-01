import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, ConfigManager, loadConfig } from '../src/config.js';
import { hashToken } from '../src/tokens.js';

let dir: string;
let vault: string;
const cfgFile = () => path.join(dir, 'vault-api.yaml');
const write = (yaml: string) => writeFileSync(cfgFile(), yaml);
const problems = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
  throw new Error('expected a ConfigError');
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'vault-api-cfg-'));
  vault = path.join(dir, 'vault');
  mkdirSync(vault);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = (accounts: string) => `version: 1
vault:
  path: ./vault
accounts:
${accounts}`;

describe('config', () => {
  it('loads a valid config with defaults', () => {
    write(
      base(`  bot:
    root: Reading List
    access:
      .: [read, create]
    tokens:
      - name: t1
        sha256: ${hashToken('x')}
        expires: 2030-01-01`),
    );
    const cfg = loadConfig(cfgFile());
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 8787, maxBody: 10 * 1024 * 1024 });
    expect(cfg.trash).toEqual(['.trash']);
    const bot = cfg.accounts.get('bot')!;
    expect(bot.root).toEqual(['Reading List']);
    expect(bot.rateLimit).toMatchObject({ limit: 120, windowMs: 60_000 });
    expect(cfg.tokensByHash.get(hashToken('x'))?.account.name).toBe('bot');
  });

  it('rejects unknown keys and typos', () => {
    write(`${base(`  a:\n    access: { .: read }\n    acess: {}`)}\nservr: {}`);
    const p = problems(() => loadConfig(cfgFile()));
    expect(p.join('\n')).toMatch(/acess/);
    expect(p.join('\n')).toMatch(/servr/);
  });

  it('rejects invalid levels', () => {
    write(base(`  a:\n    access: { .: write }`));
    expect(problems(() => loadConfig(cfgFile())).join()).toMatch(/accounts\.a\.access/);
  });

  it('requires read for update, delete and purge', () => {
    write(base(`  a:\n    access: { .: [create, update] }`));
    expect(problems(() => loadConfig(cfgFile())).join()).toMatch(/update requires read/);
  });

  it('rejects keys that are always denied, traversal and duplicates', () => {
    write(base(`  a:\n    access:\n      .obsidian: read\n      ../x: read\n      Notes: read\n      notes: none`));
    const p = problems(() => loadConfig(cfgFile())).join('\n');
    expect(p).toMatch(/always denied/);
    expect(p).toMatch(/Relative path segments/);
    expect(p).toMatch(/same path/);
  });

  it('refuses a config inside the vault', () => {
    const inside = path.join(vault, 'vault-api.yaml');
    writeFileSync(inside, 'version: 1\nvault:\n  path: .\n');
    expect(problems(() => loadConfig(inside)).join()).toMatch(/outside the vault/);
  });

  it('refuses duplicate token hashes', () => {
    const h = hashToken('same');
    write(base(`  a:\n    access: { .: read }\n    tokens: [{ name: t, sha256: ${h} }]\n  b:\n    access: { .: read }\n    tokens: [{ name: t, sha256: ${h} }]`));
    expect(problems(() => loadConfig(cfgFile())).join()).toMatch(/same hash/);
  });

  it('keeps the previous config when a reload is invalid', () => {
    write(base(`  a:\n    access: { .: read }`));
    const errors: string[] = [];
    const m = ConfigManager.load(cfgFile(), { info() {}, error: (e) => errors.push(e) });
    write('version: 1\naccounts: [oops');
    expect(m.reload()).toBe(false);
    expect(m.current.accounts.has('a')).toBe(true);
    expect(errors).toHaveLength(1);
    write(base(`  b:\n    access: { .: read }`));
    expect(m.reload()).toBe(true);
    expect([...m.current.accounts.keys()]).toEqual(['b']);
  });

  it('rejects reloads that change restart-only settings', () => {
    write(base(`  a:\n    access: { .: read }`));
    const m = ConfigManager.load(cfgFile(), { info() {}, error() {} });
    write(`version: 1\nserver: { port: 9999 }\nvault: { path: ./vault }\n`);
    expect(m.reload()).toBe(false);
    expect(m.current.server.port).toBe(8787);
  });
});

describe('cli', () => {
  const cli = (...args: string[]) =>
    execFileSync('npx', ['tsx', path.resolve('src/cli.ts'), '-c', cfgFile(), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('creates and revokes tokens, keeping comments', () => {
    write(`# my config\nversion: 1\nvault:\n  path: ./vault # the vault\naccounts:\n  bot:\n    access: { .: read } # read only\n`);
    const token = cli('token', 'create', 'bot', '--name', 'phone', '--expires', '2030-01-01').trim();
    expect(token).toMatch(/^vlt_[A-Za-z0-9_-]{43}$/);
    const text = readFileSync(cfgFile(), 'utf8');
    expect(text).toContain('# my config');
    expect(text).toContain('# the vault');
    expect(text).toContain('# read only');
    expect(text).not.toContain(token);
    const cfg = loadConfig(cfgFile());
    expect(cfg.tokensByHash.get(hashToken(token))?.token).toMatchObject({ name: 'phone', expires: '2030-01-01' });

    expect(cli('token', 'list')).toMatch(/bot\tphone\tactive/);
    cli('token', 'revoke', 'bot', 'phone');
    expect(loadConfig(cfgFile()).tokensByHash.size).toBe(0);
  }, 30_000);

  it('explains decisions', () => {
    write(base(`  agent:\n    access:\n      Notes: read\n      Notes/Private: none\n      A/B: read`));
    expect(cli('explain', 'agent', 'Notes/Private/x.md')).toMatch(/→ none \(key: Notes\/Private\)/);
    expect(cli('explain', 'agent', 'Notes/x.md')).toMatch(/→ read \(key: Notes\)/);
    expect(cli('explain', 'agent', '.git/config')).toMatch(/always denied/);
    expect(cli('explain', 'agent', 'A')).toMatch(/parent folder/);
    expect(cli('check')).toMatch(/Config OK/);
  }, 30_000);
});
