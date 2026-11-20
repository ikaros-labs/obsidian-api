<p align="center">
  <img src="assets/logo.svg" width="96" height="96" alt="Spall logo">
</p>

<h1 align="center">Spall</h1>

<p align="center">A scoped REST API, MCP server and CLI for your Obsidian vault: give every bot, script or agent its own spall of it.</p>

<p align="center">
  <a href="https://spall.nikmel.xyz">Website &amp; playground</a> ·
  <a href="#quickstart-60-seconds">Quickstart</a> ·
  <a href="#agents-mcp--cli">Agents (MCP + CLI)</a> ·
  <a href="https://github.com/ikaros-labs/spall/releases">Releases</a>
</p>

A spall is a flake struck off a stone, and obsidian is the classic stone for knapping. Spall serves a folder of markdown files over HTTP. Each account gets exactly the folders and permissions you grant it, and nothing else.

## Why

Most ways of reaching a vault from code give out **one key to the whole vault**. That's fine for your own laptop. It's not fine for a Telegram bot that only files links, an e-ink screen that shows one note, or an LLM agent that should see your projects but never your journal.

Spall gives each of them its own account:

- **Scoped to folders**, gitignore-style: the deepest matching path wins, and anything else simply doesn't exist for that account (**404, not 403**).
- **Headless.** Obsidian doesn't need to be running. Spall reads and writes plain markdown on disk, so it works with any sync (Syncthing, Obsidian Sync, git, …).
- **Notes, files and folders**: read, create, section-level `PATCH`, frontmatter edits, move, trash, and an audit log of every write.
- **Agents**: a built-in MCP server (`/mcp` over HTTP, or `spall mcp` over stdio) and a `spall` CLI, both with the same tokens and scopes. An agent only sees the tools its grants allow.
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

**AI agents.** Read your notes and work in a research folder, but never see the private subfolder. Connect it over [MCP or the CLI](#agents-mcp--cli):

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

The gauges are `spall_notes`, `spall_notes_created{window}` and `spall_notes_modified{window}` (24h, 7d, 30d), `spall_last_modified_timestamp_seconds`, `spall_folder_notes{counter,path}` and `spall_property_notes{counter,property,value}`.

## Agents (MCP + CLI)

Agents can use Spall without any glue code: through the **MCP endpoint** `POST /mcp` (Streamable HTTP, stateless), through **`spall mcp`** (stdio, for clients that only run local commands), or through the **`spall` CLI** (for agents with a shell). All three use an account token and go through the same REST checks, so scoping, 404-not-403, rate limits, revisions and the audit log are exactly the same as for REST calls.

**Tools.** An account sees only the tools its grants allow: a read-only account gets the first five, an `append` drop folder gets `spall_whoami` and `spall_create`.

| Tool | What it does | Needs |
|---|---|---|
| `spall_whoami` | Root, effective grants (hidden folders left out), rate limit and the MCP tools the account sees | – |
| `spall_search` | BM25 search over titles, folder names, tags, frontmatter values and text, or notes related to a note; paths and snippets with their heading, no bodies | `read` |
| `spall_list` | Folder entries (filtered by frontmatter with `where`/`missing`), a folder tree with note counts (`view=tree`), or tags with counts | `read` |
| `spall_read` | A note as markdown, outline (headings + `rev`, no body), frontmatter, one section, or its backlinks; a `.base` file's YAML or its views; long notes are cut at `max_chars` | `read` |
| `spall_query_base` | Evaluate a `.base` view or an ad-hoc Bases query | `read` |
| `spall_create` | Create a note from a title, or at an exact path; never overwrites | `create` |
| `spall_edit` | Atomic edits: append/prepend/replace under a heading or block, `replace_text`, frontmatter set/unset/merge (other lines stay byte-for-byte), whole-file replace; `.base` files as validated text; `expected_rev` guards against lost updates | `update` |
| `spall_move` | Move or rename; a destination ending in `/` or an existing folder moves into it | `update` + `delete` |
| `spall_trash` | Move to the trash (never permanent); the only tool marked destructive | `delete` |

Note text (bodies, search snippets, frontmatter in listings, Bases row values) comes back wrapped in `<untrusted-content …>` markers, one fence per note with its path; paths and counts stay outside, and the server instructions tell the model not to follow instructions inside them (`mcp.fence_untrusted`, on by default). Vaults hold imported articles and tweets, so this matters.

**Narrowing.** Tools can be hidden, never added: per account in the config (`mcp: {read_only: true, tools: [...]}`), per connection with `/mcp?read_only=1&tools=spall_search,spall_read`, or with `spall mcp --read-only --tools …`. Hiding a tool is a convenience; the REST checks are what enforce access.

**Rate limits.** Each tool call counts as the REST calls it makes: one for most tools, two for `spall_edit` (it reads the note first for the previous rev and the change summary), three when an edit that targets a heading fails on a stale rev (it fetches the current section). MCP protocol traffic itself (`initialize`, `tools/list`) isn't counted.

### Connect a client

Replace the URL and token with yours. Use the token of an account made for the agent, like the `agent` example above.

**Claude Code:**

```sh
claude mcp add --transport http spall http://127.0.0.1:8787/mcp --header "Authorization: Bearer spl_…"
```

**Codex** (`~/.codex/config.toml`, with `SPALL_TOKEN` in the environment):

```toml
[mcp_servers.spall]
url = "http://127.0.0.1:8787/mcp"
bearer_token_env_var = "SPALL_TOKEN"
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`), or [add it with a link](cursor://anysphere.cursor-deeplink/mcp/install?name=spall&config=eyJ1cmwiOiJodHRwOi8vMTI3LjAuMC4xOjg3ODcvbWNwIiwiaGVhZGVycyI6eyJBdXRob3JpemF0aW9uIjoiQmVhcmVyIHNwbF9ZT1VSX1RPS0VOIn19) and edit the URL and token:

```json
{
  "mcpServers": {
    "spall": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer spl_…" }
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`; it runs `spall mcp` locally over stdio):

