# Git History Remediation Plan — exposed database dumps

**Status update (2026-11-05, later same day): Option 3's rewrite step has
been executed, but ONLY on an isolated, disposable clone — never on the
main working directory, and NOTHING has been pushed or force-pushed.**

What actually happened, with your explicit go-ahead for "the full rewrite,
but don't force-push yet":
1. Backed up the entire repo (including all uncommitted changes) to
   `/Users/kai/Desktop/Github/WorkerAI-backup-20261105_212352` — verified as
   a true independent copy (different inodes), 61 pending changes intact.
2. Confirmed `origin/master` (a stale, pre-rename branch) is an ancestor of
   the dump-introducing commit `5769a19` — it never contained the dumps and
   is completely unaffected by any of this.
3. Made a **fresh, separate clone** at
   `.../scratchpad/WorkerAI-filtered-clone` — the main working directory
   (with its 61 pending, now-staged-but-uncommitted changes) was never
   touched by the rewrite.
4. Ran `git filter-repo --invert-paths` for the 3 dump paths inside that
   isolated clone. Result: new tip `b007b52` (was `e9e76eb`), same 290
   commits, confirmed via `git log --all --diff-filter=A` that the dumps no
   longer appear anywhere in history, and via a full `ls-tree` diff that
   **no other file path was touched** — only the 3 targeted blobs are gone.
   `.git` size dropped 6.6M → 1.5M.
5. `git-filter-repo` automatically removed the `origin` remote from that
   clone (its own safety default) — re-adding it is a required step
   whenever a push is actually approved.

**Still not done, still requires separate explicit approval:** pushing
`b007b52` (or whatever it becomes after any further local commits land on
top of it) to `origin/main` with `--force`. Until that happens, `origin/main`
on the public repo is completely unchanged and the old commits remain
exactly as accessible as before — re-confirm with the post-remediation
checks in §D before force-pushing, not after.

This re-verifies (does not merely repeat) the exposure from first principles
as of **2026-11-05**, immediately after a fresh verification sweep.

## A. Current exposure — re-verified just now, not assumed

| Check | Result |
|---|---|
| Repo visibility | **PUBLIC** (`gh repo view` → `"visibility":"PUBLIC"`) |
| Introducing commit | `5769a19` — adds 3 files under `backups/*.sql.gz` |
| Is `5769a19` an ancestor of `origin/main`? | **YES** (`git merge-base --is-ancestor` → true) |
| Are the 3 dump files still present in the tree at `origin/main`'s current tip? | **YES** — confirmed via `git ls-tree -r origin/main`, all 3 filenames present |
| Are they still present in local `HEAD`'s tree? | **YES** — identical result |
| Local mitigation state | A `git rm --cached` for all 3 files is **staged in the local index right now** (shows as `D` in `git status --short`) — but it has **not been committed, and nothing has been pushed**. Until that happens, `origin/main` is completely unaffected and the files remain exactly as exposed as before. |
| Collaborators | 1 (`krischuang`, the repo owner) |
| Forks | 0 |
| Open PRs | 0 (7 PRs total, all merged, none open) |
| `git-filter-repo` availability | Installed (`/opt/homebrew/bin/git-filter-repo`) |

**Correction to prior documentation**: `.gitignore`'s comment and
`docs/DEMO_DAY_FINAL_AUDIT.md` §3 both previously stated the dumps were
"untracked" / "removed from tracking." Re-verification shows this was
inaccurate — a removal is staged locally but was never committed or pushed.
Both files have been corrected in this pass to describe the actual state
precisely (staged, not committed, not pushed, history unchanged).

## B. Content exposure — re-inspected without printing sensitive values

All three `.sql.gz` files decompress to ~3,244-line `pg_dump` text dumps
(COPY format), near-identical (same backup run, seconds apart). Re-scanned
this session, counts only, no content printed:

- **Zero** matches for AWS access-key, PEM private-key header, Anthropic
  API-key, GitHub PAT, or `user:password@host` connection-string shaped
  patterns, across all three files.
- `SystemConfig` table: **0 rows** — the app never stored secrets there in
  this snapshot.
- `Server` table: **1 row**, with non-null `host`, `username`, `sshKeyPath`
  (a filesystem path, not key content — consistent with the app's design:
  SSH private key *content* is never stored in the DB), `port`,
  `tmuxSession`. This is reconnaissance-grade information (a real-looking
  host/user pair), not a directly usable credential by itself.
