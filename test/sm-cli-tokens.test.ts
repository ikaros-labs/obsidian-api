import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { hashToken } from '../src/tokens.js';

/**
 * `spall token create|revoke` edit the config file that other `spall token` runs (and the admin's
 * editor) edit too. These tests stand in for a second process at fixed points. See B5 and B6
 * in docs/STATE-MACHINES.md.
 */

// Lets a test run "another process" right before the CLI reads the config.
const hooks = vi.hoisted(() => ({
  beforeRead: null as null | ((file: string) => void),
  beforeRename: null as null | ((from: string) => void),
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string') hooks.beforeRead?.(file);
    return (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  const renameSync = ((from: string, to: string) => {
    hooks.beforeRename?.(from);
    return fs.renameSync(from, to);
  }) as typeof fs.renameSync;
  return { ...fs, default: { ...fs, readFileSync, renameSync }, readFileSync, renameSync };
});

const { adminMain } = await import('../src/cli/admin.js');

let dir: string;
let cfg: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'spall-cli-')));
  mkdirSync(path.join(dir, 'vault'));
  cfg = path.join(dir, 'spall.yaml');
});
afterEach(() => {
  hooks.beforeRead = null;
  hooks.beforeRename = null;
  rmSync(dir, { recursive: true, force: true });
});

const tokenNames = () =>
  ((parseDocument(readFileSync(cfg, 'utf8')).toJS().accounts.bot.tokens ?? []) as { name: string }[]).map((t) => t.name);

describe('B5 token revoke racing another config edit', () => {
  it('revokes the token it was asked to, even if the list changed since it was read', async () => {
    const tok = (name: string) => `      - { name: ${name}, sha256: ${hashToken(name)} }`;
    writeFileSync(cfg, ['version: 1', 'vault: { path: ./vault }', 'accounts:', '  bot:', '    access: { .: read }', '    tokens:', tok('t1'), tok('t2'), tok('t3'), ''].join('\n'));
    // Another `spall token revoke bot t1` finishes after this run loaded the config, before it edits it.
    let reads = 0;
    hooks.beforeRead = (file) => {
      if (file !== cfg || ++reads !== 2) return;
      const doc = parseDocument(readFileSync(cfg, 'utf8'));
      doc.deleteIn(['accounts', 'bot', 'tokens', 0]);
      writeFileSync(cfg, String(doc));
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await adminMain(['-c', cfg, 'token', 'revoke', 'bot', 't2']);
    } finally {
      log.mockRestore();
    }
    expect(tokenNames()).toEqual(['t3']);
  });
});

