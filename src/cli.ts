#!/usr/bin/env node
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isSeq, parseDocument } from 'yaml';
import { PERMS } from './access.js';
import { createApp } from './app.js';
import { ConfigError, ConfigManager, compileConfig, loadConfig, parseConfigText, type Config } from './config.js';
import { join, parsePlainPath } from './paths.js';
import { expiryTime, generateToken, hashToken, isExpired } from './tokens.js';

const USAGE = `Usage: vault-api <command> [options]

Commands:
  serve                                 Start the server
  check                                 Validate the config and print each account's access
  explain <account> <path>              Show what an account may do with a path (relative to its root)
  token create <account> [--name n] [--expires YYYY-MM-DD]
  token list [account]
  token revoke <account> <name>

Options:
  -c, --config <path>   Config file (default: $VAULT_API_CONFIG or ./vault-api.yaml)
`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function load(configPath: string): Config {
  try {
    return loadConfig(configPath);
  } catch (e) {
    fail(e instanceof ConfigError ? e.message : String(e));
  }
}

function account(cfg: Config, name: string | undefined) {
  if (!name) fail(USAGE);
  return cfg.accounts.get(name) ?? fail(`No such account: ${name}`);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Edits the config YAML in place (keeping comments), validates the result, then writes it atomically. */
function editConfig(configPath: string, edit: (doc: ReturnType<typeof parseDocument>) => void) {
  const doc = parseDocument(readFileSync(configPath, 'utf8'));
  edit(doc);
  const text = String(doc);
  try {
    compileConfig(parseConfigText(text), configPath);
  } catch (e) {
    fail(e instanceof ConfigError ? e.message : String(e));
  }
  const tmp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`);
  writeFileSync(tmp, text, { mode: statSync(configPath).mode });
  renameSync(tmp, configPath);
}

async function serve(configPath: string) {
  const configs = (() => {
    try {
      return ConfigManager.load(configPath);
    } catch (e) {
      fail(e instanceof ConfigError ? e.message : String(e));
    }
  })();
  const app = await createApp(configs, { watch: true, logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const { host, port } = configs.current.server;
  await app.server.listen({ host, port });
  app.server.log.info(`Serving ${configs.current.vaultPath} (${app.index.size} entries indexed)`);
  configs.watch();
  process.on('SIGHUP', () => configs.reload());
  const stop = async () => {
    configs.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function check(cfg: Config) {
  console.log(`Config OK: ${cfg.configPath}`);
  console.log(`Vault: ${cfg.vaultPath}`);
  for (const a of cfg.accounts.values()) {
    const active = a.tokens.filter((t) => !isExpired(t.expires)).length;
    console.log(`\n${a.name}${a.description ? ` (${a.description})` : ''}`);
    console.log(`  root: ${a.rootPath === '' ? '(vault root)' : a.rootPath}`);
    console.log(`  rate limit: ${a.rateLimit.spec}`);
    console.log(`  tokens: ${active} active, ${a.tokens.length - active} expired`);
    for (const g of a.grants) console.log(`  ${g.path}: ${g.permissions.join(', ') || 'none'}`);
  }
}

function explain(cfg: Config, name: string | undefined, p: string | undefined) {
  const a = account(cfg, name);
  if (p === undefined) fail(USAGE);
  const segs = [...a.root, ...parsePlainPath(p)];
  const d = a.access.decide(segs);
  const perms = PERMS.filter((x) => d.perms.has(x));
  const why = {
    grant: `key: ${d.key}`,
    no_grant: 'no matching key',
    outside_root: 'outside the account root',
    dotfile: 'dotfiles and dot-folders are always denied',
    excluded: `vault.exclude: ${d.key}`,
  }[d.reason];
  console.log(`${p} → ${perms.join(', ') || 'none'} (${why})`);
  if (!d.perms.has('read') && a.access.leadsToReadable(segs)) {
    console.log('  listed as a parent folder, showing only the branches the account can read');
  }
  console.log(`  vault path: ${join(segs) || '(vault root)'}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c' },
      name: { type: 'string' },
      expires: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return;
  }
  const configPath = path.resolve(values.config ?? process.env.VAULT_API_CONFIG ?? 'vault-api.yaml');

  switch (cmd) {
    case 'serve':
      return serve(configPath);
    case 'check':
      return check(load(configPath));
    case 'explain':
      return explain(load(configPath), args[0], args[1]);
    case 'token': {
      const [sub, accountName, tokenName] = args;
      const cfg = load(configPath);
      if (sub === 'create') {
        const a = account(cfg, accountName);
        if (values.expires !== undefined && expiryTime(values.expires) === null) fail('--expires: expected YYYY-MM-DD');
        const tokenNameNew = values.name ?? `token-${a.tokens.length + 1}`;
        const token = generateToken();
        editConfig(configPath, (doc) => {
          const entry = {
            name: tokenNameNew,
            sha256: hashToken(token),
            created: today(),
            ...(values.expires ? { expires: values.expires } : {}),
          };
          const tokens = doc.getIn(['accounts', a.name, 'tokens']);
          if (isSeq(tokens)) tokens.add(doc.createNode(entry));
          else doc.setIn(['accounts', a.name, 'tokens'], doc.createNode([entry]));
        });
        console.error(`Created token "${tokenNameNew}" for ${a.name}. It is shown only once:`);
        console.log(token);
        return;
      }
      if (sub === 'list') {
        const accounts = accountName ? [account(cfg, accountName)] : [...cfg.accounts.values()];
        for (const a of accounts) {
          for (const t of a.tokens) {
            const status = isExpired(t.expires) ? 'expired' : 'active';
            console.log(`${a.name}\t${t.name}\t${status}\tcreated ${t.created ?? '?'}\texpires ${t.expires ?? 'never'}`);
          }
        }
        return;
      }
      if (sub === 'revoke') {
        const a = account(cfg, accountName);
        const idx = a.tokens.findIndex((t) => t.name === tokenName);
        if (idx === -1) fail(`No token "${tokenName}" for ${a.name}`);
        editConfig(configPath, (doc) => doc.deleteIn(['accounts', a.name, 'tokens', idx]));
        console.log(`Revoked token "${tokenName}" for ${a.name}`);
        return;
      }
      fail(USAGE);
    }
    // falls through
    default:
      fail(USAGE);
  }
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