```json
{
  "mcpServers": {
    "spall": {
      "command": "npx",
      "args": ["-y", "@ikaros-labs/spall", "mcp"],
      "env": { "SPALL_URL": "http://127.0.0.1:8787", "SPALL_TOKEN": "spl_…" }
    }
  }
}
```

**Hermes** (`config.yaml`):

```yaml
mcp_servers:
  spall:
    url: http://127.0.0.1:8787/mcp
    headers:
      Authorization: Bearer spl_…
```

Any other stdio client: run `npx -y @ikaros-labs/spall mcp` with `SPALL_URL` and `SPALL_TOKEN` set. Browser Origins are rejected unless listed in `mcp.allowed_origins`; requests without an Origin (CLIs, agents) are allowed.

### CLI

`npm i -g @ikaros-labs/spall` (or `npx -y @ikaros-labs/spall …`; the command is `spall` either way), then set `SPALL_URL` and `SPALL_TOKEN` in the environment (`--url` can replace `SPALL_URL`; the token is never taken from the command line, so it stays out of process listings and shell history). For shell agents (Claude Code, Codex, Hermes), [`skills/spall/SKILL.md`](skills/spall/SKILL.md) is a ready-made skill that teaches the commands below.

```
spall whoami                                   # root, grants (one line per folder), rate limit, MCP tools
spall search <query> [--folder F] [--any] [--limit N] | spall search --related <path>
spall ls [folder] [--all] [--sort -modified] [--frontmatter] [--where "Status=Done"] [--missing Key]   # --missing: absent or empty (Key:, "", [])
spall tree [folder] [--depth N] [--limit N]    # folders only, indented, with note counts
spall tags [folder]
spall read <path>                              # raw markdown, pipeable
spall read <path> --outline | --frontmatter | --section "Notes > Highlights" | --backlinks
spall read <file.base> [--outline]             # a base's YAML, or its views
spall new <folder> <title> [--body text|-] [--fm key=value ...]
spall edit <path> [--rev R] [--set k=v] [--unset k] [--append-to H] [--prepend-to H]
          [--replace-section H] [--append] [--replace-all] [--content text|-] [--replace OLD --with NEW] [--ops file.json|-]
spall mv <path> <destination> | spall trash <path> [--rev R]   # destination "Folder/" moves into it
spall base <file.base> [--view V] [--limit N] [--cursor C] | spall base <file.base> --views
spall mcp [--read-only] [--tools a,b]          # MCP over stdio
spall doctor                                   # URL reachable, token valid, grants, MCP enabled
```

Paths with spaces or a leading number are printed in double quotes (`"1. Projects/Tram Board.md"`), ready to paste back. A not-found error suggests close paths the account can see. Every command takes `--json`. Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 forbidden, 5 rev conflict, 6 rate limited, 7 auth.

