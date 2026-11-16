import { splitFrontmatter } from '../markdown.js';
import type { Entry, VaultIndex } from '../vault-index.js';
import { entryName } from '../vault-index.js';
import { containsPhrase, parseQuery, type Clause } from './query.js';
import { tokenize, words } from './tokenize.js';

/** Term weight per field: a word in the title counts as much as three in the body. */
const FIELD_WEIGHTS = { name: 3, tags: 2, frontmatter: 1, body: 1 } as const;
const K1 = 1.2;
const B = 0.75;

interface Doc {
  path: string;
  rev: string;
  /** Weighted term frequencies. */
  tf: Map<string, number>;
  /** Weighted length (sum of `tf`). */
  len: number;
  /** Terms in order, fields separated by '', for phrase matching. */
  seq: string[];
  /** Body without frontmatter, kept for snippets. */
  body: string;
}

/**
 * Who is asking. `key` identifies the access rules (the Account object: a config reload makes a new
 * one), `folder` narrows the notes (vault-relative prefix, '' = all), `visible` applies the rules.
 * Scoring statistics are cached per (key, folder, index version).
 */
export interface Scope {
  key: object;
  folder: string;
  visible: (e: Entry) => boolean;
}

/** Corpus statistics over the notes one scope can see. */
interface Stats {
  version: number;
  pool: { e: Entry; doc: Doc }[];
  paths: Set<string>;
  avgLen: number;
  /** Document frequencies, filled in lazily per term. */
  df: Map<string, number>;
}

const MAX_SCOPES_PER_KEY = 32;
/** Index terms one `prefix*` clause expands to. */
const MAX_PREFIX_TERMS = 50;
/** Terms a more-like-this query is built from. */
const MLT_TERMS = 25;
/** Fragments of URLs and other tokens that say nothing about a note's topic. */
const MLT_NOISE = new Set(['www', 'http', 'https', 'com', 'org', 'net', 'html', 'htm', 'php', 'utm', 'ref', 'png', 'jpg', 'jpeg', 'pdf']);
const goodMltTerm = (t: string) => t.length >= 3 && !/\d/.test(t) && !MLT_NOISE.has(t);

export interface Hit {
  entry: Entry;
  score: number;
  /** Query terms (stemmed) the note matched. */
  matched: string[];
  /** Built on demand: only the returned page needs snippets. */
  snippet(): string;
}

/** Flattens frontmatter values (not keys) into text: strings, numbers, and lists of them. */
function frontmatterText(fm: Record<string, unknown> | null | undefined): string {
  if (!fm) return '';
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
    else if (Array.isArray(v) && depth < 3) v.forEach((x) => visit(x, depth + 1));
    else if (v && typeof v === 'object' && depth < 3) Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  for (const [k, v] of Object.entries(fm)) if (k !== 'tags' && k !== 'tag') visit(v, 0);
  return out.join(' ');
}

/**
 * In-memory BM25 index over every note in the vault. It is synced lazily against the vault index
 * (re-reading only notes whose rev changed), so it follows API writes and watcher events. Scoring
 * statistics (N, document frequencies, average length) are computed over the notes the caller can
 * see, so hidden notes affect neither which notes match nor their scores. They are cached per
 * scope until the index changes.
 */
export class SearchIndex {
  private readonly docs = new Map<string, Doc>();
  private readonly postings = new Map<string, Set<string>>();
  private syncedVersion = -1;
  private syncing: Promise<void> | null = null;
  private readonly stats = new WeakMap<object, Map<string, Stats>>();
  private vocab: string[] | null = null;
  /** For tests and the metrics endpoint. */
  readonly cacheCounters = { hits: 0, misses: 0 };

