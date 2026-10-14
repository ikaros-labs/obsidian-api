/**
 * Writes a local demo config (out/demo/vault-api.yaml) pointing at a vault, with fresh random
 * read-only tokens, plus the stats counters for the W5 demo. The tokens are printed and saved to
 * out/demo/tokens.env (gitignored), never committed.
 *
 *   npx tsx scripts/demo-config.ts --vault ../_vault-snapshot [--host 100.66.44.47] [--port 8723]
 *   npx tsx src/cli.ts serve --config out/demo/vault-api.yaml
 *
 * The default host is the tailnet address, so the demo is never on a public interface; use
 * --host 127.0.0.1 off the tailnet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { generateToken, hashToken } from '../src/tokens.js';

export const DEFAULT_HOST = '100.66.44.47';

const accounts = {
  admin: { access: { '.': 'read' } },
  reading: { root: 'datasources/Reading List', access: { '.': 'read' } },
  agent: { access: { '3. Resources': 'read', '3. Resources/X': 'none', 'datasources/Reading List': 'read' } },
};

/** Builds the demo config object and its tokens (exported for tests). */
export function demoConfig(o: { vault: string; host?: string; port?: number; audit?: string }) {
  const tokens = Object.fromEntries(Object.keys(accounts).map((name) => [name, generateToken()]));
  const config = {
    version: 1,
    server: { host: o.host ?? DEFAULT_HOST, port: o.port ?? 8723 },
    vault: { path: path.resolve(o.vault), trash: 'none' },
    stats: {
      timezone: 'Europe/London',
      folders: { inbox: 'inbox', x_inbox: '3. Resources/X/inbox' },
      properties: { reading: { folder: 'datasources/Reading List', property: 'Status' } },
    },
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([name, a]) => [name, { ...a, tokens: [{ name: 'demo', sha256: hashToken(tokens[name]!) }] }]),
    ),
  };
  return { config, tokens };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const { values } = parseArgs({
    options: { vault: { type: 'string' }, host: { type: 'string', default: DEFAULT_HOST }, port: { type: 'string', default: '8723' } },
  });
  if (!values.vault) throw new Error('--vault <path> is required');
  const { config, tokens } = demoConfig({ vault: values.vault, host: values.host, port: Number(values.port) });
  const dir = path.resolve('out/demo');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'vault-api.yaml'), stringify(config));
  writeFileSync(
    path.join(dir, 'tokens.env'),
    Object.entries(tokens).map(([name, t]) => `${name.toUpperCase()}_TOKEN=${t}\n`).join(''),
    { mode: 0o600 },
  );
  console.log(`Wrote ${path.join(dir, 'vault-api.yaml')} (binds ${values.host}:${values.port})`);
  console.log(`Tokens (also in ${path.join(dir, 'tokens.env')}):`);
  for (const [name, t] of Object.entries(tokens)) console.log(`  ${name.padEnd(8)} ${t}`);
}
