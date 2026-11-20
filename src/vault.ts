import { appendFile, link, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, alreadyExists, notFound } from './errors.js';
import { hasDotSegment, join, split, type Segs } from './paths.js';
import { revOf, type VaultIndex } from './vault-index.js';

const errno = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * One lock for every API write. Writes are a few local file operations, so running them one at a
 * time is cheap, and it rules out every interleaving between them: two names for one file (case,
 * symlinks), a folder delete and a write inside the folder, two moves picking the same free name.
 */
class WriteLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** A move that linked the destination but could remove neither the source nor the new link. */
export class PartialMoveError extends Error {
  /** The error code in the audit log's result line. */
  readonly code = 'move_incomplete';
  constructor(
    readonly from: Segs,
    readonly to: Segs,
    readonly reason: unknown,
  ) {
    super(`Moved ${join(from)} to ${join(to)} but could not remove either name`);
  }
}

/**
 * Filesystem operations on vault-relative paths. Callers check permissions; this layer makes sure a
 * path really points inside the vault and keeps the index in sync.
 */
export class Vault {
  private readonly writes = new WriteLock();
  /** Journal of in-place overwrites (see `overwrite`); a dot-folder, so never indexed or served. */
  private readonly journal: string;
  private journalSeq = 0;
  /** An overwrite failed and couldn't be undone yet: recover before the next write. */
  private recoveryPending = false;

  constructor(
    readonly root: string,
    readonly index: VaultIndex,
    private readonly opts: { followSymlinks: boolean; trash: string[] | null },
  ) {
    this.journal = path.join(root, '.spall', 'journal');
  }

  /** Runs `fn` under the vault-wide write lock, after finishing any overwrite that failed earlier. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.writes.run(async () => {
      if (this.recoveryPending) await this.recover();
      return fn();
    });
  }

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
    } catch (e) {
      // We made the file: don't leave a partial one behind.
      await fh.close().catch(() => {});
      await unlink(this.abs(segs)).catch(() => {});
      throw e;
    }
    await fh.close();
    await this.refreshChain(segs);
  }

  /**
   * Overwrites an existing file in place. Rename-over-temp would be atomic, but it gives the file a
   * new inode and so a new birth time, which is what `created` is based on. Instead the old bytes
   * go to the journal first (synced), so a write that fails or a crash midway can always be undone:
   * at once if possible, otherwise by `recover()` before the next write or at the next start.
   */
  async overwrite(segs: Segs, data: string | Buffer): Promise<void> {
    const file = this.abs(segs);
    const old = await readFile(file);
    const id = `${Date.now()}-${process.pid}-${this.journalSeq++}`;
    await this.journalWrite(id, segs, old, revOf(data));
    try {
      await writeFile(file, data);
    } catch (e) {
      if (await writeFile(file, old).then(() => true, () => false)) await this.journalDrop(id);
      else this.recoveryPending = true;
      await this.index.refresh(join(segs));
      throw e;
    }
    await this.journalDrop(id);
    await this.index.refresh(join(segs));
  }

  private async journalWrite(id: string, segs: Segs, old: Buffer, newRev: string): Promise<void> {
    await mkdir(this.journal, { recursive: true });
    const base = path.join(this.journal, id);
    try {
      await writeSynced(`${base}.old`, old);
      // The record is what makes the entry count: written last, and atomically.
      await writeSynced(`${base}.tmp`, JSON.stringify({ path: join(segs), new_rev: newRev }));
      await rename(`${base}.tmp`, `${base}.json`);
    } catch (e) {
      await this.journalDrop(id);
      throw e;
    }
  }

  private async journalDrop(id: string): Promise<void> {
    const base = path.join(this.journal, id);
    await rm(`${base}.json`, { force: true });
    await rm(`${base}.tmp`, { force: true });
    await rm(`${base}.old`, { force: true });
  }

  /**
   * Finishes overwrites that failed or were cut short: a file that doesn't hold the new bytes gets
   * its old bytes back. Returns the vault paths restored. Entries it can't finish stay for next time.
   */
  async recover(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.journal);
    } catch (e) {
      if (errno(e) === 'ENOENT') return [];
      throw e;
    }
    const restored: string[] = [];
    let failed = false;
    for (const id of new Set(names.map((n) => n.replace(/\.(json|old|tmp)$/, '')))) {
      const base = path.join(this.journal, id);
      let record: { path: string; new_rev: string } | null = null;
      try {
        record = JSON.parse(await readFile(`${base}.json`, 'utf8'));
      } catch {
        // No record: the in-place write never started.
      }
      if (record) {
        try {
          const segs = split(record.path);
          const current = await readFile(this.abs(segs)).catch((e) => (errno(e) === 'ENOENT' ? null : Promise.reject(e)));
          if (current !== null && revOf(current) !== record.new_rev) {
            await writeFile(this.abs(segs), await readFile(`${base}.old`));
            restored.push(record.path);
            await this.index.refresh(record.path);
          }
        } catch {
          failed = true;
          continue;
        }
      }
      await this.journalDrop(id);
    }
    this.recoveryPending = failed;
    return restored;
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
    let linked = true;
    try {
      await link(this.abs(from), this.abs(to));
    } catch (e) {
      if (errno(e) === 'EEXIST') throw alreadyExists(join(to));
      if (errno(e) !== 'EPERM' && errno(e) !== 'ENOTSUP' && errno(e) !== 'EXDEV') throw e;
      linked = false;
    }
    if (linked) {
      try {
        await unlink(this.abs(from));
      } catch (e) {
        // Don't leave the file under both names: drop the new one, so a retry starts clean. Only if
        // it is still our link: something else may have replaced it meanwhile.
        if (!(await this.unlinkIfSameFile(to, from))) {
          await this.index.refresh(join(from));
          await this.refreshChain(to);
          throw new PartialMoveError(from, to, e);
        }
        throw e;
      }
    } else {
      // Filesystems without hard links: check, then rename.
      if ((await this.kindOf(to)) !== null) throw alreadyExists(join(to));
      await rename(this.abs(from), this.abs(to));
    }
    await this.index.refresh(join(from));
    await this.refreshChain(to);
  }

  /** Unlinks `p` if it is the same file (inode) as `other`. False if that failed; true otherwise. */
  private async unlinkIfSameFile(p: Segs, other: Segs): Promise<boolean> {
    try {
      const [a, b] = await Promise.all([lstat(this.abs(p)), lstat(this.abs(other))]);
      if (a.ino !== b.ino || a.dev !== b.dev) return true;
      await unlink(this.abs(p));
      return true;
    } catch (e) {
      return errno(e) === 'ENOENT';
    }
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

async function writeSynced(file: string, data: string | Buffer): Promise<void> {
  const fh = await open(file, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
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
