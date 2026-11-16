import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { ConfigManager } from './config.js';
import { EngineCache, PropertyTypes } from './bases/engine.js';
import { buildServer } from './http/server.js';
import { SearchIndex } from './search/index.js';
import { AuditLog, Vault } from './vault.js';
import { VaultIndex } from './vault-index.js';

export interface App {
  server: FastifyInstance;
  index: VaultIndex;
  search: SearchIndex;
  close(): Promise<void>;
}

/** Indexes the vault and builds the HTTP server. `watch` starts the filesystem watcher. */
export async function createApp(
  configs: ConfigManager,
  opts: { watch?: boolean; logger?: FastifyServerOptions['logger'] } = {},
): Promise<App> {
  const cfg = configs.current;
  const index = new VaultIndex(cfg.vaultPath, { followSymlinks: cfg.followSymlinks });
  await index.build();
  if (opts.watch) await index.watch((e) => server.log.error(e));
  const vault = new Vault(cfg.vaultPath, index, { followSymlinks: cfg.followSymlinks, trash: cfg.trash });
  const search = new SearchIndex(index, (e) => vault.read(e.real ?? e.segs));
  const server = buildServer(
    { config: () => configs.current, index, vault, audit: new AuditLog(() => configs.current.auditPath),
      propertyTypes: new PropertyTypes(cfg.vaultPath, () => configs.current.propertyTypes),
      engineCache: new EngineCache(),
      search,
    },
    { logger: opts.logger },
  );
  // Warm the search index in the background; queries wait for it if it's not done yet.
  search.sync().catch((e) => server.log.error(e));
  return {
    server,
    index,
    search,
    async close() {
      await server.close();
      await index.close();
    },
  };
}