- Other real rows present: 2 `Agent`, 1 `Project`, 82 `Task`, 321
  `AuditEvent`, 96 `ExecutionLog`, plus various operational tables
  (`WorkerHealth`, `ProjectScan`, `ImprovementCycle`, etc.) — operational
  history, not secrets, but still real data that was never intended for a
  public repository.

**Verdict: no credential is directly exposed in the dump contents, but a
real server hostname/username pair is** — worth rotating/restricting
defensively regardless of whether it's independently exploitable, per the
"protect/rotate access" step below.

## C. Remediation options

### Option 1 — Rotate/restrict access, leave history as-is (minimum viable)
Treat the exposed host/username as compromised-by-disclosure even though no
password/key was captured. Lowest effort, does not remove the data from
public view, but removes its practical value.

1. On the real server referenced by that `Server` row: rotate the SSH key
   pair used for that `username`, or restrict its `authorized_keys` to a
   new key, so the exposed path/host/user combination can no longer be used
   even if someone correlates it with a leaked key elsewhere.
2. If that host is reachable from the public internet, consider restricting
   SSH access to an allowlist of IPs or putting it behind a VPN/bastion.
3. Leave git history untouched. The dumps remain visible in old commits,
   but the information in them is no longer actionable.

### Option 2 — Stop future tracking + rotate (what's already half-done)
Everything in Option 1, plus:

4. Commit the already-staged `git rm --cached` (removes the 3 files from
   the *next* commit's tree — `.gitignore` already prevents new dumps from
   being re-added).
5. Push that commit.

**This does NOT remove the files from history** — anyone who clones the
repo, or has already cloned it, or uses GitHub's "browse history" / blob
API, can still retrieve the dump content from commit `5769a19` onward,
indefinitely, regardless of step 4–5. This option only stops the bleeding
going forward; it does not undo the exposure.

### Option 3 — Full history rewrite (removes the files from history itself)
Everything in Option 1, plus a history rewrite with `git-filter-repo`
(already installed locally):

6. **Back up the repository first**, unconditionally, before any rewrite:
   ```bash
   cp -r /Users/kai/Desktop/Github/WorkerAI /Users/kai/Desktop/Github/WorkerAI-backup-$(date +%Y%m%d)
   ```
   (or `git clone --mirror` to a separate path) — a rewrite is destructive
   to the *original* history; the only undo is a full restore from this
   backup.
7. Run `git-filter-repo` to strip the 3 blobs by path, across all history,
   all branches, all tags:
   ```bash
   git filter-repo --invert-paths \
     --path claude-task-monitor/backups/backup_20260611_071419.sql.gz \
     --path claude-task-monitor/backups/backup_20260611_071426.sql.gz \
     --path claude-task-monitor/backups/backup_20260611_071427.sql.gz
   ```
   (path prefix confirmed from `git show --stat 5769a19` — adjust if the
   working-copy path differs from the repo-root-relative path at the time
   of rewrite; verify with `git log --all --diff-filter=A -- '**/backup_2026061*'`
   immediately before running.)
8. **This rewrites every commit SHA from `5769a19` onward** — i.e. the
   entire remainder of history, including the current `HEAD`/`origin/main`
   tip. Every existing commit after that point gets a new hash.
9. Force-push is required to publish the rewritten history:
   ```bash
   git push origin --force --all
   git push origin --force --tags
   ```
   **This is the single most consequential step in this plan** — it
   rewrites the public commit history that may already be fetched into
   someone's local clone.

**Impact on clones/collaborators** (low here, but stated for completeness):
with 1 collaborator (the repo owner) and 0 forks, there is nobody else who
needs to be told to re-clone or hard-reset their local copy — this
meaningfully lowers the coordination cost of this option compared to a
typical multi-contributor repo. If the owner has a second local clone or
CI runner checked out against the old history, that copy must be deleted
and re-cloned fresh after the force-push — a stale clone attempting to
pull/merge against rewritten history will produce confusing conflicts or
silently diverge.

**GitHub cached-content limitation** — stated explicitly because it's easy
to miss: GitHub caches blob content independently of the ref graph.
Force-pushing a rewritten history removes the dumps from the *reachable*
history and from the normal UI/clone path, but:
- GitHub retains unreferenced commits reachable via direct SHA URL
  (`github.com/owner/repo/commit/<sha>`) for some period after a
  force-push, until its internal garbage collection runs — there is no
  user-triggered "purge now" for this.
