# Pending Git Changes — Inventory and Safe Commit Preparation Plan

**Nothing in this document has been executed.** All `git add` commands
below are recommendations for your review; no staging, committing, or
pushing has been performed as part of producing this plan. Re-verified
directly from `git status` on 2026-11-05, not assumed from prior reports.

Repo root is `/Users/kai/Desktop/Github/WorkerAI`; `claude-task-monitor/` is
a subdirectory within that same repo (confirmed via `git rev-parse
--show-toplevel`). All paths below are repo-root-relative.

**Update (2026-11-05, later same day)**: §1's snapshot below is the
original point-in-time count (79 staged). Since then, the auth-state.json
root-cause fix added a 9th group (**SEC**, §3) and a regression fix added
4 more files to Group G — current total is **83 staged files across 9
groups**, verified by exact computational match (zero orphans, zero
duplicates, zero extras) before any commit executes. §2 and §3 below are
updated to the current state; §1 is left as the original historical
snapshot.

## 1. Full status snapshot (`git status --short`, repo root)

**Already staged (index), not yet committed:**
```
RM claude-task-monitor/.github/workflows/ci.yml -> .github/workflows/ci.yml
R  claude-task-monitor/.github/workflows/deploy.yml -> .github/workflows/deploy.yml
D  claude-task-monitor/backups/backup_20260611_071419.sql.gz
D  claude-task-monitor/backups/backup_20260611_071426.sql.gz
D  claude-task-monitor/backups/backup_20260611_071427.sql.gz
```

**Modified, unstaged** (33 files — see §3 for grouping) and **untracked**
(20 paths, several are directories — see §3). Full untracked list:
```
.DS_Store                                                  <- flagged, §2
claude-task-monitor/app/api/agents/[id]/compare/
claude-task-monitor/app/api/agents/[id]/reliability/
claude-task-monitor/app/api/tasks/[id]/approve-dispatch/
claude-task-monitor/docs/
claude-task-monitor/lib/__tests__/adaptive-trust.test.ts
claude-task-monitor/lib/__tests__/agent-reliability.test.ts
claude-task-monitor/lib/__tests__/api-rate-limit-enabled.test.ts
claude-task-monitor/lib/__tests__/auto-recovery.test.ts
claude-task-monitor/lib/__tests__/policy-engine.test.ts
claude-task-monitor/lib/__tests__/task-dispatch.test.ts
claude-task-monitor/lib/adaptive-trust.ts
claude-task-monitor/lib/agent-reliability.ts
claude-task-monitor/prisma/migrations/20261105042227_add_not_verified_validation_status/
claude-task-monitor/scripts/adaptive-trust-evidence.ts
claude-task-monitor/scripts/demo-adaptive-trust.ts
claude-task-monitor/scripts/demo-e2e/
claude-task-monitor/scripts/demo-evidence-preference.ts
claude-task-monitor/scripts/demo-independent-validation.ts
claude-task-monitor/scripts/export-clean-package.sh
claude-task-monitor/scripts/pre-demo-check.sh
```

## 2. Flagged items — do NOT stage as-is

| Path | Issue | Recommendation |
|---|---|---|
| `.DS_Store` (repo root) | macOS metadata, untracked, **and the repo root had no `.gitignore` at all until this pass** — nothing previously stopped it from being committed. | Fixed this pass: added `/Users/kai/Desktop/Github/WorkerAI/.gitignore` with `.DS_Store`. Do not `git add` the file itself. |
| `claude-task-monitor/e2e/.auth-state.json` | **Resolved, not just flagged.** Confirmed via `git show HEAD:...`/`origin/main:...` that every historical commit was an empty `{"cookies":[],"origins":[]}` placeholder — no real cookie was ever committed or pushed. Root cause fixed: `e2e/global-setup.ts` and `playwright.config.ts` now write the real session file to `.auth-state.local.json` instead (gitignored); the old tracked placeholder is `git rm --cached`'d. **Regression found and fixed during this pass**: 4 other spec files (`admin.spec.ts`, `reports.spec.ts`, `projects.spec.ts`, `queue.spec.ts`) independently hardcoded the old filename and would have silently broken — fixed, verified with a live `npx playwright test e2e/auth.spec.ts` run (7/7 pass). | Now in Group SEC (deletion) and Group G (the 6 spec-file + config fixes) below — no further action needed beyond committing those groups. |
| `claude-task-monitor/backups/backup_*.sql.gz` (3 files, already staged as deleted) | Covered in full in `docs/GIT_HISTORY_REMEDIATION_PLAN.md`. This commit only affects the *next* commit's tree, not existing public history — a separate, explicitly-approved history rewrite is required to purge them from history itself. | Now in Group SEC below. Fine to commit now; understand it does **not** by itself resolve the history exposure. |
| `package-lock.json` | Large generated file, modified. Not inspected line-by-line (lockfile diffs are low-signal) — should ride along with whatever `package.json` change produced it, not be staged alone. | Stage together with the `package.json` change in the same commit group that caused it (see §3, group F). |

