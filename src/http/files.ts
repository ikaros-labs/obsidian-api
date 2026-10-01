import type { FastifyInstance } from 'fastify';
import { ApiError, invalidRequest } from '../errors.js';
import { revOf } from '../vault-index.js';
import { Ctx, etag, header, parseEtagList, type Services } from './context.js';
import { deleteFile, moveFile, putFile, stripMove } from './fileops.js';

const PREFIX = '/v1/files/';

const TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  base: 'text/yaml; charset=utf-8',
  canvas: 'application/json',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  html: 'text/plain; charset=utf-8', // never let the vault serve active content
};

const contentType = (name: string) => TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

function parseRange(range: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start <= end && start < size ? [start, end] : null;
}

/** Raw bytes for any file. Registered in its own scope so every request body arrives as a Buffer. */
export async function fileRoutes(app: FastifyInstance, s: Services) {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const filePath = (ctx: Ctx) => {
    const segs = ctx.urlPath(PREFIX);
    if (segs.length === ctx.account.root.length) throw new ApiError(400, 'invalid_path', 'A file path is required');
    return segs;
  };

  app.get('/v1/files/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const real = await ctx.resolve(filePath(ctx), 'read');
    if ((await s.vault.kindOf(real)) !== 'file') throw new ApiError(404, 'not_found', 'Not found');
    const buf = await s.vault.read(real);
    const rev = revOf(buf);
    const st = await s.vault.stat(real);
    reply
      .header('etag', etag(rev))
      .header('last-modified', st.mtime.toUTCString())
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .type(contentType(real.at(-1)!));
    const inm = parseEtagList(header(req, 'if-none-match'));
    if (inm && (inm.includes(rev) || inm.includes('*'))) return reply.code(304).send();

    const range = header(req, 'range');
    if (range) {
      const r = parseRange(range, buf.length);
      if (!r) {
        return reply
          .code(416)
          .header('content-range', `bytes */${buf.length}`)
          .type('application/json')
          .send({ error: { code: 'invalid_request', message: 'Unsatisfiable range', request_id: req.id } });
      }
      return reply.code(206).header('content-range', `bytes ${r[0]}-${r[1]}/${buf.length}`).send(buf.subarray(r[0], r[1] + 1));
    }
    return reply.send(buf);
  });

  app.put('/v1/files/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return putFile(ctx, filePath(ctx), data, reply, { note: false });
  });

  app.delete('/v1/files/*', async (req, reply) => {
    const ctx = new Ctx(req, s);
    return deleteFile(ctx, filePath(ctx), reply);
  });

  app.post('/v1/files/*', async (req) => {
    const ctx = new Ctx(req, s);
    const segs = stripMove(ctx.urlPath(PREFIX), ctx.account.root.length);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '');
    } catch {
      throw invalidRequest('Expected a JSON body');
    }
    return moveFile(ctx, segs, body, { note: false });
  });
}
