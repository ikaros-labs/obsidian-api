# Spall

**A scoped REST API for your Obsidian vault: give every bot, script or agent its own spall of it.**

A spall is a flake struck off a stone, and obsidian is the classic stone for knapping. Spall serves a folder of markdown files over HTTP. Each account gets exactly the folders and permissions you grant it, and nothing else.

Landing page and playground: **https://spall.nikmel.xyz**

## Why

Most ways of reaching a vault from code give out **one key to the whole vault**. That's fine for your own laptop. It's not fine for a Telegram bot that only files links, an e-ink screen that shows one note, or an LLM agent that should see your projects but never your journal.

Spall gives each of them its own account:

- **Scoped to folders**, gitignore-style: the deepest matching path wins, and anything else simply doesn't exist for that account (**404, not 403**).
- **Headless.** Obsidian doesn't need to be running. Spall reads and writes plain markdown on disk, so it works with any sync (Syncthing, Obsidian Sync, git, …).
- **Notes, files and folders**: read, create, section-level `PATCH`, frontmatter edits, move, trash, and an audit log of every write.
- **Bases**: evaluates Obsidian `.base` files and ad-hoc queries without Obsidian.
- **Search** (BM25, English + Russian stemming), related notes, stats and Prometheus metrics, all computed over only what the account can read.
- **One YAML file** with hot reload, and a CLI that explains *why* an account can or can't reach a path.

## Quickstart (60 seconds)

You need Docker and a vault. Make a folder next to (not inside) the vault:

```sh
mkdir -p spall/config spall/data && cd spall
```

`docker-compose.yml`:

```yaml
services:
  spall:
    image: ghcr.io/ikaros-labs/spall:latest
    restart: unless-stopped
    user: "1000:1000"            # the user that owns the vault files; with rootless Docker use "0:0"
    ports:
      - "127.0.0.1:8787:8787"    # or your tailnet IP
    volumes:
      - ./config:/config
      - /path/to/your/vault:/vault
      - ./data:/data
```

`config/spall.yaml`:

```yaml
version: 1
server:
  host: 0.0.0.0        # inside the container; the port mapping decides who can reach it
vault:
  path: /vault
audit:
  path: /data/audit.jsonl
accounts:
  reading-bot:
    access:
      Reading List: edit   # a folder in your vault
```

