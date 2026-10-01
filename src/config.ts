import { existsSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { Access, expandLevel, LEVELS, PERMS, type Grant, type Level, type Perm } from './access.js';
import { hasDotSegment, join, matchKeys, parsePlainPath } from './paths.js';

const RATE_RE = /^(\d+)\/(sec|min|hour)$/;
const SIZE_RE = /^(\d+)(b|kb|mb)?$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

const PermSchema = z.enum(PERMS);
const LevelSchema = z.union([
  z.enum(Object.keys(LEVELS) as [Level, ...Level[]]),
  z.array(PermSchema).min(1),
]);
const RateSchema = z.string().regex(RATE_RE, 'expected e.g. "120/min" (unit: sec, min or hour)');
const DateSchema = z.string().regex(DATE_RE, 'expected a date like 2027-10-01');

const TokenSchema = z.strictObject({
  name: z.string().regex(/^[\w.-]+$/, 'letters, digits, ".", "_" and "-" only'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a hex SHA-256 hash'),
  created: DateSchema.optional(),
  expires: DateSchema.nullable().optional(),
});

const AccountSchema = z.strictObject({
  description: z.string().optional(),
  root: z.string().default(''),
  rate_limit: RateSchema.optional(),
  access: z.record(z.string(), LevelSchema),
  tokens: z.array(TokenSchema).default([]),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(1),
  server: z
    .strictObject({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(0).max(65535).default(8787),
      max_body: z.union([z.string().regex(SIZE_RE, 'expected e.g. "10mb"'), z.number().int().positive()]).default('10mb'),
    })
    .prefault({}),
  vault: z.strictObject({
    path: z.string().min(1),
    trash: z.string().default('.trash'),
    follow_symlinks: z.boolean().default(false),
    exclude: z.array(z.string()).default([]),
  }),
  audit: z.strictObject({ path: z.string().min(1) }).optional(),
  defaults: z.strictObject({ rate_limit: RateSchema.default('120/min') }).prefault({}),
  accounts: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'letters, digits, "_" and "-" only'), AccountSchema).default({}),
});
export type RawConfig = z.output<typeof ConfigSchema>;

export interface TokenInfo {
  name: string;
  sha256: string;
  created?: string;
  expires?: string | null;
}

export interface RateLimit {
  limit: number;
  windowMs: number;
  spec: string;
}

export interface Account {
  name: string;
  description?: string;
  /** Root as written in the config ('' = vault root). */
  rootPath: string;
  root: string[];
  access: Access;
  /** Grants as written, for /me and the CLI. */
  grants: { path: string; permissions: Perm[] }[];
  rateLimit: RateLimit;
  tokens: TokenInfo[];
}

export interface Config {
  configPath: string;
  server: { host: string; port: number; maxBody: number };
  vaultPath: string;
  /** Vault-relative trash folder, or null when DELETE without `permanent` is disabled. */
  trash: string[] | null;
  followSymlinks: boolean;
  auditPath: string | null;
  accounts: Map<string, Account>;
  tokensByHash: Map<string, { account: Account; token: TokenInfo }>;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

function parseRate(spec: string): RateLimit {
  const [, n, unit] = RATE_RE.exec(spec)!;
  return { limit: Number(n), windowMs: { sec: 1000, min: 60_000, hour: 3_600_000 }[unit as 'sec' | 'min' | 'hour'], spec };
}

function parseSize(v: string | number): number {
  if (typeof v === 'number') return v;
  const [, n, unit = 'b'] = SIZE_RE.exec(v)!;
  return Number(n) * { b: 1, kb: 1024, mb: 1024 * 1024 }[unit.toLowerCase() as 'b' | 'kb' | 'mb'];
}

const isInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Resolves symlinks in the longest existing prefix of `p`. */
function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = path.dirname(abs);
  return parent === abs ? abs : path.join(realpathLoose(parent), path.basename(abs));
}

/** Parses YAML text into a raw, schema-checked config. Throws ConfigError. */
export function parseConfigText(text: string): RawConfig {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) throw new ConfigError(doc.errors.map((e) => e.message));
  const result = ConfigSchema.safeParse(doc.toJS() ?? {});
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}

