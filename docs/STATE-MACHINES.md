# Spall state machines

What state Spall keeps, how it moves, and where it can go wrong. Written from the code at
`21b9c3a` (1.2.3) on 2026-11-20. Line numbers refer to that tree unless a fix moved them; every
fix below updates its table.

Spall has no database. Its state is spread over four places, and most machines below are implicit:
they are combinations of these.

| Where | What | Owner |
| --- | --- | --- |
| The config file (`spall.yaml`) | accounts, grants, tokens, restart-only settings | the admin's editor, `spall token …` (any number of processes) |
| The running `Config` object | the active copy of the above | `ConfigManager` |
| The vault on disk | notes, attachments, folders, the trash | the API, Obsidian, sync tools, anything |
| In-memory indexes | `VaultIndex`, `SearchIndex`, bases caches, rate-limit windows | the server process |

Notation: **from → event → to [guard]**. "API" means a REST call (MCP tools call the REST routes
in-process, so they go through the same paths). "External" means anything outside the server.

---

## M1. Active config (hot reload)

**Lives in** `src/config.ts:309-357` (`ConfigManager`), started by `src/cli/admin.ts:60-81`
(`serve`: file watcher plus `SIGHUP`).

**States.** `config.current` is one compiled `Config`. Implicitly the machine also has the file on
disk, so the real state is the pair (*active*, *on disk*):

- **InSync**: the active config was compiled from the file as it is.
- **Debouncing**: the folder watcher saw the file change; a 200 ms timer is pending.
- **Diverged(invalid)**: the file doesn't parse or compile; the previous config stays active.
- **Diverged(restart)**: the file is valid but changes a restart-only setting (`server.*`,
  `vault.path`, `vault.trash`, `vault.follow_symlinks`).
- **Closed**: watcher and timer stopped.

**Invariants.**
- I1.1 The active config is always one that compiled without problems.
- I1.2 Restart-only settings of the active config equal those the server started with (the HTTP
  listener, the `Vault` and the `VaultIndex` were built from them).
- I1.3 Every other setting, above all the token list, follows the file within ~200 ms of a valid
  write (or immediately on `SIGHUP`). Revoking a token must take effect without a restart.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| InSync | file in the config folder changes | Debouncing | name == config file name | `config.ts:346-350` |
| Debouncing | another change | Debouncing (timer restarted) | | `config.ts:348` |
| Debouncing / any | timer fires, or `SIGHUP` → `reload()` | InSync (new config) | file compiles, restart-only settings unchanged | `config.ts:326-341` |
| Debouncing / any | `reload()` | Diverged(invalid) | parse/compile error | `config.ts:328-333` |
| Debouncing / any | `reload()` | **Diverged(restart): nothing applied** | restart-only setting changed | `config.ts:334-337` (**B4**) |
| any | `close()` | Closed | | `config.ts:353-356` |

Requests read `s.config()` once in `onRequest` (`server.ts:75`) and keep the `Account` they got,
so a reload never changes the rules in the middle of a request.

**Reachable invalid state.** **B4**: Diverged(restart) drops *every* change in the edit, not only
the restart-only one. While the file holds a pending restart-only change, all later edits
(revocations, removed accounts, narrowed grants) are ignored too, until someone restarts. Breaks I1.3.

---

## M2. Token lifecycle

**Lives in** the `tokens:` lists of the config, `src/tokens.ts`, the auth hook
`src/http/server.ts:68-86`, and the CLI `src/cli/admin.ts:141-181`.

**States** (per token, derived from the config row and the clock):

- **Absent**: no row with this hash.
- **Active**: a row whose `expires` is unset or in the future.
- **Expired**: a row whose `expires` has passed (`isExpired`, `tokens.ts:20-23`); stays in the file.
- **Revoked**: the row is gone (back to Absent).

What the server enforces is the token's state *in the active config* (M1), not in the file.

