import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { analyzeNote, type NoteMeta, type RawLink } from './markdown.js';
import { hasDotSegment, isNote, join, split, type Segs } from './paths.js';

export type Kind = 'note' | 'file' | 'folder';

export interface Entry {
  path: string;
  segs: string[];
  kind: Kind;
  size: number;
  /** Birth time in ms, or mtime where the filesystem doesn't record it. */
  created: number;
  modified: number;
  /** Vault-relative target, set only when the path goes through a symlink. */
  real?: string[];
  /** Notes only. */
  rev?: string;
  meta?: NoteMeta;
}

export const revOf = (data: string | Buffer): string =>
  `sha256:${createHash('sha256').update(data).digest('hex').slice(0, 16)}`;

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const linkKey = (e: Entry) => [nameOf(e.path).toLowerCase(), ...(e.kind === 'note' ? [nameOf(e.path).slice(0, -3).toLowerCase()] : [])];

/**
 * In-memory index of the vault: every visible file and folder with its stat data, plus parsed
 * metadata for notes. Dot-paths are never indexed. Kept current by a watcher and by API writes.
 */
export class VaultIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly children = new Map<string, Set<string>>();
  private readonly byName = new Map<string, Set<string>>();
  private watcher: FSWatcher | null = null;
  private pending = new Map<string, Promise<void>>();

  constructor(
    readonly root: string,
    private readonly opts: { followSymlinks: boolean },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(p: string): Entry | undefined {
    return this.entries.get(p);
  }

  childrenOf(folder: string): Entry[] {
    return [...(this.children.get(folder) ?? [])].map((p) => this.entries.get(p)!).filter(Boolean);
  }

  notes(): IterableIterator<Entry> {
    return (function* (entries) {
      for (const e of entries.values()) if (e.kind === 'note') yield e;
    })(this.entries);
  }

  async build(): Promise<void> {
    this.entries.clear();
    this.children.clear();
    this.byName.clear();
    const now = await stat(this.root);
    this.entries.set('', { path: '', segs: [], kind: 'folder', size: 0, created: now.birthtimeMs || now.mtimeMs, modified: now.mtimeMs });
    await this.scanDir('', new Set([await realpath(this.root)]));
  }

  private async scanDir(dir: string, visited: Set<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(path.join(this.root, ...split(dir)));
    } catch {
      return;
    }
    for (const name of names) {
      const p = dir === '' ? name : `${dir}/${name}`;
      const entry = await this.load(p);
      if (!entry) continue;
      this.put(entry);
      if (entry.kind === 'folder') {
        const real = await realpath(path.join(this.root, ...entry.segs)).catch(() => null);
        if (real && !visited.has(real)) await this.scanDir(p, new Set([...visited, real]));
      }
    }
  }

  /** Reads one path from disk. Returns null when it doesn't exist or must not be indexed. */
  private async load(p: string): Promise<Entry | null> {
    const segs = split(p).map((s) => s.normalize('NFC'));
    if (hasDotSegment(segs)) return null;
    const abs = path.join(this.root, ...split(p));
    try {
      let st = await lstat(abs);
      let real: string[] | undefined;
      if (this.opts.followSymlinks) {
        const rel = path.relative(this.root, await realpath(abs));
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        const realSegs = rel === '' ? [] : rel.split(path.sep).map((s) => s.normalize('NFC'));
        if (hasDotSegment(realSegs)) return null;
        if (join(realSegs) !== join(segs)) real = realSegs;
        if (st.isSymbolicLink()) st = await stat(abs);
      } else if (st.isSymbolicLink()) {
        return null;
      }
      const base = {
        path: join(segs),
        segs,
        ...(real ? { real } : {}),
        size: st.size,
        created: st.birthtimeMs || st.mtimeMs,
        modified: st.mtimeMs,
      };
      if (st.isDirectory()) return { ...base, kind: 'folder', size: 0 };
      if (!st.isFile()) return null;
      if (!isNote(segs)) return { ...base, kind: 'file' };
      const buf = await readFile(abs);
      return { ...base, kind: 'note', rev: revOf(buf), meta: analyzeNote(buf.toString('utf8')) };
    } catch {
      return null;
    }
  }

  private put(entry: Entry): void {
    const old = this.entries.get(entry.path);
    if (old && old.kind === 'folder' && entry.kind !== 'folder') this.removeTree(entry.path);
    this.entries.set(entry.path, entry);
    const parent = parentOf(entry.path);
    if (!this.children.has(parent)) this.children.set(parent, new Set());
    this.children.get(parent)!.add(entry.path);
    for (const k of linkKey(entry)) {
      if (!this.byName.has(k)) this.byName.set(k, new Set());
      this.byName.get(k)!.add(entry.path);
    }
  }

  private removeTree(p: string): void {
    const e = this.entries.get(p);
    if (!e) return;
    for (const child of [...(this.children.get(p) ?? [])]) this.removeTree(child);
    this.children.delete(p);
    this.entries.delete(p);
    this.children.get(parentOf(p))?.delete(p);
    for (const k of linkKey(e)) this.byName.get(k)?.delete(p);
  }

  /** Re-reads a path (and, for new folders, their contents) after a change. */
  refresh(p: string): Promise<void> {
    // Serialise refreshes of the same path so a slow older read can't overwrite a newer one.
    const prev = this.pending.get(p) ?? Promise.resolve();
    const next = prev.then(() => this.doRefresh(p));
    this.pending.set(p, next);
    void next.finally(() => {
      if (this.pending.get(p) === next) this.pending.delete(p);
    });
    return next;
  }

  private async doRefresh(p: string): Promise<void> {
    if (p === '') return;
    const entry = await this.load(p);
    if (!entry) {
      this.removeTree(p);
      return;
    }
    // Make sure the parent chain is indexed.
    const parent = parentOf(p);
    if (parent !== '' && !this.entries.has(parent)) await this.doRefresh(parent);
    const existed = this.entries.get(p);
    if (existed) for (const k of linkKey(existed)) this.byName.get(k)?.delete(p);
    this.put(entry);
    if (entry.kind === 'folder' && existed?.kind !== 'folder') {
      await this.scanDir(p, new Set([await realpath(path.join(this.root, ...entry.segs))]));
    }
  }

  /**
   * Resolves a link the way Obsidian does, among the entries `visible` accepts: wikilinks by name
   * (or path suffix), markdown links relative to the source note.
   */
  resolveLink(link: RawLink, from: string, visible: (e: Entry) => boolean): Entry | null {
    const fromDir = parentOf(from);
    if (link.kind === 'md') {
      const joined = path.posix.normalize(fromDir === '' ? link.target : `${fromDir}/${link.target}`);
      if (joined.startsWith('..')) return null;
      for (const candidate of [joined, `${joined}.md`]) {
        const e = this.entries.get(candidate.normalize('NFC'));
        if (e && e.kind !== 'folder' && visible(e)) return e;
      }
      return null;
    }
    const target = link.target.normalize('NFC').toLowerCase();
    let candidates: Entry[];
    if (target.includes('/')) {
      candidates = [...this.entries.values()].filter((e) => {
        if (e.kind === 'folder') return false;
        const p = e.path.toLowerCase();
        const noExt = e.kind === 'note' ? p.slice(0, -3) : p;
        return [p, noExt].some((x) => x === target || x.endsWith(`/${target}`));
      });
    } else {
      candidates = [...(this.byName.get(target) ?? [])].map((p) => this.entries.get(p)!).filter(Boolean);
    }
    candidates = candidates.filter(visible);
    if (candidates.length === 0) return null;
    return candidates.sort(
      (a, b) =>
        Number(parentOf(b.path) === fromDir) - Number(parentOf(a.path) === fromDir) ||
        a.segs.length - b.segs.length ||
        (a.path < b.path ? -1 : 1),
    )[0]!;
  }

  /** Starts watching the vault for changes made outside the API (sync, the app, editors). */
  watch(onError?: (e: unknown) => void): Promise<void> {
    const watcher = watch(this.root, {
      ignoreInitial: true,
      followSymlinks: this.opts.followSymlinks,
      atomic: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      ignored: (abs: string) => {
        const rel = path.relative(this.root, abs);
        return rel !== '' && hasDotSegment(rel.split(path.sep));
      },
    });
    const onChange = (abs: string) => {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      if (rel !== '' && !rel.startsWith('..')) this.refresh(rel).catch((e) => onError?.(e));
    };
    for (const ev of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) watcher.on(ev, onChange);
    if (onError) watcher.on('error', onError);
    this.watcher = watcher;
    return new Promise((resolve) => watcher.once('ready', () => resolve()));
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}

export const entryName = (e: Entry): string => {
  const n = nameOf(e.path);
  return e.kind === 'note' ? n.slice(0, -3) : n;
};

export const segsKey = (segs: Segs): string => join(segs);
