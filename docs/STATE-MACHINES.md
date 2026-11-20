# Spall state machines

What state Spall keeps, how it moves, and where it can go wrong. Written from the code at
`21b9c3a` (1.2.3) on 2026-11-20 and kept current through the fixes below: line numbers refer to
the tree with all of them applied.

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

**Lives in** `src/config.ts:308-392` (`readConfigText`, `restartOnly`, `ConfigManager`), with
`parseYaml`/`checkSchema` (`config.ts:186-206`) and `compileConfig(raw, path, runningVault)`
(`config.ts:212-229`). Started by `src/cli/admin.ts:148-169` (`serve`: file watcher plus `SIGHUP`).

**States.** `config.current` is one compiled `Config` (which keeps the `raw` YAML it came from).
Implicitly the machine also has the file on disk, so the real state is the pair (*active*, *on disk*):

- **InSync**: the active config was compiled from the file as it is.
- **Debouncing**: the folder watcher saw the file change; a 200 ms timer is pending.
- **Diverged(invalid)**: the file doesn't parse, or is invalid outside the restart-only settings;
  the previous config stays active.
- **PendingRestart**: the file changes a restart-only setting (`server.*`, `vault.path`,
  `vault.trash`, `vault.follow_symlinks`), or has an invalid value there. Those keep their
  running values; everything else in the file is active.
- **Closed**: watcher and timer stopped.

**Invariants.**
- I1.1 The active config is always one that compiled without problems.
- I1.2 Restart-only settings of the active config equal those the server started with, including
  the *canonical* vault root (the HTTP listener, the `Vault` and the `VaultIndex` were built from
  them); checks that depend on them (audit log outside the vault) use those running values.
- I1.3 Every other setting, above all the token list, follows the file within ~200 ms of a valid
  write (or immediately on `SIGHUP`). Revoking a token must take effect without a restart, whatever
  else the same edit changed.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| InSync | file in the config folder changes | Debouncing | name == config file name | `config.ts:379-386` |
| Debouncing | another change | Debouncing (timer restarted) | | `config.ts:383` |
| Debouncing / any | timer fires, or `SIGHUP` → `reload()` | InSync (new config) | file valid, restart-only settings unchanged | `config.ts:349-376` |
| Debouncing / any | `reload()` | PendingRestart (new config; running restart-only values put back *before* the schema check; vault root reused as is; error logged) | file valid apart from restart-only settings | `config.ts:353-367, 372-373` |
| Debouncing / any | `reload()` | Diverged(invalid) | parse error, or invalid elsewhere | `config.ts:368-371` |
| any | `close()` | Closed | | `config.ts:388-391` |

Requests read `s.config()` once in `onRequest` (`server.ts:75`) and keep the `Account` they got,
so a reload never changes the rules in the middle of a request (see M5 for what that means for
queued writes).

**Invalid states (fixed).**
- **B4** (fixed by I3): a reload that changed a restart-only setting was rejected as a whole,
  dropping *every* change in that edit and in all later ones (revocations, removed accounts,
  narrowed grants) until a restart. Broke I1.3.
- **B13** (fixed by I8): the I3 reload re-resolved the running vault path *string*. If that path
  went through a symlink that had since been retargeted, the published `vaultPath` (and the audit
  containment check) followed the new directory while the vault and index stayed on the old one
  (broke I1.2). And the schema check ran on the file before the overlay, so an invalid pending
  restart-only value (a bad port) still blocked a valid revocation (broke I1.3).

---

## M2. Token lifecycle

**Lives in** the `tokens:` lists of the config, `src/tokens.ts`, the auth hook
`src/http/server.ts:68-86`, and the CLI `src/cli/admin.ts:229-275`.

**States** (per token, derived from the config row and the clock):

- **Absent**: no row with this hash.
- **Active**: a row whose `expires` is unset or in the future.
- **Expired**: a row whose `expires` has passed (`isExpired`, `tokens.ts:20-23`); stays in the file.
- **Revoked**: the row is gone (back to Absent).

What the server enforces is the token's state *in the active config* (M1), not in the file.

**Invariants.**
- I2.1 A plain token is never stored; only its SHA-256 (`config.ts:21-26`).
- I2.2 Hashes are unique across all accounts; names are unique within an account (`config.ts:266-273`).
- I2.3 A token printed by `token create` is in the file when the command exits 0.
- I2.4 `token revoke <account> <name>` removes exactly that token, no other.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | `spall token create` | Active (or Expired if `--expires` is past) | account exists | `admin.ts:232-252` |
| Active | clock passes `expires` | Expired | | `tokens.ts:20-23`, checked per request `server.ts:77` |
| Active / Expired | `spall token revoke` | Absent | name exists in the file under the lock | `admin.ts:263-273` |
| any | admin edits the file | anything | file compiles (restart-only settings aside) | via M1 |
| Active (on disk) | request | authenticated | Active **in the active config** | `server.ts:73-81` |

