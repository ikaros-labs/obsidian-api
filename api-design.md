# Spall: proposal v1

Status: final proposal, 1 Oct 2026. For the idea and the prior-art research, see [[obsidian-api]].

A self-hosted REST server over a folder of markdown files (an Obsidian vault or any other). It is multi-account, and each account sees only the folders it has been granted.

## Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript, chosen so the Bases expression library can be reused later |
| Interface | REST is the only security boundary. MCP (`/mcp` and `spall mcp` over stdio) and the client CLI are built on it (see *MCP and the client CLI*, added in 1.1) |
| Write scope | Full CRUD, plus a targeted PATCH |
| Vault | Any folder of `.md` files. Doesn't require Obsidian or a particular sync tool |
| Timestamps | Filesystem only: `created` = birth time (falls back to mtime), `modified` = mtime |
| Endpoints | `/notes` (understands markdown) and `/files` (raw bytes) are separate |
| Per-account `root` | Yes. The account sees a chosen folder as its root, `/` |
| Moving notes | Never rewrites links |
| Access model | Grants on the folder tree: the most specific path wins. No globs |
| Account management | A YAML config file plus a token CLI. No admin API |
| v1 leaves out | Search and stats. Bases and query, then search and stats, were added later (see *Bases* and *Search and stats*) |

## Principles

1. **Works on any folder.** It understands Obsidian conventions (frontmatter, wikilinks, tags) but doesn't depend on them.
2. **Scoping is the product.** Every response is filtered by the account's access *before* anything is computed, including counts, totals, tags and backlinks. Anything outside the scope returns **404, never 403**. 403 means "you can see this, but you can't do that".
3. **One shape per endpoint.** A note endpoint always returns a note and a folder endpoint always returns a listing.
4. **Raw markdown is a first-class format.** `Accept: text/markdown` returns the file unchanged.
5. **Writes are safe by default.** Writes use optimistic concurrency (`rev` + `If-Match`), deletes go to the trash, and paths are made canonical and checked one segment at a time.

---

## Conventions

- **Base URL and auth.** All endpoints live under `/v1` and require `Authorization: Bearer spl_…`.
- **Paths** are relative to the account's root, and each segment is percent-encoded: `/v1/notes/Research/Some%20note.md`. The `.md` can be left off for notes.
- **`rev`** is a truncated content hash (`sha256:9f2c…`), sent both as a JSON field and as the `ETag` header.
  - `If-Match: <rev>` on a write returns **412 `rev_mismatch`** if the file has changed.
  - `If-None-Match: *` makes the write create-only.
  - `If-None-Match: <rev>` on a GET returns **304** if nothing changed.
- **Timestamps** are ISO 8601 in UTC.
- **Pagination** uses one envelope everywhere: `{ "results": [...], "next_cursor": "…"|null, "has_more": bool }`.
  - `limit` defaults to 50, with a maximum of 500.
  - Cursors are opaque, and are bound to the account and the request parameters (but not to `limit` or `fields`, so the next page can be bigger). A cursor sent with other parameters is a 400 that names them: `Invalid cursor: depth, sort changed …`, with `details.changed`.
  - `next_cursor` is null, and `has_more` false, once everything has been returned.
