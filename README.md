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

## Docker

Pushes to `main` and `v*` tags build a multi-arch image (`linux/amd64`, `linux/arm64`) and publish it as `ghcr.io/ikaros-labs/obsidian-api`, after tests pass. Pull requests only build the image.

[`deploy/`](deploy) has a compose example and a sample config:

```sh
cp -r deploy ~/vault-api && cd ~/vault-api
# edit docker-compose.yml (vault path, port binding) and config/vault-api.yaml
docker compose run --rm vault-api token create reading-bot --name hermes
docker compose up -d
```

Inside the container the config must use `server.host: 0.0.0.0`. To control who can reach the server, use the port mapping instead, e.g. bind it to your tailnet IP only.

## Try it with Bruno

[`bruno/`](bruno) is a [Bruno](https://www.usebruno.com) collection (OpenCollection YAML) that covers every endpoint. Open the folder in Bruno and pick the **local** environment. Set `token` (secret) and `note`, an existing note path such as `Inbox`, and `baseUrl` if the server isn't on `127.0.0.1:8787`.

To run everything from the terminal:

```sh
cd bruno && npx @usebruno/cli run --env local --env-var token=vlt_… --env-var note=Inbox
```

The Notes, Files and Folders requests create files in `{{scratchFolder}}` (default `Bruno/`) and move them to the trash afterwards. The token needs `full` access to that folder, because the cleanup deletes files.

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
