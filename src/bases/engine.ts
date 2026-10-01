import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  compileExpression,
  compileFilter,
  createFileContext,
  createLinkResolutionMap,
  normalizeFrontmatterProperties,
  stringifyValue,
  toPlain,
  type CompiledExpression,
  type CompiledFilter,
  type EvaluationContext,
  type FileValueInput,
  type FilterExpression,
  type PropertyValueType,
  type RuntimeValue,
} from 'obsidian-bases-expression';
import type { ObsidianType } from '../config.js';
import type { Entry, VaultIndex } from '../vault-index.js';

export interface SortSpec {
  property: string;
  direction: 'ASC' | 'DESC';
}

/** Everything needed to run a view: the merged filters plus how to order, group and show rows. */
export interface ViewSpec {
  /** Labelled filters, all ANDed. A label is where the filter came from, for diagnostics. */
  filters: { where: string; filter: FilterExpression }[];
  formulas: Record<string, string>;
  sort: SortSpec[];
  groupBy?: SortSpec;
  columns: string[];
  /** The view's own cap on the number of rows. */
  limit?: number;
}

export interface Diagnostic {
  where: string;
  message: string;
  /** Rows on which the expression failed at runtime (absent for parse errors). */
  rows?: number;
}

export interface Row {
  entry: Entry;
  ctx: EvaluationContext;
  group?: RuntimeValue;
}

export interface ViewResult {
  rows: Row[];
  groups?: { key: unknown; count: number }[];
  diagnostics: Diagnostic[];
}