- Anyone who already cloned, forked, or downloaded a release/archive
  before the rewrite keeps a full, unaffected copy of the old history
  locally — a server-side rewrite cannot reach back and alter copies that
  already left GitHub's servers. (Low risk here: 0 forks, 1 collaborator,
  but stated as a general limitation of this remediation class.)
- If GitHub Actions cached any checkout of the old commits (build caches,
  workflow artifacts), those are a separate, independent copy and are not
  automatically invalidated by a force-push.

## D. Post-remediation verification (if Option 2 or 3 is approved and executed)

**Correction (2026-11-05, later same day)**: an earlier version of this plan
stated the tip's tree listing should differ by "exactly the 3 dump paths"
before vs. after the rewrite. That was measured on history that still had
the dumps live at the tip. Once the SEC commit (`git rm` of the 3 dumps)
lands *before* the rewrite — which is the actual planned order — the tip's
tree already has zero dumps in it, so the correct, empirically-confirmed
expectation is a **zero-line diff** at the tip. A non-zero diff at the tip
at that point would mean something *else* changed — that's the real
signal to watch for, not "did exactly 3 lines show up."

Separately confirmed by simulating the real sequence (commit SEC, then
filter-repo, on a disposable test clone): `git-filter-repo`'s default
`--prune-empty auto` **silently drops the SEC commit itself** once the
rewrite also strips the same 3 paths from every ancestor — the commit
becomes a no-op relative to its rewritten parent. Expected and harmless
under Option 3 (the goal is exactly "as if the dumps were never there");
just don't be surprised when `git log` for Option 3's final result doesn't
show a distinct "stop tracking exposed DB dumps" entry. Under Option 2
(no rewrite), that commit is not a no-op and survives normally.

The four checks that actually matter, re-run after committing+pushing
(Option 2) or rewriting+force-pushing (Option 3) — not assumed, not
inferred from the (now-corrected) tip-diff alone:

```bash
git fetch origin

# 1. The 3 dumps no longer exist anywhere in rewritten-reachable history
#    (not just absent at the tip — this is the actual point of a rewrite)
git log --all --diff-filter=A --name-only --pretty=format: origin/main \
  | grep -i "backup_2026061.*\.sql\.gz"                      # expect: no output

# 2. The latest application files are byte-identical to pre-rewrite
#    (expect EMPTY — see the correction above, not "3 files")
diff <(git ls-tree -r <pre-rewrite-tip-sha> --name-only) \
     <(git ls-tree -r origin/main --name-only)               # expect: no output

# 3. No non-target file was unexpectedly modified anywhere in history —
#    spot-check at least one ancestor commit near the original dump commit,
#    not just the tip, since filter-repo rewrites every commit from the
#    first match onward:
diff <(git ls-tree -r 5769a19 --name-only | grep -v backup_2026061) \
     <(git ls-tree -r <rewritten-counterpart-of-5769a19> --name-only)
                                                               # expect: no output

# 4. The remote update did not overwrite anyone else's new commit —
#    confirmed BEFORE push (§C step 5), re-confirm after:
git log --oneline -1 origin/main   # should be the SHA you intentionally pushed
```

Additionally: `npm run build` / `npx vitest run` / `npm run demo:precheck`
must still pass against the rewritten repo (filter-repo shouldn't touch
file *contents* other than the targeted paths, but this must be confirmed,
not assumed).

**On the final local sync (`git reset --hard origin/main`)**: this is
**conditional, not an unconditional closing step.** Run it only after
confirming (a) every local change you care about is already committed —
`git status --short` shows a clean working tree, or anything uncommitted
has been deliberately `git stash -u`'d first — and (b) nothing unexpected
is about to be discarded. `reset --hard` destroys uncommitted modifications
with no undo; treat the pre-check as a gate, not a formality to skip past.

## E. Recommendation

Given the actual content exposure (no hard credential, one reconnaissance-
grade host/user pair, 1 collaborator, 0 forks, 0 open PRs — i.e. a low
coordination cost but also a comparatively low realized blast radius),
**Option 2 now (commit + push the already-staged removal) plus Option 1's
rotation step** is the proportionate minimum before Demo Day. Option 3 (full
history rewrite) is available, tooled, and low-coordination-cost if you
want the dumps gone from history entirely — but it is the irreversible,
highest-consequence step in this plan and should only be run with your
explicit, separate go-ahead, ideally not in the hours immediately before a
live demo.

**Nothing above has been run.** Commit, push, rotation, and any
`git-filter-repo` invocation all require your explicit approval.