No `.env`, node_modules, `.next`, build output, or other dump/credential
files were found untracked or staged anywhere else in the scan.

## 3. Logical commit groups

**Do not run `git add -A` or `git add .`** — the untracked list mixes this
session's new library code with docs, and the modified list spans several
unrelated subsystems; a single blanket add would conflate them into one
commit and would also pick up the flagged items in §2.

All commands below are relative to the repo root
(`/Users/kai/Desktop/Github/WorkerAI`) and use the full
`claude-task-monitor/...` prefix accordingly.

### Group SEC — Stop tracking exposed DB dumps and auth-state placeholder
```
git add claude-task-monitor/backups/backup_20260611_071419.sql.gz
git add claude-task-monitor/backups/backup_20260611_071426.sql.gz
git add claude-task-monitor/backups/backup_20260611_071427.sql.gz
git add claude-task-monitor/e2e/.auth-state.json
```
All four are staged **deletions** — this group removes them from the next
commit's tree. Commit this group first; it's the most reviewer-visible
change and the one most directly tied to the security findings. Note (see
`docs/GIT_HISTORY_REMEDIATION_PLAN.md` §D): if a full history rewrite is
later run, `git-filter-repo`'s `--prune-empty auto` will likely drop this
specific commit as a no-op once the same 3 dump paths are also stripped
from every ancestor — expected, not an error.

### Group A — Core security: policy engine, kill switch, dispatch, rate limiting
```
git add claude-task-monitor/lib/kill-switch.ts
git add claude-task-monitor/lib/policy-engine.ts
git add claude-task-monitor/lib/task-dispatch.ts
git add claude-task-monitor/lib/timing-safe.ts
git add claude-task-monitor/lib/api-rate-limit.ts
git add claude-task-monitor/lib/__tests__/kill-switch.test.ts
git add claude-task-monitor/lib/__tests__/timing-safe.test.ts
git add claude-task-monitor/lib/__tests__/policy-engine.test.ts
git add claude-task-monitor/lib/__tests__/api-rate-limit-enabled.test.ts
git add claude-task-monitor/lib/__tests__/task-dispatch.test.ts
git add "claude-task-monitor/app/api/tasks/[id]/approve-dispatch/"
```
Review before staging: skim `lib/policy-engine.ts` and `lib/kill-switch.ts`
diffs specifically for the glob-matcher fix mentioned in
`docs/DEMO_RUN_RECORD.md` ("an earlier run... caught a real bug... bare,
repo-root `.env` file") to confirm it's the fix you expect, not something
else bundled in.

### Group B — Independent validation / completion detection
```
git add claude-task-monitor/lib/validation-gate.ts
git add claude-task-monitor/lib/ssh-claude-tmux.ts
git add claude-task-monitor/instrumentation.node.ts
git add claude-task-monitor/lib/__tests__/validation-gate.test.ts
git add claude-task-monitor/lib/__tests__/completion-marker.test.ts
git add claude-task-monitor/prisma/schema.prisma
git add "claude-task-monitor/prisma/migrations/20261105042227_add_not_verified_validation_status/"
```
Review before staging: a schema migration is included — confirm
`npx prisma migrate status` (part of `demo:precheck`, already re-verified
PASS this pass) still reports this migration applied cleanly before
committing it alongside the code that depends on it.

### Group C — Auto-recovery
```
git add claude-task-monitor/lib/auto-recovery.ts
git add claude-task-monitor/lib/__tests__/auto-recovery.test.ts
```

### Group D — Adaptive Trust Engine (advisory layer + this session's new evidence-preference comparison)
```
git add claude-task-monitor/lib/adaptive-trust.ts
git add claude-task-monitor/lib/agent-reliability.ts
git add claude-task-monitor/lib/__tests__/adaptive-trust.test.ts
git add claude-task-monitor/lib/__tests__/agent-reliability.test.ts
git add "claude-task-monitor/app/api/agents/[id]/compare/"
git add "claude-task-monitor/app/api/agents/[id]/reliability/"
git add "claude-task-monitor/app/agents/[id]/page.tsx"
```

### Group E — Demo collateral: scripts, E2E harness, UI test hook
```
git add claude-task-monitor/scripts/demo-adaptive-trust.ts
git add claude-task-monitor/scripts/demo-evidence-preference.ts
git add claude-task-monitor/scripts/demo-independent-validation.ts
git add claude-task-monitor/scripts/adaptive-trust-evidence.ts
git add claude-task-monitor/scripts/export-clean-package.sh
git add claude-task-monitor/scripts/pre-demo-check.sh
git add "claude-task-monitor/scripts/demo-e2e/"
git add "claude-task-monitor/app/_components/TaskDetailPanel.tsx"
```
Review before staging: `scripts/demo-e2e/` includes
`last-run-report.json`-style outputs in some setups — confirm the
directory's `.gitignore` rule (`/scripts/demo-e2e/*-report.json`, already
present) is actually excluding today's regenerated report before adding the
whole directory; `git add -n` (dry run) or `git status` after staging will
show if it slipped in.

