import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { accessFromConfig, ConfigError, parsePlainPath } from '../src/access.js';
import { compileConfig, parseConfigText } from '../src/config.js';
import { FIXTURE } from './helpers.js';

describe('@ikaros-labs/spall/access export', () => {
  it('bundles for the browser without node:*, chokidar or fastify', async () => {
    const r = await build({
      entryPoints: ['src/access.ts'],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.filter((i) => /^node:|chokidar|fastify|node_modules\/yaml\//.test(i))).toEqual([]);
    expect(inputs.filter((i) => i.startsWith('src/')).sort()).toEqual(['src/access.ts', 'src/errors.ts', 'src/paths.ts']);
  });

  it('decides exactly like the server config', () => {
    const account = { root: 'Notes', access: { '.': 'read', Private: 'none', 'Private/Shared.md': 'edit' } } as const;
    const exclude = ['Notes/Excluded'];
    const cfg = compileConfig(
      parseConfigText(JSON.stringify({ version: 1, vault: { path: FIXTURE, exclude, trash: 'none' }, accounts: { a: account } })),
      '/tmp/spall-access-test/spall.yaml',
    );
    const server = cfg.accounts.get('a')!.access;
    const browser = accessFromConfig({ ...account, exclude });
    const paths = ['Notes', 'Notes/Ideas.md', 'notes/ideas.md', 'Notes/Private', 'Notes/Private/x.md', 'Notes/Private/Shared.md', 'Notes/.obsidian/a', 'Notes/Excluded/b.md', 'Inbox.md', ''];
    for (const p of paths) {
      const segs = parsePlainPath(p);
      expect(browser.decide(segs), p).toEqual(server.decide(segs));
      expect(browser.leadsToReadable(segs), p).toBe(server.leadsToReadable(segs));
    }
    expect(browser.can(parsePlainPath('Notes/Private/Shared.md'), 'update')).toBe(true);
    expect(browser.leadsToReadable(parsePlainPath('Notes/Private'))).toBe(true);
  });

  it('rejects what the config rejects, listing every problem', () => {
    expect(() => accessFromConfig({ access: { '.': 'admin' } })).toThrow(ConfigError);
    try {
      accessFromConfig({ access: { '.obsidian': 'read', 'A/../B': 'read', X: ['update'] } });
      expect.unreachable();
    } catch (e) {
      expect((e as ConfigError).problems).toHaveLength(3);
    }
  });
});
