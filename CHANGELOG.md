# Changelog

## 1.0.0 — unreleased

First public release. Formerly developed as `obsidian-api` (internally `vault-api`).

- Per-account access to a vault: `root`, folder/file grants with levels `none`, `read`, `append`, `edit`, `full` or explicit permission lists; deepest grant wins; dotfiles, `vault.exclude` and paths outside the root are always denied; 404 for anything out of scope.
- Notes API: JSON, raw markdown and outline reads with ETags; create, replace, section-level and frontmatter `PATCH`, move, trash and permanent delete; audit log.
- Files and folders API: raw bytes with `Range`, listings with sampling, cursors and `traverse_only` parents, counts, tags.
- Bases: read `.base` files, evaluate their views and ad-hoc queries without Obsidian.
- Search (BM25, English and Russian), related notes, stats and Prometheus metrics, all scoped to what the account can read.
- YAML config with hot reload (file watch and `SIGHUP`); CLI `serve`, `check`, `explain`, `token create|list|revoke`. Tokens are `spl_…` and stored as SHA-256 hashes.
- OpenAPI 3.1 document at `GET /openapi.json` and in the repo.
- `spall/access`: the access rules as a browser-safe module.
- Multi-arch Docker image `ghcr.io/ikaros-labs/spall` (`linux/amd64`, `linux/arm64`).
