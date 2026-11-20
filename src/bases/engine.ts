import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Script, createContext } from 'node:vm';
import {
  compileExpression,
  compileFilter,
  createFileContext,
  createLinkResolutionMap,
  dateValue,
  durationToMilliseconds,
  Evaluator,
  errorValue,
  frontmatterLink,
  fromJs,
  objectValue,
  nullValue,
  boolValue,
  parseDuration,
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
import { invalidRequest } from '../errors.js';
import { propertyWikilink } from '../markdown.js';
import type { Entry, VaultIndex } from '../vault-index.js';

/**
 * `<`, `>`, `<=` and `>=` as Obsidian evaluates them; the library coerces Null to 0, so
 * `Completed < date("2026-01-01")` would match notes with no `Completed`. In Obsidian a Null side
 * makes the result Null (falsy, and `!` of it true). Otherwise: a Date or Duration left side reads
 * a string right side as one of its kind, both sides become milliseconds, numbers or strings, and
 * are compared with plain JS `<` (so `"" < date(...)` is `"" < <ms>`, true, as in Obsidian).
 * `==` and `!=` between two primitives (String, Number, Boolean) are JS loose equality, as in
 * Obsidian's `looseEquals` (`Score == "3"`, `true == 1`, `"" == 0`); every other pair, null
 * included, is left to the library, which agrees with Obsidian there.
 * The library's compiled filters and expressions all evaluate through `Evaluator`, so overriding it
 * here covers filters, formulas, sorts and columns.
 */
type Value = RuntimeValue;
type Scope = Record<string, Value>;
interface EvaluatorInternals {
  eval(expr: unknown, scope?: Scope): Value;
  evalBinary(op: string, left: unknown, right: unknown, scope: Scope): Value;
  callMethod(receiver: Value, name: string, argExprs: unknown[], scope: Scope): Value;
  equals(left: Value, right: Value): boolean;
}
const ORDERING = new Set(['<', '>', '<=', '>=']);
const PRIMITIVE = new Set(['String', 'Number', 'Boolean']);
const proto = Evaluator.prototype as unknown as EvaluatorInternals;
const libraryEvalBinary = proto.evalBinary;
proto.evalBinary = function (op, leftExpr, rightExpr, scope) {
  const equality = op === '==' || op === '!=';
  if (!equality && !ORDERING.has(op)) return libraryEvalBinary.call(this, op, leftExpr, rightExpr, scope);
  const left = this.eval(leftExpr, scope);
  let right = this.eval(rightExpr, scope);
  if (left.type === 'Error') return left;
  if (right.type === 'Error') return right;
  if (equality) {
    const eq =
      PRIMITIVE.has(left.type) && PRIMITIVE.has(right.type)
        ? // eslint-disable-next-line eqeqeq
          (left.value as unknown) == (right.value as unknown)
        : this.equals(left, right);
    return boolValue(op === '==' ? eq : !eq);
  }
  if (left.type === 'Null' || right.type === 'Null') return nullValue();
  let a: number | string;
  if (left.type === 'Date') {
    a = left.value.getTime();
    if (right.type === 'String') {
      const d = dateValue(right.value) as Extract<Value, { type: 'Date' }>;
      if (!Number.isNaN(d.value.getTime())) right = d;
    }
  } else if (left.type === 'Duration') {
    a = durationToMilliseconds(left.value);
    if (right.type === 'String') {
      const d = parseDuration(right.value);
      if (d) right = { type: 'Duration', value: d };
    }
  } else a = left.type === 'Number' ? left.value : stringifyValue(left);
  const b =
    right.type === 'Date'
      ? right.value.getTime()
      : right.type === 'Duration'
        ? durationToMilliseconds(right.value)
        : right.type === 'Number'
          ? right.value
          : stringifyValue(right);
  return boolValue(op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b);
};

/**
 * Expressions come from requests and from .base files accounts write, and they run on the one event
 * loop every account shares. Two limits keep one query from holding it:
 *
 * - `withBudget` gives the evaluation of one query a fixed time. The watchdog of `vm` interrupts
 *   the running JavaScript, including a regex that backtracks, which nothing inside the thread can.
 * - A method call may not return a string or list far larger than anything a note holds, so
 *   `"a".repeat(1e9)` and its like fail as a value error instead of allocating.
 */
export const EVALUATION_BUDGET_MS = 1000;
const MAX_VALUE_SIZE = 100_000;

const budgetContext = createContext({});
const budgetScript = new Script('run()');

export function withBudget<T>(fn: () => T): T {
  const sandbox = budgetContext as { run?: () => T };
  sandbox.run = fn;
  try {
    return budgetScript.runInContext(budgetContext, { timeout: EVALUATION_BUDGET_MS }) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw invalidRequest(`The query is too expensive: its filters and formulas ran for more than ${EVALUATION_BUDGET_MS} ms. Simplify them or narrow the folders`);
    }
    throw e;
  } finally {
    delete sandbox.run;
  }
}