```
$ spall read Research/Plan --outline
rev: sha256:071a36b954f871a3
# Plan  (line 6)
  ## Notes  (line 10)
    ### Highlights  (line 14)
$ spall edit Research/Plan --rev sha256:071a36b954f871a3 --append-to "Notes > Highlights" --content "- new point"
Research/Plan.md
rev: sha256:082f85f1f14f1b25  (changed lines: +1 −0)
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
  path: /var/lib/spall/audit.jsonl   # optional: two JSON lines per write (intent, result)
defaults:
  rate_limit: 120/min      # per account; sec, min or hour
mcp:
  enabled: true            # default; false = /mcp answers 404
  allowed_origins: []      # browser Origins allowed to call /mcp (none by default)
  fence_untrusted: true    # default: wrap note text in <untrusted-content> for MCP clients
accounts:
  <name>:
    description: …
    root: Some/Folder      # optional: the account sees this folder as "/"
    rate_limit: 600/min    # optional
    access:                # path (relative to root) → level
      .: read
      Some/Sub: none
    mcp:                   # optional: hide MCP tools for this account (never adds any)
      read_only: false
      tools: [spall_search, spall_read]
      fence_untrusted: true
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

All endpoints are under `/v1` (plus `/mcp`, see [Agents](#agents-mcp--cli)) and take `Authorization: Bearer <token>`. Paths are relative to the account root, percent-encoded per segment; `.md` can be left off for notes. The full reference is [`openapi.json`](openapi.json), also served by every instance at `GET /openapi.json`.

| Endpoint | What |
|---|---|
| `GET /v1/me` | The calling account: root, effective grants (hidden folders left out), token, the MCP tools it sees and whether results are fenced |
| `GET /v1/notes/{path}` | A note as JSON (frontmatter, body, links, tags), raw markdown (`Accept: text/markdown`) or an outline. `ETag`; `If-None-Match` → 304 |
| `PUT /v1/notes/{path}` | Create or replace (markdown or `{frontmatter, body}`); `If-Match` → 412 on conflict |
| `POST /v1/notes` | Create from `{folder, title, frontmatter?, body?}` |
| `PATCH /v1/notes/{path}` | `{"ops": [...]}`: append/prepend/replace under a heading or block, `frontmatter.set` / `unset` / `merge`, `replace_text` |
| `DELETE /v1/notes/{path}` | Move to the trash (`?permanent=true` needs `purge`) |
| `POST /v1/notes/{path}/move` | Move or rename; a destination ending in `/` or an existing folder moves into it (links are not rewritten) |
| `/v1/files/{path}` | The same for any file, as raw bytes (`Range` supported) |
| `GET /v1/folders/{path}` | List: `depth`, `kind`, `sort`, `sample`, `include=frontmatter,body`, `where`, `missing`, cursors |
| `GET /v1/tree/{path}` | Folder tree with note counts: `depth`, `limit` |
| `GET /v1/count/{path}`, `GET /v1/tags` | Counts and tags over readable notes |
| `GET /v1/bases/{path}`, `POST /v1/bases/{path}/query`, `POST /v1/query` | Obsidian Bases: read a `.base`, evaluate a view, or run an ad-hoc query |
| `GET /v1/search`, `GET /v1/related` | BM25 search (`"phrases"`, `-exclusions`, `prefix*`) and more-like-this |
| `GET /v1/stats`, `GET /v1/stats/metrics` | Created/modified series and counters, as JSON or Prometheus text |
| `POST /mcp` | MCP (Streamable HTTP, stateless; not in the OpenAPI document) |
| `GET /healthz`, `GET /openapi.json` | No auth; `/healthz` returns the version |

Errors always use one envelope: `{"error": {"code": "…", "message": "…", "request_id": "…"}}`. The design notes behind all of this are in [api-design.md](api-design.md). [`bruno/`](bruno) is a [Bruno](https://www.usebruno.com) collection covering every endpoint.

## Server CLI

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
- **Turn on the audit log** (`audit.path`, also outside the vault) to get two JSON lines per write, joined by the request id. The **intent** line is written before the vault is touched. It holds the time, account, token, operation, path and revisions. The **result** line comes after the change, with `outcome: ok` or `outcome: failed` and an error code. If the intent can't be written, the write is refused with `500 audit_unavailable` and nothing changes, so no change goes unlogged. If only the result line is lost, the client still gets the real outcome and the server logs an error. An intent with no result means the outcome is unknown; check the vault.
  ```json
  {"time":"…","request":"3f1c…","op":"patch","phase":"intent","account":"agent","token":"laptop","path":"Research/Plan.md","old_rev":"sha256:…","new_rev":"sha256:…","ops":["append"]}
  {"time":"…","request":"3f1c…","op":"patch","phase":"result","outcome":"ok"}
  ```
- **What a scope doesn't hide:** a readable note's text can mention hidden notes by name; Spall doesn't redact note bodies.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Compared to

| | Spall | [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin | Obsidian MCP servers |
|---|---|---|---|
| Runs | Standalone server / Docker | Inside the Obsidian app | Usually a local process per AI client |
| Needs Obsidian running | No | Yes | Depends on the server |
| Access control | Per account, per folder, per permission | One API key, whole vault | Usually the whole vault |
| Clients | Anything that speaks HTTP, MCP clients, shell agents (CLI) | Anything that speaks HTTP | MCP clients (LLM apps) |
| MCP | Built in: `/mcp` (HTTP) and `spall mcp` (stdio); tools follow the account's grants | No; needs a separate MCP server | Yes |
| Obsidian commands, plugins, active file | No | Yes | Some |

What Spall can't do: it doesn't run Obsidian commands or plugins (no Dataview, no Templater), doesn't rewrite links when you move notes, has no OAuth yet (so no Claude.ai or ChatGPT remote connectors; local and token-based MCP clients work), no file/attachment tools over MCP, no semantic/embedding search, and no admin API (accounts live in the YAML). One server serves one vault.

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
npm i @ikaros-labs/spall
```

```ts
import { accessFromConfig, parsePlainPath } from '@ikaros-labs/spall/access';
const access = accessFromConfig({ access: { Notes: 'read', 'Notes/Private': 'none' } });
access.decide(parsePlainPath('Notes/Private/diary.md')); // { perms: Set {}, reason: 'grant', key: 'Notes/Private' }
```

## License

[MIT](LICENSE). Spall is an independent project, not affiliated with or endorsed by Obsidian.