  constructor(
    private readonly index: VaultIndex,
    private readonly read: (e: Entry) => Promise<Buffer>,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  /** Brings the index up to date with the vault index. Concurrent callers share one sync. */
  sync(): Promise<void> {
    if (this.syncedVersion === this.index.version) return Promise.resolve();
    this.syncing ??= this.doSync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    while (this.syncedVersion !== this.index.version) {
      const version = this.index.version;
      const live = new Set<string>();
      for (const e of this.index.notes()) {
        live.add(e.path);
        if (this.docs.get(e.path)?.rev === e.rev) continue;
        let text: string;
        try {
          text = (await this.read(e)).toString('utf8');
        } catch {
          continue; // Gone since it was indexed; the next sync drops it.
        }
        this.add(e, text);
      }
      for (const p of [...this.docs.keys()]) if (!live.has(p)) this.remove(p);
      this.syncedVersion = version;
    }
  }

  private add(e: Entry, text: string): void {
    this.remove(e.path);
    const body = splitFrontmatter(text).body;
    const tf = new Map<string, number>();
    const seq: string[] = [];
    const fields: [keyof typeof FIELD_WEIGHTS, string][] = [
      ['name', entryName(e)],
      ['tags', (e.meta?.tags ?? []).join(' ')],
      ['frontmatter', frontmatterText(e.meta?.frontmatter)],
      ['body', body],
    ];
    let len = 0;
    for (const [field, value] of fields) {
      const w = FIELD_WEIGHTS[field];
      if (seq.length > 0) seq.push('');
      for (const t of tokenize(value)) {
        tf.set(t, (tf.get(t) ?? 0) + w);
        len += w;
        seq.push(t);
      }
    }
    this.docs.set(e.path, { path: e.path, rev: e.rev ?? '', tf, len, seq, body });
    this.vocab = null;
    for (const t of tf.keys()) {
      let set = this.postings.get(t);
      if (!set) this.postings.set(t, (set = new Set()));
      set.add(e.path);
    }
  }

  private remove(p: string): void {
    const doc = this.docs.get(p);
    if (!doc) return;
    for (const t of doc.tf.keys()) {
      const set = this.postings.get(t);
      set?.delete(p);
      if (set?.size === 0) this.postings.delete(t);
    }
    this.docs.delete(p);
    this.vocab = null;
  }

  /** Statistics for a scope, from the cache when the index hasn't changed since. */
  private statsFor(scope: Scope): Stats {
    let byFolder = this.stats.get(scope.key);
    if (!byFolder) this.stats.set(scope.key, (byFolder = new Map()));
    const cached = byFolder.get(scope.folder);
    if (cached && cached.version === this.syncedVersion) {
      this.cacheCounters.hits++;
      return cached;
    }
    this.cacheCounters.misses++;
    const prefix = scope.folder === '' ? '' : `${scope.folder}/`;
    const pool: Stats['pool'] = [];
    let totalLen = 0;
    for (const doc of this.docs.values()) {
      if (!doc.path.startsWith(prefix)) continue;
      const e = this.index.get(doc.path);
      if (!e || !scope.visible(e)) continue;
      pool.push({ e, doc });
      totalLen += doc.len;
    }
    const stats: Stats = {
      version: this.syncedVersion,
      pool,
      paths: new Set(pool.map((x) => x.doc.path)),
      avgLen: pool.length ? totalLen / pool.length || 1 : 1,
      df: new Map(),
    };
    // Drop stale entries; cap the number of folders cached per account.
    for (const [k, v] of byFolder) if (v.version !== this.syncedVersion) byFolder.delete(k);
    if (byFolder.size >= MAX_SCOPES_PER_KEY) byFolder.delete(byFolder.keys().next().value!);
    byFolder.set(scope.folder, stats);
    return stats;
  }

  /** Document frequency of `term` among the scope's notes (cached in `stats`). */
  private df(stats: Stats, term: string): number {
    let df = stats.df.get(term);
    if (df === undefined) {
      df = 0;
      for (const p of this.postings.get(term) ?? []) if (stats.paths.has(p)) df++;
      stats.df.set(term, df);
    }
    return df;
  }

  private idf(stats: Stats, term: string): number {
    const df = this.df(stats, term);
    const n = stats.pool.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /** Every indexed term, sorted, for prefix lookups by binary search. Rebuilt after changes. */
  private sortedVocab(): string[] {
    this.vocab ??= [...this.postings.keys()].sort();
    return this.vocab;
  }

  private bm25(stats: Stats, doc: Doc, term: string, idf: number): number {
    const f = doc.tf.get(term);
    if (!f) return 0;
    return idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.len) / stats.avgLen)));
  }

  /**
   * Index terms a prefix clause stands for: terms starting with one of `prefixes` that occur in the
   * scope's own notes, at most 50, the most common (in scope) first. Only the scope's notes count,
   * so hidden notes can neither crowd out visible terms nor reveal which prefixes they contain.
   */
  private expand(prefixes: string[], stats: Stats): string[] {
    const vocab = this.sortedVocab();
    const found = new Set<string>();
    for (const p of prefixes) {
      let lo = 0;
      let hi = vocab.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (vocab[mid]! < p) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < vocab.length && vocab[i]!.startsWith(p); i++) found.add(vocab[i]!);
    }
    return [...found]
      .map((t) => ({ t, df: this.df(stats, t) }))
      .filter((x) => x.df > 0)
      .sort((a, b) => b.df - a.df || (a.t < b.t ? -1 : 1))
      .slice(0, MAX_PREFIX_TERMS)
      .map((x) => x.t);
  }

  /**
   * Ranks the notes in `scope` against `query` (see `parseQuery` for the syntax). A note must match
   * every positive clause (or, with `any`, at least one) and no negated one. Throws QueryError.
   */
  async search(query: string, scope: Scope, opts: { any?: boolean } = {}): Promise<Hit[]> {
    await this.sync();
    const clauses = parseQuery(query);
    const positive = clauses.filter((c) => !c.negate);
    const negative = clauses.filter((c) => c.negate);
    if (positive.length === 0) return [];
    const stats = this.statsFor(scope);
    if (stats.pool.length === 0) return [];

    const termsOf = new Map<Clause, string[]>(
      clauses.map((c) => [c, c.kind === 'term' ? [c.term] : c.kind === 'phrase' ? c.terms : this.expand(c.prefixes, stats)]),
    );
    const idf = new Map<string, number>();
    for (const c of positive) for (const t of termsOf.get(c)!) if (!idf.has(t)) idf.set(t, this.idf(stats, t));

    const matches = (doc: Doc, c: Clause): boolean => {
      const terms = termsOf.get(c)!;
      if (c.kind === 'phrase') return terms.every((t) => doc.tf.has(t)) && containsPhrase(doc.seq, terms);
      return terms.some((t) => doc.tf.has(t));
    };

    const hits: Hit[] = [];
    for (const { e, doc } of stats.pool) {
      if (negative.some((c) => matches(doc, c))) continue;
      let score = 0;
      let clausesHit = 0;
      const matched: string[] = [];
      for (const c of positive) {
        if (!matches(doc, c)) continue;
        clausesHit++;
        for (const t of termsOf.get(c)!) {
          const s = this.bm25(stats, doc, t, idf.get(t)!);
          if (s === 0) continue;
          score += s;
          if (!matched.includes(t)) matched.push(t);
        }
      }
      if (clausesHit === 0 || (!opts.any && clausesHit < positive.length)) continue;
      hits.push({ entry: e, score, matched, snippet: () => snippet(doc.body, new Set(matched)) });
    }
    return hits.sort((a, b) => b.score - a.score || (a.entry.path < b.entry.path ? -1 : 1));
  }

  /**
   * More like this: the notes in `scope` most similar to the note at `path`. The query is the
   * source note's `terms` most distinctive terms (weighted tf × idf over the scope, ignoring terms
   * no other visible note has), scored with BM25 and OR. Returns null when `path` isn't indexed.
   */
  async related(path: string, scope: Scope, opts: { terms?: number } = {}): Promise<{ terms: string[]; hits: Hit[] } | null> {
    await this.sync();
    const source = this.docs.get(path);
    if (!source) return null;
    const stats = this.statsFor(scope);
    const inScope = stats.paths.has(path) ? 1 : 0;
    const candidates: { t: string; w: number; idf: number }[] = [];
    for (const [t, f] of source.tf) {
      if (!goodMltTerm(t)) continue; // Numbers, dates, URL parts and 2-letter words are poor signals.
      const idf = this.idf(stats, t);
      if (stats.df.get(t)! - inScope < 1) continue; // Nobody else has it.
      candidates.push({ t, w: f * idf, idf });
    }
    candidates.sort((a, b) => b.w - a.w || (a.t < b.t ? -1 : 1));
    const top = candidates.slice(0, opts.terms ?? MLT_TERMS);
    const hits: Hit[] = [];
    for (const { e, doc } of stats.pool) {
      if (doc.path === path) continue;
      let score = 0;
      const matched: string[] = [];
      for (const { t, idf } of top) {
        const s = this.bm25(stats, doc, t, idf);
        if (s === 0) continue;
        score += s;
        matched.push(t);
      }
      if (matched.length === 0) continue;
      hits.push({ entry: e, score, matched, snippet: () => snippet(doc.body, new Set(matched)) });
    }
    hits.sort((a, b) => b.score - a.score || (a.entry.path < b.entry.path ? -1 : 1));
    return { terms: top.map((x) => x.t), hits };
  }
}

const SNIPPET_CHARS = 160;

/**
 * A window of `body` around the first line containing a matched term, on one line. Text lines
 * win over headings, which mostly repeat the title.
 */
export function snippet(body: string, terms: Set<string>): string {
  const lines = body.split('\n').filter((l) => words(l).length > 0);
  const isHeading = (l: string) => /^\s{0,3}#{1,6}\s/.test(l);
  const hits = lines.filter((l) => tokenize(l).some((t) => terms.has(t)));
  const pick = hits.find((l) => !isHeading(l)) ?? hits[0] ?? lines.find((l) => !isHeading(l)) ?? lines[0] ?? '';
  const text = pick.replace(/\s+/g, ' ').trim();
  if (text.length <= SNIPPET_CHARS) return text;
  // Centre the window on the first matching word.
  let at = 0;
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    if (tokenize(m[0]).some((t) => terms.has(t))) {
      at = m.index;
      break;
    }
  }
  const start = Math.max(0, Math.min(at - SNIPPET_CHARS / 3, text.length - SNIPPET_CHARS));
  const cut = text.slice(start, start + SNIPPET_CHARS);
  return `${start > 0 ? '…' : ''}${cut}${start + SNIPPET_CHARS < text.length ? '…' : ''}`;
}
