# Changelog

## 1.2.0 — unreleased

- **Frontmatter edits keep untouched content byte-for-byte.** `frontmatter.set` / `unset` / `merge` rewrite only the targeted key: flow lists stay `[ai]` (not `[ ai ]`), and key order, quoting, comments, spacing and trailing spaces on other keys are kept. The blank line between the frontmatter and the body is kept, and appending to an empty body adds one. Long strings are no longer folded.
- **Move into a folder.** A move destination ending in `/`, or naming an existing folder the account can see, means "move into it, keeping the file name" (`POST …/move`, `spall_move`, `spall mv`). Before, `spall mv note.md "3. Resources/Electronics/"` created the file `3. Resources/Electronics.md`.
- **`.base` files over MCP and the CLI.**
  - `spall_read` / `spall read` on a `.base` return its raw YAML; `view=outline` / `--outline` / `spall base X --views` list its views with filters, sort, columns and the default view. `GET /v1/bases/{path}` now returns `default_view`.
  - `spall_edit` / `spall edit` edit a `.base` as text (`replace_text`, `replace_all`; new CLI flag `--replace-all`) under the account's `update` grant; `spall_move` and `spall_trash` take `.base` files too.
  - `PUT /v1/files/{path}.base` (and so every edit) checks the YAML, the base structure and every filter/formula expression, and returns 422 `invalid_base` without writing.
  - A visible non-note file asked for through a note route or tool returns 400 `not_a_note`, naming the endpoint/tool to use, instead of `not_found`. Hidden files still return 404.
- **Backlinks over MCP and the CLI:** `spall_read view=backlinks` and `spall read <path> --backlinks` list the notes linking to a note (only notes the account can read), like `?include=backlinks` in REST.
- **Fix:** a wikilink `[[X]]` no longer resolves to a folder named `X`; it finds the note (e.g. the folder note `X/X.md`). This made backlinks and resolved `links` miss folder notes.

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