The CLI edits the file with lock → read → edit → validate → write temp → rename → unlock (M11).

**Invalid states (fixed).**
- **B5** (broke I2.4, fixed by I4): `revoke` found the token's *index* in the config it loaded
  first, then re-read the file and deleted that index. If another edit removed an earlier token in
  between, it deleted the wrong token and the one asked for stayed Active.
- **B6** (broke I2.3, fixed by I4): two concurrent edits each read the same file and the second
  rename won; the first `token create` had printed a token that was not in the file.
- Through **B4** and **B13** (fixed by I3, I8), a token revoked in the file could stay Active on the
  server.
- **B14** (fixed by I9): the I4 lock could have two owners after a stale takeover, and released
  locks it didn't own (M11).

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
  folder, `config.ts:227-228`), deepest grant. The first match wins.
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

**Lives in** `src/vault.ts:9-22` (`WriteLock`) and `vault.ts:55-61` (`Vault.exclusive`, which also
finishes a pending overwrite recovery, M6, before running the write). Taken by every API write:
PUT, DELETE and move (`fileops.ts:110,156,180`), `POST /v1/notes` and PATCH (`notes.ts:93,127`),
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
| Free | `exclusive(fn)` | Held (recover pending overwrites, then `fn`) | `vault.ts:16-21, 55-61` |
| Held | `exclusive(fn)` from another request | Held+queued | `vault.ts:17-19` |
| Held(+queued) | `fn` resolves or rejects | Free / next in queue | `vault.ts:18-19` |

**What the lock covers, and when.** It is held for the whole route body: permission checks on the
resolved path, the filesystem change, the index refresh, the audit-log append and (for PUT, PATCH,
POST and move) building the response. A slow disk or audit sink therefore delays every queued
write; that is the price of D1. Two things happen *before* a write queues and so can be stale by
the time it runs:
- authentication and the account snapshot (`server.ts:73-81`): a write queued behind a slow one
  still runs with the grants it was admitted with, even if a reload revoked its token meanwhile
  (D7);
- the note-path preflight `checkNotANote` (`notes.ts:45`, `fileops.ts:74-85`), which only decides
  between "not a note" (400) and the normal path; the write itself re-resolves and re-checks under
  the lock.

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

**Lives in** `src/http/fileops.ts` (`putFile` 104-148, `deleteFile` 152-170, `moveFile` 177-218),
`src/http/notes.ts` (POST 90-119, PATCH 121-142), `src/vault.ts` (`create` 119-138,
`overwrite` 140-161, journal 163-224, `trash` 283-290, `purge` 292-295). Recovery at startup:
`src/app.ts:24-27`.

**States** per path: **Absent**; **Present(rev)** where `rev = sha256(bytes)[:16]`; **Trashed** (moved
to `trash/<same path>` or `… N.ext`); **Partial** (the bytes on disk are neither the old nor the new
content); **Journaled(old, new_rev)**: an overwrite is in flight or was cut short, and
`.spall/journal/<id>.old` + `<id>.json` hold the old bytes and the rev the write was going to produce.

**Invariants.**
- I6.1 A conditional write (`If-Match`, PATCH `if_match`) only applies to the rev the client saw.
- I6.2 After a request ends, a file is either in its old or its new state, never Partial; if it
  is Partial (the disk refuses even the rollback, or the process died), it is also Journaled, and
  the old bytes come back before the next API write or at the next start, before the index is built.
- I6.3 A write that returned an error left the file as it was (or, per I6.2, Journaled).
- I6.4 A failed create leaves nothing behind.

