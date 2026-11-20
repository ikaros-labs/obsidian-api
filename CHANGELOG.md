# Changelog

## Unreleased

- **Fix: a recursive folder delete could remove a file written after its permission check.** Writes now run one at a time under a vault-wide lock, so another account's note created inside the folder while the delete ran is no longer purged or trashed by an account that can't see it. The same lock stops two edits of one note through a symlink alias (with `follow_symlinks`) from losing one of them.
- **Fix: a failed or interrupted overwrite no longer leaves a partial note or file.** Before replacing a file in place (which keeps its creation time), Spall saves the old bytes to a journal in `.spall/journal` in the vault. If the write fails, the old content is put back at once. If that fails too, or the server stops midway, it is put back before the next write or at the next start. A retry with the `If-Match` from before the failure then applies. A new file whose write fails is removed instead of left partial.
- **Config reloads apply everything except restart-only settings.** An edit that changed `server.*`, `vault.path`, `vault.trash` or `vault.follow_symlinks` used to be rejected as a whole, so a token revoked in it (or in any later edit) stayed valid until a restart. Now those settings keep their running values, an error says they need a restart, and everything else (accounts, grants, tokens) applies at once.
- **Fix: `spall token revoke` could revoke the wrong token,** and concurrent `spall token` runs could lose a created token. Edits now take a `.<config>.lock` file next to the config, and the token is looked up by name in the file being edited.
- **Fix: a move whose source couldn't be removed left the file under both names** (and could answer 409 for its own destination). The new name is removed again and the error is returned, so a retry starts clean.
- **Fix: a write whose audit line failed returned 500 although it had happened,** so a retried `POST /v1/notes` made a duplicate note. **The audit log format changes:** each write now logs two lines with the same `request` id. An `intent` line (account, token, op, path, revs) is written before the vault is touched, and a `result` line (`outcome: ok`, or `failed` with an `error` code) after. If the intent can't be written, the write is refused with 500 `audit_unavailable` and nothing changes, so a retry is safe. If only the result can't be written, the client gets the real outcome and the server logs an error. A move that leaves the file at both paths is now logged as a failed `move` with `error: move_incomplete`. Tools that read the audit log should join the two lines on `request`; an intent with no result means the outcome is unknown.
- **Fix: a deleted folder could leave a ghost entry** in search, tags, bases and backlinks when a file inside it was being re-indexed at the same moment.

## 1.2.4 — 2026-11-20

- **Security fix: `fields` reads only the response's own data.** A crafted `fields` value (REST `fields=`, and the MCP tools and CLI flags that pass it on) could reach past the response into shared process state and weaken authentication. `fields` now follows only the response's own properties. Upgrade from 1.2.3.

## 1.2.3 — 2026-11-19

- **Fix: bases `<`, `>`, `<=`, `>=` with an empty value, as in Obsidian.** An empty side (`Key:` or a missing property) counted as 0, so `Completed < date("2026-01-01")` matched notes with no `Completed` and `Score < 5` matched notes with no `Score`. Now a comparison with an empty side is empty, as in Obsidian: it doesn't match as a filter, `!(…)` of it does, and a formula `Score < 5` shows `null`. Other comparisons follow Obsidian too: a string right of a date or duration is read as one (`Completed < "2026-01-01"`), and a mixed comparison is plain JavaScript (`""` is a string, not empty, so `"" < date(…)` is true). Applies to `.base` views, `/v1/query`, `spall_query_base` and `spall base`.
- **Fix: bases `==` / `!=` between strings, numbers and booleans are loose, as in Obsidian.** `Score == "3"` now matches a `Score` of 3 (and `true == 1`, `"" == 0` are true). Other values compare as before: `null` equals only `null`, so `"" == null` is false.

## 1.2.2 — 2026-11-19

