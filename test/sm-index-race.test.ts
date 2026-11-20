import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault-index.js';
import { setup, type TestEnv } from './helpers.js';

/** Index refreshes interleaved with folder removal and replacement. See B8 and B10 in docs/STATE-MACHINES.md. */

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

/**
 * Parks the first `load(path)` after it has read the disk, before the index publishes the result.
 * Runs `meanwhile` while it is parked, then lets it go and waits for `run`.
 */
async function whileLoadParked(path_: string, run: () => Promise<void>, meanwhile: () => Promise<void>) {
  const proto = VaultIndex.prototype as unknown as { load: (p: string) => Promise<unknown> };
  const orig = proto.load;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const parked = new Promise<void>((r) => (reached = r));
  let first = true;
  proto.load = async function (this: VaultIndex, p: string) {
    const out = await orig.call(this, p);
    if (p === path_ && first) {
      first = false;
      reached();
      await gate;
    }
    return out;
  };
  try {
    const done = run();
    await parked;
    await meanwhile();
    release();
    await done;
  } finally {
    proto.load = orig;
  }
}

const withFolder = (vault: string) => {
  mkdirSync(path.join(vault, 'F'));
  writeFileSync(path.join(vault, 'F/x.md'), 'old');
};

describe('B8 index refresh of a file racing the removal of its folder', () => {
  it('does not leave a ghost entry under a folder that is gone', async () => {
    env = await setup({ prepare: withFolder });
    const index = env.app.index;
    await whileLoadParked('F/x.md', () => index.refresh('F/x.md'), async () => {
      rmSync(path.join(env.vault, 'F'), { recursive: true });
      await index.refresh('F');
    });
    expect(index.get('F')).toBeUndefined();
    expect(index.get('F/x.md')).toBeUndefined();
  });
});

describe('B10 index publication under a folder that changed meanwhile', () => {
  it('does not publish a stale child into a recreated folder', async () => {
    env = await setup({ prepare: withFolder });
    const index = env.app.index;
    await whileLoadParked('F/x.md', () => index.refresh('F/x.md'), async () => {
      rmSync(path.join(env.vault, 'F'), { recursive: true });
      await index.refresh('F');
      mkdirSync(path.join(env.vault, 'F'));
      await index.refresh('F');
    });
    expect(index.get('F')?.kind).toBe('folder');
    expect(index.get('F/x.md')).toBeUndefined();
  });

  it('does not publish a child under a folder that became a file', async () => {
    env = await setup({ prepare: withFolder });
    const index = env.app.index;
    await whileLoadParked('F/x.md', () => index.refresh('F/x.md'), async () => {
      rmSync(path.join(env.vault, 'F'), { recursive: true });
      writeFileSync(path.join(env.vault, 'F'), 'a file now');
      await index.refresh('F');
    });
    expect(index.get('F')?.kind).toBe('file');
    expect(index.get('F/x.md')).toBeUndefined();
    expect(index.childrenOf('F')).toEqual([]);
  });

  it('a folder scan stops when an ancestor is removed meanwhile', async () => {
    env = await setup();
    const index = env.app.index;
    mkdirSync(path.join(env.vault, 'Top/New'), { recursive: true });
    writeFileSync(path.join(env.vault, 'Top/New/a.md'), 'a');
    await index.refresh('Top');
    expect(index.get('Top/New/a.md')).toBeDefined();
    // A new folder's refresh scans it; park the scan on its child, then delete the whole tree.
    rmSync(path.join(env.vault, 'Top/New'), { recursive: true });
    await index.refresh('Top/New');
    mkdirSync(path.join(env.vault, 'Top/New'));
    writeFileSync(path.join(env.vault, 'Top/New/a.md'), 'a');
    await whileLoadParked('Top/New/a.md', () => index.refresh('Top/New'), async () => {
      rmSync(path.join(env.vault, 'Top'), { recursive: true });
      await index.refresh('Top');
    });
    expect(index.get('Top')).toBeUndefined();
    expect(index.get('Top/New/a.md')).toBeUndefined();
  });

  it('still indexes a file whose new folder is refreshed after it', async () => {
    env = await setup();
    const index = env.app.index;
    mkdirSync(path.join(env.vault, 'A/B'), { recursive: true });
    writeFileSync(path.join(env.vault, 'A/B/c.md'), 'c');
    await index.refresh('A/B/c.md');
    expect(index.get('A')?.kind).toBe('folder');
    expect(index.get('A/B')?.kind).toBe('folder');
    expect(index.get('A/B/c.md')?.kind).toBe('note');
  });
});