**Transitions.**

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | PUT | Present(r) | `create` perm; no `If-Match` other than none; `O_EXCL` | `fileops.ts:132-141`, `vault.ts:119-138` |
| Absent | PUT / POST, write fails after `open` | Absent (partial new file unlinked), error | | `vault.ts:128-135` (fixed **B12**) |
| Absent | POST /notes | Present(r) at `Title.md` or `Title N.md` | `create` on folder; `on_conflict` | `notes.ts:90-119` |
| Present(r) | PUT / PATCH: journal old bytes (synced), write in place, drop journal | Present(r') | `read`+`update`; `If-Match` ∋ r | `fileops.ts:119-131`, `notes.ts:127-141`, `vault.ts:146-161` |
| Present(r) | journal write fails (e.g. disk full) | Present(r), error | | `vault.ts:163-175` |
| Present(r) | in-place write fails, rollback works | Present(r), journal dropped, error | | `vault.ts:153-154` |
| Present(r) | in-place write *and* rollback fail, or crash | Partial + Journaled | | `vault.ts:155` |
| Partial + Journaled | next `exclusive()` write, or startup `recover()` | Present(r) (or Present(r') if the write had completed), journal dropped | file exists | `vault.ts:55-61, 188-224`, `app.ts:24-27` |
| Present(r) | DELETE | Trashed | `read`+`delete`; `If-Match` | `fileops.ts:152-170`, `vault.ts:283-290` |
| Present(r) | DELETE `permanent=true` | Absent | `read`+`purge` | `vault.ts:292-295` |
| Present(r) at A | move to B | Absent at A, Present(r) at B | see M7 | `fileops.ts:177-218` |
| any | external write / delete | any | | M9 picks it up |

`overwrite` writes in place on purpose: a rename over a temp file would give the note a new inode
and so a new birth time, which is what `created` reports (D2). The journal is what makes the
in-place write recoverable. It lives in the vault's `.spall/` dot-folder, which is never indexed,
served or watched.

**Retries.** PUT with `If-None-Match: *` (create) and PUT/PATCH with `If-Match` are safe to retry: a
retry after a lost response gets 409/412 and the current rev, not a second write; a retry after a
failed write applies with the rev from *before* the failure. DELETE and move retries get 404 once
the first one went through. `POST /v1/notes` with the default `on_conflict: rename` is *not*
idempotent: a retry creates `Title 1.md` (see B9 and decision D4).

**Invalid states.**
- **B3** (broke I6.2, I6.3; fixed by I2, completed by I7): `writeFile` truncates first. If it failed
  after that (disk full, quota, I/O error), the request returned 500 and the note held only the bytes
  written so far. I2 wrote the old bytes back with the same kind of write and dropped that error, so
  a disk that kept failing, or a crash, still left a partial note; I7 journals the old bytes first.
- **B12** (broke I6.4; fixed by I7): a create whose write failed left a partial new file, and a
  retry with `If-None-Match: *` then got 409.
- **B9**: the audit line is written after the change (`fileops.ts:130`, `notes.ts:114`, …). If that
  write fails, the client gets 500 for a change that happened; a retry of `POST /v1/notes` then
  makes a duplicate. Not fixed (D3).

---

## M7. Move protocol (two steps on disk)

**Lives in** `src/vault.ts:238-281` (`Vault.move`, `unlinkIfSameFile`), called by `moveFile` under
the write lock (M5), which turns a `PartialMoveError` into a 500 naming both paths
(`fileops.ts:200-211`).

**States** for a move A → B: **Src** (only A), **Both** (A and B are hard links of one inode),
**Dst** (only B).

**Invariants.**
- I7.1 A move never overwrites B through the API (`link` fails with `EEXIST`; see the fallback below).
- I7.2 A failed move leaves Src, so the client can retry; if it can't, the response says the file is
  now at both paths, and the index and audit log show both.
- I7.3 Only on success does the index lose A and gain B.
- I7.4 A rollback removes B only while B is still the link this move made (same inode as A).

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Src | `link(A, B)` | Both | B absent | `vault.ts:242` |
| Both | `unlink(A)` | Dst | | `vault.ts:250` |
| Both | `unlink(A)` fails, B is our link, `unlink(B)` works | Src, original error | | `vault.ts:251-259, 271-281` |
| Both | `unlink(A)` fails, B was replaced by someone else | Src (B left alone), original error | inode differs | `vault.ts:274` |
| Both | `unlink(A)` and `unlink(B)` fail | Both, indexed; 500 with `path` + `destination`; audit `move_incomplete` | | `vault.ts:254-257`, `fileops.ts:203-211` |
| Src | `link` fails `EPERM`/`ENOTSUP`/`EXDEV` | Dst via check-then-`rename` | B absent at check | `vault.ts:245-247, 261-265` |
| Src | `link` fails `EEXIST` | Src, 409 | | `vault.ts:244` |
| Dst | index refresh of A and B | | | `vault.ts:266-267` |

**Guarantee without hard links.** On filesystems that refuse `link` (some FUSE, SMB and exFAT
mounts) the move checks that B is free, then `rename`s, which would replace a B created in between.
API writes can't do that (they wait for the lock, M5); an external writer can. Node has no no-replace
rename, so this window stays (U3, D8).

**Invalid states.**
- **B7** (broke I7.2, fixed by I5): `link` and `unlink` shared one `try`. If `unlink(A)` failed, the
  file stayed at both paths and the index didn't know B. With `EACCES` the client got 500; with
  `EPERM` the error fell into the "no hard links" branch, which saw B (just linked) and answered 409
  `already_exists`, blaming a destination the request itself had created.
- **B11** (broke I7.2, I7.4; fixed by I10): I5's rollback swallowed a failed `unlink(B)`, so the
  duplicate stayed while the client only saw the original error; and it unlinked B without checking
  it was still its own link, so it could delete a file an external writer had just put there.
- A crash between `link` and `unlink` still leaves Both. That can't be prevented without a journal;
  see U2.

---

## M8. A folder in the vault

**Lives in** `src/http/folders.ts:251-294`, `src/vault.ts:127-136` (`mkdir`), `181-191`
(`rmdirEmpty`), `167-179` (`trash`, `purge`).

**States:** **Absent**, **Empty**, **NonEmpty(visible to the caller)**, **NonEmpty(has entries the
caller can't see or can't delete)**, **Trashed**.

**Invariants.**
- I8.1 A recursive delete only removes what the caller may delete: everything inside must be
  indexed (no dotfiles, no skipped symlinks) and carry `delete`/`purge` for the caller
  (`folders.ts:282-288`).
- I8.2 The root of an account can't be deleted.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| Absent | POST /folders | Empty | `create` | `folders.ts:251-265` |
| Absent | PUT/POST of a file below | NonEmpty (parents made with `mkdir -p`) | | `vault.ts:94` |
| Empty | DELETE | Absent | `read`+`delete` | `folders.ts:277-281` |
| NonEmpty | DELETE | 409 `folder_not_empty` | not `recursive` | `vault.ts:185-187` |
| NonEmpty(visible) | DELETE `recursive=true` | Trashed / Absent | check passes | `folders.ts:282-293` |
| NonEmpty(hidden) | DELETE `recursive=true` | 409 / 403 | check fails | `folders.ts:286-287` |

**Invalid state (fixed by I1).** **B1** (M5): between the check and the trash/purge, another request
could turn NonEmpty(visible) into NonEmpty(hidden), and the hidden file was removed anyway. The
check and the removal now run under the write lock, so an API write inside the folder lands either
before the check (and fails it) or after the removal (in a fresh folder).

---

## M9. Vault index and watcher

**Lives in** `src/vault-index.ts:36-285` (`VaultIndex`), started by `src/app.ts:22-28`.

**States.** Per path: **Unindexed**, **Indexed(kind, stat, rev, meta)**; per indexed folder, a
**generation** (`gens`), new whenever a folder appears where there was none (created, recreated
after a delete, replacing a file), kept when a folder is re-read in place. Per path refresh queue:
**Idle**, **Refreshing(+queued)** (`pending`, `vault-index.ts:182-191`). Watcher: **Off**,
**Starting** (until chokidar's `ready`), **Watching**, **Closed**. Plus a global `version`, bumped
on every change.

**Invariants.**
- I9.1 Every indexed entry's parent is an indexed *folder* (the tree is connected; `childrenOf` and
  listings rely on it).
- I9.2 No dot-path is indexed; with `follow_symlinks` off, no symlink is.
- I9.3 After the vault is quiet and all refreshes settle, the index matches the disk.
- I9.4 Refreshes of one path apply in the order they were asked for, and a parent is refreshed
  through its own queue.
- I9.5 A read of a path (a refresh, or a scan of its folder) is published only if its folder still
  has the generation it had when the read started.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| (none) | `build()` | Indexed tree | | `vault-index.ts:80-88` |
| Off | `watch()` | Starting → Watching | `ready` | `vault-index.ts:260-279` |
| any path | watcher add/change/unlink/addDir/unlinkDir | `refresh(path)` queued | not a dot-path | `vault-index.ts:271-275` |
| any path | API write | `refresh(path)` | | `vault.ts` (each op) |
| Indexed / Unindexed | refresh, `load` finds it, parent generation unchanged | Indexed | | `vault-index.ts:193-219` |
| Unindexed | refresh, parent wasn't indexed | `refresh(parent)` (queued), then read again | parent now a folder | `vault-index.ts:202-210` |
| any | refresh, parent removed, recreated or replaced by a file during the read | read again (≤ 5 times), or Unindexed if the parent is no folder | | `vault-index.ts:202-210` |
| Indexed | refresh, `load` finds nothing | Unindexed, with its subtree | | `vault-index.ts:197-200` |
| Indexed(file) | refresh, now a folder | Indexed(folder), new generation, contents scanned | | `vault-index.ts:158, 214-216` |
| Indexed(folder) | refresh, now a file | Indexed(file), old subtree and generation dropped | | `vault-index.ts:157` |
| scanning a folder | folder's generation changed during a child's read | scan stops | | `vault-index.ts:96-115` |
| Watching | `close()` | Closed | | `vault-index.ts:281-284` |

**Invalid states (fixed).**
- **B8** (broke I9.1, I9.3; fixed by I6): refreshes were serialised per path only. A refresh of
  `Gone/x.md` read the file, then waited; meanwhile `Gone/` was deleted and its own refresh
  dropped the subtree. When the first refresh resumed, it refreshed the (gone) parent and then
  inserted `Gone/x.md` anyway: a ghost entry under a folder that doesn't exist, visible in search,
  tags, bases and backlinks until something touched that exact path again.
- **B10** (broke I9.1, I9.5; fixed by I11): I6 only checked that *something* was indexed at the
  parent path. A child read before its folder was deleted and recreated was published into the new
  folder (stale metadata, or a file that no longer exists), and one read before its folder became a
  file was published under the file. A folder scan didn't check at all, so a scan running while an
  ancestor was deleted repopulated the deleted subtree. And the parent refresh bypassed the
  parent's queue (broke I9.4).

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

**Lives in** `src/cli/admin.ts:45-146` (`lockConfig`, `editConfig`, `tokensOf`), used by
`token create` and `token revoke` (`admin.ts:232-273`).

**States** of one run: **Loaded** (compiled config, used only to check the account exists),
**Locked**, **Read** (YAML document of the *canonical* config file), **Edited** (token found or
named *in this document*), **Validated**, **TempWritten**, **Renamed** (committed), **Unlocked**.

Lock file `.<config>.lock`, next to the canonical config (`realpath`), holding `<pid> <nonce>`:
**Free**, **Held(pid alive)**, **Stale(pid dead, or unparsable)**.

**Invariants.**
- I11.1 The file on disk is always a complete config (temp file plus rename).
- I11.2 The edit applies to the file as it is when the edit is written (no lost update between
  `spall token` runs).
- I11.3 What the edit acts on (which token, which default name) is decided on the same version of
  the file it writes.
- I11.4 At most one run holds the lock; a lock is only ever removed by its owner, or by a run that
  has verified it is the stale lock it judged dead.
- I11.5 The lock file is never seen half-written; a crashed holder's lock is taken over.
- I11.6 One config file has one lock, whatever path (symlink, relative) it was named by.

| From | Event | To | Guard | Code |
| --- | --- | --- | --- | --- |
| start | `loadConfig` | Loaded | | `admin.ts:231` |
| Loaded | write `<lock>.<nonce>`, `link` it to the lock | Locked | lock Free | `admin.ts:78-81` |
| Loaded | `link` → `EEXIST`, lock gone when read | retry | | `admin.ts:90-91` |
| Loaded | lock Held | wait 50 ms, retry | < 10 s | `admin.ts:112-113` |
| Loaded | lock Held | exit 1 naming the holder | ≥ 10 s | `admin.ts:112` |
| Loaded | lock Stale: `rename` it aside, re-read it | retry | aside == what was judged stale | `admin.ts:93-110` |
| Loaded | lock Stale, but aside is someone else's fresh lock | `link` it back, retry (wait for it) | aside ≠ judged | `admin.ts:102-108` |
| Locked | `realpath` → read + `parseDocument` | Read | | `admin.ts:124-128` |
| Read | edit callback | Edited (or abort) | token name exists (revoke) | `admin.ts:129, 236-247, 265-270` |
| Edited | `compileConfig` | Validated (or abort) | | `admin.ts:131` |
| Validated | write temp, `rename` onto the canonical file | Renamed; the server's watcher reloads (M1) | | `admin.ts:132-134` |
| any of the above | done or aborted | Unlocked (lock removed only if it still holds our `<pid> <nonce>`); exit 1 on abort | | `admin.ts:83, 137-140` |

The admin's own editor doesn't take the lock; an edit saved in the middle of a `spall token` run
can still be overwritten by it (the window is a few milliseconds). See U6.

**Invalid states (fixed).**
- **B5** (broke I11.3, fixed by I4): `revoke` took the token's index from Loaded and deleted that
  index in Read.
- **B6** (broke I11.2, fixed by I4): nothing stopped two runs from each reading the file and the
  second rename winning.
- **B14** (broke I11.4-I11.6, fixed by I9): I4's lock was created with `O_EXCL` and then written,
  so it could be read empty; an empty or unparsable lock was never taken over (10 s timeout every
  time); a release between `EEXIST` and the read threw `ENOENT`; two runs that both saw a dead
  holder could both proceed, the second removing the first's fresh lock; release removed whatever
  lock was there; and the lock name came from the path as given, while the edit wrote through it
  (replacing a symlinked config with a regular file). Four real concurrent `spall token create`
  runs lost tokens with it.

---

## Reachable invalid states and transitions (confirmed)

"Confirmed" = reproduced by a test that fails before its fix (B1-B8 on `21b9c3a`; B10-B14 on the
commit before their follow-up fix). B9 was reproduced by a scratch run, described in its row.

| Bug | Machine | Impact | What happens | Reproduced by | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | M5, M8 | data loss, security | Recursive folder delete purges/trashes a file another account wrote after the permission check; the deleter could not see it | `test/sm-write-lock.test.ts` "B1 …" (parks `Vault.purge`, waits until the other account's PUT reaches the write queue or completes) | fixed (I1) |
| B2 | M5, M6 | data loss | Two PATCHes of one note through a symlink alias and its real path both apply to the old text; one edit is lost | `test/sm-write-lock.test.ts` "B2 …" (parks `Vault.overwrite`, same synchronisation) | fixed (I1) |
| B3 | M6 | data loss | A write that fails after truncating (ENOSPC, EIO) leaves a partial note; with a persistently failing disk or a crash, even after I2 | `test/sm-overwrite-fault.test.ts` "B3 …" (ENOSPC after 3 bytes, once and persistently; restart) | fixed (I2, I7) |
| B12 | M6 | data loss (partial file), wrong state | A create whose write fails leaves a partial new file; a retry gets 409 | `test/sm-overwrite-fault.test.ts` "B12 …" | fixed (I7) |
| B4 | M1, M2 | security | A config edit that also touches a restart-only setting is ignored entirely, so a token revoked in it stays valid until restart | `test/sm-config-reload.test.ts` "B4 …" | fixed (I3) |
| B13 | M1, M2 | security | After I3: a pending invalid restart-only value still blocks a revocation; a retargeted vault symlink moves the published vault root | `test/sm-config-reload.test.ts` "B13 …" | fixed (I8) |
| B5 | M2, M11 | security | `token revoke` after a concurrent edit deletes the wrong token; the one asked for stays valid | `test/sm-cli-tokens.test.ts` "B5 …" | fixed (I4) |
| B6 | M2, M11 | wrong user-visible state | Concurrent `token create` + another edit: the printed token is not in the file | `test/sm-cli-tokens.test.ts` "B6 …" (child CLI vs. a lock holder; waits on a filesystem event for the child's commit or lock attempt) | fixed (I4) |
| B14 | M11 | security, wrong state | The I4 lock: two owners after a stale takeover, foreign locks released, empty locks never taken over, `ENOENT` on release races, symlinked config replaced; real concurrent runs lose tokens | `test/sm-cli-tokens.test.ts` "B14 …" (4 real CLI processes; injected takeover/release interleavings) | fixed (I9) |
| B7 | M7 | wrong user-visible state (duplicate file) | `unlink` of the source fails after `link`: the file exists at both paths; with EPERM the API answers 409 for its own link | `test/sm-move-fault.test.ts` "B7 …" | fixed (I5) |
| B11 | M7 | wrong user-visible state, data loss (external file) | After I5: a failed rollback is swallowed (hidden duplicate); the rollback can delete a file an external writer put at B | `test/sm-move-fault.test.ts` "B11 …" | fixed (I10) |
| B8 | M9 | wrong user-visible state | A refresh racing a folder removal leaves a ghost index entry under a missing folder | `test/sm-index-race.test.ts` "B8 …" | fixed (I6) |
| B10 | M9 | wrong user-visible state | After I6: stale child published into a recreated folder or under a file; a scan repopulates a deleted subtree | `test/sm-index-race.test.ts` "B10 …" | fixed (I11) |
| B9 | M6 | wrong user-visible state | The audit write fails after the change: 500 for a change that happened; a retried `POST /v1/notes` creates `Title 1.md` | scratch run (audit folder read-only): first POST 500, retry 201 `Research/Retry me 1.md`, both files on disk | not fixed (D3) |

## Unconfirmed

| # | Suspicion | Why not confirmed | What would settle it |
| --- | --- | --- | --- |
| U1 | A crash during the journal write itself, or a disk that loses the synced journal. | The journal is synced before the in-place write, and the in-place write is only undone when a record exists; a crash before the record is written leaves the file untouched. What is left is filesystem-level loss of synced data. | A kill harness on a filesystem with `data=writeback`. |
| U2 | A crash between `link` and `unlink` in a move leaves the file at both paths (M7); a retry then answers 409. | Needs a real crash between two syscalls. | Same kill harness. A fix needs a move journal, or `renameat2(RENAME_NOREPLACE)`, which Node doesn't expose. |
| U3 | External tools (Obsidian, sync) racing API writes: the "no hard links" move fallback checks then renames and could replace a file created in between; `PUT` checks `kindOf` then creates. | The window is between two syscalls; API-vs-API is covered by the lock (M5), external writers can't take it. | A filesystem without hard links plus a writer injected between `kindOf` and `rename`. |
| U4 | Case-insensitive filesystems: grants and locks compare case-folded keys, the index is case-sensitive. A file renamed only in case externally could show twice until the watcher settles. | Not reproducible on the Linux CI filesystem. | Run the suite on APFS/NTFS. |
| U5 | Watcher event storms (`git checkout` of thousands of files) while API writes run, and folders churning faster than 5 re-reads (I11 then drops the path until the next event). | No deterministic interleaving found beyond B8/B10. | A property test that applies random external ops and API ops, waits for quiet, then diffs `VaultIndex` against a fresh `build()`. |
| U6 | The admin saving the config in an editor during a `spall token` run: the editor doesn't take the lock, so one of the two writes can be lost. | Needs an editor save inside a few-millisecond window. | Same harness as B6 with an unlocked writer; a fix would be compare-and-swap on the file's content before the rename. |

## Issues

Grouped fixes, in priority order. One commit each, each with the regression test named above.
I7-I11 are the review round: they complete I2, I3, I4, I5 and I6.

### I1. One write lock for the whole vault
- **Bugs:** B1, B2.
- **Impact:** data loss, security.
- **Fix:** replace the per-path `Locks` with one FIFO `WriteLock` on the `Vault`, and take it in
  every write route, including `POST /v1/notes` and `POST /v1/folders`, which took none. `moveFile`
  now also works out its destination (folder or file) inside the lock. (Review round: the tests wait
  for the competing request to reach the write queue instead of a 150 ms window, `4275223`.)
- **Commit:** `b284e5f`
- **Test:** `test/sm-write-lock.test.ts`

### I2. Roll back a failed in-place overwrite
- **Bugs:** B3.
- **Impact:** data loss.
- **Fix:** `Vault.overwrite` keeps the old bytes and writes them back if the in-place write fails.
  Incomplete: the rollback could fail the same way; see I7.
- **Commit:** `7738465`
- **Test:** `test/sm-overwrite-fault.test.ts`

### I3. Apply hot settings of a reload that also changes restart-only ones
- **Bugs:** B4.
- **Impact:** security.
- **Fix:** `Config` keeps its raw YAML; `reload()` puts the running restart-only settings back,
  applies the rest and logs that those settings need a restart. Completed by I8.
- **Commit:** `6624f91`
- **Test:** `test/sm-config-reload.test.ts`, `test/config.test.ts` ("keeps restart-only settings…")

### I4. Lock CLI config edits and decide inside the lock
- **Bugs:** B5, B6.
- **Impact:** security, wrong user-visible state.
- **Fix:** `editConfig` takes `.<config>.lock` around read → edit → validate → rename; `revoke`
  finds the token by name and `create` picks its default name in the document being edited. The
  lock itself is redone in I9.
- **Commit:** `3ba3809`
- **Test:** `test/sm-cli-tokens.test.ts`

### I5. Undo the link when a move's unlink fails
- **Bugs:** B7.
- **Impact:** wrong user-visible state (duplicate file, failing retries).
- **Fix:** only the `link` is in the `try` that picks the no-hard-links fallback; if the following
  `unlink(A)` fails, `move` unlinks B again and rethrows. Completed by I10.
- **Commit:** `f84e606`
- **Test:** `test/sm-move-fault.test.ts`

### I6. Don't index a path whose parent is gone
- **Bugs:** B8.
- **Impact:** wrong user-visible state.
- **Fix:** `doRefresh` returns without indexing a path when refreshing its missing parent didn't
  index the parent. Completed by I11.
- **Commit:** `56ed2e6`
- **Test:** `test/sm-index-race.test.ts`

### I7. Journal in-place overwrites; clean up failed creates
- **Bugs:** B3 (completed), B12.
- **Impact:** data loss.
- **Fix:** before writing in place, `overwrite` writes the old bytes and a record (`path`,
  `new_rev`) to `.spall/journal`, both synced, the record last and atomically. On success the entry
  is dropped. On failure it writes the old bytes back; if that fails too, the entry stays and
  `Vault.exclusive` runs `recover()` before the next write, as does `createApp` at startup (before
  the index is built). `recover()` restores the old bytes unless the file already holds `new_rev`.
  `create` unlinks its new file when the write fails. The index is refreshed either way. The
  CHANGELOG now states exactly this.
- **Commit:** `bb4789c`
- **Test:** `test/sm-overwrite-fault.test.ts` (one-shot and persistent failure, the ETag from before
  the failure, a restart, a failed create)

### I8. Reload: pin the running restart-only values, before validation
- **Bugs:** B13.
- **Impact:** security.
- **Fix:** `reload()` puts the running `server` and `vault.path`/`trash`/`follow_symlinks` into the
  parsed YAML *before* the schema check, and compiles with the running canonical vault root
  (`compileConfig(…, runningVault)`), so nothing is resolved again. Policy: restart-only settings
  that changed or are invalid are reported in the log and wait for a restart; everything else that
  is valid applies.
- **Commit:** `419db38`
- **Test:** `test/sm-config-reload.test.ts` "B13 …"

### I9. An ownership-safe CLI lock on the canonical config
- **Bugs:** B14.
- **Impact:** security, wrong user-visible state.
- **Fix:** the lock holds `<pid> <nonce>`, is written to a private file and hard-linked into
  place (never half-written); `ENOENT` after `EEXIST` means retry; a stale or unparsable lock is
  renamed aside and only deleted if it is still what was judged stale, otherwise linked back;
  release removes the lock only if it holds our nonce; the config is `realpath`ed first, so the lock
  and the rename target are the real file.
- **Commit:** `98cd72c`
- **Test:** `test/sm-cli-tokens.test.ts` "B14 …"

### I10. Move: surface a failed rollback; roll back only our own link
- **Bugs:** B11.
- **Impact:** wrong user-visible state; data loss of an external file.
- **Fix:** the rollback unlinks B only if it is still the same inode as A. If B can't be removed
  either, `move` refreshes both paths in the index and throws `PartialMoveError`; `moveFile` audits
  `move_incomplete` and answers 500 with a message and `details: {path, destination}`.
- **Commit:** `88dfb74`
- **Test:** `test/sm-move-fault.test.ts` "B11 …"

### I11. Index: folder generations
- **Bugs:** B10.
- **Impact:** wrong user-visible state.
- **Fix:** every indexed folder has a generation, new whenever a folder appears where there was
  none. `doRefresh` notes the parent's generation before reading and publishes only if it is
  unchanged and still a folder; otherwise it refreshes the parent through its queue (if it wasn't
  indexed) and reads again (at most 5 times). `scanDir` stops when its folder's generation changes.
- **Commit:** `5f853ab`
- **Test:** `test/sm-index-race.test.ts` "B10 …"

## Decisions

- D1. One global write lock instead of per-path, hierarchical or real-path locks: writes are local
  file operations on one person's vault, so serialising them costs nothing noticeable, and it is
  the only simple scheme that also covers folder-vs-file and alias races. The lock covers the audit
  append and building the response too (M5); a slow audit sink slows all writes. Accepted: moving
  those out would reopen ordering questions (audit order vs. disk order) for a single-user server.
- D2. Overwrites stay in place, keeping the inode and so `created`, as Obsidian does. I7 makes the
  in-place write recoverable with a journal instead of switching to temp + rename.
- D3. B9 is left as is: returning success when the audit line could not be written would hide
  unaudited changes, and writing the line first would log changes that then fail. A failing audit
  log is an operator problem that already surfaces as 500s and an error in the server log.
- D4. `POST /v1/notes` with `on_conflict: rename` stays non-idempotent by design; clients that retry
  should use `PUT` with `If-None-Match: *`, which is.
- D5. The journal lives in the vault (`.spall/journal`), not next to the config: it must be
  writable whenever the vault is, and dot-folders are never indexed, served or watched. Sync tools
  that copy dot-folders will copy it; entries exist only while a write is in flight or failed.
- D6. Recovery after a failed rollback runs at the next write (under the lock) and at startup, not
  on reads: until then a GET can return the partial content, with its own rev. A client's
  `If-Match` from before the failure still applies after recovery (tested).
- D7. Declined: re-checking the token when a queued write reaches the lock. A request is authorised
  when it arrives; the queue only adds the time of the writes ahead of it (milliseconds normally,
  longer only on a stalled disk, which delays the revocation's own effect too). Re-checking would
  also have to decide what grants a request admitted under the old config should get. Revocation
  stops every request that arrives after the reload.
- D8. Declined: making the no-hard-links move fallback no-replace. Node exposes no
  `RENAME_NOREPLACE`; `copyFile(COPYFILE_EXCL)` + unlink would lose the inode and birth time that
  the fallback exists to keep. Within the API the lock makes it safe; the window against external
  writers is documented (M7, U3).
- D9. Declined: making the B5 regression test take the lock in its simulated competing edit. It
  checks name selection inside the edit (I11.3); the lock's competing-acquisition paths have their
  own tests under B14, including four real CLI processes.
- D10. The index re-reads a path at most 5 times when its folder keeps changing under it, then
  leaves it unindexed until the next event for it (U5). Unbounded retries could spin on a churning
  folder.
