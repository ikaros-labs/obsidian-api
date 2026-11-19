import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientMain } from '../src/cli/client.js';
import { setup, unfenced, type TestEnv } from './helpers.js';
import { callTool, injectFetch, mcpClient } from './mcp-helpers.js';

// Four English notes and one Russian one about solder flux («флюс»): an English-only search for
// "flux" finds nothing, and the hint should say the notes are partly in Russian.
let env: TestEnv;
let agent: Client;
beforeAll(async () => {
  env = await setup({
    fixture: path.join(import.meta.dirname, 'fixtures/bases-vault'),
    accounts: unfenced({
      agent: { access: { Electronics: 'read' } },
      english: { access: { Electronics: 'read', 'Electronics/Пайка.md': 'none' } },
    }),
    prepare: (vault) => {
      mkdirSync(path.join(vault, 'Electronics'));
      for (const n of ['Resistors', 'Capacitors', 'Diodes', 'Breadboards'])
        writeFileSync(path.join(vault, `Electronics/${n}.md`), `# ${n}\n\nNotes about ${n.toLowerCase()} and how to choose them.\n`);
      writeFileSync(path.join(vault, 'Electronics/Пайка.md'), '# Пайка\n\nДля пайки нужен хороший флюс и тонкий припой.\n');
    },
  });
  agent = await mcpClient(env, 'agent');
});
afterAll(async () => {
  await agent.close();
  await env.cleanup();
});

const search = async (account: string, q: string) => (await env.req(account, { method: 'GET', url: `/v1/search?q=${encodeURIComponent(q)}` })).json();
const HINT =
  "No matches in 5 notes. Notes in this scope are in English (≈80%) and Russian (≈20%); search is word-based and doesn't translate, so try the terms in those languages too.";

describe('zero-result hint about languages', () => {
  it('REST: names the languages of the notes in scope', async () => {
    const body = await search('agent', 'flux');
    expect(body.total).toBe(0);
    expect(body.hint).toBe(HINT);
    expect((await search('agent', 'флюс')).hint).toBeUndefined();
  });

  it('counts only notes the account can read', async () => {
    const body = await search('english', 'flux');
    expect(body.hint).toBe("No matches in 4 notes. Notes in this scope are in English (≈100%); search is word-based and doesn't translate, so try the terms in that language.");
  });

  it('MCP: in the text and the structured result', async () => {
    const r = await callTool(agent, 'spall_search', { query: 'flux' });
    expect(r.text).toContain('Notes in this scope are in English (≈80%) and Russian (≈20%)');
    expect(r.data.hint).toBe(HINT);
  });

  it('CLI: printed under "No matches"', async () => {
    let out = '';
    const code = await clientMain(['search', 'flux'], {
      env: { SPALL_URL: 'http://spall.test', SPALL_TOKEN: 'tok-agent' },
      out: (s) => (out += s),
      err: () => {},
      stdin: async () => '',
      fetch: injectFetch(env),
    });
    expect(code).toBe(0);
    expect(out).toContain('(5 notes searched).\nNotes in this scope are in English (≈80%) and Russian (≈20%)');
  });
});
