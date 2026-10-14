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

## Search and stats

`GET /v1/search?q=` is BM25 full-text search over the notes the account can read. It stems Russian and English words, so `принтеры` finds `принтер`. It supports `"phrases"`, `-exclusions` and `prefix*` queries. `GET /v1/related?path=` returns similar notes (more-like-this), for agent recall. `GET /v1/stats` returns notes created and modified per day, week or month, plus named counters from a `stats:` config section, such as the inbox size or Reading List notes by `Status`. `/v1/stats/metrics` serves the same data as Prometheus text. The details are in [api-design.md](api-design.md#search-and-stats).

Demo against a vault, without touching any real config or token:

```sh
npx tsx scripts/demo-config.ts --vault ~/hermes-playground/_vault-snapshot   # writes out/demo/vault-api.yaml + fresh random tokens in out/demo/tokens.env
npx tsx src/cli.ts serve --config out/demo/vault-api.yaml                     # binds 100.66.44.47:8723 (tailnet only), read-only accounts
. out/demo/tokens.env; API=http://100.66.44.47:8723                         # --host 127.0.0.1 when off the tailnet

curl -s -H "Authorization: Bearer $ADMIN_TOKEN" $API/v1/stats/metrics | grep -E 'x_inbox|Not started'
# vault_folder_notes{counter="x_inbox",path="3. Resources/X/inbox"} 179
# vault_property_notes{counter="reading",property="Status",value="Not started"} 32

curl -s -G -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode 'q=pcb laser' \
  --data-urlencode 'fields=path,score,matched' --data-urlencode limit=3 $API/v1/search
# {"query":"pcb laser","total":6,"results":[{"path":"daily/2026-10-09.md","score":14.885,"matched":["pcb","laser"]},
#  {"path":"inbox/making PCBs in-house.md","score":14.703,…},{"path":"inbox/PCB with CNC + laser (Alvaro's Workshop).md",…}],…}

# Grants apply before scoring: the agent account has "3. Resources/X: none"
curl -s -G -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode 'q=bookmark' $API/v1/search | jq .total   # 229
curl -s -G -H "Authorization: Bearer $AGENT_TOKEN" --data-urlencode 'q=bookmark' $API/v1/search | jq .total   # 5

curl -s -G -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode 'q="reading list" -bot' $API/v1/search | jq .total   # phrase + exclusion

curl -s -G -H "Authorization: Bearer $ADMIN_TOKEN" --data-urlencode 'path=inbox/making PCBs in-house' \
  --data-urlencode limit=3 --data-urlencode fields=path $API/v1/related
# {"path":"inbox/making PCBs in-house.md","terms":["laser","lhs","pcb","etch","solder","copper",…],"total":145,
#  "results":[{"path":"inbox/PCB with CNC + laser (Alvaro's Workshop).md"},{"path":"daily/2026-10-09.md"},
#             {"path":"3. Resources/Electronics/paper circuit boards.md"}],…}
```

Use `curl -G --data-urlencode` (or Bruno) for Cyrillic queries: a raw non-ASCII URL is rejected with 400.

## Try it with Bruno

[`bruno/`](bruno) is a [Bruno](https://www.usebruno.com) collection (OpenCollection YAML) that covers every endpoint. Open the folder in Bruno and pick the **local** environment. Set `token` (secret) and `note`, an existing note path such as `Inbox`, and `baseUrl` if the server isn't on `127.0.0.1:8787`. For the Bases requests, also set `base` (e.g. `Reading List.base`) and `view` (one of its view names). The Search requests use `query`, and Related uses `note`.

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
| `src/search/` | Tokeniser (Snowball Russian, light English stemmer) and the BM25 index |
| `src/stats.ts` | Date buckets, property counters, Prometheus text |
| `src/http/` | Fastify server and routes |
| `src/cli.ts` | `serve`, `check`, `explain`, `token` |