/** Checks cross-field rules and builds the runtime config. Throws ConfigError. */
export function compileConfig(raw: RawConfig, configPath: string): Config {
  const problems: string[] = [];
  const tryPath = (p: string, where: string): string[] | null => {
    try {
      return parsePlainPath(p);
    } catch (e) {
      problems.push(`${where}: ${(e as Error).message}`);
      return null;
    }
  };

  const configAbs = realpathLoose(configPath);
  const vaultPathRaw = path.resolve(path.dirname(configAbs), raw.vault.path);
  let vaultPath = vaultPathRaw;
  if (!existsSync(vaultPathRaw) || !statSync(vaultPathRaw).isDirectory()) {
    problems.push(`vault.path: not a directory: ${vaultPathRaw}`);
  } else {
    vaultPath = realpathSync(vaultPathRaw);
    if (isInside(configAbs, vaultPath)) problems.push('the config file must live outside the vault');
  }

  let auditPath: string | null = null;
  if (raw.audit) {
    auditPath = realpathLoose(path.resolve(path.dirname(configAbs), raw.audit.path));
    if (isInside(auditPath, vaultPath)) problems.push('audit.path: the audit log must live outside the vault');
  }

  let trash: string[] | null = null;
  if (raw.vault.trash !== 'none') {
    trash = tryPath(raw.vault.trash, 'vault.trash');
    if (trash && trash.length === 0) problems.push('vault.trash: must be a folder inside the vault, or "none"');
  }

  const exclude: string[][] = [];
  raw.vault.exclude.forEach((p, i) => {
    const segs = tryPath(p, `vault.exclude[${i}]`);
    if (segs) exclude.push(segs);
  });
  // A trash folder without a leading dot would otherwise be visible.
  if (trash && trash.length > 0 && !hasDotSegment(trash)) exclude.push(trash);

  const accounts = new Map<string, Account>();
  const tokensByHash = new Map<string, { account: Account; token: TokenInfo }>();

  for (const [name, a] of Object.entries(raw.accounts)) {
    const where = `accounts.${name}`;
    const root = tryPath(a.root, `${where}.root`);
    if (!root) continue;
    if (hasDotSegment(root)) problems.push(`${where}.root: dotfiles and dot-folders are always denied`);

    const grants: Grant[] = [];
    const seen = new Map<string, string>();
    for (const [key, level] of Object.entries(a.access)) {
      const segs = tryPath(key, `${where}.access["${key}"]`);
      if (!segs) continue;
      const match = matchKeys(segs).join('/');
      const dup = seen.get(match);
      if (dup !== undefined) problems.push(`${where}.access: "${key}" and "${dup}" are the same path`);
      seen.set(match, key);
      if (hasDotSegment(segs)) problems.push(`${where}.access["${key}"]: dotfiles and dot-folders are always denied`);
      const perms = expandLevel(level);
      const needsRead = (['update', 'delete', 'purge'] as const).filter((p) => perms.has(p));
      if (needsRead.length > 0 && !perms.has('read')) {
        problems.push(`${where}.access["${key}"]: ${needsRead.join(', ')} requires read`);
      }
      const vaultSegs = [...root, ...segs];
      grants.push({ key: segs.length === 0 ? '.' : join(segs), segs: vaultSegs, match: matchKeys(vaultSegs), perms });
    }

    const account: Account = {
      name,
      description: a.description,
      rootPath: join(root),
      root,
      access: new Access(root, grants, exclude),
      grants: grants.map((g) => ({ path: g.key, permissions: PERMS.filter((p) => g.perms.has(p)) })),
      rateLimit: parseRate(a.rate_limit ?? raw.defaults.rate_limit),
      tokens: a.tokens,
    };
    accounts.set(name, account);

    const names = new Set<string>();
    for (const token of a.tokens) {
      if (names.has(token.name)) problems.push(`${where}.tokens: duplicate token name "${token.name}"`);
      names.add(token.name);
      const other = tokensByHash.get(token.sha256);
      if (other) problems.push(`${where}.tokens.${token.name}: same hash as ${other.account.name}.${other.token.name}`);
      tokensByHash.set(token.sha256, { account, token });
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    configPath: configAbs,
    server: { host: raw.server.host, port: raw.server.port, maxBody: parseSize(raw.server.max_body) },
    vaultPath,
    trash,
    followSymlinks: raw.vault.follow_symlinks,
    auditPath,
    accounts,
    tokensByHash,
  };
}

export function loadConfig(configPath: string): Config {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError([`cannot read ${configPath}: ${(e as Error).message}`]);
  }
  return compileConfig(parseConfigText(text), configPath);
}

/** Settings that only take effect after a restart. */
function restartKey(c: Config): string {
  return JSON.stringify([c.server, c.vaultPath, c.trash, c.followSymlinks]);
}

/**
 * Holds the current config and reloads it when the file changes (or on `reload()`). An invalid new
 * config is rejected and the previous one stays active.
 */
export class ConfigManager {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private config: Config,
    private readonly log: { info(msg: string): void; error(msg: string): void } = console,
  ) {}

  static load(configPath: string, log?: ConstructorParameters<typeof ConfigManager>[1]): ConfigManager {
    return new ConfigManager(loadConfig(configPath), log);
  }

  get current(): Config {
    return this.config;
  }

  reload(): boolean {
    let next: Config;
    try {
      next = loadConfig(this.config.configPath);
    } catch (e) {
      this.log.error(`Config reload failed, keeping the previous config. ${(e as Error).message}`);
      return false;
    }
    if (restartKey(next) !== restartKey(this.config)) {
      this.log.error('Config reload rejected: server or vault settings changed, restart to apply them');
      return false;
    }
    this.config = next;
    this.log.info(`Config reloaded (${next.accounts.size} accounts)`);
    return true;
  }

  /** Watches the config's folder, so editors that replace the file are picked up too. */
  watch(): void {
    const file = path.basename(this.config.configPath);
    this.watcher = watch(path.dirname(this.config.configPath), (_event, name) => {
      if (name !== file) return;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 200);
    });
  }

  close(): void {
    this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
  }
}

