import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Perm } from '../access.js';
import { ApiError, alreadyExists, forbidden, invalidRequest, notFound } from '../errors.js';
import { analyzeNote, splitFrontmatter } from '../markdown.js';
import { join, parsePlainPath, withMdExtension } from '../paths.js';
import { revOf } from '../vault-index.js';
import { Ctx, etag, iso, parse, parseEtagList, header, project } from './context.js';

/** Shared write logic for /notes and /files. `note` switches on markdown-aware responses. */
export interface Kind {
  note: boolean;
}

export async function statJson(ctx: Ctx, real: string[], rev: string) {
  const st = await ctx.s.vault.stat(real);
  return {
    path: ctx.toApi(real),
    name: real.at(-1)!,
    rev,
    created: iso(st.birthtimeMs || st.mtimeMs),
    modified: iso(st.mtimeMs),
    size: st.size,
  };
}

export async function noteJson(ctx: Ctx, real: string[], text: string, opts: { body?: boolean; backlinks?: boolean } = {}) {
  const st = await ctx.s.vault.stat(real);
  const meta = analyzeNote(text);
  const index = ctx.s.index;
  const self = join(real);
  const out: Record<string, unknown> = {
    path: ctx.toApi(real),
    name: real.at(-1)!.replace(/\.md$/i, ''),
    rev: revOf(Buffer.from(text, 'utf8')),
    created: iso(st.birthtimeMs || st.mtimeMs),
    modified: iso(st.mtimeMs),
    size: st.size,
    frontmatter: meta.frontmatter,
  };
  if (opts.body) out.body = splitFrontmatter(text).body;
  out.tags = meta.tags;
  out.links = meta.links.map((l) => {
    const e = index.resolveLink(l, self, ctx.visible);
    return { target: l.target, path: e ? ctx.toApi(e.path) : null, resolved: e !== null };
  });
  if (opts.backlinks) {
    const backlinks: string[] = [];
    for (const e of index.notes()) {
      if (e.path === self || !ctx.visible(e)) continue;
      if (e.meta?.links.some((l) => index.resolveLink(l, e.path, ctx.visible)?.path === self)) backlinks.push(ctx.toApi(e.path));
    }
    out.backlinks = backlinks.sort();
  }
  return out;
}

/** Permissions on a path and, if it goes through a symlink, on its target too. */
function effectivePerms(ctx: Ctx, segs: string[], real: string[]): Set<Perm> {
  const a = ctx.perms(segs);
  const b = ctx.perms(real);
  return new Set([...a].filter((p) => b.has(p)));
}

export function checkIfMatch(ifMatch: string[] | null, current: string | null): void {
  if (!ifMatch) return;
  if (ifMatch.includes('*') ? current !== null : current !== null && ifMatch.includes(current)) return;
  throw new ApiError(412, 'rev_mismatch', current === null ? 'The file does not exist' : 'The file has changed', {
    current_rev: current,
  });
}