- **`fields=`** is an optional list of the fields to return: `fields=path,frontmatter.status,modified`.
- **Limits:** URLs over 16 KiB return 414. Path-like query parameters are capped at 1,024 characters, and `fields`/`cursor` at 512. Malformed HTTP (e.g. raw non-ASCII bytes in the URL) gets the same JSON error envelope. Unexpected errors never include messages or stack traces.
- **Errors** use one envelope:
  ```json
  { "error": { "code": "rev_mismatch", "message": "…", "request_id": "…", "details": { "current_rev": "…" } } }
  ```
  A `not_found` for a path can carry `details.did_you_mean`: up to three visible paths close to the one asked for (without `1. `-style prefixes, case or `.md`; the same name elsewhere; a near-miss spelling). Only paths the account can see are candidates, so the response for a hidden path is the same as for a missing one.
  The codes are `unauthorized`, `not_found`, `forbidden`, `already_exists`, `rev_mismatch`, `invalid_path`, `invalid_request`, `patch_target_not_found`, `patch_target_ambiguous`, `folder_not_empty`, `payload_too_large`, `rate_limited` and `audit_unavailable` (500: the audit log can't be written, so the write was refused and nothing changed; safe to retry).

---

## Endpoints

### `GET /v1/me`
Returns what the caller can actually do: the account name, its root, its effective grants, the rate limit, the token's name and expiry, and the MCP tools it sees.

```json
{
  "account": "reader", "description": null, "root": "",
  "access": [{ "path": ".", "permissions": ["read"] }],
  "rate_limit": "120/min",
  "token": { "name": "laptop", "expires": null },
  "mcp": { "enabled": true, "tools": ["spall_whoami", "spall_search", "spall_list", "spall_read", "spall_query_base"], "fenced": true }
}
```

- `access` lists only grants with at least one permission. A hidden folder (a grant with no permissions) is left out, so it looks the same as a folder that doesn't exist (see 404-not-403 above).
- `mcp.tools` is the tool list `/mcp` gives this account: its grants narrowed by the account's `mcp` config. With MCP off on the server, `enabled` is `false` and `tools` is `[]`. `mcp.fenced` says whether MCP results fence note text for this account (its effective `fence_untrusted`). The raw `mcp` config (`read_only`, `tools: null`) is not reported.

### Notes

#### `GET /v1/notes/{path}`

| Accept | Returns |
|---|---|
| `text/markdown` (default) | The raw file, with `ETag` and `Last-Modified` headers |
| `application/json` | The Note object (below) |
| `application/vnd.vault.outline+json` | `{ rev, headings: [tree], blocks: [ids], frontmatter_keys: [...] }`: everything a PATCH can target |

```json
{
  "path": "Some article.md",
  "name": "Some article",
  "rev": "sha256:9f2c…",
  "created": "2026-09-12T08:10:00Z",
  "modified": "2026-09-30T19:02:11Z",
  "size": 4211,
  "frontmatter": { "status": "to-read", "url": "https://…" },
  "body": "# Some article\n…",
  "tags": ["ai", "longread"],
  "links": [{ "target": "Other note", "path": "Other note.md", "resolved": true }],
  "backlinks": ["…"]
}
```
- `body` doesn't include the frontmatter. `tags` combines frontmatter tags with inline `#tags`.
- Links are resolved within the account's scope. A target the account can't read comes back as `resolved: false, path: null`.
- `backlinks` is only included with `?include=backlinks`. It lists only the notes the account can read.

#### `PUT /v1/notes/{path}`
Creates or replaces a note.
- The body is either `text/markdown` (the whole file) or JSON `{ frontmatter, body }`.
- Combine with `If-None-Match: *` to only create, or `If-Match: <rev>` to only replace that revision.
- Returns 201 for a new note or 200 for a replaced one, with the Note object minus `body`. Accounts with `append` access get only `{ path, rev }` back.

#### `POST /v1/notes`
Creates a note and lets the server pick the filename. This is how the bot saves an article.
```json
{ "folder": "", "title": "How LLMs work: part 1/3", "frontmatter": { "url": "…", "status": "to-read" }, "body": "…", "on_conflict": "rename" }
```
- `folder` is relative to the account's root; `""` (the default) is the root itself.
- The title is cleaned into a valid filename, e.g. `How LLMs work part 1-3.md`.
- `on_conflict` is `rename` (the default: appends ` 1`, ` 2`, …) or `fail`, which returns 409.
- Returns 201 with the Note, or just `{ path, rev }` for `append`-only accounts.

#### `PATCH /v1/notes/{path}`
Applies a list of operations **atomically**: either all of them succeed or none do.
```json
{
  "if_match": "sha256:9f2c…",
  "ops": [
    { "op": "frontmatter.set",   "key": "status", "value": "read" },
    { "op": "frontmatter.unset", "key": "snooze" },
    { "op": "frontmatter.merge", "value": { "tags": ["done"] } },
    { "op": "append",  "target": { "heading": ["Notes", "Highlights"] }, "content": "- new highlight" },
    { "op": "prepend", "target": { "block": "abc123" }, "content": "…" },
    { "op": "replace", "target": { "heading": ["Summary"] }, "content": "…" },
    { "op": "append",  "content": "goes to the end of the file" },
    { "op": "replace_text", "old": "exact old string", "new": "new string", "count": 1 }
  ]
}
```
- **Targets:**
  - Leave `target` out to act on the whole body.
  - A heading is matched by its text path, e.g. `["Notes", "Highlights"]`.
  - If a heading path matches more than one heading, you get `patch_target_ambiguous`, which lists the candidates. Retry with `{ "heading": [...], "index": n }`.
- **Content** is written exactly as given. Heading levels are never adjusted.
- **`replace_text`** fails if the string isn't found, or if it's found more times than `count` allows.
- **`frontmatter.merge`** concatenates lists, merges objects, and replaces anything else.
- **Frontmatter ops touch only their key.** Every other byte of the frontmatter stays as written (flow lists like `[ai]`, quotes, comments, spacing, key order). A changed scalar keeps its quote style and a changed flow list stays flow. A new key is added at the end. The fence lines (CRLF, a `...` closing fence) are kept as well. Only a frontmatter that is not a plain block mapping (e.g. `{a: 1}`) is re-serialized. Before anything is written, the result must parse (aliases included) to exactly the old data with the requested change; otherwise the op fails and the file is unchanged. Changing or removing a value that defines a YAML anchor used by an alias elsewhere returns 400 `invalid_request` (edit it with `replace_text`).
- **The blank line(s) after the frontmatter are kept** by whole-body ops; appending to an empty body adds one.
- **Response:** the new `rev` plus the Note minus `body`. Add `?return=full` to include the body.

#### `DELETE /v1/notes/{path}`
- Moves the note to the trash and returns 204.
- `?permanent=true` deletes it for good, and requires `purge` access.
- Supports `If-Match`.

#### `POST /v1/notes/{path}/move`
```json
{ "destination": "Archive/Some article.md", "on_conflict": "fail" }
```
- Requires `update` + `delete` access on the source and `create` on the destination.
- **Into a folder:** a destination ending in `/` (e.g. `"Archive/"`), or naming an existing folder the account can see, means "move into that folder, keeping the file name". A folder the account can't see is treated as a file name, so hidden and missing folders behave the same.
- Links pointing to the note are **not** rewritten.

#### Not a note
A path under `/v1/notes/` that names a visible non-note file (`Reading List.base`, `cover.png`) and has no `….md` twin the account can read returns 400 `not_a_note`, with `details.kind` (`base` or `file`) and `details.use` (the endpoint to use). Hidden and missing files return 404 as usual.

### Files (attachments, and any file that isn't a note)

| Endpoint | Behaviour |
|---|---|
| `GET /v1/files/{path}` | Raw bytes with the right `Content-Type`; supports `ETag`, `Range` and 304 |
| `PUT /v1/files/{path}` | Uploads raw bytes; supports `If-Match` / `If-None-Match` |
| `DELETE /v1/files/{path}` | Same as for notes |
| `POST /v1/files/{path}/move` | Same as for notes |

A `.md` file can also be reached here as plain bytes.

A `PUT` of a `.base` file is validated first: it must be YAML with a valid base structure, and every filter and formula expression must parse. Otherwise it returns 422 `invalid_base` (with `details.yaml_error` for YAML that doesn't parse, `details.issues` for the structure and `details.diagnostics` for expressions) and nothing is written. This is how `.base` files are edited; create and update grants apply as for notes.

### Folders

#### `GET /v1/folders/{path}`
An empty `{path}` means the account's root.

Query parameters:
- `depth`: `1` or `all` (default `1`)
- `kind`: `note`, `file`, `folder` or `all`
- `sort`: `name`, `created` or `modified`, with a `-` prefix for descending
- `limit` and `cursor` for paging
- `sample=N`: returns N random entries from the filtered set instead of a page, for the reading-list bot. Add `seed=` to get the same picks again.
- `include=body,frontmatter`: inlines note bodies and/or frontmatter (`body` only with `sample` or a `limit` of 20 or less)
- `where=Key=Value` (repeatable, ANDed): notes whose frontmatter matches. Operators `=`, `!=`, and `>`, `>=`, `<`, `<=` with a number or a `YYYY-MM-DD` date. `=` matches any item of a list and ignores the value's case; `Key=` matches empty or missing values; `!=` also matches notes without the key.
- `missing=Key` (repeatable): notes where that property is absent or empty: `Key:` (null), `""` or blank text, or `[]`. Obsidian shows all of these as empty (Properties panel, Bases `isEmpty()`), and templates often write an empty key (`Completed:`) on every unfinished note. A key that is present but empty still counts as a known property for the 400 below.
- With `where` or `missing`, only notes are listed. Property names are case-sensitive, as in Obsidian. A name that no listed note has is a 400 naming it (`details.unknown_properties`, with `did_you_mean` for the same name in another case), and so is a condition that doesn't parse.

```json
{
  "path": "",
  "total": { "entries": 219, "notes": 214, "files": 3, "folders": 2 },
  "results": [
    { "kind": "folder", "path": "Archive" },
    { "kind": "note", "path": "Some article.md", "name": "Some article", "rev": "…", "created": "…", "modified": "…", "size": 4211 }
  ],
  "next_cursor": null, "has_more": false
}
```
- `total` covers the whole filtered set, not just the current page. `entries` counts everything that matched (traverse-only folders too), so `results` across all pages add up to it.
- Folders and entries the account can't see are left out of both `results` and `total`.
- Parent folders of a granted path are shown so the account can find its way there, marked `"traverse_only": true`. They list only the branch that leads to the grant and aren't counted in `total`. See *Ancestor visibility* under *Access model*.

#### `GET /v1/tree/{path}`
The folders under a folder, without their notes: an overview of how a vault is organised. An empty `{path}` means the account's root.

Query parameters: `depth` (folder levels to list, 1–20, default 3) and `limit` (folders listed, 1–2000, default 200).
```json
{ "path": "", "depth": 3, "notes": 114, "total_folders": 20,
  "folders": [
    { "path": "1. Projects", "name": "1. Projects", "depth": 1, "notes": 16 },
    { "path": "1. Projects/Archive", "name": "Archive", "depth": 2, "notes": 2, "more_folders": 1 },
    { "path": "Private", "name": "Private", "depth": 1, "notes": 3, "traverse_only": true }
  ],
  "truncated": false }
```
- `folders` is depth-first in name order, so it reads as an indented tree.
- `notes` counts the readable notes in the folder and everything below it, also below `depth`. `more_folders` counts the subfolders below `depth` that aren't listed.
- Past `limit`, `truncated` is true and `omitted` says how many folders within `depth` were left out.
- Scoped like a listing: hidden folders and notes are neither listed nor counted, and parents shown only on the way to a grant are marked `traverse_only`.

#### `GET /v1/count/{path}`
Counts what's in a folder without listing it. An empty `{path}` means the account's root.

Query parameters: `depth` (`1` or `all`, default `1`) and `kind` (`note`, `file`, `folder` or `all`), with the same meaning as in the listing.
```json
{ "path": "", "depth": "all", "notes": 214, "files": 3, "folders": 2 }
```
- Only entries the account can see are counted; parent folders shown only to reach a grant are not counted.
- When `kind` is set, only that count is returned, e.g. `{ "path": "", "depth": "1", "notes": 214 }`.
- Works on any folder the account can list, including a traverse-only parent folder. The numbers come from the in-memory index, so a count costs nothing even on a large vault.

#### Other folder operations
- `POST /v1/folders/{path}` creates a folder.
- `DELETE /v1/folders/{path}` only works on an empty folder. `?recursive=true` moves the folder and everything in it to the trash; it needs `delete` access on everything inside.

### Tags
`GET /v1/tags?folder=` returns `{ results: [{ "tag": "ai", "count": 31 }] }`. The counts include only the notes the account can see.

### Health
`GET /healthz` needs no auth and returns 200 with `{ "ok": true, "version": "1.1.0" }`.

---

## Access model

### Grants
Each account has an `access` map: **path → level**.

- **Paths** are exact folder or file paths, relative to the account's `root`. `.` means the root itself. Globs aren't allowed.
- **Matching** ignores case and trailing dots/spaces (`Notes/Private` also covers `notes/private.`), so a case-insensitive filesystem can't be used to get around a `none`.
- **Resolution:** a file or folder takes the level of its **deepest matching key**. If no key matches, the level is `none`. The order of the keys doesn't matter.
- **A grant on a folder** covers everything below it, until a deeper key overrides it.

| Level | Permissions |
|---|---|
| `none` | nothing |
| `read` | read |
| `append` | create only, without read (a write-only drop folder) |
| `edit` | read, create, update |
| `full` | read, create, update, delete |
| `[list]` | an explicit set, e.g. `[read, create]`; `purge` can only be granted this way |

**Validation:** an explicit list that includes `update`, `delete` or `purge` must also include `read`. You can't edit blind. Breaking this rule is a config error.

### Ancestor visibility
Take an account with `Research/inbox: edit`. Listing `.` shows the folder `Research`, and listing `Research` shows only `inbox`.

The parent folders are only there to get you to the grant. They can't be read or written, and they don't count toward `total`.

### Always denied
These are denied whatever the grants say:
- dotfiles and dot-folders (`.obsidian`, `.git`, `.trash`, …)
- the server's own files
- anything in `vault.exclude`

Matching is done on each segment separately and ignores case. Before matching, paths are normalised to Unicode NFC and trailing dots and spaces are stripped. This closes the bypasses behind mcpvault's CVE-2026-57441 and CVE-2026-57442.

### Path safety
- Rejected outright: `..`, NUL, backslashes, and an encoded `/` inside a segment.
- After symlinks are resolved, the real path is checked again. It must be inside the vault and must still be allowed.
- `follow_symlinks` is `false` by default.

### Known leaks (by design)
- **Note bodies can mention hidden notes.** The text of a note can contain the names of notes the account can't see, and the server doesn't redact it.
- **`on_conflict: fail` confirms that a name is taken.** For an `append` account this reveals that a file with that name exists, but only inside the account's own drop folder.

---

## Config

```yaml
# spall.yaml — must live OUTSIDE the vault (the server refuses to start otherwise)
version: 1

server:
  host: 127.0.0.1          # bind to the tailnet IP on hermes
  port: 8787
  max_body: 10mb

vault:
  path: /srv/obsidian/vault
  trash: .trash            # DELETE moves files here; "none" = only permanent delete (purge)
  follow_symlinks: false
  exclude:                 # denied for every account, exact paths like access keys
    - Private
    - Templates

audit:
  path: /var/lib/spall/audit.jsonl   # two lines per write: intent (before) and result (after)

defaults:
  rate_limit: 120/min

accounts:
  reading-bot:
    description: Telegram reading-list bot
    root: datasources/Reading List
    access:
      .: [read, create, update]
    tokens:
      - name: hermes-2026-10
        sha256: 3b1f…
        created: 2026-10-01
        expires: 2027-10-01

  eink:
    description: E-ink dashboard
    access:
      Dashboards/eink.md: read
    tokens: [...]

  agent-research:
    description: Research agents
    rate_limit: 600/min
    access:
      Research: edit
      Research/inbox: full
      Notes: read
      Notes/Private: none
      Reading List.base: read
    tokens: [...]
```

- **Strict validation.** A zod schema rejects unknown keys and wrong types at startup. The same schema is exported as JSON Schema, so your editor can autocomplete the config.
- **Hot reload.** The config reloads when the file changes or on SIGHUP. If the new version is invalid, the server keeps the old one and logs the error. `server` and `vault.path`/`trash`/`follow_symlinks` only change at a restart; a reload keeps the running values and applies the rest, so a revoked token stops working at once.
- **Tokens.**
  - Tokens look like `spl_` + 43 base64url characters (256 random bits). The prefix lets secret scanners spot a leaked token.
  - The config stores only a SHA-256 hash of each token. Because the tokens are high-entropy, a slow hash like bcrypt isn't needed.
  - An account can have several tokens, so you can rotate one without downtime.
  - Expired tokens return 401. A date-only `expires` (e.g. `2027-10-01`) takes effect at 00:00 UTC on that day.
- **Audit log.** With `audit.path` set, each write appends two JSON lines that share `request` (the request id that error envelopes carry as `request_id`) and `op`:
  - **intent**, before the vault is touched: `phase: "intent"`, `time`, `account`, `token`, `path`, `via` for MCP tool calls, and what is known beforehand (`old_rev`, `new_rev`, `destination`, `ops`, `recursive`). If it can't be appended, the write is refused with 500 `audit_unavailable` and nothing changes.
  - **result**, after the change: `phase: "result"`, `outcome: "ok"` plus what is known only afterwards (`trash` for deletes, `path` for `POST /v1/notes`), or `outcome: "failed"` and `error` (an API code such as `already_exists`, `move_incomplete`, or an errno such as `ENOSPC`). If it can't be appended, the client still gets the real outcome and the server logs an error.

  Requests rejected before the intent (auth, permissions, `If-Match`) aren't logged. An intent without a result means the outcome is unknown (the result line was lost or the server stopped); the vault shows what happened.

### CLI
```
spall serve [--config path]
spall check                         # validate the config, print the expanded grants of each account
spall explain <account> <path>      # e.g. Notes/Private/x.md → none (key: Notes/Private)
spall token create <account> [--name n] [--expires 2027-10-01]   # prints the token once, writes its hash and keeps YAML comments
spall token list [account]
spall token revoke <account> <name>
```
These admin commands read the config file. The client commands (`spall whoami|search|ls|read|new|edit|…|mcp|doctor`) talk to a server instead; see *MCP and the client CLI*.

---

## Which access each endpoint needs

| Endpoint | Needs |
|---|---|
| `GET` note, file, folder listing or count; tags | `read` (listings show parent folders on the way to a grant) |
| `GET` base, base query | `read` on the `.base` file; rows only from readable notes |
| `GET /v1/search`, `/v1/stats`, `/v1/stats/metrics` | `read` on (or a way to) `folder`; only readable notes are indexed, scored or counted |
| `GET /v1/related` | `read` on the source note, plus the same as search for `folder` |
| `POST /v1/query` | `read` on (or a way to) each `from` folder; rows only from readable notes |
| `PUT` to a new path, `POST /notes`, `POST /folders/{path}` | `create` |
| `PUT` over an existing file, `PATCH` | `update` |
| `DELETE` | `delete`; with `permanent=true`, `purge` |
| move | `update` + `delete` on the source, `create` on the destination |

## How the use cases map

| Use case | Calls |
|---|---|
| Count articles | `GET /v1/count/?kind=note&depth=all` |
| Daily reading list | `GET /v1/folders/?kind=note&sample=3&include=body` |
| Save an article | `POST /v1/notes {title, frontmatter, body}` (the bot's root is the reading-list folder, so `folder` can be left out) |
| Mark an article read | `PATCH /v1/notes/{path} {ops:[{op:"frontmatter.set", key:"status", value:"read"}]}` |
| E-ink display | `GET /v1/notes/Dashboards/eink.md` with `If-None-Match`, so a poll with no changes is a cheap 304 |
| Grafana | `GET /v1/stats?metric=modified&interval=day` through the Infinity datasource, or scrape `/v1/stats/metrics` with Prometheus |
| Find a note | `GET /v1/search?q=…` |
| Agent recall | `GET /v1/related?path=…` for notes on the same topic |
| Agents | MCP or the CLI: `spall_whoami` → `spall_search` → `spall_read view=outline` (rev) → `spall_edit` with `expected_rev`. Over REST: `GET /me` → folder listing → note (outline) → `PATCH` with `if_match` |

Once query exists, the reading-list bot can filter by `status == "to-read"` on the server. Until then it filters on the client side or keeps unread items in a subfolder.

---

## Bases

Status: implemented. The example throughout is `Reading List.base`.

### Engine
- **Expressions** (filters and formulas) are evaluated by [`obsidian-bases-expression`](https://github.com/callumalpass/obsidian-bases-expression). Its results are checked against a running Obsidian app, and it publishes a list of known divergences.
- **Everything else in a view is done by the server:** combining the base's and the view's filters, `sort`, `groupBy`, `limit`, choosing columns, and paging.
- **Property types** come from `.obsidian/types.json` when the vault has one; Obsidian keeps them there. The server reads this file only internally; it is never served. Without the type, `Completed > date("2026-08-01")` fails, because the library treats `"2026-09-01"` as a plain string.
  - Fallback when a property has no type: a value that looks like an ISO date or datetime is treated as a date.
  - `vault.property_types` in the config can override types.
- **Evaluation runs over the in-memory index.** Frontmatter, tags, links and stat data are already there, so a query never reads note files unless the client asks for `include=body`.
- **Rows are all files, not only notes**, as in Obsidian: an image in the folder matches `file.folder == "…"` too. Add `file.ext == "md"` to a filter to keep only notes.
- **Per-file inputs and the vault-wide lookup tables are cached between queries**, separately for each account. The cache is rebuilt when the index changes, when the property types change, or when the config is reloaded. On a vault of about 5,000 notes, a query takes 100–300 ms.
- **Known library quirk:** `file("path")` for a path the account can't see (or that doesn't exist) returns the *current* row's properties instead of empty. The hidden note's data doesn't leak, but the value is wrong.
- **Errors are tolerated.** An expression that errors on a row counts as `false` in a filter and `null` in a column, as in Obsidian. The response lists them under `diagnostics`.

### Scoping
- **The base file:** querying a base requires `read` on the `.base` file. Anything else returns 404.
- **Rows** are limited to notes the account can read. A row is skipped before the filter runs, so hidden notes can't show up in counts, groups or totals either.
- **Expressions see vault-relative paths**, exactly as in Obsidian (`file.folder == "datasources/Reading List"`), even when the account has a `root`. The paths in the response are relative to the root, as everywhere else in the API.
- **Lookups are scoped as well.** `file("…")`, `link.asFile()`, `file.backlinks` and link resolution all work against the readable notes only. Otherwise a formula like `file("Private/x.md").properties` could read hidden notes.
- **Read access to a base never adds access to notes.** A base covering the whole vault, queried by the bot, returns only the bot's notes.

### `GET /v1/bases/{path}`
Returns the parsed base:
```json
{
  "path": "Reading List.base",
  "rev": "sha256:…",
  "filters": { "and": ["file.folder == \"datasources/Reading List\""] },
  "formulas": {},
  "properties": { "Status": { "displayName": "Status" } },
  "default_view": "To read",
  "views": [
    { "name": "To read", "type": "table", "filters": { "and": ["Status.containsAny(\"Not started\", \"In progress\")"] },
      "group_by": { "property": "Type", "direction": "ASC" }, "order": ["file.name", "Score", "…"] },
    { "name": "All items", "type": "table", "order": ["…"] },
    { "name": "Done articles", "type": "table", "filters": { "and": ["Status == \"Done\"", "Type == \"Article\""] },
      "sort": [{ "property": "Completed", "direction": "DESC" }] }
  ],
  "diagnostics": []
}
```
`default_view` is the view a query runs when none is named (the first one). `diagnostics` lists expressions that don't parse, each as `{ where, message }` (e.g. `where: "views[2].filters"`), so you find out before running a query.

### `POST /v1/bases/{path}/query`
```json
{
  "view": "To read",
  "filters": "Score >= 3",
  "sort": [{ "property": "Score", "direction": "DESC" }],
  "select": ["file.name", "Score", "Link"],
  "this": "Dashboards/eink.md",
  "limit": 50,
  "cursor": null,
  "sample": 3,
  "seed": "2026-10-01",
  "count_only": false,
  "include": ["frontmatter", "body"]
}
```
Every field is optional.

| Field | Meaning |
|---|---|
| `view` | Which view to run, by name. Defaults to the first view. |
| `filters` | Extra filter (expression string or `and`/`or`/`not` tree), ANDed with the base's and the view's own. |
| `sort` | Replaces the view's sort. |
| `select` | Replaces the view's columns (`order`). Accepts properties, `file.*`, `formula.*`. |
| `this` | The note that `this` refers to, as a path relative to the account root. Defaults to the base file itself. Must be readable, or the request returns 404. |
| `limit`, `cursor` | Paging. The view's own `limit`, if it has one, caps the total. |
| `sample` | N random matching rows, like folder listings. Add `seed` to get the same picks again. |
| `count_only` | Returns `{ "total": N, "groups": […] }` only. |
| `include` | `frontmatter` adds every frontmatter property, not just the selected columns. `body` adds the note text, and is allowed only with `sample` or a `limit` of 20 or less. |

Response for the "To read" view:
```json
{
  "base": "Reading List.base",
  "view": { "name": "To read", "type": "table" },
  "columns": [
    { "key": "file.name", "name": "Name" },
    { "key": "Score", "name": "Score" },
    { "key": "Status", "name": "Status" }
  ],
  "total": 37,
  "groups": [{ "key": "Article", "count": 30 }, { "key": "Book", "count": 7 }],
  "results": [
    { "path": "Some article.md", "group": "Article",
      "values": { "file.name": "Some article", "Score": 4, "Status": "Not started" } }
  ],
  "next_cursor": "…", "has_more": true,
  "diagnostics": []
}
```
- **Grouping keeps one flat list.** Rows come sorted by group first and then by the view's sort, and each row carries its `group`. `groups` gives the count for each group, so paging works the same as without grouping.
- **Values are plain JSON.** Dates come back as ISO strings, lists as arrays and links as `"[[Target]]"`, the same way they are written in frontmatter.
- **`columns` gives display names** from the base's `properties`, falling back to the key.
- **Sorting:** values compare according to their type, and empty values go last whatever the direction.
- **The view `type` makes no difference.** Table, cards, list and map views all return the same rows; `type` is passed through for the client.
- **Errors:**
  - An unknown `view` returns 400, with `details.available_views` listing the base's views.
  - A request `filters` that doesn't parse returns 400, with `details.diagnostics`.
  - A broken filter inside the base returns 200 with no rows, and the problem listed in `diagnostics`.
  - A filter that is a quoted string (`"\"status == 'x'\""`, a JSON-encoded filter quoted once too often) would match every row, so it counts as broken: 400 for a request filter, no rows for one in the base.
  - A filter that reads a note property none of the queried notes has gets a diagnostic, naming the property with the same name in another case if there is one: `Unknown property "status": no queried note has it. Did you mean "Status"?`
  - Runtime failures are counted per expression: `{ where, message, rows }`.
  - A `.base` file that isn't valid YAML returns 422 `invalid_base`.
  - Expressions have limits, because every account shares one process: a query gets 1 s of evaluation in total (compiling, filtering, sorting and the page's columns together; over it: 400 `invalid_request`), and a value an expression builds may hold at most 100,000 characters and items (over it: a value error in `diagnostics`).
- **No view at all:** a base without `views` runs its global filters, with `file.name` plus the keys of `properties` as columns.

### `POST /v1/query`
Runs an unsaved view, with the same engine and the same response as a base query. The body is the same plus `from` and `formulas`; it has no `view` and no `this`:
```json
{ "from": ["datasources/Reading List"], "filters": "Status == \"Not started\"", "formulas": { "age": "(now() - file.ctime).days" },
  "sort": [{ "property": "formula.age", "direction": "DESC" }], "select": ["file.name", "formula.age"], "limit": 20 }
```
- **`from`** is a list of folders to search, relative to the account root, and subfolders are included. It defaults to the account root, while a base always starts from the whole vault.
  - Access to each folder in `from` is checked the same way as for a listing, and an unknown or hidden folder returns 404.
  - If one folder in `from` is inside another, only the outer one is used.
- **`group_by`** works like a view's `groupBy`.
- **Columns** default to `file.name` plus one column for each formula.

### Not in this design (yet)
- **`summaries`** (per-column totals, averages, …). These are view footers. They can be added as a `summaries` field in the response.
- **Structured view edits** (add/remove a view as JSON). `.base` files are edited as text, through `PUT /v1/files/…` (validated) or `spall_edit`.
- **Creating notes "in" a view.** Obsidian works out a new note's properties from the view's filters, and the library supports this through `inferDefaultsFromFilter`. It would let the bot do `POST /v1/bases/Reading List.base/notes`, with the folder and `Status` filled in automatically. It's a candidate for later.

## Implementation notes

- **Stack:** Node 22+, Fastify (HTTP; pino logging, body limits), zod (config and request validation, called inside handlers), `yaml` (config and frontmatter; keeps comments in both), a small hand-written markdown scanner (headings, block ids, tags, links; fenced code is skipped), and chokidar (filesystem watcher).
- **Routing vault paths in Fastify:**
  - Vault paths use wildcard routes (`/v1/notes/*`). The path is parsed from the raw `request.url` rather than from the decoded `params['*']`, so an encoded `%2F` inside a segment can be detected and rejected.
  - `find-my-way` only allows a wildcard at the end of a route, so `…/{path}/move` is handled by the `POST /v1/notes/*` handler, which strips the trailing `/move`. No other POST exists on that route, so the suffix can't be mistaken for part of a path.
  - `text/markdown` and `application/octet-stream` bodies are registered as raw buffer content-type parsers.
- **In-memory index.** At startup the server scans the vault into an index (path, stat, frontmatter, tags, links). A filesystem watcher keeps it up to date, so changes made by sync, the Obsidian app or by hand show up without an API call. Listings, totals, tags and backlinks all come from the index. Note contents are read from disk on request. The search index is the exception: it keeps every note body in memory (a few MB for 2,000 notes).
- **Writes.**
  - New files are created with `O_EXCL`, which makes "create only if missing" atomic.
  - Existing files are overwritten **in place**. Writing a temp file and renaming it over the target would be atomic, but it gives the file a new inode, which resets the birth time that `created` comes from. The cost is that a reader could briefly see a half-written file.
  - Moves use `link` + `unlink`, which keeps the inode and never overwrites the destination.
  - Each path has its own mutex, so the `If-Match` check and the write happen as one step.
- **Trash layout.** `.trash/` uses Obsidian's local layout: the original relative path, plus a numeric suffix if a file of that name is already there.

## Search and stats

Status: implemented.

### `GET /v1/search?q=`
Lexical full-text search, ranked with BM25.

| Parameter | Meaning |
|---|---|
| `q` | Required, up to 500 characters. Syntax below |
| `match` | `all` (default: every word must match) or `any` |
| `folder` | Only notes under this folder, relative to the account root. Default: the root |
| `limit`, `cursor`, `fields` | As everywhere else; `limit` defaults to 20, with a maximum of 100 |

```json
{ "query": "pcb laser", "scope": { "folder": "", "notes": 1812 }, "total": 6,
  "results": [{ "path": "inbox/making PCBs in-house.md", "name": "making PCBs in-house", "score": 14.703,
                "matched": ["pcb", "laser"], "snippet": "…", "heading": "Notes > Tools", "tags": [], "modified": "2026-10-09T…" }],
  "next_cursor": "…", "has_more": true }
```
Query syntax:

| Form | Meaning |
|---|---|
| `printer` | The word, after stemming (`printers`, `Printer` match too) |
| `kicad*` | Prefix: terms that start with `kicad` or with its stem and occur in notes the account can read (at most 50, the most common in scope first) |
| `"reading list"` | Phrase: the stems in this order, next to each other. Stopwords inside are skipped on both sides, and a phrase never spans two fields (title → tags → frontmatter → body). A hyphenated word (`pcb-плата`) is a phrase too |
| `-draft`, `-"old stuff"`, `-tmp*` | Exclusion: notes that match are dropped. A query made only of exclusions is a 400 |

Positive clauses are ANDed (`match=all`) or ORed (`match=any`). Exclusions apply either way. A query can have at most 32 clauses, of which at most 5 are prefixes; more is a 400.

- **Index.** All notes are kept in memory: weighted term frequencies plus the body for snippets. It is built in the background at startup and synced lazily before each query: only notes whose `rev` changed are read again, so API writes and watcher events show up on the next search.
- **Fields.** A word in the title (file name) counts 3×, in `tags` 2×, and in folder names, frontmatter *values* or the body 1×. Frontmatter keys aren't indexed. `related` ignores words that only come from folder names.
- **Snippets** come from the body line with the most distinct matched terms (text lines before headings, fenced code skipped for headings), cut to 160 characters centred on the first match. `heading` is the path of headings above that line (null above the first one). When only frontmatter matched, the snippet is that `Key: value`; when only the title or a folder name did, it is the first text line.
- **`scope`** says what was searched: the folder and the number of notes in it the account can read. MCP and the CLI use it to say "No matches for … in …" instead of returning nothing.
- **Tokenisation.** Unicode letter and digit runs, lowercased, NFC, `ё` folded to `е`. Short English and Russian stopwords and single letters are dropped. Cyrillic words go through the Snowball Russian stemmer, and Latin words through a light English one (plural, `-ing`, `-ed`). The query uses the same pipeline, so `принтеры` finds `принтер`.
- **Prefix queries** help where Snowball cuts related words differently (печать → `печа`, печатать → `печата`): `печа*` covers both.
- **Phrases** are checked against each note's stored term sequence, after a cheap check that every term is present.
- **Scoping.** Hidden notes are filtered out *before* scoring. N, document frequencies and the average length all come from the notes the account can read, so a hidden note can't affect a score, which would otherwise leak its words.
- **Prefix expansion is scoped too:** expansions are picked among the terms of readable notes, so hidden notes can't crowd out visible terms or reveal which prefixes they contain.
- **Statistics cache.** Those per-account statistics are cached per (account, `folder`, index version): the set of visible notes, their average length, and document frequencies filled in per term as queries need them. Any change to the vault bumps the version and invalidates the cache. A config reload creates new account objects, so changed grants take effect at once. On the 1.8k-note snapshot, a query that misses the cache takes ~115 ms and one that hits takes ~20–30 ms (on a busy machine).
- **Snippet.** The first non-heading line that contains a matched term, cut to 160 characters around the match. Snippets are built only for the returned page.
- **Not yet supported:** fuzzy matching, field filters (`tag:`), and `mode=semantic|hybrid`.

### `GET /v1/related?path=`
More like this: the notes most similar to one note, for agents recalling "what else have I written about this?"

| Parameter | Meaning |
|---|---|
| `path` | The source note, relative to the account root (`.md` optional). 404 unless the account can read it |
| `terms` | How many terms to build the query from: 1–100, default 25 |
| `folder`, `limit` (default 10, max 100), `cursor`, `fields` | As for search |

```json
{ "path": "inbox/making PCBs in-house.md",
  "terms": ["laser", "lhs", "pcb", "etch", "solder", "copper", "board", …],
  "total": 145,
  "results": [{ "path": "inbox/PCB with CNC + laser (Alvaro's Workshop).md", "score": 82.5, "matched": [...], "snippet": "…", … }],
  "next_cursor": "…", "has_more": true }
```
- **Term choice.** The source's terms are ranked by weighted tf × idf over the notes the account can read. Terms that no other visible note has are skipped, and so are numbers, terms shorter than 3 characters, and URL fragments (`www`, `https`, `com`, …).
- **Scoring.** The top terms run as an OR query with the same BM25 and the same cached statistics as search. The source note itself is never returned.
- **Scoping.** Both the term statistics and the candidates come from readable notes only, under `folder` if one is given.

### `GET /v1/stats`
Notes created and modified per bucket, and named counters for dashboards.

| Parameter | Meaning |
|---|---|
| `interval` | `day` (default), `week` (starting Monday) or `month` |
| `from`, `to` | Calendar dates (YYYY-MM-DD), inclusive. Default: the last 30 days, 12 weeks or 12 months up to today |
| `tz` | IANA time zone for dates and buckets. Defaults to `stats.timezone` (UTC) |
| `folder` | Only notes under this folder (relative to the account root) |
| `metric` | `created` or `modified`: return only that series as `{ buckets }`, for the Grafana Infinity datasource |

```json
{ "folder": "", "notes": 1792, "interval": "day", "from": "2026-09-13", "to": "2026-10-12", "timezone": "Europe/London",
  "created": [{ "t": "2026-09-13", "count": 0 }, …], "modified": [{ "t": "2026-09-13", "count": 4 }, …],
  "folders": { "x_inbox": { "path": "3. Resources/X/inbox", "notes": 179 } },
  "properties": { "reading": { "path": "datasources/Reading List", "property": "Status",
                               "counts": { "Done": 177, "Reviewed": 46, "Not started": 32, "Cancelled": 6, "In progress": 2 } } } }
```
- Every bucket in the window is present, so charts have no gaps. A window can have at most 5,000 buckets.
- `created` is the filesystem birth time, as everywhere else. It's only meaningful when the files have kept their inodes: on a fresh copy or clone, every note is "created" on the day of the copy.
- **Counters** come from the config and are server-wide:
  ```yaml
  stats:
    timezone: Europe/London
    folders:                  # notes under each folder, recursively
      inbox: inbox
      x_inbox: 3. Resources/X/inbox
    properties:               # notes per value of a frontmatter property
      reading: { folder: datasources/Reading List, property: Status }
  ```
  Paths are vault-relative. Counter names are lowercase identifiers, because they become metric labels. A list value counts once for each distinct item, and a missing value counts as `(none)`. The exact property name is matched first, then a case-insensitive one.
- **Scoping.** Only readable notes are counted. A counter whose folder the account can neither read nor pass through (see *Ancestor visibility*), or that lies outside its root, is left out, so the account can't even learn that it exists.

### `GET /v1/stats/metrics`
The same data in the Prometheus text format (`text/plain; version=0.0.4`), for a scrape job with `authorization: { credentials: spl_… }`:
```
spall_notes 1792
spall_notes_created{window="24h"} 3          # also 7d, 30d
spall_notes_modified{window="24h"} 3
spall_last_modified_timestamp_seconds 1791750633
spall_folder_notes{counter="x_inbox",path="3. Resources/X/inbox"} 179
spall_property_notes{counter="reading",property="Status",value="Not started"} 32
```
It takes `folder` too. The values are gauges, recomputed from the index on every scrape, which takes a few milliseconds on a vault of 2,000 notes.

## MCP and the client CLI

Status: implemented in 1.1. This replaces the original "REST only, no MCP endpoint" decision: agents no longer need to wrap the REST API themselves.

### Shape
- **One tool module, three transports.** `src/mcp/tools.ts` defines nine task-shaped tools. Each one calls Spall through a `Caller`, `(method, url, headers, body) → (status, headers, body)`:
  - `POST /mcp` on the server uses `fastify.inject()`, carrying the request's own `Authorization` header;
  - `spall mcp` (stdio) and the client CLI use `fetch` with `SPALL_URL` + `SPALL_TOKEN`.
- **REST stays the only security boundary.** Every tool call is an ordinary REST call, so auth, scoping, 404-not-403, rate limits, revision checks and the audit log are the REST ones. No access logic is duplicated. Hiding tools is a convenience, not enforcement.
- **Task-shaped, not 1:1 REST.** Nine tools instead of ~30 endpoints keep `tools/list` around 9 KB for an account that sees everything (a test caps it at 16 KB). Schemas are flat (no `oneOf`), descriptions stay under 1 KB, and every tool sets `openWorldHint: false`. Schemas are snapshot-tested in `test/__toolsnaps__/`.
- **Endpoint.** `/mcp` is stateless Streamable HTTP via `@modelcontextprotocol/server` 2.x. It serves 2026-07-28 clients and 2025-era `initialize` clients. Each request builds a fresh server with only the tools the account may see. `GET`/`DELETE` return 405. It isn't part of the OpenAPI document.

### Tools

| Tool | Wraps | Shown when one grant has | Hints |
|---|---|---|---|
| `spall_whoami` | `GET /v1/me` | always | read-only |
| `spall_search` | `GET /v1/search`, or `/v1/related` with `related_to` | `read` | read-only |
| `spall_list` | `GET /v1/folders/{path}` (with `where`/`missing`), `/v1/tree/{path}` with `view=tree`, or `/v1/tags` with `view=tags` | `read` | read-only |
| `spall_read` | `GET /v1/notes/{path}`: `markdown`, `outline`, `frontmatter`, `section` or `backlinks` (`?include=backlinks`); for a `.base`, `GET /v1/files/{path}` (YAML) or `GET /v1/bases/{path}` (`outline`: views) | `read` | read-only |
| `spall_query_base` | `POST /v1/bases/{path}/query`, `POST /v1/query` | `read` | read-only |
| `spall_create` | `POST /v1/notes`, or `PUT` + `If-None-Match: *` for an exact path | `create` | not destructive |
| `spall_edit` | `PATCH /v1/notes/{path}`; `PUT` + `If-Match` for `replace_all`; for a `.base`, `PUT /v1/files/{path}` + `If-Match` (`replace_text` applied by the tool) | `update` | not destructive |
| `spall_move` | `POST /v1/notes/{path}/move` (`/v1/files/…` for a `.base`) | `update` + `delete` | not destructive |
| `spall_trash` | `DELETE /v1/notes/{path}` (`/v1/files/…` for a `.base`; trash only, never `permanent`) | `delete` | destructive |

- `spall_read view=section` and `spall_edit` match headings with the same code (`headingRegion` in `patch.ts`), so they agree on which heading is meant and on ambiguity errors.
- `spall_read` always returns `rev`. `view=outline` is the cheap way to get it without the body. Long notes are cut at a line boundary (`max_chars`, default 20,000) with `truncated: true` and a hint to read sections instead.
- `spall_edit` ops are one flat object type (`op`, `heading`, `index`, `block`, `content`, `key`, `value`, `old`, `new`, `count`). They map to PATCH ops and apply atomically. The result carries the new `rev`, `previous_rev` and a `changed lines: +n −m` summary. It costs two REST calls: a read, then the PATCH.

### Visibility
A tool is shown when **one** grant includes every permission it needs. Then each narrowing can only remove tools:
- the account's `mcp: {read_only, tools}` in the config;
- `?read_only=1&tools=a,b` on `/mcp`, or `spall mcp --read-only --tools a,b`.

`read_only` drops every tool without `readOnlyHint`. The tool list is computed per request, so config reloads apply immediately. `/v1/me` reports the resulting tool list (`mcp.tools`), so `spall mcp` (stdio) starts from the same list and its flags narrow it further; it fences note text when `mcp.fenced` is true.

### Results and errors
- `structuredContent` and the text content come from one object. With fencing on, a result is text only, with no `structuredContent`: clients such as Claude Code show the model `structuredContent` instead of the text when both are present, and it can't be fenced. With fencing off, `structuredContent` carries the raw values and the text is their JSON. No tool declares an `outputSchema`.
- Note-derived text is wrapped in `<untrusted-content source="spall" path="…">` markers. A closing marker inside the note is escaped (`<\/untrusted-content`, which is still the same JSON string). The server `instructions` tell the model not to follow instructions inside the markers. This is `mcp.fence_untrusted`, on by default and overridable per account; off, the text is the plain JSON of the result.
  - `spall_read` markdown and section views: the body, with `rev` in the attrs.
  - `spall_search` (`snippet`, `heading`), `spall_list` with `frontmatter`, `spall_query_base` (row `values`, `group`, `groups`), `spall_read` views frontmatter (`frontmatter`, `tags`), outline (`headings`) and backlinks (`links`), `spall_list view=tags` (`results`, in one fence without a path): the text is one JSON line for the result's plain fields (left out when there are none), then per item one JSON line of its plain fields (path, name, score, rev, dates) followed by one fence holding the item's note fields as JSON. One fence per note keeps the note's path next to its text without repeating markers per field. A result with no note text (a list without frontmatter) stays plain JSON.
  - Paths, counts, revs and other metadata are never fenced. The CLI doesn't fence.
- REST errors become `isError: true` results with the REST `code`, a hint and the details in the text (and `structuredContent.error` with fencing off):

| Code | Tool error |
|---|---|
| `not_found` | Always the same text, without a request id, so a hidden note and a missing one can't be told apart. When the REST error has `did_you_mean` (drawn only from visible paths), the message lists them |
| `forbidden` | The REST message plus a pointer to `spall_whoami` |
| `rev_mismatch` | `current_rev`, plus the current section when the edit targeted a heading |
| `patch_target_ambiguous` | The candidates with their `index` |
| `rate_limited` | `retry_after` |

### Auth, audit, limits
- `/mcp` uses the same bearer tokens: 401 with `WWW-Authenticate: Bearer`, and 404 when `mcp.enabled: false`.
- A browser `Origin` is rejected unless it's listed in `mcp.allowed_origins`. Requests without an Origin are allowed.
- The `/mcp` request itself is not counted against the rate limit; the REST calls its tools make are. Protocol-only traffic (`initialize`, `tools/list`) is therefore uncapped. It touches no vault data.
- Writes made through `/mcp` are audited with `via: mcp/<tool>`. The marker is set only on in-process inject calls, which carry a per-process random secret header, so a client can't forge it. Writes from `spall mcp` and the CLI arrive over HTTP and are audited as plain REST writes.

### Client CLI
`spall whoami | search | ls | tags | read | new | edit | mv | trash | base | mcp | doctor` run the same tool handlers through `fetch`. Credentials come from `SPALL_URL` (or `--url`) and `SPALL_TOKEN`, which is read only from the environment. There is no `--token` flag, so the token stays out of argv, and no credential file yet. Output is human-readable, or JSON with `--json`. Exit codes: 0 ok, 1 error, 2 usage, 3 not found, 4 forbidden, 5 rev conflict, 6 rate limited, 7 auth.

The npm package is `@ikaros-labs/spall` (npm blocks the unscoped `spall` as too close to an existing name). Its bin is still `spall`, so `npm i -g @ikaros-labs/spall` installs the `spall` command and `npx -y @ikaros-labs/spall mcp` runs the stdio server. The browser-safe access module is `@ikaros-labs/spall/access`.

### Not in 1.1
- OAuth: an OAuth 2.1 resource server, which Claude.ai and ChatGPT remote connectors need.
- File and attachment tools, a stats tool, restore from trash, prompts and resources.

## Later
- **Bases:** `GET /v1/bases` listing, `summaries`, and creating notes through a view (see *Bases*).
- **Search:** `mode=semantic|hybrid`, fuzzy matching, field filters.
- **Stats:** `created` from a frontmatter property (e.g. `created:`), for vaults whose birth times were lost in a copy.
- **Changes feed:** `GET /v1/changes?since=&wait=` (long-poll), built on the same filesystem watcher.
- **Rewriting links when a note moves.**
- **Globs or a `types:` filter in access grants**, if a use case comes up.
- **`Accept: text/html` rendering.**

## Not planned
- **Obsidian commands, an active file, opening notes in the UI:** there is no app on the server.
- **Built-in periodic notes:** clients can create `Daily/2026-10-01.md` themselves.
- **Notion-style typed property wrappers:** frontmatter stays plain JSON.
