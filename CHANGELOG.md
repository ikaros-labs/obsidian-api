# Changelog

## 1.1.0 — unreleased

Agents can use Spall directly, over MCP or a CLI, with the same tokens and folder scoping as REST.

- **MCP endpoint `POST /mcp`** (Streamable HTTP, stateless; 2026-07-28 and 2025-era clients). Nine tools: `spall_whoami`, `spall_search`, `spall_list`, `spall_read`, `spall_query_base`, `spall_create`, `spall_edit`, `spall_move`, `spall_trash`.
  - Each tool call goes through the REST routes in-process, so auth, scoping, rate limits, rev checks and the audit log are the REST ones.
  - An account sees only the tools its grants allow. `?read_only=1&tools=…` and a per-account `mcp:` block can hide more, never add.
  - Note bodies are wrapped in `<untrusted-content>` markers (`mcp.fence_untrusted`, on by default).
  - Writes made through `/mcp` are audited with `via: mcp/<tool>`.
  - A `spall_edit` call counts as two REST calls against the rate limit; the `/mcp` request itself isn't counted.
  - New config: `mcp: {enabled, allowed_origins, fence_untrusted}`; per account, `mcp: {read_only, tools, fence_untrusted}`.
- **Client CLI:** `spall whoami | search | ls | tags | read | new | edit | mv | trash | base | doctor` against a server. Credentials come from `SPALL_URL` (or `--url`) and `SPALL_TOKEN`; the token is never taken from the command line. `--json` works everywhere, and the exit codes are documented.
- **`spall mcp`:** the same tools over stdio for clients that only run local commands (e.g. `npx -y spall mcp` in Claude Desktop).
- **npm:** published as `spall` (`npm i -g spall`, `npx -y spall …`), with provenance, from a tag workflow using npm trusted publishing (OIDC, no token). The first version is published once by hand, then trusted publishing is configured on npmjs.com for `ikaros-labs/spall`, workflow `npm.yml`.
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
