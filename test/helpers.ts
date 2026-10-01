import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { stringify } from 'yaml';
import { createApp, type App } from '../src/app.js';
import { ConfigManager } from '../src/config.js';
import { hashToken } from '../src/tokens.js';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/vault');
export const BASES_FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/bases-vault');

/** Test accounts; each gets a token `tok-<name>`. */
export const ACCOUNTS = {
  admin: { access: { '.': ['read', 'create', 'update', 'delete', 'purge'] } },
  bot: { root: 'Reading List', access: { '.': ['read', 'create', 'update'] } },
  eink: { access: { 'Dashboards/eink.md': 'read' } },
  agent: {
    access: { Research: 'edit', 'Research/inbox': 'full', Notes: 'read', 'Notes/Private': 'none' },
  },
  dropbox: { root: 'Reading List', access: { '.': 'append' } },
  limited: { rate_limit: '3/min', access: { '.': 'read' } },
  expired: { access: { '.': 'read' }, expires: '2020-01-01' },
} as const;

export type AccountName = keyof typeof ACCOUNTS;
type AccountSpec = { root?: string; rate_limit?: string; access: Record<string, unknown>; expires?: string };

export interface TestEnv {
  dir: string;
  vault: string;
  configPath: string;
  auditPath: string;
  app: App;
  configs: ConfigManager;
  req(account: AccountName | (string & {}) | null, opts: InjectOptions): Promise<LightMyRequestResponse>;
  cleanup(): Promise<void>;
}

export function writeConfig(
  file: string,
  vault: string,
  extra: { vault?: Record<string, unknown>; audit?: string; accounts?: Record<string, AccountSpec> } = {},
) {
  const accounts = Object.fromEntries(
    Object.entries(extra.accounts ?? (ACCOUNTS as Record<string, AccountSpec>)).map(([name, a]) => {
      const { expires, ...rest } = a;
      return [name, { ...rest, tokens: [{ name: 'test', sha256: hashToken(`tok-${name}`), ...(expires ? { expires } : {}) }] }];
    }),
  );
  writeFileSync(
    file,
    stringify({
      version: 1,
      vault: { path: vault, ...extra.vault },
      ...(extra.audit ? { audit: { path: extra.audit } } : {}),
      accounts,
    }),
  );
}

/** Copies the fixture vault into a temp dir and starts an app (no network; use `req`). */
export async function setup(
  opts: {
    watch?: boolean;
    fixture?: string;
    accounts?: Record<string, AccountSpec>;
    vault?: Record<string, unknown>;
    prepare?: (vault: string) => void;
  } = {},
): Promise<TestEnv> {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-api-test-'));
  const vault = path.join(dir, 'vault');
  cpSync(opts.fixture ?? FIXTURE, vault, { recursive: true });
  mkdirSync(path.join(vault, '.git'));
  writeFileSync(path.join(vault, '.git/config'), '[core]\n');
  opts.prepare?.(vault);
  const configPath = path.join(dir, 'vault-api.yaml');
  const auditPath = path.join(dir, 'audit.jsonl');
  writeConfig(configPath, vault, { vault: opts.vault, audit: auditPath, accounts: opts.accounts });
  const configs = ConfigManager.load(configPath, { info() {}, error() {} });
  const app = await createApp(configs, { watch: opts.watch });
  return {
    dir,
    vault,
    configPath,
    auditPath,
    app,
    configs,
    req(account, o) {
      const headers = { ...(account ? { authorization: `Bearer tok-${account}` } : {}), ...o.headers };
      return app.server.inject({ ...o, headers });
    },
    async cleanup() {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Polls until `fn` returns true (for watcher tests). */
export async function eventually(fn: () => Promise<boolean> | boolean, timeoutMs = 4000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('condition not met in time');
}