**Invariants.**
- I2.1 A plain token is never stored; only its SHA-256 (`config.ts:21-26`).
- I2.2 Hashes are unique across all accounts; names are unique within an account (`config.ts:264-271`).
- I2.3 A token printed by `token create` is in the file when the command exits 0.
- I2.4 `token revoke <account> <name>` removes exactly that token, no other.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | `spall token create` | Active (or Expired if `--expires` is past) | account exists | `admin.ts:144-162` |
| Active | clock passes `expires` | Expired | | `tokens.ts:20-23`, checked per request `server.ts:77` |
| Active / Expired | `spall token revoke` | Absent | name exists | `admin.ts:174-180` |
| any | admin edits the file | anything | file compiles | via M1 |
| Active (on disk) | request | authenticated | Active **in the active config** | `server.ts:73-81` |

The CLI edits the file with read → edit → validate → write temp → rename (`editConfig`,
`admin.ts:46-58`). The rename is atomic, but the read-modify-write is not protected against
another writer.

**Reachable invalid states.**
- **B5** (breaks I2.4): `revoke` finds the token's *index* in the config it loaded first
  (`admin.ts:176`), then re-reads the file and deletes that index (`admin.ts:178`). If another
  edit removed an earlier token in between, it deletes the wrong token and the one asked for stays
  Active.
- **B6** (breaks I2.3): two concurrent edits each read the same file and the second rename wins;
  the first `token create` printed a token that is not in the file.
- Through **B4**, a token revoked in the file can stay Active on the server.

---

## M3. Grant decision

**Lives in** `src/access.ts:40-90` (`Access.decide`, `leadsToReadable`), compiled by
`compileAccess` (`access.ts:140-173`). Pure: no mutable state, but it is the classifier every
write path and listing depends on, so its states are listed for completeness.

**States** (the `reason` of a decision for one path): `outside_root`, `dotfile`, `excluded`,
`no_grant`, `grant(key, perms)`; plus the derived *traversable* (no read, but leads to a readable
grant).

**Invariants.**
- I3.1 Checks run in this order: root, dot segments, `vault.exclude` (including a non-dot trash
  folder, `config.ts:225-226`), deepest grant. The first match wins.
- I3.2 Paths are compared by `matchKey` (NFC, case-folded, leading spaces and trailing dots/spaces
  stripped), so aliases of one path get one decision.
- I3.3 `update`, `delete` and `purge` imply `read` (rejected at compile time otherwise).
- I3.4 A path through a symlink needs the permission on both the link path and the target
  (`fileops.ts:88-92`, `context.ts:88-93`).

No reachable violation found (see Unconfirmed U4).

---

## M4. Rate-limit window

**Lives in** `src/http/server.ts:29-44` (`RateLimiter`), keyed by account name.

**States** per account: **NoWindow**; **Open(start, count < limit)**; **Full(start, count = limit)**.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| NoWindow | request | Open(now, 1) | | `server.ts:36-42` |
| Open | request | Open(count+1) or Full | within window | `server.ts:40-42` |
| Full | request | Full, 429 with `retry-after` | within window | `server.ts:40` |
| Open / Full | request after `windowMs` | Open(now, 1) | | `server.ts:36` |
| Open / Full | request after a reload changed the limit | Open(now, 1) | `w.limit !== limit` | `server.ts:36` |

MCP envelopes don't count; the REST calls their tools make do (`server.ts:78-79`).

Invariant I4.1: at most `limit` counted requests per window per account. It is a fixed window, so up
to 2×limit can pass across a window boundary; that is the documented design, not a bug. A reload
that changes the limit opens a fresh window (cosmetic, admin-triggered).

---

## M5. Vault write lock

**Lives in** `src/vault.ts:9-23` (`WriteLock`, `Vault.writes`), taken by every API write: PUT,
DELETE and move (`fileops.ts:109,155,179`), `POST /v1/notes` and PATCH (`notes.ts:93,127`),
folder create and delete (`folders.ts:255,274`). Reads never take it.

