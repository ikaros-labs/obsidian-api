import { hasDotSegment, isPrefix, join, matchKeys, type Segs } from './paths.js';

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
