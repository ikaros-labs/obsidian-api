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
import { ApiError, invalidRequest } from '../errors.js';
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
  callString(value: string, name: string, args: Value[]): Value;
  callList(values: Value[], name: string, argExprs: unknown[], scope: Scope): Value;
  asNumber(value: Value): number;
  noteProperty(name: string): Value;
  context: { note?: Record<string, unknown> };
  add(left: Value, right: Value): Value;
  callGlobal(name: string, args: Value[]): Value;
  callDate(value: Date, name: string, args: Value[]): Value;
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
 * loop every account shares. These limits keep one query from holding it or filling the heap:
 *
 * - `Budget` gives a query one fixed amount of time for all of its synchronous work: parsing the
 *   base and the property types, compiling, enumerating, filtering, sorting, paging and shaping
 *   the response. The watchdog of `vm` interrupts the running JavaScript, including a regex that
 *   backtracks, which nothing inside the thread can.
 * - No value an expression reads or builds may render to more than `MAX_VALUE_SIZE` characters
 *   (`sizeOf`: the length of what `stringifyValue` or the JSON response would hold, nested values,
 *   link targets and display texts included). Every operand is therefore small, and converting one
 *   to a string builds a small string.
 * - The operations whose result can be far larger than their operands (`repeat`, `replace`, `join`,
 *   `+`, `escapeHTML`, `format`) work out the size of what they would build first, refuse it if it
 *   is too large, and charge it to the expression's allowance before anything is allocated.
 * - One expression, for one row, may build `MAX_EXPRESSION_ALLOCATION` in total, which stops a
 *   `map` from making many values that are each within the limit.
 * - `retainedMeter` bounds what a query keeps for all its rows (sort and group keys, a page's cells).
 */
export const EVALUATION_BUDGET_MS = 1000;
const MAX_VALUE_SIZE = 100_000;
const MAX_EXPRESSION_ALLOCATION = 10_000_000;
const MAX_RETAINED_SIZE = 20_000_000;
/** A moment format pattern longer than this is no date format; tokens expand to several characters. */
const MAX_FORMAT_PATTERN = 1000;

const budgetContext = createContext({});
const budgetScript = new Script('run()');

const tooExpensive = () =>
  invalidRequest(`The query is too expensive: its filters and formulas ran for more than ${EVALUATION_BUDGET_MS} ms. Simplify them or narrow the folders`);

/**
 * The time one query may keep the event loop. Every synchronous piece of its work runs through `run`
 * (awaited file reads in between don't hold the loop and don't count).
 */
export class Budget {
  private spent = 0;

  run<T>(fn: () => T): T {
    const left = Math.floor(EVALUATION_BUDGET_MS - this.spent);
    if (left < 1) throw tooExpensive();
    const sandbox = budgetContext as { run?: () => T };
    sandbox.run = fn;
    const started = performance.now();
    // An interrupted evaluation unwinds without running `finally` blocks: start from a clean meter.
    evalDepth = 0;
    try {
      return budgetScript.runInContext(budgetContext, { timeout: left }) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw tooExpensive();
      throw e;
    } finally {
      evalDepth = 0;
      this.spent += performance.now() - started;
      delete sandbox.run;
    }
  }
}

const sizes = new WeakMap<object, number>();

/**
 * How many characters a value renders to, as text (`stringifyValue`) or in the JSON response,
 * whichever is longer, give or take punctuation. Counting stops soon after `MAX_VALUE_SIZE`, so the
 * cost is bounded however large (or shared) the value is.
 */
function sizeOf(v: Value): number {
  switch (v.type) {
    case 'String':
    case 'HTML':
    case 'Icon':
      return v.value.length;
    case 'Null':
    case 'Boolean':
      return 5;
    case 'Number':
      return String(v.value).length;
    case 'Date':
      return 24;
    case 'Duration':
      return 32;
    case 'File':
      return v.value.path.length;
    case 'Link':
      return v.value.path.length + 5 + (v.value.display ? sizeOf(v.value.display) : 0);
    case 'RegExp':
      return v.value.source.length + v.value.flags.length + 2;
    case 'Image':
      return 5 + (typeof v.value === 'string' ? v.value.length : v.value.path.length);
    case 'Error':
      return v.value.message.length + 12;
    case 'List':
    case 'Object':
      break;
    default:
      return 1;
  }
  const known = sizes.get(v.value);
  if (known !== undefined) return known;
  let n = 2;
  if (v.type === 'List') {
    for (const item of v.value) {
      n += sizeOf(item) + 1;
      if (n > MAX_VALUE_SIZE) break;
    }
  } else {
    for (const key in v.value) {
      if (!Object.hasOwn(v.value, key)) continue;
      n += key.length + 4 + sizeOf(v.value[key]!);
      if (n > MAX_VALUE_SIZE) break;
    }
  }
  sizes.set(v.value, n);
  return n;
}

const tooLarge = (what: string) => errorValue(`The result of ${what} is too large (more than ${MAX_VALUE_SIZE} characters or items)`);

/** Sums what a query keeps; throws once it is more than a response could reasonably carry. */
export function retainedMeter(): (v: RuntimeValue | undefined) => void {
  let kept = 0;
  return (v) => {
    if (v === undefined) return;
    kept += sizeOf(v) + 1;
    if (kept > MAX_RETAINED_SIZE) throw invalidRequest('The query builds too much data: its sort, group or column values are too large for this many rows. Simplify them or narrow the folders');
  };
}

/** Node types that build a new value; identifiers and member reads hand out what is already there. */
const BUILDS = new Set(['Call', 'Binary', 'Array', 'Object']);
let evalDepth = 0;
let allocated = 0;
const overAllocated = () => errorValue('This expression builds too much data');
/** Charges `size` to the running expression before it is built. False when that is over its allowance. */
const reserve = (size: number): boolean => (allocated += size) <= MAX_EXPRESSION_ALLOCATION;

function notePropertyRead(expr: unknown): string | null {
  const e = expr as { type?: string; computed?: boolean; object?: { type?: string; name?: string }; property?: { type?: string; value?: unknown } } | undefined;
  if (e?.type !== 'Member' || !e.computed || e.object?.type !== 'Identifier' || e.object.name !== 'note') return null;
  return e.property?.type === 'Literal' && typeof e.property.value === 'string' ? e.property.value : null;
}

const libraryEval = proto.eval;
proto.eval = function (expr, scope) {
  if (evalDepth === 0) allocated = 0;
  else if (allocated > MAX_EXPRESSION_ALLOCATION) return overAllocated();
  evalDepth++;
  let out: Value;
  try {
    // `note["x"]` (how a column reads a property) is that one property: the library would build
    // the whole frontmatter as an object first, and a note with a lot of it would be over the limit.
    const property = notePropertyRead(expr);
    out = property === null ? libraryEval.call(this, expr, scope) : Object.hasOwn(this.context.note ?? {}, property) ? this.noteProperty(property) : nullValue();
  } finally {
    evalDepth--;
  }
  // Read or built: nothing larger than the limit goes on to be an operand.
  const size = sizeOf(out);
  const node = expr as { type?: string; callee?: { property?: unknown } } | undefined;
  if (size > MAX_VALUE_SIZE) return tooLarge(node?.type === 'Call' && typeof node.callee?.property === 'string' ? `${node.callee.property}()` : 'this expression');
  if (!node || !BUILDS.has(node.type!)) return out;
  return reserve(size + 1) ? out : overAllocated();
};

const libraryAdd = proto.add;
proto.add = function (left, right) {
  if (left.type === 'String' || right.type === 'String') {
    const built = sizeOf(left) + sizeOf(right);
    if (built > MAX_VALUE_SIZE) return tooLarge('+');
    if (!reserve(built)) return overAllocated();
  }
  return libraryAdd.call(this, left, right);
};

/** How long `value.replace(pattern, replacement)` would be at most, found without building it. */
function replacedSize(value: string, pattern: Value, replacement: string): number {
  let matches = 0;
  let matched = 0;
  if (pattern.type !== 'RegExp') {
    // The library replaces a text pattern with split and join: every occurrence, `$` not special.
    const needle = stringifyValue(pattern);
    if (needle === '') matches = Math.max(0, value.length - 1);
    else for (let i = value.indexOf(needle); i !== -1; i = value.indexOf(needle, i + needle.length)) matches++, (matched += needle.length);
    return value.length - matched + matches * replacement.length;
  }
  const re = new RegExp(pattern.value.source, `${pattern.value.flags.replace(/[gy]/g, '')}g`);
  for (let m = re.exec(value); m; m = re.exec(value)) {
    matches++;
    matched += m[0].length;
    if (m[0] === '') re.lastIndex++;
    if (!pattern.value.global) break;
  }
  // `$&` and `$1` stand for matched text; "$`" and "$'" for up to the whole string, at every match.
  const refs = replacement.split('$').length - 1;
  const referenced = /\$[`']/.test(replacement) ? matches * value.length : matched;
  return value.length - matched + matches * replacement.length + refs * referenced;
}

const libraryCallString = proto.callString;
proto.callString = function (value, name, args) {
  let built = 0;
  if (name === 'repeat') built = value.length * this.asNumber(args[0] ?? fromJs(0)) || 0;
  else if (name === 'replace') built = replacedSize(value, args[0] ?? nullValue(), stringifyValue(args[1] ?? fromJs('')));
  if (built > MAX_VALUE_SIZE) return tooLarge(`${name}()`);
  if (!reserve(built)) return overAllocated();
  return libraryCallString.call(this, value, name, args);
};

const libraryCallList = proto.callList;
proto.callList = function (values, name, argExprs, scope) {
  if (name !== 'join') return libraryCallList.call(this, values, name, argExprs, scope);
  // Done here in full, so the separator is evaluated once, whether or not one was given.
  const separator = stringifyValue(this.eval(argExprs[0], scope));
  let built = separator.length * Math.max(0, values.length - 1);
  for (const item of values) {
    if (built > MAX_VALUE_SIZE) break;
    built += sizeOf(item);
  }
  if (built > MAX_VALUE_SIZE) return tooLarge('join()');
  if (!reserve(built)) return overAllocated();
  return fromJs(values.map(stringifyValue).join(separator));
};

const libraryCallGlobal = proto.callGlobal;
proto.callGlobal = function (name, args) {
  // `&` becomes `&amp;`, `"` becomes `&quot;`: up to six characters for one.
  if (name === 'escapeHTML' && args[0]) {
    const built = sizeOf(args[0]) * 6;
    if (built > MAX_VALUE_SIZE) return tooLarge('escapeHTML()');
    if (!reserve(built)) return overAllocated();
  }
  return libraryCallGlobal.call(this, name, args);
};

const libraryCallDate = proto.callDate;
proto.callDate = function (value, name, args) {
  if (name === 'format' && args[0] && sizeOf(args[0]) > MAX_FORMAT_PATTERN) return tooLarge('format()');
  return libraryCallDate.call(this, value, name, args);
};

/** One filter of a view, compiled, with what is wrong with it. */
export interface CompiledViewFilter {
  compiled: CompiledFilter;
  /** A quoted string: it would match every row. */
  literal: boolean;
  properties: string[];
  problems: string[];
}

/** Parse errors become `problems`, and so does a filter that is a quoted string (a JSON-encoded filter, quoted once too often). */
export function compileViewFilter(filter: FilterExpression): CompiledViewFilter {
  const compiled = compileFilter(filter);
  const problems = compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message);
  const leaves = filterLeaves(filter);
  const literal = leaves.some((l) => {
    const ast = compileExpression(l).ast as { type?: string; value?: unknown } | null;
    return ast?.type === 'Literal' && typeof ast.value === 'string';
  });
  if (literal) problems.push('This filter is a quoted string, so it would match every row. Remove the outer quotes');
  return { compiled, literal, properties: [...new Set(leaves.flatMap(noteProperties))], problems };
}

export interface SortSpec {
  property: string;
  direction: 'ASC' | 'DESC';
}

/** Everything needed to run a view: the merged filters plus how to order, group and show rows. */
export interface ViewSpec {
  /**
   * Labelled filters, all ANDed. A label is where the filter came from, for diagnostics. `compiled`
   * is set when the filter was compiled already (a request filter is checked before anything else).
   */
  filters: { where: string; filter: FilterExpression; compiled?: CompiledViewFilter }[];
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

  /** `run` wraps the parsing, so a query can charge it to its budget. */
  async load(run: <T>(fn: () => T) => T = (fn) => fn()): Promise<Record<string, PropertyValueType>> {
    const file = path.join(this.vaultPath, '.obsidian', 'types.json');
    let fromFile: Record<string, PropertyValueType> = {};
    try {
      const st = await stat(file);
      if (this.cache?.mtimeMs !== st.mtimeMs) {
        const text = await readFile(file, 'utf8');
        const types = run(() => {
          const json = JSON.parse(text) as { types?: Record<string, string> };
          const out: Record<string, PropertyValueType> = {};
          for (const [k, v] of Object.entries(json.types ?? {})) {
            const mapped = TYPE_MAP[v as ObsidianType];
            if (mapped) out[k] = mapped;
          }
          return out;
        });
        this.cache = { mtimeMs: st.mtimeMs, types };
      }
      fromFile = this.cache.types;
    } catch (e) {
      // A file that is missing or not JSON means no types; a query that ran out of time still fails.
      if (e instanceof ApiError) throw e;
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
    // Each property is converted on its own: the frontmatter itself stays the map of properties,
    // also when two of its keys happen to be `type` and `value`.
    const properties = Object.fromEntries(Object.entries(fm).map(([k, v]) => [k, asData(v)]));
    const note = this.withLinks(normalizeFrontmatterProperties(properties, { propertyTypes: this.rowTypes(fm) }), e.path);
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
    const filters = spec.filters.map(({ where, filter, compiled }) => {
      const f = compiled ?? compileViewFilter(filter);
      for (const message of f.problems) diagnostics.push({ where, message });
      return { where, ...f };
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
    const keep = retainedMeter();
    for (const row of rows) {
      const keys = compiled.sort.map((s) => s.compiled.evaluateValue(row.ctx));
      keys.forEach(keep);
      sortValues.set(row, keys);
      if (compiled.groupBy) keep((row.group = compiled.groupBy.compiled.evaluateValue(row.ctx)));
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