const libraryCallMethod = proto.callMethod;
proto.callMethod = function (receiver, name, argExprs, scope) {
  const out = libraryCallMethod.call(this, receiver, name, argExprs, scope);
  if ((out.type === 'String' || out.type === 'List') && out.value.length > MAX_VALUE_SIZE) {
    return errorValue(`The result of ${name}() is too large (more than ${MAX_VALUE_SIZE} ${out.type === 'String' ? 'characters' : 'items'})`);
  }
  return out;
};

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

/** The expression strings in a filter (a string, or nested and/or/not lists of them). */
function filterLeaves(f: unknown): string[] {
  if (typeof f === 'string') return [f];
  if (Array.isArray(f)) return f.flatMap(filterLeaves);
  if (f && typeof f === 'object') return Object.values(f).flatMap(filterLeaves);
  return [];
}

const GLOBALS = new Set(['file', 'note', 'formula', 'this', 'true', 'false', 'null']);

/** Note properties an expression reads: bare names, `note.x` and `note["x"]`. */
function noteProperties(source: string): string[] {
  type Node = { type?: string; name?: string; callee?: Node; args?: Node[]; object?: Node; property?: Node | string; computed?: boolean; value?: unknown };
  const out: string[] = [];
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (!n || typeof n !== 'object') return;
    const node = n as Node;
    switch (node.type) {
      case 'Identifier':
        if (node.name && !GLOBALS.has(node.name)) out.push(node.name);
        return;
      case 'Call':
        if (node.callee?.type !== 'Identifier') visit(node.callee); // a global function's name is no property
        return visit(node.args);
      case 'Member': {
        const p = node.property;
        if (node.object?.type === 'Identifier' && node.object.name === 'note') {
          const name = typeof p === 'string' ? p : typeof p?.value === 'string' ? p.value : null;
          if (name !== null) out.push(name);
          return;
        }
        visit(node.object);
        if (node.computed) visit(p);
        return;
      }
      default:
        for (const [k, v] of Object.entries(node)) if (k !== 'span') visit(v);
    }
  };
  visit(compileExpression(source).ast);
  return out;
}

/**
 * Filters that read a note property none of the queried notes has: almost always a typo or the
 * wrong case (names are case-sensitive, as in Obsidian). Each gets a diagnostic, naming the
 * property with the same name in another case when there is one.
 */