### Group F — Dependencies / tooling / seed scripts
```
git add claude-task-monitor/package.json
git add claude-task-monitor/package-lock.json
git add claude-task-monitor/prisma.config.ts
git add claude-task-monitor/prisma/seed.ts
git add claude-task-monitor/prisma/seed-workerai.ts
git add claude-task-monitor/scripts/seed-platform-tasks.ts
git add claude-task-monitor/scripts/seed-platform-tasks.mjs
git add claude-task-monitor/scripts/seed-workerai-review-tasks.ts
```

### Group G — E2E test suite + Playwright config
```
git add claude-task-monitor/e2e/agents.spec.ts
git add claude-task-monitor/e2e/auth.spec.ts
git add claude-task-monitor/e2e/core-workflows.spec.ts
git add claude-task-monitor/e2e/global-setup.ts
git add claude-task-monitor/e2e/tasks.spec.ts
git add claude-task-monitor/e2e/admin.spec.ts
git add claude-task-monitor/e2e/reports.spec.ts
git add claude-task-monitor/e2e/projects.spec.ts
git add claude-task-monitor/e2e/queue.spec.ts
git add claude-task-monitor/playwright.config.ts
```
Includes the auth-state-local-path regression fix (4 spec files found
independently hardcoding the old filename, fixed this pass — see §2).
**Deliberately excludes** `e2e/.auth-state.json`'s own deletion — that's in
Group SEC, not here. Do not add it with a bare
`git add claude-task-monitor/e2e/` for this reason; stage the
`.spec.ts`/config files by explicit name as listed.

### Group H — Repo hygiene, CI placement, docs
```
git add /Users/kai/Desktop/Github/WorkerAI/.gitignore
git add claude-task-monitor/.gitignore
git add .github/workflows/ci.yml
git add .github/workflows/deploy.yml
git add README.md
git add claude-task-monitor/README.md
git add claude-task-monitor/ws-server.ts
git add "claude-task-monitor/docs/"
```
Note: `.github/workflows/ci.yml` and `deploy.yml` are **already staged as
renames** (moved from the non-functional nested
`claude-task-monitor/.github/workflows/` location to the repo-root
`.github/workflows/` — GitHub Actions only triggers on workflows at the
repo root, so this move is a real correctness fix, not cosmetic). The `git
add` lines above re-confirm that staged state; nothing new happens here
beyond what's already in the index.

## 4. Why no group runs `git add -A`

Confirmed by inspection, not assumed: the untracked list mixes brand-new
library code (Group D), demo scripts (Group E), and an entire new `docs/`
directory (Group H) with the two flagged items in §2 that must not be
staged at all. A blanket add would have no way to exclude
`.DS_Store`/`e2e/.auth-state.json` short of a second corrective
`git reset` — safer to never stage them in the first place.

## 5. Suggested commit order (if groups are approved)

SEC → A → B → C → D → E → F → G → H. Each group is independently buildable and
testable (the verification sweep in this session's final report already
covers the combined result of all of them together); this order simply
goes from lowest-level/most-foundational to most-cosmetic, so an early
`git bisect` on a future regression lands on a more specific commit.

No group has been staged or committed. All `git add` commands above are
for your review and require your explicit go-ahead to run.
