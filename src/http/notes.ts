import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import { z } from 'zod';
import { ApiError, alreadyExists, forbidden, invalidRequest, notFound } from '../errors.js';
import { joinFrontmatter, outline } from '../markdown.js';
import { PatchBodySchema, applyPatch } from '../patch.js';
import { join, parsePlainPath, sanitizeTitle, withMdExtension } from '../paths.js';
import { revOf } from '../vault-index.js';
import { Ctx, etag, header, negotiate, parse, parseEtagList, project, type Services } from './context.js';
import { checkIfMatch, checkNotANote, DeleteQuery, deleteFile, freeName, MoveBody, moveFile, noteJson, putFile, stripMove, writablePath } from './fileops.js';
import { doc, jsonSchema } from './openapi.js';

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
  const notePath = async (ctx: Ctx, raw = ctx.urlPath(PREFIX)) => {
    const segs = withMdExtension(raw);
    if (segs.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A note path is required');
    await checkNotANote(ctx, raw, segs);
    return segs;
  };

  app.get('/v1/notes/*', { schema: doc({
    summary: 'Read a note',
    description: 'Accept: text/markdown (raw), application/json (default; frontmatter, body, links, tags) or application/vnd.vault.outline+json (headings and blocks). Sends an ETag; If-None-Match gives 304.',
    tag: 'Notes', url: '/v1/notes/{path}', query: NoteQuery }) }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(NoteQuery, req.query, 'query');
    const real = await ctx.resolve(await notePath(ctx), 'read');
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

  app.put('/v1/notes/*', { schema: doc({
    summary: 'Create or replace a note',
    description: 'Send text/markdown, or JSON {frontmatter, body}. If-Match makes it conditional; If-None-Match: * only creates.',
    tag: 'Notes', url: '/v1/notes/{path}',
    body: { content: { 'application/json': { schema: jsonSchema(JsonNoteBody) }, 'text/markdown': { schema: { type: 'string' } } } },
  }) }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    let text: string;
    if (typeof req.body === 'string') text = req.body;
    else if (req.body && typeof req.body === 'object') {
      const b = parse(JsonNoteBody, req.body);
      text = renderNote(b.frontmatter, b.body);
    } else throw invalidRequest('Send the note as text/markdown, or as JSON {frontmatter, body}');
    return putFile(ctx, await notePath(ctx), Buffer.from(text, 'utf8'), reply, { note: true });
  });

  app.post('/v1/notes', { schema: doc({ summary: 'Create a note from a title (the file name is derived from it)', tag: 'Notes', body: CreateBody }) }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    const b = parse(CreateBody, req.body);
    const name = `${sanitizeTitle(b.title)}.md`;
    const requested = ctx.toVault(parsePlainPath(b.folder));
    return s.vault.locks.run([join([...requested, name])], async () => {
      // The folder as requested and the folder it resolves to must both allow the new note.
      const { real: folder, perms } = await writablePath(ctx, requested, name);
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
          target = await freeName(ctx, target, requested);
        }
      }
      const rev = revOf(data);
      await ctx.audit('create', target, { new_rev: rev });
      reply.code(201).header('etag', etag(rev));
      if (!perms.has('read')) return { path: ctx.toApi(target), rev };
      return noteJson(ctx, target, data.toString('utf8'));
    });
  });

  app.patch('/v1/notes/*', { schema: doc({ summary: 'Edit frontmatter, sections or text in place', tag: 'Notes', url: '/v1/notes/{path}', query: NoteQuery, body: PatchBodySchema }) }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    const q = parse(NoteQuery, req.query, 'query');
    const body = parse(PatchBodySchema, req.body);
    const segs = await notePath(ctx);
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

  app.delete('/v1/notes/*', { schema: doc({ summary: 'Move a note to the trash, or delete it with permanent=true', tag: 'Notes', url: '/v1/notes/{path}', query: DeleteQuery }) }, async (req, reply) => {
    const ctx = new Ctx(req, s);
    return deleteFile(ctx, await notePath(ctx), reply);
  });

  app.post('/v1/notes/*', { schema: doc({ summary: 'Move or rename a note', tag: 'Notes', url: '/v1/notes/{path}/move', body: MoveBody }) }, async (req) => {
    const ctx = new Ctx(req, s);
    const segs = await notePath(ctx, stripMove(ctx.urlPath(PREFIX), ctx.account.root.length));
    return moveFile(ctx, segs, req.body, { note: true });
  });
}
