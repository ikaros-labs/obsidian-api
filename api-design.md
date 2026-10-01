# Vault API: proposal v1

Status: final proposal, 1 Oct 2026. For the idea and the prior-art research, see [[obsidian-api]].

A self-hosted REST server over a folder of markdown files (an Obsidian vault or any other). It is multi-account, and each account sees only the folders it has been granted.

## Decisions

| Topic | Decision |
|---|---|
| Language | TypeScript, chosen so the Bases expression library can be reused later |
| Interface | REST only, no MCP endpoint |
| Write scope | Full CRUD, plus a targeted PATCH |
| Vault | Any folder of `.md` files. Doesn't require Obsidian or a particular sync tool |
| Timestamps | Filesystem only: `created` = birth time (falls back to mtime), `modified` = mtime |
| Endpoints | `/notes` (understands markdown) and `/files` (raw bytes) are separate |
| Per-account `root` | Yes. The account sees a chosen folder as its root, `/` |
| Moving notes | Never rewrites links |
| Access model | Grants on the folder tree: the most specific path wins. No globs |
| Account management | A YAML config file plus a token CLI. No admin API |
| v1 leaves out | Search and stats. Bases and query were added later (see *Bases*) |

## Principles

1. **Works on any folder.** It understands Obsidian conventions (frontmatter, wikilinks, tags) but doesn't depend on them.
2. **Scoping is the product.** Every response is filtered by the account's access *before* anything is computed, including counts, totals, tags and backlinks. Anything outside the scope returns **404, never 403**. 403 means "you can see this, but you can't do that".
3. **One shape per endpoint.** A note endpoint always returns a note and a folder endpoint always returns a listing.
4. **Raw markdown is a first-class format.** `Accept: text/markdown` returns the file unchanged.
5. **Writes are safe by default.** Writes use optimistic concurrency (`rev` + `If-Match`), deletes go to the trash, and paths are made canonical and checked one segment at a time.

---

## Conventions

- **Base URL and auth.** All endpoints live under `/v1` and require `Authorization: Bearer vlt_…`.
- **Paths** are relative to the account's root, and each segment is percent-encoded: `/v1/notes/Research/Some%20note.md`. The `.md` can be left off for notes.
- **`rev`** is a truncated content hash (`sha256:9f2c…`), sent both as a JSON field and as the `ETag` header.
  - `If-Match: <rev>` on a write returns **412 `rev_mismatch`** if the file has changed.
  - `If-None-Match: *` makes the write create-only.
  - `If-None-Match: <rev>` on a GET returns **304** if nothing changed.
- **Timestamps** are ISO 8601 in UTC.
- **Pagination** uses one envelope everywhere: `{ "results": [...], "next_cursor": "…"|null, "has_more": bool }`.
  - `limit` defaults to 50, with a maximum of 500.
  - Cursors are opaque, and are bound to the account and the request parameters.
- **`fields=`** is an optional list of the fields to return: `fields=path,frontmatter.status,modified`.
- **Errors** use one envelope:
  ```json
  { "error": { "code": "rev_mismatch", "message": "…", "request_id": "…", "details": { "current_rev": "…" } } }
  ```
  The codes are `unauthorized`, `not_found`, `forbidden`, `already_exists`, `rev_mismatch`, `invalid_path`, `invalid_request`, `patch_target_not_found`, `patch_target_ambiguous`, `folder_not_empty`, `payload_too_large` and `rate_limited`.

---

## Endpoints

### `GET /v1/me`
Returns the account name, its root, its expanded access grants, and the token's name and expiry. This lets clients and agents find out what they're allowed to do.

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
- Links pointing to the note are **not** rewritten.

### Files (attachments, and any file that isn't a note)

| Endpoint | Behaviour |
|---|---|
| `GET /v1/files/{path}` | Raw bytes with the right `Content-Type`; supports `ETag`, `Range` and 304 |
| `PUT /v1/files/{path}` | Uploads raw bytes; supports `If-Match` / `If-None-Match` |
| `DELETE /v1/files/{path}` | Same as for notes |
| `POST /v1/files/{path}/move` | Same as for notes |

A `.md` file can also be reached here as plain bytes.

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

```json
{
  "path": "",
  "total": { "notes": 214, "files": 3, "folders": 2 },
  "results": [
    { "kind": "folder", "path": "Archive" },
    { "kind": "note", "path": "Some article.md", "name": "Some article", "rev": "…", "created": "…", "modified": "…", "size": 4211 }
  ],
  "next_cursor": null, "has_more": false
}
```
- `total` covers the whole filtered set, not just the current page.
- Folders and entries the account can't see are left out of both `results` and `total`.
- Parent folders of a granted path are shown so the account can find its way there, marked `"traverse_only": true`. They list only the branch that leads to the grant and aren't counted in `total`. See *Ancestor visibility* under *Access model*.

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
`GET /healthz` needs no auth and returns 200.

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
# vault-api.yaml — must live OUTSIDE the vault (the server refuses to start otherwise)
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
  path: /var/lib/vault-api/audit.jsonl   # one line per write: time, account, token, op, path, old/new rev

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
- **Hot reload.** The config reloads when the file changes or on SIGHUP. If the new version is invalid, the server keeps the old one and logs the error.
- **Tokens.**
  - Tokens look like `vlt_` + 43 base64url characters (256 random bits). The prefix lets secret scanners spot a leaked token.
  - The config stores only a SHA-256 hash of each token. Because the tokens are high-entropy, a slow hash like bcrypt isn't needed.
  - An account can have several tokens, so you can rotate one without downtime.
  - Expired tokens return 401. A date-only `expires` (e.g. `2027-10-01`) takes effect at 00:00 UTC on that day.

