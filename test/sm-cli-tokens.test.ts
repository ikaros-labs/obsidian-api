import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
const hooks = vi.hoisted(() => ({ beforeRead: null as null | ((file: string) => void) }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string') hooks.beforeRead?.(file);
    return (fs.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync;
  return { ...fs, default: { ...fs, readFileSync }, readFileSync };
});

const { adminMain } = await import('../src/cli/admin.js');

let dir: string;
let cfg: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'spall-cli-'));
  mkdirSync(path.join(dir, 'vault'));
  cfg = path.join(dir, 'spall.yaml');
});
afterEach(() => {
  hooks.beforeRead = null;
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
    writeFileSync(lock, String(process.pid));
    const before = readFileSync(cfg, 'utf8');
    const child = spawn('npx', ['tsx', path.resolve('src/cli.ts'), '-c', cfg, 'token', 'create', 'bot', '--name', 'child'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);

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
