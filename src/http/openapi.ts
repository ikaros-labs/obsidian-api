import swagger from '@fastify/swagger';
import type { FastifyInstance, FastifySchema } from 'fastify';
import { createRequire } from 'node:module';
import { z } from 'zod';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

/** The input side of a zod schema as JSON Schema, for the OpenAPI document. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  return rest;
}

const ERROR = {
  $id: 'Error',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        request_id: { type: 'string' },
        details: { type: 'object' },
      },
      required: ['code', 'message'],
    },
  },
  required: ['error'],
};

/**
 * Route schema for the OpenAPI document. Request validation stays with the zod schemas in the
 * handlers (the server compiles these schemas to no-ops), so the two can't disagree.
 */
export function doc(o: {
  summary: string;
  tag: string;
  description?: string;
  /** Path as documented, when the route is a wildcard (`{path}` is the note, file or folder path). */
  url?: string;
  query?: z.ZodType;
  body?: z.ZodType | Record<string, unknown>;
  public?: boolean;
}): FastifySchema {
  const schema: Record<string, unknown> = { summary: o.summary, tags: [o.tag] };
  if (o.description) schema.description = o.description;
  if (o.url) schema['x-url'] = o.url;
  if (o.url?.includes('{path}')) {
    schema.params = {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the account root, percent-encoded per segment' } },
      required: ['path'],
    };
  }
  if (o.query) schema.querystring = jsonSchema(o.query);
  if (o.body) schema.body = o.body instanceof z.ZodType ? jsonSchema(o.body) : o.body;
  if (o.public) schema.security = [];
  else schema.response = { '2xx': { description: 'Success' }, '4xx': { description: 'Error envelope', $ref: 'Error#' } };
  return schema;
}

/** Registers @fastify/swagger. Call before adding routes. */
export function registerOpenApi(app: FastifyInstance) {
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));
  app.addSchema(ERROR);
  app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Spall',
        version,
        description: 'Scoped REST API for an Obsidian vault: every account sees only the folders it is granted.',
        license: { name: 'MIT', identifier: 'MIT' },
      },
      externalDocs: { url: 'https://github.com/ikaros-labs/spall' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
      security: [{ bearer: [] }],
    },
    refResolver: { buildLocalReference: (json, _base, _fragment, i) => (json.$id as string) ?? `def-${i}` },
    transform: ({ schema, url }) => {
      if (!schema) return { schema, url };
      const { 'x-url': docUrl, ...rest } = schema as Record<string, unknown>;
      return { schema: rest as FastifySchema, url: (docUrl as string | undefined) ?? url };
    },
  });
}