Create a token (it's printed once, and only its hash is written to the config), then start the server:

```sh
docker compose run --rm spall token create reading-bot --name laptop
# Created token "laptop" for reading-bot. It is shown only once:
# spl_…
docker compose up -d
TOKEN=spl_…
```

The bot can read its folder:

```sh
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/v1/folders/Reading%20List"
# 200 {"path":"Reading List","total":{"notes":…},"results":[…],"next_cursor":null,"has_more":false}
```

Everything else is invisible. Whether `Journal` exists or not, the answer is the same:

```sh
curl -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8787/v1/folders/Journal"
# 404 {"error":{"code":"not_found","message":"Not found","request_id":"…"}}
```

## Use cases

**Reading-list bot.** A Telegram bot that saves links into one folder, and sees that folder as `/`:

```yaml
reading-bot:
  root: Reading List
  access:
    .: [read, create, update]
```

**E-ink dashboard.** Reads exactly one note, and cannot even list the folder it's in:

```yaml
eink:
  access:
    Dashboards/eink.md: read
```

**AI agents.** Read your notes and work in a research folder, but never see the private subfolder:

```yaml
agent:
  rate_limit: 600/min
  access:
    Research: edit
    Research/inbox: full
    Notes: read
    Notes/Private: none
```

**Grafana.** Notes created/modified per day and named counters as JSON (`/v1/stats`, works with the Infinity datasource) or Prometheus text (`/v1/stats/metrics`):

```yaml
stats:
  timezone: Europe/Berlin
  folders:
    inbox: Inbox
  properties:
    reading: { folder: Reading List, property: status }
accounts:
  grafana:
    access:
      .: read
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: spall
    metrics_path: /v1/stats/metrics
    authorization: { credentials: spl_… }
    static_configs: [{ targets: ["spall:8787"] }]
```

## Configuration

The config file must live **outside** the vault (the server refuses to start otherwise). It reloads when the file changes or on `SIGHUP`. If the new version is invalid, the server keeps the old one and logs why.

```yaml
version: 1
server:
  host: 127.0.0.1          # default
  port: 8787               # default
  max_body: 10mb           # default
vault:
  path: /srv/vault         # relative paths are relative to the config file
  trash: .trash            # DELETE moves files here; "none" = only permanent delete
  follow_symlinks: false   # default; when true, the target is checked again
  exclude: [Private]       # denied for every account
audit:
  path: /var/lib/spall/audit.jsonl   # optional: one JSON line per write
defaults:
  rate_limit: 120/min      # per account; sec, min or hour
accounts:
  <name>:
    description: …
    root: Some/Folder      # optional: the account sees this folder as "/"
    rate_limit: 600/min    # optional
    access:                # path (relative to root) → level
      .: read
      Some/Sub: none
    tokens: []             # managed by `spall token`
```

**Levels**

| Level | Permissions |
|---|---|
| `none` | nothing |
| `read` | read |
| `append` | create only, without read: a write-only drop folder |
| `edit` | read, create, update |
| `full` | read, create, update, delete (to the trash) |
| `[read, create, …]` | an explicit list of `read`, `create`, `update`, `delete`, `purge`. `purge` (permanent delete) can only be granted this way. `update`, `delete` and `purge` require `read`. |

**Rules**

- **Deepest grant wins.** A path takes the level of its most specific matching key; key order doesn't matter. No key means `none`. Keys are exact paths (no globs); `.` is the root.
- **Matching ignores case and trailing dots and spaces**, and paths are Unicode-NFC-normalised, so `notes/private.` is still `Notes/Private`.
- **Always denied:** dotfiles and dot-folders (`.obsidian`, `.git`, `.trash`, …), anything in `vault.exclude`, and anything outside the account's `root`.
- **Parent folders** on the way to a grant are listed (marked `traverse_only: true`) so the account can navigate, but they can't be read and only show the granted branch.
- **404, not 403.** Anything the account can't read returns 404, exactly like a path that doesn't exist. 403 means "you can see this, but you may not do that" (e.g. writing with `read`).
- Symlinks are not followed unless `follow_symlinks: true`; then the real path must be inside the vault and is checked against the grants again.

## API

All endpoints are under `/v1` and take `Authorization: Bearer <token>`. Paths are relative to the account root, percent-encoded per segment; `.md` can be left off for notes. The full reference is [`openapi.json`](openapi.json), also served by every instance at `GET /openapi.json`.

| Endpoint | What |
|---|---|
| `GET /v1/me` | The calling account, its root and grants |
| `GET /v1/notes/{path}` | A note as JSON (frontmatter, body, links, tags), raw markdown (`Accept: text/markdown`) or an outline. `ETag`; `If-None-Match` → 304 |
| `PUT /v1/notes/{path}` | Create or replace (markdown or `{frontmatter, body}`); `If-Match` → 412 on conflict |
| `POST /v1/notes` | Create from `{folder, title, frontmatter?, body?}` |
| `PATCH /v1/notes/{path}` | `{"ops": [...]}`: append/prepend/replace under a heading or block, `frontmatter.set` / `unset` / `merge`, `replace_text` |
| `DELETE /v1/notes/{path}` | Move to the trash (`?permanent=true` needs `purge`) |
| `POST /v1/notes/{path}/move` | Move or rename (links are not rewritten) |
| `/v1/files/{path}` | The same for any file, as raw bytes (`Range` supported) |
| `GET /v1/folders/{path}` | List: `depth`, `kind`, `sort`, `sample`, `include=frontmatter,body`, cursors |
| `GET /v1/count/{path}`, `GET /v1/tags` | Counts and tags over readable notes |
| `GET /v1/bases/{path}`, `POST /v1/bases/{path}/query`, `POST /v1/query` | Obsidian Bases: read a `.base`, evaluate a view, or run an ad-hoc query |
| `GET /v1/search`, `GET /v1/related` | BM25 search (`"phrases"`, `-exclusions`, `prefix*`) and more-like-this |
| `GET /v1/stats`, `GET /v1/stats/metrics` | Created/modified series and counters, as JSON or Prometheus text |
| `GET /healthz`, `GET /openapi.json` | No auth |

Errors always use one envelope: `{"error": {"code": "…", "message": "…", "request_id": "…"}}`. The design notes behind all of this are in [api-design.md](api-design.md). [`bruno/`](bruno) is a [Bruno](https://www.usebruno.com) collection covering every endpoint.

## CLI

```
spall serve                                  # start the server
spall check                                  # validate the config, print every account's grants
spall explain <account> <path>               # why an account may or may not reach a path
spall token create <account> [--name n] [--expires 2027-10-01]
spall token list [account]
spall token revoke <account> <name>
```

Every command takes `-c <config>` (default: `$SPALL_CONFIG`, else `./spall.yaml`). In Docker, prefix them with `docker compose run --rm spall`.

```
$ spall explain agent Notes/Private/diary.md
Notes/Private/diary.md → none (key: Notes/Private)
  vault path: Notes/Private/diary.md
```

## Security notes

- **Keep the config outside the vault.** Spall refuses to start otherwise, so a synced vault can't grant itself access.
- **Bind to localhost or a tailnet**, not the open internet. Spall speaks plain HTTP; put a TLS proxy in front if it must leave the machine.
- **Tokens** are 256-bit random values. Only their SHA-256 is stored; they can expire, and an account can have several for rotation.
- **Deletes go to the trash** (`vault.trash`) unless the account has `purge` and asks for `permanent=true`.
- **Turn on the audit log** (`audit.path`, also outside the vault) to get one line per write: time, account, token, operation, path and revisions.
- **What a scope doesn't hide:** a readable note's text can mention hidden notes by name; Spall doesn't redact note bodies.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Compared to

| | Spall | [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin | Obsidian MCP servers |
|---|---|---|---|
| Runs | Standalone server / Docker | Inside the Obsidian app | Usually a local process per AI client |
| Needs Obsidian running | No | Yes | Depends on the server |
| Access control | Per account, per folder, per permission | One API key, whole vault | Usually the whole vault |
| Clients | Anything that speaks HTTP | Anything that speaks HTTP | MCP clients (LLM apps) |
| Obsidian commands, plugins, active file | No | Yes | Some |

What Spall can't do: it doesn't run Obsidian commands or plugins (no Dataview, no Templater), doesn't rewrite links when you move notes, has no MCP endpoint (agents call it over HTTP), no semantic/embedding search, and no admin API (accounts live in the YAML). One server serves one vault.

## Develop

```sh
npm install
npm test             # vitest; API tests run against a temp copy of test/fixtures/vault
npm run typecheck
npm run openapi      # regenerate openapi.json after changing a route
npm run cli -- check -c spall.yaml
```

The access rules are also published as a browser-safe module (no Node APIs), which the landing-page playground uses:

```sh
npm i github:ikaros-labs/spall
```

```ts
import { accessFromConfig, parsePlainPath } from 'spall/access';
const access = accessFromConfig({ access: { Notes: 'read', 'Notes/Private': 'none' } });
access.decide(parsePlainPath('Notes/Private/diary.md')); // { perms: Set {}, reason: 'grant', key: 'Notes/Private' }
```

## License

[MIT](LICENSE). Spall is an independent project, not affiliated with or endorsed by Obsidian.
