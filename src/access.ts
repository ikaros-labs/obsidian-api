import { z } from 'zod';
import { ConfigError } from './errors.js';
import { hasDotSegment, isPrefix, join, matchKeys, parsePlainPath, type Segs } from './paths.js';

export { ConfigError } from './errors.js';
export { hasDotSegment, join, matchKeys, parsePlainPath, split, type Segs } from './paths.js';

export const PERMS = ['read', 'create', 'update', 'delete', 'purge'] as const;
export type Perm = (typeof PERMS)[number];

export const LEVELS = {
  none: [],
  read: ['read'],
  append: ['create'],
  edit: ['read', 'create', 'update'],
  full: ['read', 'create', 'update', 'delete'],
} as const satisfies Record<string, readonly Perm[]>;
export type Level = keyof typeof LEVELS;

export interface Grant {
  /** The key as written in the config, relative to the account root. */
  key: string;
  /** Vault-relative segments. */
  segs: string[];
  match: string[];
  perms: ReadonlySet<Perm>;
}

export type Decision =
  | { perms: ReadonlySet<Perm>; reason: 'grant'; key: string }
  | { perms: ReadonlySet<Perm>; reason: 'no_grant' | 'outside_root' | 'dotfile' | 'excluded'; key?: string };

const NONE: ReadonlySet<Perm> = new Set();

/**
 * Access for one account. All paths are vault-relative. A path gets the permissions of its deepest
 * matching grant; no match means no access. Dotfiles, `vault.exclude` and anything outside the
 * account root are always denied.
 */
export class Access {
  private readonly rootMatch: string[];
  private readonly excludeMatch: { key: string; match: string[] }[];

  constructor(
    readonly root: string[],
    readonly grants: Grant[],
    exclude: string[][],
  ) {
    this.rootMatch = matchKeys(root);
    this.excludeMatch = exclude.map((segs) => ({ key: join(segs), match: matchKeys(segs) }));
    // Deepest first, so the first match wins.
    this.grants = [...grants].sort((a, b) => b.match.length - a.match.length);
  }

  decide(segs: Segs): Decision {
    const keys = matchKeys(segs);
    if (!isPrefix(this.rootMatch, keys)) return { perms: NONE, reason: 'outside_root' };
    if (hasDotSegment(segs)) return { perms: NONE, reason: 'dotfile' };
    const ex = this.excludeMatch.find((e) => isPrefix(e.match, keys));
    if (ex) return { perms: NONE, reason: 'excluded', key: ex.key };
    const grant = this.grants.find((g) => isPrefix(g.match, keys));
    if (!grant) return { perms: NONE, reason: 'no_grant' };
    return { perms: grant.perms, reason: 'grant', key: grant.key };
  }

  perms(segs: Segs): ReadonlySet<Perm> {
    return this.decide(segs).perms;
  }

  can(segs: Segs, perm: Perm): boolean {
    return this.perms(segs).has(perm);
  }

  /**
   * True when `segs` is a folder the account can't read but that lies on the way to something it
   * can read. Such folders are listed so the account can navigate, but show only that branch.
   */
  leadsToReadable(segs: Segs): boolean {
    const d = this.decide(segs);
    if (d.reason === 'outside_root' || d.reason === 'dotfile' || d.reason === 'excluded') return false;
    const keys = matchKeys(segs);
    return this.grants.some(
      (g) =>
        g.match.length > keys.length &&
        isPrefix(keys, g.match) &&
        g.perms.has('read') &&
        this.decide(g.segs).reason === 'grant',
    );
  }
}

export function expandLevel(level: Level | readonly Perm[]): Set<Perm> {
  return new Set(typeof level === 'string' ? LEVELS[level] : level);
}

// ---------------------------------------------------------------------------------------------
// Grants as written in the config. Used by config.ts and, through the `@ikaros-labs/spall/access` export, by
// anything that wants the exact same rules without a server (e.g. the landing-page playground).

export const LevelSchema = z.union([z.enum(Object.keys(LEVELS) as [Level, ...Level[]]), z.array(z.enum(PERMS)).min(1)]);

/** An account's `root` and `access` map, as in the YAML. */
export const AccountAccessSchema = {
  root: z.string().default(''),
  access: z.record(z.string(), LevelSchema),
};

/** Parses a config path, recording a problem (prefixed with `where`) instead of throwing. */
export function tryPath(p: string, where: string, problems: string[]): string[] | null {
  try {
    return parsePlainPath(p);
  } catch (e) {
    problems.push(`${where}: ${(e as Error).message}`);
    return null;
  }
}

/** Parses `vault.exclude`-style paths, recording problems as `where[i]`. */
export function parseExclude(paths: string[], where: string, problems: string[]): string[][] {
  const out: string[][] = [];
  paths.forEach((p, i) => {
    const segs = tryPath(p, `${where}[${i}]`, problems);
    if (segs) out.push(segs);
  });
  return out;
}

export interface CompiledAccess {
  root: string[];
  access: Access;
  /** Grants as written, for /me and the CLI. */
  grants: { path: string; permissions: Perm[] }[];
}

/**
 * Builds the access rules of one account. `exclude` is vault-relative. Problems (bad paths, two
 * keys for one path, dotfile grants, update/delete without read) are pushed to `problems`, each
 * prefixed with `where`; returns null only when the root itself is unusable.
 */
export function compileAccess(
  spec: { root: string; access: Record<string, Level | readonly Perm[]> },
  exclude: string[][],
  where: string,
  problems: string[],
): CompiledAccess | null {
  const root = tryPath(spec.root, `${where}.root`, problems);
  if (!root) return null;
  if (hasDotSegment(root)) problems.push(`${where}.root: dotfiles and dot-folders are always denied`);

  const grants: Grant[] = [];
  const seen = new Map<string, string>();
  for (const [key, level] of Object.entries(spec.access)) {
    const segs = tryPath(key, `${where}.access["${key}"]`, problems);
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
  return {
    root,
    access: new Access(root, grants, exclude),
    grants: grants.map((g) => ({ path: g.key, permissions: PERMS.filter((p) => g.perms.has(p)) })),
  };
}

const AccessConfigSchema = z.strictObject({ ...AccountAccessSchema, exclude: z.array(z.string()).default([]) });

/**
 * The Access of one account from its config: `{ root, access }` as in the YAML, plus the vault's
 * `exclude` list. Applies exactly the server's rules. Throws ConfigError listing every problem.
 *
 *     const a = accessFromConfig({ root: 'Notes', access: { '.': 'read', Private: 'none' } });
 *     a.can(parsePlainPath('Notes/Ideas.md'), 'read'); // true
 */
export function accessFromConfig(input: { root?: string; access: Record<string, unknown>; exclude?: string[] }): Access {
  const r = AccessConfigSchema.safeParse(input);
  if (!r.success) throw new ConfigError(r.error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`));
  const problems: string[] = [];
  const exclude = parseExclude(r.data.exclude, 'exclude', problems);
  const compiled = compileAccess(r.data, exclude, 'account', problems);
  if (problems.length > 0 || !compiled) throw new ConfigError(problems);
  return compiled.access;
}
