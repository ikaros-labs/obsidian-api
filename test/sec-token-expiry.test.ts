import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { isExpired } from '../src/tokens.js';
import { FIXTURE, writeConfig } from './helpers.js';

// F-19: an `expires` that can't be read must not mean "never expires".
describe('token expiry that does not parse', () => {
  const BAD = ['2020-13-01', '2020-31-12', '2020-01-45', '2020-01-01T25:00:00Z', '2020-01-01T10Z'];

  it('is a config error', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'spall-test-'));
    try {
      const file = path.join(dir, 'spall.yaml');
      for (const expires of BAD) {
        writeConfig(file, FIXTURE, { accounts: { a: { access: { '.': 'read' }, expires } } });
        expect(() => loadConfig(file), expires).toThrow(/accounts\.a\.tokens\.0\.expires: not a valid date/);
      }
      for (const expires of ['2020-01-01', '2999-12-31', '2020-01-01T10:00:00Z', '2020-01-01T10:00:00+02:00']) {
        writeConfig(file, FIXTURE, { accounts: { a: { access: { '.': 'read' }, expires } } });
        expect(() => loadConfig(file), expires).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('counts as expired if it ever reaches the check', () => {
    for (const expires of BAD) expect(isExpired(expires), expires).toBe(true);
    expect(isExpired('2020-01-01')).toBe(true);
    expect(isExpired('2999-12-31')).toBe(false);
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
  });
});
