import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isMap, isSeq, parseDocument } from 'yaml';
import { PERMS } from '../access.js';
import { createApp } from '../app.js';
import { ConfigManager, compileConfig, loadConfig, parseConfigText, type Config } from '../config.js';
import { ConfigError } from '../errors.js';
import { join, parsePlainPath } from '../paths.js';
import { expiryTime, generateToken, hashToken, isExpired } from '../tokens.js';

export const ADMIN_COMMANDS = ['serve', 'check', 'explain', 'token'];

export const ADMIN_USAGE = `Server commands (need the config file):
  serve                                 Start the server
  check                                 Validate the config and print each account's access
  explain <account> <path>              Show what an account may do with a path (relative to its root)
  token create <account> [--name n] [--expires YYYY-MM-DD]
  token list [account]
  token revoke <account> <name>

  -c, --config <path>                   Config file (default: $SPALL_CONFIG or ./spall.yaml)
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
  if (!name) fail(ADMIN_USAGE);
  return cfg.accounts.get(name) ?? fail(`No such account: ${name}`);
}

const today = () => new Date().toISOString().slice(0, 10);

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes `.<config>.lock` next to the (canonical) config, so concurrent `spall token …` runs edit
 * one at a time. The lock holds `<pid> <nonce>`. It is created whole (written to a private file,
 * then hard-linked into place), so it is never seen half-written. A lock whose process is gone is
 * taken over by moving it aside first and checking it is still the one judged stale; if another
 * run took it over in between, its lock is put back. Release removes the lock only if it is ours.
 */
function lockConfig(configPath: string): () => void {
  const lock = path.join(path.dirname(configPath), `.${path.basename(configPath)}.lock`);
  const mine = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const nonce = mine.split(' ')[1];
  const deadline = Date.now() + 10_000;
  const read = (file: string) => {
    try {
      return readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  for (;;) {
    const tmp = `${lock}.${nonce}`;
    writeFileSync(tmp, mine);
    try {
      linkSync(tmp, lock);
      return () => {
        if (read(lock) === mine) rmSync(lock, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
    const held = read(lock);
    if (held === null) continue; // released meanwhile
    const holder = Number(held.split(' ')[0]);
    if (!(Number.isInteger(holder) && holder > 0 && alive(holder))) {
      // Stale (or not ours to parse): take it over, unless someone else did first.
      const aside = `${lock}.stale.${nonce}`;
      try {
        renameSync(lock, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      if (read(aside) !== held) {
        try {
          linkSync(aside, lock);
        } catch {
          // Yet another run holds it now; ours to wait for, like any other.
        }
      }
      rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() > deadline) fail(`The config is being edited by process ${holder} (lock: ${lock})`);
    sleep(50);
  }
}

/**
 * Edits the config YAML in place (keeping comments), validates the result, then writes it
 * atomically. The read, the edit and the write happen under the config lock, so the edit is made
 * on the file as it is and no other `spall token` run can overwrite it. `edit` throws to abort.
 * A config reached through a symlink is edited where it really is (the lock lives there too).
 */
function editConfig(configPathGiven: string, edit: (doc: ReturnType<typeof parseDocument>) => void) {
  const configPath = realpathSync(configPathGiven);
  const unlock = lockConfig(configPath);
  let problem: string | null = null;
  try {
    const doc = parseDocument(readFileSync(configPath, 'utf8'));
    edit(doc);
    const text = String(doc);
    compileConfig(parseConfigText(text), configPath);
    const tmp = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.tmp`);
    writeFileSync(tmp, text, { mode: statSync(configPath).mode });
    renameSync(tmp, configPath);
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  } finally {
    unlock();
  }
  if (problem !== null) fail(problem);
}

const tokensOf = (doc: ReturnType<typeof parseDocument>, account: string) => {
  const tokens = doc.getIn(['accounts', account, 'tokens']);
  return isSeq(tokens) ? tokens : null;
};

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
  if (p === undefined) fail(ADMIN_USAGE);
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

export async function adminMain(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
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
    console.log(ADMIN_USAGE);
    return;
  }
  const configPath = path.resolve(values.config ?? process.env.SPALL_CONFIG ?? 'spall.yaml');

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
        const token = generateToken();
        let tokenNameNew = '';
        editConfig(configPath, (doc) => {
          const tokens = tokensOf(doc, a.name);
          tokenNameNew = values.name ?? `token-${(tokens?.items.length ?? 0) + 1}`;
          const entry = {
            name: tokenNameNew,
            sha256: hashToken(token),
            created: today(),
            ...(values.expires ? { expires: values.expires } : {}),
          };
          if (tokens) tokens.add(doc.createNode(entry));
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
        editConfig(configPath, (doc) => {
          // Found by name in the file being edited: another edit may have changed the list.
          const idx = tokensOf(doc, a.name)?.items.findIndex((t) => isMap(t) && t.get('name') === tokenName) ?? -1;
          if (idx === -1) throw new Error(`No token "${tokenName}" for ${a.name}`);
          doc.deleteIn(['accounts', a.name, 'tokens', idx]);
        });
        console.log(`Revoked token "${tokenName}" for ${a.name}`);
        return;
      }
      fail(ADMIN_USAGE);
    }
    // falls through
    default:
      fail(ADMIN_USAGE);
  }
}