describe('B6 token create racing another config edit', () => {
  it('waits for the config lock, so neither edit is lost', async () => {
    writeFileSync(cfg, ['version: 1', 'vault: { path: ./vault }', 'accounts:', '  bot:', '    access: { .: read }', ''].join('\n'));
    // We are the other writer: hold the lock, read, let the CLI start, then write our edit.
    const lock = path.join(dir, '.spall.yaml.lock');
    writeFileSync(lock, `${process.pid} parent`);
    const before = readFileSync(cfg, 'utf8');
    // Wait until the child either committed its edit (no lock) or is trying to take the lock.
    let seen!: () => void;
    const reached = new Promise<void>((r) => (seen = r));
    const watcher = watch(dir, (_e, name) => {
      if (name && (/^\.spall\.yaml\.lock\./.test(name) || name === 'spall.yaml')) seen();
    });
    const child = spawn('npx', ['tsx', path.resolve('src/cli.ts'), '-c', cfg, 'token', 'create', 'bot', '--name', 'child'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await reached;
    watcher.close();

    const doc = parseDocument(before);
    doc.setIn(['accounts', 'bot', 'tokens'], doc.createNode([{ name: 'ours', sha256: hashToken('ours') }]));
    writeFileSync(`${cfg}.tmp`, String(doc));
    renameSync(`${cfg}.tmp`, cfg);
    rmSync(lock, { force: true });

    expect(await exited).toBe(0);
    const token = out.trim();
    const names = tokenNames();
    expect(names).toContain('ours');
    expect(names).toContain('child');
    const all = parseDocument(readFileSync(cfg, 'utf8')).toJS().accounts.bot.tokens as { sha256: string }[];
    expect(all.map((t) => t.sha256)).toContain(hashToken(token));
  }, 60_000);
});

const base = ['version: 1', 'vault: { path: ./vault }', 'accounts:', '  bot:', '    access: { .: read }', ''].join('\n');
const lockPath = () => path.join(dir, '.spall.yaml.lock');
const quiet = async (fn: () => Promise<void>) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await fn();
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
};
const create = (name: string) => quiet(() => adminMain(['-c', cfg, 'token', 'create', 'bot', '--name', name]));

describe('B14 the CLI config lock', () => {
  it('several real CLI runs at once all keep their tokens', async () => {
    writeFileSync(cfg, base);
    const names = ['w1', 'w2', 'w3', 'w4'];
    const runs = names.map(
      (n) =>
        new Promise<number | null>((r) =>
          spawn('npx', ['tsx', path.resolve('src/cli.ts'), '-c', cfg, 'token', 'create', 'bot', '--name', n], { stdio: 'ignore' }).on('exit', r),
        ),
    );
    expect(await Promise.all(runs)).toEqual([0, 0, 0, 0]);
    expect(tokenNames().sort()).toEqual(names);
    expect(existsSync(lockPath())).toBe(false);
  }, 60_000);

  it('takes over a lock left by a process that died, even a malformed one', async () => {
    writeFileSync(cfg, base);
    writeFileSync(lockPath(), '999999999 dead');
    await create('a');
    writeFileSync(lockPath(), '');
    await create('b');
    expect(tokenNames()).toEqual(['a', 'b']);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('retries when the holder releases between its attempt and reading the lock', async () => {
    writeFileSync(cfg, base);
    writeFileSync(lockPath(), `${process.ppid} other`);
    hooks.beforeRead = (file) => {
      if (file === lockPath()) {
        hooks.beforeRead = null;
        rmSync(file); // the holder finishes right now
      }
    };
    await create('a');
    expect(tokenNames()).toEqual(['a']);
  });

  it("doesn't steal a lock another run took over from the dead holder first", async () => {
    writeFileSync(cfg, base);
    writeFileSync(lockPath(), '999999999 dead');
    const other = `${process.ppid} other`;
    let seenOther = false;
    hooks.beforeRename = (from) => {
      if (from !== lockPath()) return;
      hooks.beforeRename = null;
      // Another run saw the same dead holder and took the lock over just before us.
      rmSync(from);
      writeFileSync(from, other);
      // When we next look at the lock, it must be the other run's, intact; then that run finishes.
      hooks.beforeRead = (file) => {
        if (file !== lockPath() || !existsSync(file)) return;
        hooks.beforeRead = null;
        seenOther = readFileSync(file, 'utf8') === other;
        rmSync(file);
      };
    };
    await create('a');
    expect(seenOther).toBe(true);
    expect(tokenNames()).toEqual(['a']);
  });

  it('on release, removes only its own lock', async () => {
    writeFileSync(cfg, base);
    const other = `${process.ppid} other`;
    let reads = 0;
    hooks.beforeRead = (file) => {
      if (file !== cfg || ++reads !== 2) return; // the read inside the lock
      hooks.beforeRead = null;
      writeFileSync(lockPath(), other); // someone else's lock replaced ours meanwhile
    };
    await create('a');
    expect(readFileSync(lockPath(), 'utf8')).toBe(other);
  });

  it('locks and edits the real file when the config path is a symlink', async () => {
    writeFileSync(cfg, base);
    const link = path.join(dir, 'link.yaml');
    (await import('node:fs')).symlinkSync(cfg, link);
    await quiet(() => adminMain(['-c', link, 'token', 'create', 'bot', '--name', 'a']));
    expect((await import('node:fs')).lstatSync(link).isSymbolicLink()).toBe(true);
    expect(tokenNames()).toEqual(['a']);
  });
});