### CLI
```
vault-api serve [--config path]
vault-api check                         # validate the config, print the expanded grants of each account
vault-api explain <account> <path>      # e.g. Notes/Private/x.md → none (key: Notes/Private)
vault-api token create <account> [--name n] [--expires 2027-10-01]   # prints the token once, writes its hash and keeps YAML comments
vault-api token list [account]
vault-api token revoke <account> <name>
```

---

## Which access each endpoint needs

| Endpoint | Needs |
|---|---|
| `GET` note, file, folder listing or count; tags | `read` (listings show parent folders on the way to a grant) |
| `GET` base, base query | `read` on the `.base` file; rows only from readable notes |
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
| Grafana | Not in v1 (see *Later*). Could use obsidian-grafana in the meantime |
| Agents | `GET /me` → folder listing → note (outline) → `PATCH` with `replace_text` and `if_match` |

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
`diagnostics` lists expressions that don't parse, each as `{ where, message }` (e.g. `where: "views[2].filters"`), so you find out before running a query.

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
  - Runtime failures are counted per expression: `{ where, message, rows }`.
  - A `.base` file that isn't valid YAML returns 422 `invalid_base`.
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
- **Editing `.base` files** beyond what `PUT /v1/files/…` already allows.
- **Creating notes "in" a view.** Obsidian works out a new note's properties from the view's filters, and the library supports this through `inferDefaultsFromFilter`. It would let the bot do `POST /v1/bases/Reading List.base/notes`, with the folder and `Status` filled in automatically. It's a candidate for later.

## Implementation notes

- **Stack:** Node 22+, Fastify (HTTP; pino logging, body limits), zod (config and request validation, called inside handlers), `yaml` (config and frontmatter; keeps comments in both), a small hand-written markdown scanner (headings, block ids, tags, links; fenced code is skipped), and chokidar (filesystem watcher).
- **Routing vault paths in Fastify:**
  - Vault paths use wildcard routes (`/v1/notes/*`). The path is parsed from the raw `request.url` rather than from the decoded `params['*']`, so an encoded `%2F` inside a segment can be detected and rejected.
  - `find-my-way` only allows a wildcard at the end of a route, so `…/{path}/move` is handled by the `POST /v1/notes/*` handler, which strips the trailing `/move`. No other POST exists on that route, so the suffix can't be mistaken for part of a path.
  - `text/markdown` and `application/octet-stream` bodies are registered as raw buffer content-type parsers.
- **In-memory index.** At startup the server scans the vault into an index (path, stat, frontmatter, tags, links). A filesystem watcher keeps it up to date, so changes made by sync, the Obsidian app or by hand show up without an API call. Listings, totals, tags and backlinks all come from the index. Note contents are read from disk on request.
- **Writes.**
  - New files are created with `O_EXCL`, which makes "create only if missing" atomic.
  - Existing files are overwritten **in place**. Writing a temp file and renaming it over the target would be atomic, but it gives the file a new inode, which resets the birth time that `created` comes from. The cost is that a reader could briefly see a half-written file.
  - Moves use `link` + `unlink`, which keeps the inode and never overwrites the destination.
  - Each path has its own mutex, so the `If-Match` check and the write happen as one step.
- **Trash layout.** `.trash/` uses Obsidian's local layout: the original relative path, plus a numeric suffix if a file of that name is already there.

## Later
- **Bases:** `GET /v1/bases` listing, `summaries`, and creating notes through a view (see *Bases*).
- **Search:** `GET /v1/search?q=` using lexical BM25 first, with `mode=semantic|hybrid` added later.
- **Stats (for Grafana):** `GET /v1/stats?metric=created|modified&interval=day|week|month&from=&to=&folder=` → `{ "buckets": [{ "t": "2026-09-01", "count": 5 }] }`, in a format the Grafana Infinity datasource reads directly. Counts only notes the account can see.
- **Changes feed:** `GET /v1/changes?since=&wait=` (long-poll), built on the same filesystem watcher.
- **Rewriting links when a note moves.**
- **Globs or a `types:` filter in access grants**, if a use case comes up.
- **`Accept: text/html` rendering.**

## Not planned
- **Obsidian commands, an active file, opening notes in the UI:** there is no app on the server.
- **Built-in periodic notes:** clients can create `Daily/2026-10-01.md` themselves.
- **MCP:** REST only.
- **Notion-style typed property wrappers:** frontmatter stays plain JSON.