- **Fix: empty dates in bases are empty, not 1970-01-01.** A date property (typed in `.obsidian/types.json` or by config) that is `Key:` (null) showed as `1970-01-01T00:00:00.000Z` in `POST /v1/bases/{path}/query`, `/v1/query`, `spall_query_base` and `spall base`, and formulas saw it as a 1970 date. `""` and a missing value became an invalid date. All three are now empty values: `null` (or `""` as written) in JSON, blank in CLI tables, `isEmpty()` is true, and they sort after real dates in either direction.

## 1.2.1 — 2026-11-19

Fixes from the 1.2.0 agent evals.

- **MCP fences all note text, not only bodies.** `spall_search` snippets and headings, `spall_list` frontmatter, `spall_query_base` row values and groups, and `spall_read` frontmatter, outline headings and backlinks' link targets now come inside `<untrusted-content source="spall" path="…">`, one fence per note; paths, counts and revs stay plain JSON. `spall_list view=tags` fences the tag names. With fencing on, results carry no `structuredContent`: Claude Code shows the model `structuredContent` instead of the text, so the fence never reached it; the text carries the same data. `mcp.fence_untrusted: false` gives the old output (JSON text plus `structuredContent`). The CLI doesn't fence; `spall mcp` (stdio) follows the account's setting via `/v1/me` `mcp.fenced`.
- **`whoami` reports effective access.** `GET /v1/me`, `spall_whoami` and `spall whoami` list only grants that have permissions (hidden folders are left out, like missing ones), and `mcp` is now `{enabled, tools, fenced}`: the tool names the account actually sees (`[]` when MCP is off on the server) and whether note text is fenced (the account's effective `fence_untrusted`). The raw config fields `mcp.read_only`, `mcp.tools: null` and `mcp.fence_untrusted` are gone. `spall whoami` prints one line per grant (`Inbox  create`) and the tool list.
- **`missing=Key` matches empty values.** `missing` (REST, `spall_list`, `spall ls --missing`) now matches notes where the property is absent, `Key:` (null), `""` or blank, or `[]`, as Obsidian treats them alike; `--missing Completed` finds unfinished notes from a template that writes `Completed:`. An empty key still counts as a known property.

## 1.2.0 — 2026-11-19

Correctness fixes and fewer calls for agents, from the 1.1.0 agent evals.

- **Frontmatter edits keep untouched content byte-for-byte.** `frontmatter.set` / `unset` / `merge` rewrite only the targeted key: flow lists stay `[ai]` (not `[ ai ]`), and key order, quoting, comments, spacing and trailing spaces on other keys are kept. The blank line between the frontmatter and the body is kept, and appending to an empty body adds one. The fence lines are kept too (CRLF line endings, a `...` closing fence). Long strings are no longer folded. Every edit is checked to parse back to exactly the requested values before anything is written; changing or removing a value whose YAML anchor other keys refer to is refused with 400 (use `replace_text`).
- **Move into a folder.** A move destination ending in `/`, or naming an existing folder the account can see, means "move into it, keeping the file name" (`POST …/move`, `spall_move`, `spall mv`). Before, `spall mv note.md "3. Resources/Electronics/"` created the file `3. Resources/Electronics.md`.
- **`.base` files over MCP and the CLI.**
  - `spall_read` / `spall read` on a `.base` return its raw YAML; `view=outline` / `--outline` / `spall base X --views` list its views with filters, sort, columns and the default view. `GET /v1/bases/{path}` now returns `default_view`.
  - `spall_edit` / `spall edit` edit a `.base` as text (`replace_text`, `replace_all`; new CLI flag `--replace-all`) under the account's `update` grant; `spall_move` and `spall_trash` take `.base` files too.
  - `PUT /v1/files/{path}.base` (and so every edit) checks the YAML, the base structure and every filter/formula expression, and returns 422 `invalid_base` without writing.
  - A visible non-note file asked for through a note route or tool returns 400 `not_a_note`, naming the endpoint/tool to use, instead of `not_found`. Hidden files still return 404.
- **Backlinks over MCP and the CLI:** `spall_read view=backlinks` and `spall read <path> --backlinks` list the notes linking to a note (only notes the account can read), like `?include=backlinks` in REST.
- **Fix:** a wikilink `[[X]]` no longer resolves to a folder named `X`; it finds the note (e.g. the folder note `X/X.md`). This made backlinks and resolved `links` miss folder notes.
- **Fix: bases compare wikilink properties as links.** A frontmatter value that is a whole wikilink (`base: "[[Info Dump.base]]"`, also `[[X|alias]]`, `[[folder/X]]` and list items) is a link, as in Obsidian, so `note["base"] == link("Info Dump.base")` and `.contains(link(…))` match it; before, such a base returned no rows. These links also count as the note's outgoing links: `file.hasLink`, `file.links` and backlinks see them.
- **CLI paths are copy-pasteable.** `search`, `ls`, `tree` and `read --backlinks` print paths in double quotes when they have spaces or a leading number (`"1. Projects/Tram Board.md"`), so a numbered folder no longer reads as a rank. Search hits show `score N` instead of a bare number in parentheses.
- **`not_found` suggests paths.** A 404 for a path gets `details.did_you_mean` (up to three): the same path without `1. `-style prefixes, case, `.md` or `.base`, the same name in another folder, or a near-miss spelling. Suggestions come only from paths the account can see, so a hidden path and a missing one still get the same answer. MCP and CLI errors show them in the message. The CLI prints a `not_a_note` error with the path quoted and without the REST endpoints.
- **Frontmatter filters on listings:** `where` (`Status=Done`, `Status!=Done`, `Score>=4`, `Due<2026-12-01`; `=` matches list items and ignores the value's case) and `missing` (notes without a property) on `GET /v1/folders`, `spall_list` and `spall ls --where … --missing …`. A property no listed note has, or a condition that doesn't parse, is a 400 that names it, and suggests the property with the same name in another case (names stay case-sensitive, as in Obsidian).
- **Bases diagnostics:** a filter that is a quoted string (a JSON-encoded filter quoted once too often, which matched every row) is rejected, and a filter that reads a property none of the queried notes has gets a diagnostic with the right-case name. The `spall_query_base` description says how to run an ad-hoc query without a `.base` file.
- **Search:**
  - folder names match too (`template` finds notes under `templates/`), as titles, tags and frontmatter values already did; `related` ignores folder names;
  - snippets come from the line with the most matched terms, centred on the match, with a new `heading` field (`"Notes > Highlights"`); when only the frontmatter matched, the snippet is that `Key: value`;
  - responses include `scope: {folder, notes}`, and an empty result says so: MCP `No matches for "x" in … (N notes)`, CLI `No matches for "x" in … (N notes searched).`
  - an empty result also says which languages the notes in scope are in (REST `hint`, MCP text, CLI): `Notes in this scope are in English (≈80%) and Russian (≈20%); search is word-based and doesn't translate, so try the terms in those languages too.` Only counts over notes the account can read, never names.
- **Paging:**
  - a cursor no longer depends on `limit`, so the next page can be bigger;
  - a cursor used with other parameters names them: `Invalid cursor: depth, sort changed …` (`details.changed`);
  - a malformed cursor is always a 400, never a 500;
  - `spall_list` pages hold 200 entries by default (max 500), `spall_search` 20 (max 100); MCP results have `next_cursor` only when there is a next page;
  - listing totals include `entries` (everything that matched, folders too), and the CLI prints `(63 entries: 50 notes, 1 file, 12 folders)` or `(50 shown of 63 entries…; more: --cursor …)`.
- **Folder tree:** `GET /v1/tree/{path}?depth=3&limit=200`, `spall_list view=tree` (`max_depth`) and `spall tree [folder] [--depth N] [--limit N]`. Folders only, indented, each with its count of readable notes below it; folders past the depth are summed into their parent (`2 subfolders below`), and a cap adds a `[truncated: …]` line. Scoped like listings: traverse-only parents are marked, hidden folders and notes aren't shown or counted.

## 1.1.0 — 2026-11-19

Agents can use Spall directly, over MCP or a CLI, with the same tokens and folder scoping as REST.

- **MCP endpoint `POST /mcp`** (Streamable HTTP, stateless; 2026-07-28 and 2025-era clients). Nine tools: `spall_whoami`, `spall_search`, `spall_list`, `spall_read`, `spall_query_base`, `spall_create`, `spall_edit`, `spall_move`, `spall_trash`.
  - Each tool call goes through the REST routes in-process, so auth, scoping, rate limits, rev checks and the audit log are the REST ones.
  - An account sees only the tools its grants allow. `?read_only=1&tools=…` and a per-account `mcp:` block can hide more, never add.
  - Note bodies are wrapped in `<untrusted-content>` markers (`mcp.fence_untrusted`, on by default).
  - Writes made through `/mcp` are audited with `via: mcp/<tool>`.
  - A `spall_edit` call counts as two REST calls against the rate limit; the `/mcp` request itself isn't counted.
  - New config: `mcp: {enabled, allowed_origins, fence_untrusted}`; per account, `mcp: {read_only, tools, fence_untrusted}`.
- **Client CLI:** `spall whoami | search | ls | tags | read | new | edit | mv | trash | base | doctor` against a server. Credentials come from `SPALL_URL` (or `--url`) and `SPALL_TOKEN`; the token is never taken from the command line. `--json` works everywhere, and the exit codes are documented.
- **`spall mcp`:** the same tools over stdio for clients that only run local commands (e.g. `npx -y @ikaros-labs/spall mcp` in Claude Desktop).
- **npm:** published as `@ikaros-labs/spall` (`npm i -g @ikaros-labs/spall`, `npx -y @ikaros-labs/spall …`; the command stays `spall`, and the access module is `@ikaros-labs/spall/access`), with provenance, from a tag workflow using npm trusted publishing (OIDC, no token). The first version is published once by hand, then trusted publishing is configured on npmjs.com for `ikaros-labs/spall`, workflow `npm.yml`.
- **Agent skill:** `skills/spall/SKILL.md`.
- **Fix:** `PATCH` append keeps the markdown structure. It adds a blank line before an appended `---`/`===` (it turned the paragraph above into a heading) and before text appended after a table (it became a table row).
- `/v1/me` includes the account's `mcp` settings, and `/healthz` returns the server version.

## 1.0.0 — 2026-11-16

First public release. Formerly developed as `obsidian-api` (internally `vault-api`).

- Per-account access to a vault: `root`, folder/file grants with levels `none`, `read`, `append`, `edit`, `full` or explicit permission lists; deepest grant wins; dotfiles, `vault.exclude` and paths outside the root are always denied; 404 for anything out of scope.
- Notes API: JSON, raw markdown and outline reads with ETags; create, replace, section-level and frontmatter `PATCH`, move, trash and permanent delete; audit log.
- Files and folders API: raw bytes with `Range`, listings with sampling, cursors and `traverse_only` parents, counts, tags.
- Bases: read `.base` files, evaluate their views and ad-hoc queries without Obsidian.
- Search (BM25, English and Russian), related notes, stats and Prometheus metrics (`spall_*`), all scoped to what the account can read.
- YAML config with hot reload (file watch and `SIGHUP`); CLI `serve`, `check`, `explain`, `token create|list|revoke`. Tokens are `spl_…` and stored as SHA-256 hashes.
- OpenAPI 3.1 document at `GET /openapi.json` and in the repo.
- `spall/access`: the access rules as a browser-safe module.
- Multi-arch Docker image `ghcr.io/ikaros-labs/spall` (`linux/amd64`, `linux/arm64`).
