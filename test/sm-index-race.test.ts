import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultIndex } from '../src/vault-index.js';
import { setup, type TestEnv } from './helpers.js';

/** Index refreshes interleaved with folder removal. See B8 in docs/STATE-MACHINES.md. */

let env: TestEnv;
afterEach(async () => {
  await env?.cleanup();
});

describe('B8 index refresh of a file racing the removal of its folder', () => {
  it('does not leave a ghost entry under a folder that is gone', async () => {
    env = await setup({
      prepare: (vault) => {
        mkdirSync(path.join(vault, 'Gone'));
        writeFileSync(path.join(vault, 'Gone/x.md'), 'x');
      },
    });
    const index = env.app.index;
    // Park the child's refresh after it has read the file from disk, before it updates the index.
    const proto = VaultIndex.prototype as unknown as { load: (p: string) => Promise<unknown> };
    const orig = proto.load;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const parked = new Promise<void>((r) => (reached = r));
    proto.load = async function (this: VaultIndex, p: string) {
      const out = await orig.call(this, p);
      if (p === 'Gone/x.md') {
        reached();
        await gate;
      }
      return out;
    };
    try {
      const child = index.refresh('Gone/x.md');
      await parked;
      rmSync(path.join(env.vault, 'Gone'), { recursive: true });
      await index.refresh('Gone');
      release();
      await child;
    } finally {
      proto.load = orig;
    }
    expect(index.get('Gone')).toBeUndefined();
    expect(index.get('Gone/x.md')).toBeUndefined();
  });
});
