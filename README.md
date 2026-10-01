# vault-api

A REST API over a folder of markdown files (an Obsidian vault or any other) where each account sees only the folders it has been granted. The design is in [api-design.md](api-design.md).

## Run

```sh
npm install
npm run build

# vault-api.yaml must live outside the vault
node dist/cli.js -c vault-api.yaml token create reading-bot --name hermes --expires 2027-10-01
node dist/cli.js -c vault-api.yaml check
node dist/cli.js -c vault-api.yaml explain reading-bot "Archive/Old.md"
node dist/cli.js -c vault-api.yaml serve
```

Minimal config:

```yaml
version: 1
vault:
  path: /srv/obsidian/vault
accounts:
  reading-bot:
    root: datasources/Reading List
    access:
      .: [read, create, update]
```

The server reloads the config when the file changes or on `SIGHUP`. If the new config is invalid, it keeps the old one. Set `LOG_LEVEL` to change log verbosity.

## Develop

```sh
npm test            # vitest; API tests run against a temp copy of test/fixtures/vault
npm run typecheck
npm run cli -- check -c vault-api.yaml   # run the CLI from source
```

## Layout

| Path | What |
|---|---|
| `src/config.ts` | Config schema, validation, hot reload |
| `src/access.ts` | Grant resolution (deepest key wins) |
| `src/paths.ts` | Path parsing and safety rules |
| `src/vault-index.ts` | In-memory index of the vault, kept current by a watcher |
| `src/vault.ts` | Filesystem operations, locks, trash, audit log |
| `src/markdown.ts` | Frontmatter, headings, blocks, tags, links |
| `src/patch.ts` | PATCH operations |
| `src/http/` | Fastify server and routes |
| `src/cli.ts` | `serve`, `check`, `explain`, `token` |
