import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ApiError, alreadyExists, forbidden, invalidRequest, notFound } from '../errors.js';
import { joinFrontmatter, outline } from '../markdown.js';
import { PatchBodySchema, applyPatch } from '../patch.js';
import { join, parsePlainPath, sanitizeTitle, withMdExtension } from '../paths.js';
import { revOf } from '../vault-index.js';
import { Ctx, etag, header, negotiate, parse, parseEtagList, project, type Services } from './context.js';
import { checkIfMatch, deleteFile, moveFile, noteJson, putFile, stripMove } from './fileops.js';

const PREFIX = '/v1/notes/';
const MD = 'text/markdown';
const JSON_TYPE = 'application/json';
const OUTLINE = 'application/vnd.vault.outline+json';

const NoteQuery = z.object({
  include: z.string().optional(),
  fields: z.string().optional(),
  return: z.enum(['full']).optional(),
});

const JsonNoteBody = z.strictObject({
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  body: z.string().default(''),
});

const CreateBody = z.strictObject({
  folder: z.string().default(''),
  title: z.string().min(1).max(500),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  body: z.string().default(''),
  on_conflict: z.enum(['rename', 'fail']).default('rename'),
});

function renderNote(frontmatter: Record<string, unknown> | undefined, body: string): string {
  const fm = frontmatter && Object.keys(frontmatter).length > 0 ? stringify(frontmatter) : null;
  return joinFrontmatter(fm, body);
}

const includes = (q: { include?: string }, what: string) => (q.include ?? '').split(',').map((s) => s.trim()).includes(what);

export function noteRoutes(app: FastifyInstance, s: Services) {
  const notePath = (ctx: Ctx) => {
    const segs = withMdExtension(ctx.urlPath(PREFIX));
    if (segs.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A note path is required');
    return segs;
  };

  app.get('/v1/notes/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(NoteQuery, req.query, 'query');
    const real = await ctx.resolve(notePath(ctx), 'read');
    const buf = await s.vault.read(real);
    const rev = revOf(buf);
    const st = await s.vault.stat(real);
    reply.header('etag', etag(rev)).header('last-modified', st.mtime.toUTCString()).header('vary', 'accept');
    const inm = parseEtagList(header(req, 'if-none-match'));
    if (inm && (inm.includes(rev) || inm.includes('*'))) return reply.code(304).send();

    const text = buf.toString('utf8');
    const type = negotiate(header(req, 'accept'), [MD, JSON_TYPE, OUTLINE]);
    if (type === MD) return reply.type('text/markdown; charset=utf-8').send(text);
    if (type === OUTLINE) return reply.type(OUTLINE).send({ path: ctx.toApi(real), rev, ...outline(text) });
    const note = await noteJson(ctx, real, text, { body: true, backlinks: includes(q, 'backlinks') });
    return reply.type(JSON_TYPE).send(project(note, q.fields));
  });

  app.put('/v1/notes/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    let text: string;
    if (typeof req.body === 'string') text = req.body;
    else if (req.body && typeof req.body === 'object') {
      const b = parse(JsonNoteBody, req.body);
      text = renderNote(b.frontmatter, b.body);
    } else throw invalidRequest('Send the note as text/markdown, or as JSON {frontmatter, body}');
    return putFile(ctx, notePath(ctx), Buffer.from(text, 'utf8'), reply, { note: true });
  });

  app.post('/v1/notes', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const b = parse(CreateBody, req.body);
    const folder = await s.vault.resolve(ctx.toVault(parsePlainPath(b.folder)));
    const name = `${sanitizeTitle(b.title)}.md`;
    const perms = ctx.perms([...folder, name]);
    if (!perms.has('create')) throw perms.has('read') ? forbidden('create') : notFound();
    if ((await s.vault.kindOf(folder)) === 'file') throw new ApiError(400, 'invalid_path', 'folder is a file');

    const data = Buffer.from(renderNote(b.frontmatter, b.body), 'utf8');
    let target = [...folder, name];
    for (let attempt = 0; ; attempt++) {
      try {
        await s.vault.create(target, data);
        break;
      } catch (e) {
        if (!(e instanceof ApiError && e.code === 'already_exists') || b.on_conflict === 'fail' || attempt > 50) {
          throw e instanceof ApiError && e.code === 'already_exists' ? alreadyExists(ctx.toApi(target)) : e;
        }
        target = await s.vault.freePath(target);
      }
    }
    const rev = revOf(data);
    await ctx.audit('create', target, { new_rev: rev });
    reply.code(201).header('etag', etag(rev));
    if (!perms.has('read')) return { path: ctx.toApi(target), rev };
    return noteJson(ctx, target, data.toString('utf8'));
  });

  app.patch('/v1/notes/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(NoteQuery, req.query, 'query');
    const body = parse(PatchBodySchema, req.body);
    const segs = notePath(ctx);
    const ifMatch = body.if_match ? [body.if_match] : parseEtagList(header(req, 'if-match'));
    return s.vault.locks.run([join(segs)], async () => {
      const real = await ctx.resolve(segs, 'read', 'update');
      const before = await s.vault.read(real);
      const oldRev = revOf(before);
      checkIfMatch(ifMatch, oldRev);
      const text = before.toString('utf8');
      const next = applyPatch(text, body.ops);
      const newRev = revOf(Buffer.from(next, 'utf8'));
      if (next !== text) {
        await s.vault.overwrite(real, next);
        await ctx.audit('patch', real, { old_rev: oldRev, new_rev: newRev, ops: body.ops.map((o) => o.op) });
      }
      reply.header('etag', etag(newRev));
      return project(await noteJson(ctx, real, next, { body: q.return === 'full' }), q.fields);
    });
  });

  app.delete('/v1/notes/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    return deleteFile(ctx, notePath(ctx), reply);
  });

  app.post('/v1/notes/*', async (req) => {
    const ctx = new Ctx(req, s);
    const segs = withMdExtension(stripMove(ctx.urlPath(PREFIX), ctx.account.root.length));
    return moveFile(ctx, segs, req.body, { note: true });
  });
}