*Before I1* it was a per-key mutex (`Locks`) keyed by the lower-cased *requested* path, taken by
PUT, DELETE, move, PATCH and folder DELETE only.

**States:** **Free**, **Held**, **Held+queued(n)** (one promise chain, FIFO).

**Invariants.**
- I5.1 Two API operations that touch the same file never interleave their read-check-write steps.
- I5.2 An operation that checks a whole folder (recursive delete) sees no API write land inside
  that folder between its check and its action.
- I5.3 A failed write releases the lock (the chain swallows the rejection; the caller still gets it).

| From | Event | To | Code |
| --- | --- | --- | --- |
| Free | `writes.run(fn)` | Held | `vault.ts:17-21` |
| Held | `writes.run(fn)` from another request | Held+queued | `vault.ts:18-19` |
| Held(+queued) | `fn` resolves or rejects | Free / next in queue | `vault.ts:19-20` |

External writers (Obsidian, sync) can't take the lock; see U3.

**Invalid states (fixed by I1).**
- **B1** (broke I5.2): folder DELETE locked only the folder's own key; a PUT into the folder locked
  the file's key. Both ran at once, so the recursive delete's "everything inside is visible and
  deletable" check (`folders.ts:282-288`) could pass, then a file another account had just written
  was purged or trashed by an account that couldn't even see it.
- **B2** (broke I5.1): keys were requested paths, not real ones. With `follow_symlinks`,
  `Alias/Plan.md` and `Research/Plan.md` are one file under two keys, so two PATCHes read the same
  old text and the second write lost the first.

---

## M6. A file in the vault (notes and attachments)

**Lives in** `src/http/fileops.ts` (`putFile` 103-147, `deleteFile` 151-169, `moveFile` 176-207),
`src/http/notes.ts` (POST 90-117, PATCH 119-140), `src/vault.ts` (`create` 105-120,
`overwrite` 126-129, `trash` 160-167, `purge` 169-172).

**States** per path: **Absent**; **Present(rev)** where `rev = sha256(bytes)[:16]`; **Trashed** (moved
to `trash/<same path>` or `… N.ext`); **Partial** (the bytes on disk are neither the old nor the new
content: must never be observable after a request ends).

