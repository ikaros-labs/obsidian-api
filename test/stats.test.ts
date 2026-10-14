import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/vault-index.js';
import { bucketStart, buckets, countByProperty, dateIn, defaultFrom, prometheusText } from '../src/stats.js';

const at = (iso: string) => Date.parse(iso);
const note = (frontmatter: Record<string, unknown> | null): Entry =>
  ({ path: 'x.md', segs: ['x.md'], kind: 'note', size: 0, created: 0, modified: 0, meta: { frontmatter, tags: [], links: [] } }) as Entry;

describe('dates and buckets', () => {
  it('formats dates in a time zone', () => {
    expect(dateIn(at('2026-10-11T23:30:00Z'), 'UTC')).toBe('2026-10-11');
    expect(dateIn(at('2026-10-11T23:30:00Z'), 'Europe/London')).toBe('2026-10-12');
    expect(dateIn(at('2026-10-11T23:30:00Z'), 'America/New_York')).toBe('2026-10-11');
  });

  it('finds bucket starts (weeks start on Monday)', () => {
    expect(bucketStart('2026-10-11', 'day')).toBe('2026-10-11');
    expect(bucketStart('2026-10-11', 'week')).toBe('2026-10-05'); // a Sunday
    expect(bucketStart('2026-10-12', 'week')).toBe('2026-10-12'); // a Monday
    expect(bucketStart('2026-10-11', 'month')).toBe('2026-10-01');
  });

  it('defaults to 30 days, 12 weeks or 12 months', () => {
    expect(defaultFrom('2026-10-11', 'day')).toBe('2026-09-12');
    expect(defaultFrom('2026-10-11', 'week')).toBe('2026-07-20');
    expect(defaultFrom('2026-10-11', 'month')).toBe('2025-11-01');
  });

  it('counts per day, filling empty days with 0', () => {
    const times = ['2026-10-01T10:00:00Z', '2026-10-01T22:00:00Z', '2026-10-03T08:00:00Z', '2026-09-01T00:00:00Z'].map(at);
    expect(buckets(times, { from: '2026-10-01', to: '2026-10-03', interval: 'day', timeZone: 'UTC' })).toEqual([
      { t: '2026-10-01', count: 2 },
      { t: '2026-10-02', count: 0 },
      { t: '2026-10-03', count: 1 },
    ]);
  });

  it('assigns times to the local day of the time zone', () => {
    const times = [at('2026-10-01T23:30:00Z')];
    const opts = { from: '2026-10-01', to: '2026-10-02', interval: 'day' as const };
    expect(buckets(times, { ...opts, timeZone: 'UTC' }).map((b) => b.count)).toEqual([1, 0]);
    expect(buckets(times, { ...opts, timeZone: 'Europe/London' }).map((b) => b.count)).toEqual([0, 1]);
  });

  it('counts per week and month', () => {
    const times = ['2026-09-28T12:00:00Z', '2026-10-04T12:00:00Z', '2026-10-05T12:00:00Z'].map(at);
    expect(buckets(times, { from: '2026-09-28', to: '2026-10-11', interval: 'week', timeZone: 'UTC' })).toEqual([
      { t: '2026-09-28', count: 2 },
      { t: '2026-10-05', count: 1 },
    ]);
    expect(buckets(times, { from: '2026-09-01', to: '2026-10-31', interval: 'month', timeZone: 'UTC' })).toEqual([
      { t: '2026-09-01', count: 1 },
      { t: '2026-10-01', count: 2 },
    ]);
  });

  it('refuses absurd windows', () => {
    expect(() => buckets([], { from: '1900-01-01', to: '2026-01-01', interval: 'day', timeZone: 'UTC' })).toThrow(RangeError);
  });
});

describe('countByProperty', () => {
  it('tallies values, lists once per distinct item, and missing values', () => {
    const notes = [
      note({ Status: 'Done' }),
      note({ Status: 'Done' }),
      note({ status: 'Not started' }),
      note({ Status: ['A', 'B', 'A'] }),
      note({}),
      note(null),
      note({ Status: '' }),
    ];
    expect(countByProperty(notes, 'Status')).toEqual({ '(none)': 3, Done: 2, A: 1, B: 1, 'Not started': 1 });
  });
});

describe('prometheusText', () => {
  it('renders HELP, TYPE and escaped labels', () => {
    const text = prometheusText([
      { name: 'vault_notes', help: 'Notes.', type: 'gauge', samples: [{ value: 3 }] },
      { name: 'vault_x', help: 'X.', type: 'gauge', samples: [{ labels: { value: 'a "b"\\c\nd' }, value: 1 }] },
    ]);
    expect(text).toBe(
      '# HELP vault_notes Notes.\n# TYPE vault_notes gauge\nvault_notes 3\n' +
        '# HELP vault_x X.\n# TYPE vault_x gauge\nvault_x{value="a \\"b\\"\\\\c\\nd"} 1\n',
    );
  });
});