const TYPE_MAP: Record<ObsidianType, PropertyValueType> = {
  text: 'string',
  multitext: 'list',
  number: 'number',
  checkbox: 'boolean',
  date: 'date',
  datetime: 'date',
  aliases: 'list',
  tags: 'list',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Property types from `.obsidian/types.json` (re-read when it changes), with config overrides on
 * top. The file is read by the server only; dot-folders are never served.
 */
export class PropertyTypes {
  private cache: { mtimeMs: number; types: Record<string, PropertyValueType> } | null = null;

  constructor(
    private readonly vaultPath: string,
    private readonly overrides: () => Record<string, ObsidianType>,
  ) {}

  async load(): Promise<Record<string, PropertyValueType>> {
    const file = path.join(this.vaultPath, '.obsidian', 'types.json');
    let fromFile: Record<string, PropertyValueType> = {};
    try {
      const st = await stat(file);
      if (this.cache?.mtimeMs !== st.mtimeMs) {
        const json = JSON.parse(await readFile(file, 'utf8')) as { types?: Record<string, string> };
        const types: Record<string, PropertyValueType> = {};
        for (const [k, v] of Object.entries(json.types ?? {})) {
          const mapped = TYPE_MAP[v as ObsidianType];
          if (mapped) types[k] = mapped;
        }
        this.cache = { mtimeMs: st.mtimeMs, types };
      }
      fromFile = this.cache.types;
    } catch {
      this.cache = null;
    }
    const merged = { ...fromFile };
    for (const [k, v] of Object.entries(this.overrides())) merged[k] = TYPE_MAP[v];
    return merged;
  }
}

/** Property id as used in `order`, `sort` and `groupBy` → an expression that reads it. */
function propertyExpression(id: string, formulas: Record<string, string>): string {
  if (id.startsWith('file.')) return id;
  if (id.startsWith('formula.')) return formulas[id.slice('formula.'.length)] ?? 'null';
  const name = id.startsWith('note.') ? id.slice('note.'.length) : id;
  return `note[${JSON.stringify(name)}]`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const isEmptyValue = (v: RuntimeValue | undefined) =>
  !v || v.type === 'Null' || v.type === 'Error' || (v.type === 'String' && v.value === '') || (v.type === 'List' && v.value.length === 0);

function compareValues(a: RuntimeValue, b: RuntimeValue): number {
  if (a.type === 'Number' && b.type === 'Number') return a.value - b.value;
  if (a.type === 'Date' && b.type === 'Date') return a.value.getTime() - b.value.getTime();
  if (a.type === 'Boolean' && b.type === 'Boolean') return Number(a.value) - Number(b.value);
  return collator.compare(stringifyValue(a), stringifyValue(b));
}

/** Sorts ascending or descending, with empty values always last. */
function compareDirected(a: RuntimeValue | undefined, b: RuntimeValue | undefined, dir: 'ASC' | 'DESC'): number {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return Number(ea) - Number(eb);
  const d = compareValues(a!, b!);
  return dir === 'DESC' ? -d : d;
}

/**
 * Runtime value → plain JSON for responses. Dates become `YYYY-MM-DD` or a UTC ISO timestamp,
 * links are written as `[[target|display]]`, files as their path.
 */
export function plainValue(v: RuntimeValue, toApiPath: (vaultPath: string) => string): unknown {
  switch (v.type) {
    case 'Null':
    case 'Error':
      return null;
    case 'Date':
      if (Number.isNaN(v.value.getTime())) return null;
      return v.dateOnly
        ? `${v.value.getFullYear()}-${String(v.value.getMonth() + 1).padStart(2, '0')}-${String(v.value.getDate()).padStart(2, '0')}`
        : v.value.toISOString();
    case 'List':
      return v.value.map((x) => plainValue(x, toApiPath));
    case 'Object':
      return Object.fromEntries(Object.entries(v.value).map(([k, x]) => [k, plainValue(x, toApiPath)]));
    case 'File':
      return toApiPath(v.value.path);
    case 'Link':
      return v.value.external ? v.value.path : stringifyValue(v);
    case 'Boolean':
    case 'Number':
    case 'String':
      return v.value;
    default:
      return toPlain(v);
  }
}

/**
 * Per-file evaluation inputs and vault-wide lookup tables. Building them is most of a query's cost,
 * so they are kept between queries as long as the index, the property types and the account's
 * access stay the same (see `EngineCache`).
 */
export class EngineState {
  /** Keyed by `withBacklinks:path`, since backlinks are computed only when an expression needs them. */
  readonly fileCache = new Map<string, FileValueInput>();
  /** Slot 0 is reserved for the row being evaluated; see `BasesEngine.context()`. */
  sharedFiles: FileValueInput[] | null = null;
  sharedResolutions: Record<string, string | null> | null = null;
  backlinks: Map<string, { path: string }[]> | null = null;
}

/** One `EngineState` per account, rebuilt when its key changes. */
export class EngineCache {
  private readonly states = new Map<string, { key: string; state: EngineState }>();

  get(account: string, key: string): EngineState {
    const hit = this.states.get(account);
    if (hit?.key === key) return hit.state;
    const state = new EngineState();
    this.states.set(account, { key, state });
    return state;
  }
}

export interface EngineScope {
  index: VaultIndex;
  /** Entries the account can read. */
  visible: (e: Entry) => boolean;
  propertyTypes: Record<string, PropertyValueType>;
  now?: Date;
}

/**
 * Evaluates views over a set of index entries. Lookups that reach other files (`file()`,
 * `link.asFile()`, backlinks, link resolution) only ever see entries in `scope.visible`.
 */
export class BasesEngine {
  private readonly now: Date;

  constructor(
    private readonly scope: EngineScope,
    private readonly state: EngineState = new EngineState(),
  ) {
    this.now = scope.now ?? new Date();
  }

  private rowTypes(fm: Record<string, unknown>): Record<string, PropertyValueType> {
    const types = { ...this.scope.propertyTypes };
    for (const [k, v] of Object.entries(fm)) {
      if (!(k in types) && typeof v === 'string' && ISO_DATE.test(v)) types[k] = 'date';
    }
    return types;
  }

  private fileInput(e: Entry, withBacklinks: boolean): FileValueInput {
    const cacheKey = `${withBacklinks ? 1 : 0}:${e.path}`;
    const cached = this.state.fileCache.get(cacheKey);
    if (cached) return cached;
    const fm = e.meta?.frontmatter ?? {};
    const note = normalizeFrontmatterProperties(fm, { propertyTypes: this.rowTypes(fm) });
    const links = (e.meta?.links ?? []).map((l) => ({
      path: l.target,
      resolvedPath: this.scope.index.resolveLink(l, e.path, this.scope.visible)?.path ?? null,
    }));
    const input = createFileContext({
      path: e.path,
      size: e.size,
      ctime: new Date(e.created),
      mtime: new Date(e.modified),
      tags: e.meta?.tags ?? [],
      links,
      properties: note,
      ...(withBacklinks ? { backlinks: this.backlinksOf(e.path) } : {}),
    });
    this.state.fileCache.set(cacheKey, input);
    return input;
  }

  private backlinksOf(p: string): { path: string }[] {
    if (!this.state.backlinks) {
      const backlinks = new Map<string, { path: string }[]>();
      for (const e of this.scope.index.notes()) {
        if (!this.scope.visible(e)) continue;
        for (const l of e.meta?.links ?? []) {
          const target = this.scope.index.resolveLink(l, e.path, this.scope.visible);
          if (!target) continue;
          if (!backlinks.has(target.path)) backlinks.set(target.path, []);
          backlinks.get(target.path)!.push({ path: e.path });
        }
      }
      this.state.backlinks = backlinks;
    }
    return this.state.backlinks.get(p) ?? [];
  }

  /**
   * Every file the account can read, not just the rows, for `file()` and link lookups. Built once
   * per engine, on first use.
   */
  private shared() {
    const st = this.state;
    if (!st.sharedFiles) {
      const files = this.scope.index.files().filter(this.scope.visible).map((e) => this.fileInput(e, false));
      st.sharedResolutions = createLinkResolutionMap(files);
      st.sharedFiles = [...files.slice(0, 1), ...files];
    }
    return { files: st.sharedFiles, linkResolutions: st.sharedResolutions! };
  }

  context(e: Entry, spec: ViewSpec, extra: { thisFile?: Entry; backlinks: boolean }): EvaluationContext {
    const file = this.fileInput(e, extra.backlinks);
    // Lazy: the vault-wide lookup tables are built only when an expression needs them.
    // The library looks up the current file in `files` with a linear `find` on every `file.*`
    // access; putting the row's own file in slot 0 makes that lookup O(1) instead of O(n).
    const shared = () => this.shared();
    return {
      note: file.properties ?? {},
      file,
      get files() {
        const { files } = shared();
        files[0] = file;
        return files;
      },
      get linkResolutions() {
        return shared().linkResolutions;
      },
      formulas: spec.formulas,
      propertyTypes: this.rowTypes(e.meta?.frontmatter ?? {}),
      now: this.now,
      ...(extra.thisFile ? { thisFile: this.fileInput(extra.thisFile, extra.backlinks) } : {}),
    };
  }

  /** Compiles a view's expressions; parse errors become diagnostics. */
  static compile(spec: ViewSpec) {
    const diagnostics: Diagnostic[] = [];
    const filters: { where: string; compiled: CompiledFilter }[] = spec.filters.map(({ where, filter }) => {
      const compiled = compileFilter(filter);
      for (const d of compiled.diagnostics) if (d.severity === 'error') diagnostics.push({ where, message: d.message });
      return { where, compiled };
    });
    const expr = (id: string) => compileExpression(propertyExpression(id, spec.formulas));
    for (const [name, source] of Object.entries(spec.formulas)) {
      for (const d of compileExpression(source).diagnostics) {
        if (d.severity === 'error') diagnostics.push({ where: `formulas.${name}`, message: d.message });
      }
    }
    const sort = spec.sort.map((s) => ({ ...s, compiled: expr(s.property) }));
    const groupBy = spec.groupBy ? { ...spec.groupBy, compiled: expr(spec.groupBy.property) } : undefined;
    const columns = spec.columns.map((id) => ({ id, compiled: expr(id) }));
    const exprs: CompiledExpression[] = [...sort, ...columns, ...(groupBy ? [groupBy] : [])].map((x) => x.compiled);
    const deps = [...filters.map((f) => f.compiled.dependencies), ...exprs.map((x) => x.dependencies)];
    const usesBacklinks = deps.some((d) => d.fileProperties.includes('backlinks'));
    return { filters, sort, groupBy, columns, diagnostics, usesBacklinks };
  }

  run(
    universe: Entry[],
    spec: ViewSpec,
    opts: { thisFile?: Entry; toApiPath: (vaultPath: string) => string },
  ): ViewResult & { compiled: ReturnType<typeof BasesEngine.compile> } {
    const compiled = BasesEngine.compile(spec);
    const diagnostics = [...compiled.diagnostics];
    const failures = new Map<string, { message: string; rows: number }>();
    const fail = (where: string, v: RuntimeValue) => {
      if (v.type !== 'Error') return;
      const f = failures.get(where) ?? { message: v.value.message, rows: 0 };
      f.rows++;
      failures.set(where, f);
    };

    const invalid = compiled.filters.some((f) => !f.compiled.valid);
    const rows: Row[] = [];
    if (!invalid) {
      for (const e of universe) {
        const ctx = this.context(e, spec, { thisFile: opts.thisFile, backlinks: compiled.usesBacklinks });
        let ok = true;
        for (const f of compiled.filters) {
          const r = f.compiled.evaluate(ctx);
          fail(f.where, r.value);
          if (!r.matches) {
            ok = false;
            break;
          }
        }
        if (ok) rows.push({ entry: e, ctx });
      }
    }

    const sortValues = new Map<Row, RuntimeValue[]>();
    for (const row of rows) {
      sortValues.set(row, compiled.sort.map((s) => s.compiled.evaluateValue(row.ctx)));
      if (compiled.groupBy) row.group = compiled.groupBy.compiled.evaluateValue(row.ctx);
    }
    rows.sort((a, b) => {
      if (compiled.groupBy) {
        const g = compareDirected(a.group, b.group, compiled.groupBy.direction);
        if (g !== 0) return g;
      }
      const va = sortValues.get(a)!;
      const vb = sortValues.get(b)!;
      for (let i = 0; i < compiled.sort.length; i++) {
        const d = compareDirected(va[i], vb[i], compiled.sort[i]!.direction);
        if (d !== 0) return d;
      }
      return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0;
    });
    const limited = spec.limit !== undefined ? rows.slice(0, spec.limit) : rows;

    // Rows are sorted by group first, so each group is one consecutive run.
    let groups: ViewResult['groups'];
    if (compiled.groupBy) {
      groups = [];
      let lastKey: string | undefined;
      for (const row of limited) {
        const empty = isEmptyValue(row.group);
        const key = empty ? '' : stringifyValue(row.group!);
        if (key !== lastKey) {
          groups.push({ key: empty ? null : plainValue(row.group!, opts.toApiPath), count: 0 });
          lastKey = key;
        }
        groups.at(-1)!.count++;
      }
    }

    for (const [where, f] of failures) diagnostics.push({ where, message: f.message, rows: f.rows });
    return { rows: limited, groups, diagnostics, compiled };
  }
}
