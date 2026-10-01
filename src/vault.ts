import { appendFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, alreadyExists, notFound } from './errors.js';
import { hasDotSegment, join, type Segs } from './paths.js';
import type { VaultIndex } from './vault-index.js';

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Per-key async mutex. */
class Locks {
  private tails = new Map<string, Promise<void>>();

  async run<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys.map((k) => k.toLowerCase()))].sort();
    const releases: (() => void)[] = [];
    for (const key of sorted) {
      const prev = this.tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const tail = prev.then(() => mine);
      this.tails.set(key, tail);
      releases.push(() => {
        release();
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
      await prev;
    }
    try {
      return await fn();
    } finally {
      releases.reverse().forEach((r) => r());
    }
  }
}

/**
 * Filesystem operations on vault-relative paths. Callers check permissions; this layer makes sure a
 * path really points inside the vault and keeps the index in sync.
 */
export class Vault {
  readonly locks = new Locks();

  constructor(
    readonly root: string,
    readonly index: VaultIndex,
    private readonly opts: { followSymlinks: boolean; trash: string[] | null },
  ) {}

  abs(segs: Segs): string {
    return path.join(this.root, ...segs);
  }

  /**
   * Returns the vault-relative path that `segs` really points to, following symlinks in the existing
   * part of the path. Symlinks are rejected unless `follow_symlinks` is on, and must stay inside the
   * vault and outside dot-folders. The caller re-checks permissions on the result.
   */
  async resolve(segs: Segs): Promise<string[]> {
    let realSegs: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const abs = path.join(this.root, ...realSegs, segs[i]!);
      let st;
      try {
        st = await lstat(abs);
      } catch (e) {
        if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') return [...realSegs, ...segs.slice(i)];
        throw e;
      }
      if (st.isSymbolicLink()) {
        if (!this.opts.followSymlinks) throw notFound();
        const rel = path.relative(this.root, await realpath(abs).catch(() => abs));
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw notFound();
        realSegs = rel === '' ? [] : rel.split(path.sep);
        if (hasDotSegment(realSegs)) throw notFound();
      } else {
        realSegs.push(segs[i]!);
      }
    }
    return realSegs;
  }

  async kindOf(segs: Segs): Promise<'file' | 'folder' | null> {
    try {
      const st = await stat(this.abs(segs));
      return st.isDirectory() ? 'folder' : st.isFile() ? 'file' : null;
    } catch {
      return null;
    }
  }

  async read(segs: Segs): Promise<Buffer> {
    try {
      return await readFile(this.abs(segs));
    } catch (e) {
      if (errno(e) === 'ENOENT' || errno(e) === 'EISDIR' || errno(e) === 'ENOTDIR') throw notFound();
      throw e;
    }
  }

  async stat(segs: Segs) {
    return stat(this.abs(segs));
  }

  /** Creates a file; fails with 409 if it exists. Parent folders are created as needed. */
  async create(segs: Segs, data: string | Buffer): Promise<void> {
    await mkdir(path.dirname(this.abs(segs)), { recursive: true });
    let fh;
    try {
      fh = await open(this.abs(segs), 'wx');
    } catch (e) {
      if (errno(e) === 'EEXIST') throw alreadyExists(join(segs));
      throw e;
    }
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    await this.refreshChain(segs);
  }

  /**
   * Overwrites an existing file in place. Rename-over-temp would be atomic, but it gives the file a
   * new inode and so a new birth time, which is what `created` is based on.
   */
  async overwrite(segs: Segs, data: string | Buffer): Promise<void> {
    await writeFile(this.abs(segs), data);
    await this.index.refresh(join(segs));
  }

  async mkdir(segs: Segs): Promise<void> {
    await mkdir(path.dirname(this.abs(segs)), { recursive: true });
    try {
      await mkdir(this.abs(segs));
    } catch (e) {
      if (errno(e) === 'EEXIST') throw alreadyExists(join(segs));
      throw e;
    }
    await this.refreshChain(segs);
  }

  /** Moves a file without overwriting the destination. Keeps the inode (and birth time). */
  async move(from: Segs, to: Segs): Promise<void> {
    await mkdir(path.dirname(this.abs(to)), { recursive: true });
    try {
      await link(this.abs(from), this.abs(to));
      await unlink(this.abs(from));
    } catch (e) {
      if (errno(e) === 'EEXIST') throw alreadyExists(join(to));
      if (errno(e) !== 'EPERM' && errno(e) !== 'ENOTSUP' && errno(e) !== 'EXDEV') throw e;
      // Filesystems without hard links: check, then rename.
      if ((await this.kindOf(to)) !== null) throw alreadyExists(join(to));
      await rename(this.abs(from), this.abs(to));
    }
    await this.index.refresh(join(from));
    await this.refreshChain(to);
  }

  /** Moves a file or folder into the trash, keeping its relative path. */
  async trash(segs: Segs): Promise<string> {
    if (!this.opts.trash) throw new ApiError(400, 'invalid_request', 'The trash is disabled; delete with permanent=true');
    const dest = await this.freePath([...this.opts.trash, ...segs], true);
    await mkdir(path.dirname(this.abs(dest)), { recursive: true });
    await rename(this.abs(segs), this.abs(dest));
    await this.index.refresh(join(segs));
    return join(dest);
  }

  async purge(segs: Segs): Promise<void> {
    await rm(this.abs(segs), { recursive: true, force: true });
    await this.index.refresh(join(segs));
  }

  async rmdirEmpty(segs: Segs): Promise<void> {
    try {
      await rmdir(this.abs(segs));
    } catch (e) {
      if (errno(e) === 'ENOTEMPTY' || errno(e) === 'EEXIST') {
        throw new ApiError(409, 'folder_not_empty', 'The folder is not empty; use recursive=true');
      }
      throw e;
    }
    await this.index.refresh(join(segs));
  }

  async listRaw(segs: Segs): Promise<string[]> {
    return readdir(this.abs(segs));
  }

  /** `a/b.md` → the first of `a/b.md`, `a/b 1.md`, `a/b 2.md`, … that doesn't exist. */
  async freePath(segs: Segs, includeSelf = true): Promise<string[]> {
    const last = segs.at(-1)!;
    const dot = last.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [last.slice(0, dot), last.slice(dot)] : [last, ''];
    for (let n = includeSelf ? 0 : 1; ; n++) {
      const candidate = [...segs.slice(0, -1), n === 0 ? last : `${stem} ${n}${ext}`];
      if ((await this.kindOf(candidate)) === null) return candidate;
    }
  }

  /** Re-indexes a new path; the index adds any parent folders created on the way. */
  private async refreshChain(segs: Segs): Promise<void> {
    await this.index.refresh(join(segs));
  }
}

export class AuditLog {
  constructor(private readonly file: () => string | null) {}

  async write(entry: Record<string, unknown>): Promise<void> {
    const file = this.file();
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  }
}