function unknownProperties(filters: { where: string; properties: string[] }[], universe: Entry[]): Diagnostic[] {
  if (filters.every((f) => f.properties.length === 0)) return [];
  const keys = new Set(universe.flatMap((e) => Object.keys(e.meta?.frontmatter ?? {})));
  const lower = new Map([...keys].map((k) => [k.toLowerCase(), k]));
  const out: Diagnostic[] = [];
  for (const f of filters) {
    for (const p of f.properties) {
      if (keys.has(p)) continue;
      const alt = lower.get(p.toLowerCase());
      out.push({ where: f.where, message: `Unknown property "${p}": no queried note has it${alt ? `. Did you mean "${alt}"? Names are case-sensitive` : ''}` });
    }
  }
  return out;
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

/**
 * Frontmatter as the library may read it. The library takes any object with `type` and `value` keys
 * for one of its own runtime values, so `status: {type: Error, value: {message: …}}` in a note would
 * be an error with that message, and `{type: Date, value: x}` a broken date. Such an object is
 * handed over as an explicit Object value instead: frontmatter is only ever data.
 */
function asData(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(asData);
  if (v === null || typeof v !== 'object' || v instanceof Date) return v;
  const entries = Object.entries(v).map(([k, x]) => [k, asData(x)] as const);
  if (!('type' in v && 'value' in v)) return Object.fromEntries(entries);
  return objectValue(Object.fromEntries(entries.map(([k, x]) => [k, fromJs(x)])));
}

/**
 * One `EngineState` per Account object, rebuilt when its key changes. The state holds what that
 * account can see, so it is tied to the object the access rules came from: a config reload makes
 * new Account objects, and a request that was authenticated before the reload can't leave its
 * state behind for requests after it.
 */
export class EngineCache {
  private readonly states = new WeakMap<object, { key: string; state: EngineState }>();

  get(account: object, key: string): EngineState {
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

  /**
   * Property types for one note. A date type is dropped where the value is empty (null, `""` or
   * missing): the library would turn it into a date (`new Date(null)` is the epoch), where
   * Obsidian treats it as empty.
   */
  private rowTypes(fm: Record<string, unknown>): Record<string, PropertyValueType> {
    const types = { ...this.scope.propertyTypes };
    for (const [k, t] of Object.entries(types)) {
      if (t === 'date' && (fm[k] === null || fm[k] === undefined || fm[k] === '')) delete types[k];
    }
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
    const note = this.withLinks(normalizeFrontmatterProperties(asData(fm) as Record<string, unknown>, { propertyTypes: this.rowTypes(fm) }), e.path);
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

  /**
   * Property values that are whole wikilinks (`"[[X]]"`, also in lists) become links, as in
   * Obsidian, so `note.base == link("X")` and `.contains(link("X"))` compare them as links.
   * Resolved like body links, among visible files only.
   */
  private withLinks(note: Record<string, unknown>, from: string): Record<string, unknown> {
    const toLink = (v: unknown) => {
      const l = propertyWikilink(v);
      if (!l) return v;
      // Unresolved → let the library resolve it the same way it resolves `link()`.
      const resolved = this.scope.index.resolveLink({ target: l.target, kind: 'wiki' }, from, this.scope.visible)?.path;
      return frontmatterLink(l.target, l.display, resolved);
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(note)) out[k] = Array.isArray(v) ? v.map(toLink) : toLink(v);
    return out;
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

  /**
   * Compiles a view's expressions; parse errors become diagnostics, and so does a filter that is a
   * quoted string (it would match every row: a JSON-encoded filter, quoted once too often).
   */
  static compile(spec: ViewSpec) {
    const diagnostics: Diagnostic[] = [];
    const filters: { where: string; compiled: CompiledFilter; literal: boolean; properties: string[] }[] = spec.filters.map(({ where, filter }) => {
      const compiled = compileFilter(filter);
      for (const d of compiled.diagnostics) if (d.severity === 'error') diagnostics.push({ where, message: d.message });
      const leaves = filterLeaves(filter);
      const literal = leaves.some((l) => {
        const ast = compileExpression(l).ast as { type?: string; value?: unknown } | null;
        return ast?.type === 'Literal' && typeof ast.value === 'string';
      });
      if (literal) diagnostics.push({ where, message: 'This filter is a quoted string, so it would match every row. Remove the outer quotes' });
      return { where, compiled, literal, properties: [...new Set(leaves.flatMap(noteProperties))] };
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

    const invalid = compiled.filters.some((f) => !f.compiled.valid || f.literal);
    diagnostics.push(...unknownProperties(compiled.filters, universe));
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