**Invariants.**
- I6.1 A conditional write (`If-Match`, PATCH `if_match`) only applies to the rev the client saw.
- I6.2 After a request ends, a file is either in its old or its new state, never Partial.
- I6.3 A write that returned an error left the file as it was.
- I6.4 A trashed file never overwrites another trashed file.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | PUT | Present(r) | `create` perm; no `If-Match` other than none; `O_EXCL` | `fileops.ts:131-140`, `vault.ts:105-120` |
| Absent | POST /notes | Present(r) at `Title.md` or `Title N.md` | `create` on folder; `on_conflict` | `notes.ts:90-117` |
| Present(r) | PUT | Present(r') | `read`+`update`; `If-Match` ∋ r; not `If-None-Match: *` | `fileops.ts:118-130` |
| Present(r) | PATCH | Present(r') (or unchanged if no-op) | `read`+`update`; `if_match` ∋ r | `notes.ts:125-139` |
| Present(r) | DELETE | Trashed | `read`+`delete`; `If-Match` | `fileops.ts:151-169`, `vault.ts:160-167` |
| Present(r) | DELETE `permanent=true` | Absent | `read`+`purge` | `vault.ts:169-172` |
| Present(r) at A | move to B | Absent at A, Present(r) at B | see M7 | `fileops.ts:176-207` |
| Present(r) | overwrite fails midway | Present(r): old bytes written back, error returned | | `Vault.overwrite` (fixed **B3**) |
| any | external write / delete | any | | M9 picks it up |

`overwrite` writes in place on purpose: a rename over a temp file would give the note a new inode and
so a new birth time, which is what `created` reports (`vault.ts:122-125`).

**Retries.** PUT with `If-None-Match: *` (create) and PUT/PATCH with `If-Match` are safe to retry: a
retry after a lost response gets 409/412 and the current rev, not a second write. DELETE and move
retries get 404 once the first one went through. `POST /v1/notes` with the default
`on_conflict: rename` is *not* idempotent: a retry creates `Title 1.md` (see B9 and decision D4).

**Invalid states.**
- **B3** (broke I6.2, I6.3; fixed by I2): `writeFile` truncates first. If it failed after that
  (disk full, quota, I/O error), the request returned 500 and the note held only the bytes written
  so far. `overwrite` now reads the old bytes first and writes them back when the write fails; the
  index is untouched, so the client's old rev still matches. A crash mid-write is still U1.
- **B9**: the audit line is written after the change (`fileops.ts:129`, `notes.ts:113`, …). If that
  write fails, the client gets 500 for a change that happened; a retry of `POST /v1/notes` then
  makes a duplicate.

---

## M7. Move protocol (two steps on disk)

**Lives in** `src/vault.ts:143-157` (`Vault.move`), called by `moveFile` under the lock.

**States** for a move A → B: **Src** (only A), **Both** (A and B are hard links of one inode),
**Dst** (only B).

**Invariants.**
- I7.1 A move never overwrites B (`link` fails with `EEXIST`).
- I7.2 A failed move leaves Src: the client can retry.
- I7.3 Only on success does the index lose A and gain B.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Src | `link(A, B)` | Both | B absent | `vault.ts:146` |
| Both | `unlink(A)` | Dst | | `vault.ts:147` |
| Src | `link` fails `EPERM`/`ENOTSUP`/`EXDEV` | Dst via check-then-`rename` | B absent at check | `vault.ts:150-153` |
| Src | `link` fails `EEXIST` | Src, 409 | | `vault.ts:149` |
| **Both** | **`unlink(A)` fails** | **Both, error** | | `vault.ts:148-150` (**B7**) |
| Dst | index refresh of A and B | | | `vault.ts:155-156` |

**Reachable invalid states.**
- **B7** (breaks I7.2): `link` and `unlink` share one `try`. If `unlink(A)` fails, the file stays at
  both paths and the index doesn't know B. With `EACCES` the client gets 500; with `EPERM` the
  error falls into the "no hard links" branch, which sees B (just linked) and answers 409
  `already_exists`, blaming a destination the request itself created. A retry then fails with 409
  for as long as the stray link exists.
- A crash between `link` and `unlink` also leaves Both. That can't be prevented without a journal;
  see U2.

---

## M8. A folder in the vault

**Lives in** `src/http/folders.ts:251-292`, `src/vault.ts:131-140` (`mkdir`), `174-184`
(`rmdirEmpty`), `160-172` (`trash`, `purge`).

**States:** **Absent**, **Empty**, **NonEmpty(visible to the caller)**, **NonEmpty(has entries the
caller can't see or can't delete)**, **Trashed**.

**Invariants.**
- I8.1 A recursive delete only removes what the caller may delete: everything inside must be
  indexed (no dotfiles, no skipped symlinks) and carry `delete`/`purge` for the caller
  (`folders.ts:280-286`).
- I8.2 The root of an account can't be deleted.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | POST /folders | Empty | `create` | `folders.ts:251-263` |
| Absent | PUT/POST of a file below | NonEmpty (parents made with `mkdir -p`) | | `vault.ts:106` |
| Empty | DELETE | Absent | `read`+`delete` | `folders.ts:275-279` |
| NonEmpty | DELETE | 409 `folder_not_empty` | not `recursive` | `vault.ts:178-180` |
| NonEmpty(visible) | DELETE `recursive=true` | Trashed / Absent | check passes | `folders.ts:280-290` |
| NonEmpty(hidden) | DELETE `recursive=true` | 409 / 403 | check fails | `folders.ts:284-285` |

**Invalid state (fixed by I1).** **B1** (M5): between the check and the trash/purge, another request
could turn NonEmpty(visible) into NonEmpty(hidden), and the hidden file was removed anyway. The
check and the removal now run under the write lock, so an API write inside the folder lands either
before the check (and fails it) or after the removal (in a fresh folder).

---

## M9. Vault index and watcher

**Lives in** `src/vault-index.ts:36-256` (`VaultIndex`), started by `src/app.ts:21-24`.

**States.** Per path: **Unindexed**, **Indexed(kind, stat, rev, meta)**. Per path refresh queue:
**Idle**, **Refreshing(+queued)** (`pending`, `vault-index.ts:163-172`). Watcher: **Off**,
**Starting** (until chokidar's `ready`), **Watching**, **Closed**. Plus a global `version`, bumped
on every change.

**Invariants.**
- I9.1 Every indexed entry's parent folder is indexed (the tree is connected; `childrenOf` and
  listings rely on it).
- I9.2 No dot-path is indexed; with `follow_symlinks` off, no symlink is.
- I9.3 After the vault is quiet and all refreshes settle, the index matches the disk.
- I9.4 Refreshes of one path apply in the order they were asked for.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| (none) | `build()` | Indexed tree | | `vault-index.ts:73-80` |
| Off | `watch()` | Starting → Watching | `ready` | `vault-index.ts:231-250` |
| any path | watcher add/change/unlink/addDir/unlinkDir | `refresh(path)` queued | not a dot-path | `vault-index.ts:242-246` |
| any path | API write | `refresh(path)` | | `vault.ts` (each op) |
| Indexed / Unindexed | refresh, `load` finds it | Indexed (and its parent chain) | | `vault-index.ts:174-190` |
| Indexed | refresh, `load` finds nothing | Unindexed, with its subtree | | `vault-index.ts:177-179` |
| Indexed(file) | refresh, now a folder | Indexed(folder), contents scanned | | `vault-index.ts:187-189` |
| Indexed(folder) | refresh, now a file | Indexed(file), old subtree dropped | | `vault-index.ts:140` |
| Watching | `close()` | Closed | | `vault-index.ts:252-255` |

**Reachable invalid state.** **B8** (breaks I9.1, I9.3): refreshes are serialised per path only. A
refresh of `Gone/x.md` reads the file, then waits; meanwhile `Gone/` is deleted and its own refresh
drops the subtree. When the first refresh resumes, it finds the parent missing, refreshes the
parent (gone: nothing to do) and then inserts `Gone/x.md` anyway: a ghost entry under a folder that
doesn't exist. It shows in search, tags, bases and backlinks until something touches that exact
path again.

---

## M10. Search index sync

**Lives in** `src/search/index.ts:119-145` (`sync`, `doSync`), per-scope statistics cached by
`(account object, folder, syncedVersion)`.

**States:** **Synced** (`syncedVersion == index.version`), **Stale**, **Syncing** (one shared promise).

| From | Event | To | Code |
| --- | --- | --- | --- |
| Synced | index changes (`version++`) | Stale | `vault-index.ts:138,154` |
| Stale | query → `sync()` | Syncing | `search/index.ts:119-124` |
| Syncing | pass ends, version moved during it | Syncing (another pass) | `search/index.ts:128` |
| Syncing | pass ends, version unchanged | Synced | `search/index.ts:143` |

Invariant I10.1: a query returns results computed from a sync at least as new as the index version
when the query started. Holds: each pass re-checks the version. A note read during a pass may be
newer than the rev it is stored under; the next refresh changes the rev and the note is read again.
Invariant I10.2 (scoping): statistics are keyed by the `Account` object, so a config reload (new
objects) never reuses another grant set's statistics. Holds.

Bases use the same scheme: `EngineCache` is keyed by `[index.version, property types, config
generation]` (`http/bases.ts:89-95`), `PropertyTypes` by the mtime of `.obsidian/types.json`. No
violations found.

---

## M11. CLI config edit

**Lives in** `src/cli/admin.ts:46-58` (`editConfig`).

**States** of one run: **Loaded** (compiled config used to find the account/token), **Read** (YAML
document), **Edited**, **Validated**, **TempWritten**, **Renamed** (committed).

**Invariants.**
- I11.1 The file on disk is always a complete config (temp file plus rename).
- I11.2 The edit applies to the file as it is when the edit is written (no lost update).
- I11.3 What the edit acts on (which token) is decided on the same version of the file it writes.

| From | Event | To | Code |
| --- | --- | --- | --- |
| start | `loadConfig` | Loaded | `admin.ts:143` |
| Loaded | `readFileSync` + `parseDocument` | Read | `admin.ts:47` |
| Read | edit callback | Edited | `admin.ts:48` |
| Edited | `compileConfig` | Validated (or exit 1) | `admin.ts:50-54` |
| Validated | write `.spall.yaml.<pid>.tmp` | TempWritten | `admin.ts:55-56` |
| TempWritten | `rename` | Renamed; the server's watcher reloads (M1) | `admin.ts:57` |

**Reachable invalid states.** **B5** breaks I11.3 (index from Loaded, applied to Read); **B6**
breaks I11.2 (no lock between Read and Renamed).

---

## Reachable invalid states and transitions (confirmed)

"Confirmed" = reproduced by a test that fails on `21b9c3a`. Ordered by impact.

| Bug | Machine | Impact | What happens | Reproduced by | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | M5, M8 | data loss, security | Recursive folder delete purges/trashes a file another account wrote after the permission check; the deleter could not see it | `test/sm-write-lock.test.ts` "B1 …" (parks `Vault.purge`, runs the other account's PUT) | fixed (I1) |
| B2 | M5, M6 | data loss | Two PATCHes of one note through a symlink alias and its real path both apply to the old text; one edit is lost | `test/sm-write-lock.test.ts` "B2 …" (parks `Vault.overwrite`) | fixed (I1) |
| B3 | M6 | data loss | A write that fails after truncating (ENOSPC, EIO) leaves a partial note and returns 500 | `test/sm-overwrite-fault.test.ts` (injects ENOSPC after 3 bytes) | fixed (I2) |
| B4 | M1, M2 | security | A config edit that also touches a restart-only setting is ignored entirely, so a token revoked in it stays valid until restart | `test/sm-config-reload.test.ts` | open |
| B5 | M2, M11 | security | `token revoke` after a concurrent edit deletes the wrong token; the one asked for stays valid | `test/sm-cli-tokens.test.ts` "B5 …" (another revoke lands between load and edit) | open |
| B6 | M2, M11 | wrong user-visible state | Concurrent `token create` + another edit: the printed token is not in the file | `test/sm-cli-tokens.test.ts` "B6 …" (child CLI process vs. a writer holding the file) | open |
| B7 | M7 | wrong user-visible state (duplicate file) | `unlink` of the source fails after `link`: the file exists at both paths; with EPERM the API answers 409 for its own link; retries keep failing | `test/sm-move-fault.test.ts` (injects EACCES / EPERM on unlink) | open |
| B8 | M9 | wrong user-visible state | A refresh racing a folder removal leaves a ghost index entry under a missing folder | `test/sm-index-race.test.ts` (parks `VaultIndex.load`) | open |
| B9 | M6 | wrong user-visible state | The audit write fails after the change: 500 for a change that happened; a retried `POST /v1/notes` creates `Title 1.md` | scratch reproduction (audit folder made read-only): first POST 500, retry 201 `Research/Retry me 1.md`, both files on disk | not fixed (D3) |

## Unconfirmed

| # | Suspicion | Why not confirmed | What would settle it |
| --- | --- | --- | --- |
| U1 | A crash (power loss, `kill -9`) during `overwrite` leaves a truncated note (M6). | Needs a real crash; the in-place write is a deliberate trade-off for birth times. | A test that `kill -9`s a child server mid-write of a large note, on a filesystem without data journaling. The fix would be temp + rename, at the cost of `created`. |
| U2 | A crash between `link` and `unlink` in a move leaves the file at both paths (M7); a retry then answers 409. | Needs a real crash between two syscalls. | Same kill-in-the-middle harness. A fix needs a journal or `renameat2(RENAME_NOREPLACE)`, which Node doesn't expose. |
| U3 | External tools (Obsidian, sync) racing API writes: the "no hard links" move fallback checks then renames and could overwrite a file created in between; `PUT` checks `kindOf` then creates. | The window is between two syscalls; API-vs-API is covered by the lock (M5), external writers can't take it. | A filesystem without hard links (e.g. some FUSE/SMB mounts) plus a writer injected between `kindOf` and `rename`. |
| U4 | Case-insensitive filesystems: grants and locks compare case-folded keys, the index is case-sensitive. A file renamed only in case externally could show twice until the watcher settles. | Not reproducible on the Linux CI filesystem. | Run the suite on APFS/NTFS. |
| U5 | Watcher event storms (`git checkout` of thousands of files) while API writes run: refreshes are per path, so I9.3 should hold once quiet; not stress-tested. | No deterministic interleaving found beyond B8. | A property test that applies random external ops and API ops, waits for quiet, then diffs `VaultIndex` against a fresh `build()`. |

## Issues

Grouped fixes, in priority order. One commit each, each with the regression test named above.

### I1. One write lock for the whole vault
- **Bugs:** B1, B2.
- **Impact:** data loss, security.
- **Fix:** replace the per-path `Locks` with one FIFO `WriteLock` on the `Vault`, and take it in
  every write route, including `POST /v1/notes` and `POST /v1/folders`, which took none. `moveFile`
  now also works out its destination (folder or file) inside the lock.
- **Commit:** `b284e5f`
- **Test:** `test/sm-write-lock.test.ts`

### I2. Roll back a failed in-place overwrite
- **Bugs:** B3.
- **Impact:** data loss.
- **Fix:** `Vault.overwrite` keeps the old bytes and writes them back if the in-place write fails,
  then rethrows. Keeps the inode (and so `created`), per D2.
- **Commit:** —
- **Test:** `test/sm-overwrite-fault.test.ts`

### I3. Apply hot settings of a reload that also changes restart-only ones
- **Bugs:** B4.
- **Impact:** security.
- **Fix:** —
- **Commit:** —
- **Test:** `test/sm-config-reload.test.ts`

### I4. Lock CLI config edits and decide inside the lock
- **Bugs:** B5, B6.
- **Impact:** security, wrong user-visible state.
- **Fix:** —
- **Commit:** —
- **Test:** `test/sm-cli-tokens.test.ts`

### I5. Undo the link when a move's unlink fails
- **Bugs:** B7.
- **Impact:** wrong user-visible state (duplicate file, failing retries).
- **Fix:** —
- **Commit:** —
- **Test:** `test/sm-move-fault.test.ts`

### I6. Don't index a path whose parent is gone
- **Bugs:** B8.
- **Impact:** wrong user-visible state.
- **Fix:** —
- **Commit:** —
- **Test:** `test/sm-index-race.test.ts`

## Decisions

- D1. One global write lock instead of per-path, hierarchical or real-path locks: writes are local
  file operations on one person's vault, so serialising them costs nothing noticeable, and it is
  the only simple scheme that also covers folder-vs-file and alias races.
- D2. Overwrites stay in place (keeping birth times, as Obsidian does); a failed write is rolled
  back from the old bytes. A real crash mid-write stays possible (U1).
- D3. B9 is left as is: returning success when the audit line could not be written would hide
  unaudited changes, and writing the line first would log changes that then fail. A failing audit
  log is an operator problem that already surfaces as 500s and an error in the server log.
- D4. `POST /v1/notes` with `on_conflict: rename` stays non-idempotent by design; clients that retry
  should use `PUT` with `If-None-Match: *`, which is.
