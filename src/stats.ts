import type { Entry } from './vault-index.js';

export type Interval = 'day' | 'week' | 'month';
export interface Bucket {
  t: string;
  count: number;
}

const DAY_MS = 86_400_000;

/** `ms` as a calendar date (YYYY-MM-DD) in `timeZone`. */
export function dateIn(ms: number, timeZone: string): string {
  const f = formatters.get(timeZone) ?? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  formatters.set(timeZone, f);
  return f.format(ms);
}
const formatters = new Map<string, Intl.DateTimeFormat>();

const toUtc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Start of the bucket (day, ISO week starting Monday, or month) containing `date`. */
export function bucketStart(date: string, interval: Interval): string {
  if (interval === 'day') return date;
  if (interval === 'month') return `${date.slice(0, 7)}-01`;
  const ms = toUtc(date);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return fromUtc(ms - dow * DAY_MS);
}

function nextBucket(start: string, interval: Interval): string {
  if (interval === 'day') return fromUtc(toUtc(start) + DAY_MS);
  if (interval === 'week') return fromUtc(toUtc(start) + 7 * DAY_MS);
  const d = new Date(toUtc(start));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return fromUtc(d.getTime());
}

/** Default window ending today: 30 days, 12 weeks or 12 months. */
export function defaultFrom(to: string, interval: Interval): string {
  if (interval === 'day') return fromUtc(toUtc(to) - 29 * DAY_MS);
  if (interval === 'week') return fromUtc(toUtc(bucketStart(to, 'week')) - 11 * 7 * DAY_MS);
  const d = new Date(toUtc(bucketStart(to, 'month')));
  d.setUTCMonth(d.getUTCMonth() - 11);
  return fromUtc(d.getTime());
}

/**
 * Counts `times` (ms) per bucket between `from` and `to` (inclusive calendar dates in `timeZone`).
 * Every bucket in the window is present, empty ones with a count of 0, so charts have no gaps.
 */
export function buckets(times: Iterable<number>, o: { from: string; to: string; interval: Interval; timeZone: string }): Bucket[] {
  const out = new Map<string, number>();
  const last = bucketStart(o.to, o.interval);
  for (let t = bucketStart(o.from, o.interval); t <= last; t = nextBucket(t, o.interval)) {
    out.set(t, 0);
    if (out.size > 5000) throw new RangeError('too many buckets');
  }
  for (const ms of times) {
    const date = dateIn(ms, o.timeZone);
    if (date < o.from || date > o.to) continue;
    const key = bucketStart(date, o.interval);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return [...out].map(([t, count]) => ({ t, count }));
}

/** Frontmatter value(s) of `property` as strings; exact key first, then case-insensitive. */
export function propertyValues(e: Entry, property: string): string[] {
  const fm = e.meta?.frontmatter;
  if (!fm) return [];
  let v = fm[property];
  if (v === undefined) {
    const key = Object.keys(fm).find((k) => k.toLowerCase() === property.toLowerCase());
    v = key === undefined ? undefined : fm[key];
  }
  const list = Array.isArray(v) ? v : [v];
  return list
    .filter((x) => x !== null && x !== undefined && x !== '')
    .map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : typeof x === 'object' ? JSON.stringify(x) : String(x)));
}

export const NO_VALUE = '(none)';

/** Notes per value of `property`; a list counts once for each item, a missing value as "(none)". */
export function countByProperty(notes: Iterable<Entry>, property: string): Record<string, number> {
  const tally = new Map<string, number>();
  for (const e of notes) {
    const values = propertyValues(e, property);
    for (const v of values.length ? new Set(values) : [NO_VALUE]) tally.set(v, (tally.get(v) ?? 0) + 1);
  }
  return Object.fromEntries([...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

// ---------------------------------------------------------------------------------------------
// Prometheus text exposition format (version 0.0.4).

export interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: { labels?: Record<string, string>; value: number }[];
}

const escapeLabel = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

export function prometheusText(metrics: Metric[]): string {
  const lines: string[] = [];
  for (const m of metrics) {
    lines.push(`# HELP ${m.name} ${m.help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`, `# TYPE ${m.name} ${m.type}`);
    for (const s of m.samples) {
      const labels = Object.entries(s.labels ?? {});
      const l = labels.length ? `{${labels.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',')}}` : '';
      lines.push(`${m.name}${l} ${Number.isFinite(s.value) ? s.value : 'NaN'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