/** PUT: create or replace. */
export async function putFile(ctx: Ctx, segs: string[], data: Buffer, reply: FastifyReply, kind: Kind) {
  if (segs.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A file path is required');
  const { vault } = ctx.s;
  const ifMatch = parseEtagList(header(ctx.req, 'if-match'));
  const ifNoneMatch = parseEtagList(header(ctx.req, 'if-none-match'));

  return vault.locks.run([join(segs)], async () => {
    const real = await vault.resolve(segs);
    const perms = effectivePerms(ctx, segs, real);
    const existing = await vault.kindOf(real);
    if (existing === 'folder') {
      if (!perms.has('read')) throw notFound();
      throw alreadyExists(ctx.toApi(real));
    }
    let created: boolean;
    if (existing === 'file') {
      if (!perms.has('read')) {
        // A create-only account learns that the name is taken, but nothing more.
        if (perms.has('create')) throw alreadyExists(ctx.toApi(real));
        throw notFound();
      }
      if (ifNoneMatch?.includes('*')) throw alreadyExists(ctx.toApi(real));
      if (!perms.has('update')) throw forbidden('update');
      const oldRev = revOf(await vault.read(real));
      checkIfMatch(ifMatch, oldRev);
      await vault.overwrite(real, data);
      await ctx.audit('update', real, { old_rev: oldRev, new_rev: revOf(data) });
      created = false;
    } else {
      if (!perms.has('create')) throw perms.has('read') ? forbidden('create') : notFound();
      if (ifMatch) {
        if (!perms.has('read')) throw notFound();
        checkIfMatch(ifMatch, null);
      }
      await vault.create(real, data);
      await ctx.audit('create', real, { new_rev: revOf(data) });
      created = true;
    }
    const rev = revOf(data);
    reply.code(created ? 201 : 200).header('etag', etag(rev));
    if (!perms.has('read')) return { path: ctx.toApi(real), rev };
    const out = kind.note ? await noteJson(ctx, real, data.toString('utf8')) : await statJson(ctx, real, rev);
    return project(out, (ctx.req.query as { fields?: string }).fields);
  });
}

const DeleteQuery = z.object({ permanent: z.enum(['true', 'false']).optional() });

export async function deleteFile(ctx: Ctx, segs: string[], reply: FastifyReply) {
  const q = parse(DeleteQuery, ctx.req.query, 'query');
  const permanent = q.permanent === 'true';
  const { vault } = ctx.s;
  return vault.locks.run([join(segs)], async () => {
    const real = await ctx.resolve(segs, 'read', permanent ? 'purge' : 'delete');
    if ((await vault.kindOf(real)) !== 'file') throw notFound();
    const rev = revOf(await vault.read(real));
    checkIfMatch(parseEtagList(header(ctx.req, 'if-match')), rev);
    if (permanent) {
      await vault.purge(real);
      await ctx.audit('purge', real, { old_rev: rev });
    } else {
      const trashed = await vault.trash(real);
      await ctx.audit('delete', real, { old_rev: rev, trash: trashed });
    }
    return reply.code(204).send();
  });
}

const MoveBody = z.strictObject({
  destination: z.string().min(1),
  on_conflict: z.enum(['fail', 'rename']).default('fail'),
});

export async function moveFile(ctx: Ctx, segs: string[], body: unknown, kind: Kind) {
  const b = parse(MoveBody, body);
  const { vault } = ctx.s;
  let dest = ctx.toVault(parsePlainPath(b.destination));
  if (kind.note) dest = withMdExtension(dest);
  if (dest.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A destination file path is required');

  return vault.locks.run([join(segs), join(dest)], async () => {
    const real = await ctx.resolve(segs, 'read', 'update', 'delete');
    if ((await vault.kindOf(real)) !== 'file') throw notFound();
    let realDest = await vault.resolve(dest);
    const destPerms = effectivePerms(ctx, dest, realDest);
    if (!destPerms.has('create')) throw destPerms.has('read') ? forbidden('create') : notFound();
    if (join(realDest) === join(real)) throw invalidRequest('Source and destination are the same');
    if ((await vault.kindOf(realDest)) !== null) {
      if (b.on_conflict === 'fail') throw alreadyExists(ctx.toApi(realDest));
      realDest = await vault.freePath(realDest);
    }
    const rev = revOf(await vault.read(real));
    await vault.move(real, realDest);
    await ctx.audit('move', real, { destination: join(realDest), rev });
    if (!destPerms.has('read')) return { path: ctx.toApi(realDest), rev };
    return kind.note
      ? noteJson(ctx, realDest, (await vault.read(realDest)).toString('utf8'))
      : statJson(ctx, realDest, rev);
  });
}

/** Splits `…/{path}/move` for POST routes; anything else is not an endpoint. */
export function stripMove(segs: string[], root: number): string[] {
  if (segs.length <= root + 1 || segs.at(-1) !== 'move') throw new ApiError(404, 'not_found', 'No such endpoint');
  return segs.slice(0, -1);
}
