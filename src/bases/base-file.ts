import { compileExpression, compileFilter, type FilterExpression } from 'obsidian-bases-expression';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ApiError } from '../errors.js';
import type { Diagnostic, SortSpec } from './engine.js';

const Direction = z
  .string()
  .default('ASC')
  .transform((d) => (d.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'));

export const SortSchema = z.object({ property: z.string().min(1), direction: Direction });

const ViewSchema = z.looseObject({
  type: z.string().default('table'),
  name: z.string(),
  filters: z.unknown().optional(),
  order: z.array(z.string()).optional(),
  sort: z.array(SortSchema).optional(),
  groupBy: SortSchema.optional(),
  limit: z.number().int().positive().optional(),
});

const BaseSchema = z.looseObject({
  filters: z.unknown().optional(),
  formulas: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]).transform(String)).default({}),
  properties: z.record(z.string(), z.looseObject({ displayName: z.string().optional() })).default({}),
  views: z.array(ViewSchema).default([]),
});

export interface BaseView {
  name: string;
  type: string;
  filters?: FilterExpression;
  order?: string[];
  sort: SortSpec[];
  groupBy?: SortSpec;
  limit?: number;
}

export interface BaseFile {
  filters?: FilterExpression;
  formulas: Record<string, string>;
  properties: Record<string, { displayName?: string }>;
  views: BaseView[];
}

const invalidBase = (message: string, details?: Record<string, unknown>) => new ApiError(422, 'invalid_base', message, details);

export function parseBase(text: string): BaseFile {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw invalidBase(`The base is not valid YAML: ${doc.errors[0]!.message}`);
  const r = BaseSchema.safeParse(doc.toJS() ?? {});
  if (!r.success) {
    throw invalidBase('The base has an unexpected structure', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return {
    filters: r.data.filters as FilterExpression,
    formulas: r.data.formulas,
    properties: r.data.properties,
    views: r.data.views.map((v) => ({
      name: v.name,
      type: v.type,
      filters: v.filters as FilterExpression,
      order: v.order,
      sort: v.sort ?? [],
      groupBy: v.groupBy,
      limit: v.limit,
    })),
  };
}

/** Parse errors in every expression of the base, so clients learn about them before querying. */
export function baseDiagnostics(base: BaseFile): Diagnostic[] {
  const out: Diagnostic[] = [];
  const filter = (where: string, f: FilterExpression) => {
    if (f === undefined || f === null) return;
    for (const d of compileFilter(f).diagnostics) if (d.severity === 'error') out.push({ where, message: d.message });
  };
  filter('filters', base.filters);
  for (const [name, source] of Object.entries(base.formulas)) {
    for (const d of compileExpression(source).diagnostics) if (d.severity === 'error') out.push({ where: `formulas.${name}`, message: d.message });
  }
  base.views.forEach((v, i) => filter(`views[${i}].filters`, v.filters));
  return out;
}

/** Display name for a property id: `properties` may key it as `Status` or `note.Status`. */
export function displayName(base: Pick<BaseFile, 'properties'>, id: string): string {
  const bare = id.startsWith('note.') ? id.slice(5) : id;
  return base.properties[id]?.displayName ?? base.properties[bare]?.displayName ?? base.properties[`note.${bare}`]?.displayName ?? id;
}
