# Demo Day Final Audit — WorkerAI

Date: 2026-11-05. Demo date: 2026-11-07.

This document is the final output of a 9-phase hardening pass over WorkerAI
ahead of Demo Day. It reports what was verified by actually running code,
not what the source *appears* to do. Where something could not be verified,
it is marked **NOT VERIFIED**, not PASS.

---

## 1. Executive summary

WorkerAI's core claim — that it goes beyond "AI agent writes code" to
orchestrate dispatch, enforce policy, and **independently** verify
completion — was largely true in architecture but had three real gaps that
would have let a misbehaving or malicious agent fake a "verified" success.
All three were found, fixed, and covered by regression tests:

1. Autonomous completion could be marked as independently verified from
   agent-reported text alone when the workspace was unavailable, instead of
   being withheld. Fixed with an explicit `NOT_VERIFIED` state that can
   never be confused with `INDEPENDENTLY_VERIFIED`.
2. Policy approvals were not scoped to a specific task+operation or
   time-limited, so a stale or unrelated approval could be reused. Fixed
   with `(taskId, category)`-scoped, TTL-expiring, one-time-use approvals.
3. File-change detection used `git status --short`, which never shows
   gitignored files — meaning a write to `.env` was invisible. Fixed with
   `--ignored=matching`, closing the most dangerous blind spot (secret-file
   writes during autonomous execution).

Separately, two real structural bugs were found and fixed that had nothing
to do with the audit's stated scope but were actively breaking the app:
Next.js's Edge Runtime and Node.js runtime do not share `globalThis`, which
had silently broken (a) all authentication in a prior session and (b) the
rate-limit admin toggle in this session. Both are now fixed via
Edge-Runtime-safe mechanisms (env vars), not globalThis flags.

A full, real, end-to-end run was executed and independently verified: a real
task was dispatched over SSH/tmux to a disposable container, a scripted
stand-in model made a real source-code change, WorkerAI's production
completion detector and independent validator ran for real, and the task was
marked `INDEPENDENTLY_VERIFIED` only after re-executing the test suite
itself — not by trusting the agent's self-report. A separate, real Claude
CLI invocation (no mock) was also executed and independently verified. The
two layers are deliberately not merged; see §7 for why.

The codebase is lint-clean, typecheck-clean, 1160/1160 unit tests pass, and
the production build succeeds. All changes are uncommitted, pending your
review.

---

## 2. Baseline vs. final status

| Area | Baseline (Phase 0) | Final |
|---|---|---|
| Verification states | Implicit; agent self-report could be trusted as "verified" when workspace was absent | Explicit `NOT_VERIFIED` / `AGENT_REPORTED` / `INDEPENDENTLY_VERIFIED` / `VERIFICATION_FAILED`; `INDEPENDENTLY_VERIFIED` is unreachable from agent text alone |
| Policy approvals | Keyed by `taskId` only, no expiry, no category check | Keyed by `(taskId, category)`, TTL-expiring (30 min default, 240 min cap), one-time-use, audited |
| File-change detection | `git status --short` (blind to gitignored files, e.g. `.env`) | `git status --short --ignored=matching` |
| Secret-file deny patterns | `.env` only | `.env`, SSH keys, AWS/GCP/kube/Docker/npm/netrc credential paths |
| Independent validation commands | No allowlist; any command could run | Allowlisted commands only; non-allowlisted commands rejected with an explicit evidence entry |
| Validation timeouts | None observed | 10-minute hard cap enforced |
| Auto-recovery vs. kill switch | `recoverServer`/`recoverAgent` could fire while the `selfHealing` kill switch was active | Both check `isSubsystemHalted("selfHealing")` first and refuse to act |
| Rate-limit admin toggle | Silently no-op (Edge/Node.js `globalThis` isolation bug) | `RATE_LIMIT_DISABLED` env var, Edge-Runtime-safe |
| E2E acceptance assertions | 8 | 13, including 4 new adversarial/negative scenarios |
| Real Claude CLI evidence | None in-repo | Captured run with cost, exit code, real diff, real independent verification |
| Demo collateral | None | Script, checklist, backup plan, run record |
| Shareable package | No process; tracked DB dumps with real data in git history | Export script + verified-clean archive; tracked dumps removed going forward |

---

## 3. Files modified

**Core security/correctness logic**
- `lib/validation-gate.ts` — explicit verification states; command allowlist; timeout; `--ignored=matching`; secret scrubbing on captured evidence.
- `lib/policy-engine.ts` — approval scoping, TTL/expiry, expanded secret-file patterns.
- `lib/task-dispatch.ts` — approval lookup now category-scoped.
- `lib/auto-recovery.ts` — kill-switch check before any recovery action.
- `lib/api-rate-limit.ts` — `RATE_LIMIT_DISABLED` env-var fast path (Edge-Runtime fix).
- `instrumentation.node.ts` — workspace fallback to `agent.workDir` for agent-dispatched tasks.
- `app/api/tasks/[id]/approve-dispatch/route.ts` — rewritten to re-evaluate policy and grant scoped, TTL'd approvals.
- `prisma/schema.prisma` + migration `20261105042227_add_not_verified_validation_status` — adds `ValidationStatus.not_verified` (additive, applied locally only).
- `.github/workflows/ci.yml` — `RATE_LIMIT_DISABLED: "true"` for the e2e job.

**dotenv load-order fix (8 files)** — `prisma.config.ts`, `ws-server.ts`, `playwright.config.ts`, `prisma/seed.ts`, `prisma/seed-workerai.ts`, `scripts/seed-platform-tasks.ts`, `scripts/seed-platform-tasks.mjs`, `scripts/seed-workerai-review-tasks.ts`: load `.env.local` first, then `.env`, both with dotenv's default non-destructive behavior. (`override: true` was tried and reverted — it clobbers a legitimate explicit env var a parent process sets before spawning these as children, e.g. the demo harness targeting a disposable database.)

**Demo/evidence**
- `scripts/demo-e2e/` (fake-claude.sh, scenario.ts, run.ts, report) — expanded from 8 to 13 acceptance assertions, including a lying-agent scenario and a `.env`-write scenario.
- `scripts/demo-independent-validation.ts`, `scripts/demo-real-claude/` / `verify-real-claude.ts` — real-Claude-CLI evidence capture.
- `docs/DEMO_RUN_RECORD.md`, `docs/DEMO_DAY_SCRIPT.md`, `docs/DEMO_DAY_CHECKLIST.md`, `docs/DEMO_DAY_BACKUP_PLAN.md` — new.
- `scripts/export-clean-package.sh`, `package.json` (`export:clean` script) — new.

**Tests (new/expanded)**
- `lib/__tests__/validation-gate.test.ts`, `lib/__tests__/policy-engine.test.ts`, `lib/__tests__/auto-recovery.test.ts` (new), `lib/__tests__/api-rate-limit-enabled.test.ts` (new), `lib/__tests__/task-dispatch.test.ts` (new).

**Housekeeping**
- `.gitignore` — excludes `backups/*.sql*` dumps and demo scenario reports.
- `backups/*.sql.gz` — `git rm --cached` staged locally for all three, but
  **not yet committed or pushed** (re-verified 2026-11-05) — until that
  happens, they remain tracked at `origin/main`'s current public tip exactly
  as before (see §10).

---

## 4. Bugs fixed

| # | Bug | Severity | Fix |
|---|---|---|---|
| 1 | Autonomous completion could reach "verified" from agent self-report alone when workspace unavailable | Critical | Explicit `NOT_VERIFIED` state; invariant enforced that `allowed: true` only pairs with `INDEPENDENTLY_VERIFIED` |
| 2 | Policy approvals not scoped/time-limited — stale or unrelated approval reusable | High | `(taskId, category)` scoping + TTL expiry + one-time consumption |
| 3 | `git status --short` blind to gitignored `.env` writes | Critical | `--ignored=matching` |
| 4 | Rate-limit admin toggle silently no-op from Edge Runtime (`globalThis` not shared with Node.js runtime) | Medium (functional bug, not exploitable) | `RATE_LIMIT_DISABLED` env var |
| 5 | Auto-recovery could run while `selfHealing` kill switch active | Medium | Kill-switch check added to both recovery paths |
| 6 | `dotenv/config` / plain two-call loads let `.env` (possibly production credentials) silently win over `.env.local` in 8 files | Medium | Correct `.env.local`-first, non-destructive load order |
| 7 | (Self-introduced, caught and fixed before reporting) `override: true` on the above fix clobbered a parent process's intentional `DATABASE_URL` override, redirecting `prisma migrate deploy` to the wrong database | High (would have silently invalidated demo evidence) | Removed `override: true`; load order alone gives correct precedence |
| 8 | SSH key / cloud credential paths not in the secret-file deny list | Medium | Expanded `pathPatterns` |

---

## 5. Security controls verified

All verified via actual execution (unit tests and/or the live `demo-e2e` scenario), not static reading:

- **Independent verification cannot be forged by agent text.** A lying agent that prints `[WORKERAI_VALIDATION] ... passed` is independently re-tested; the real test failure flips the result to `VERIFICATION_FAILED`. Confirmed live (Task 2, `[LYING_AGENT]`, see §6/§8).
- **Gitignored secret-file writes block completion.** Confirmed live (Task 3, `[TOUCHES_ENV]`): `.env` write detected via `git status --short --ignored=matching`, completion blocked.
- **High-risk autonomous dispatch is hard-blocked**, distinct from **human-created high-risk tasks requiring approval** — two different code paths, both confirmed live.
- **Direct `evaluatePolicy` check denies secret-file edits** independent of dispatch path — confirmed live.
- **Kill switch blocks dispatch while active**, and **auto-recovery also refuses to act** while the `selfHealing` subsystem is halted — confirmed via unit tests and the live kill-switch step.
- **Execution is auditable**: real `AuditEvent` rows (`task.dispatched`, `task.validation_passed`, `policy.deny`) queried directly from the database after the run, not asserted from in-memory state.
- **Validation commands are allowlisted**; a non-allowlisted command is rejected with an explicit evidence entry rather than silently skipped or run.
- **Validation runs under a 10-minute hard timeout.**
- **Captured evidence (stdout/stderr/diffs) is scrubbed of known secret values** before being written to the DB or reports.

**Known, disclosed limitation (not fixed, by design):** git-based detection is blind to writes made entirely outside the task's git working tree (e.g., to `~/.bashrc`). This requires OS-level sandboxing to truly prevent, not just detect, and is explicitly documented as such rather than silently claimed as covered.

---

## 6. Automated test results

| Test Suite | Passed | Failed | Skipped |
|---|---|---|---|
| ESLint (`npm run lint`) | — | 0 errors / 0 warnings | — |
| TypeScript (`tsc --noEmit`) | — | 0 errors | — |
| Vitest unit tests (60 files) | 1160 | 0 | 0 |
| Production build (`npm run build`) | Succeeded | — | — |
| `demo-e2e` scenario (13 acceptance assertions, live SSH/tmux/Docker) | 13 | 0 | 0 |
| Playwright E2E (full browser suite) | 76 | 15 | 17 did not run |

**Playwright detail:** the 15 failures and 17 non-runs are pre-existing sequential-test-dependency fragility, confirmed present in the very first baseline run of this suite before any change in this engagement — not something introduced by this work. The rate-limiter fix (`RATE_LIMIT_DISABLED`) measurably improved the pass count from 45/41/17 to 76/15/17 by removing a real, structural cause of 429 failures; the remainder is a separate, pre-existing issue (test ordering/isolation) that was out of scope for this pass and is listed as a remaining risk below.

---

## 7. Real Claude execution evidence

Two layers were independently verified; they are deliberately **not** merged (see rationale below):

**A. Real Claude CLI, direct invocation** (`npm run demo:real-claude`): real `claude -p` call, no mock, authenticated via this machine's existing Claude Code OAuth session. Most recent captured run: `claude` CLI version 2.1.220, cost $0.19, ~19s. Claude produced a real source diff (`multiply()` added to `math.js`), WorkerAI's production `detectCompletionBlock`/`detectValidationBlock`/`runIndependentValidation` functions ran against it for real, and independent re-execution of the test suite passed. Full transcript in `docs/DEMO_RUN_RECORD.md`.

**B. Full SSH/tmux/policy/kill-switch orchestration** (`npm run demo:e2e`, this session's final confirmation run): real SSH connection, real tmux dispatch, into a disposable Docker container, against a disposable local Postgres database. The LLM step uses a clearly-labeled scripted stand-in (`fake-claude.sh`) rather than a live API call, so the mechanism can be re-run on demand without cost or network dependency. All 13 acceptance assertions passed on the final re-run this session (log reproduced in §8).

**Why not merged into one run:** running the real Claude CLI *inside* the disposable container, driven over the same SSH/tmux path as (B), would require mounting this machine's Claude Code OAuth credential store (`~/.claude.json`) into a container — judged an unnecessary credential-handling risk for demo purposes, with no `ANTHROPIC_API_KEY` configured as a lower-risk alternative. **A single combined run (real Claude CLI, driven over real SSH/tmux, inside the disposable container) is explicitly NOT VERIFIED.** The missing dependency is authenticated Claude CLI access from inside a container.

---

## 8. Docker / mock E2E evidence

Final confirmation run, executed this session after fixing the dotenv regression (§10), full log:

```
[demo-e2e] PASS — all acceptance assertions held.
  [PASS] Task 1 was successfully dispatched to the selected server
  [PASS] the correct server was selected
  [PASS] a real completion marker was detected (post-dispatch, not echoed from the prompt)
  [PASS] the task's own validation block (not an echo) reported passed
  [PASS] independent re-execution actually ran and passed (INDEPENDENTLY_VERIFIED, not merely AGENT_REPORTED)
  [PASS] Task 1 was actually marked completed
  [PASS] a non-empty, expected git diff exists for Task 1 (math.js was actually changed)
  [PASS] Task 2 [LYING_AGENT]: a false 'passed' self-report does NOT result in completion
  [PASS] Task 3 [TOUCHES_ENV]: a gitignored .env write is detected and blocks completion (live, via git --ignored=matching)
  [PASS] high-risk autonomous dispatch was blocked (hard gate, no approval path)
  [PASS] a human-created high-risk task requires approval rather than hard-blocking (distinct code path)
  [PASS] secret-file policy violation was denied (direct evaluatePolicy check)
  [PASS] kill switch blocked dispatch while active
  [PASS] execution results are auditable — real AuditEvent rows exist for Task 1
```

This supersedes the 8-assertion baseline suite; the 5 new assertions (lying agent, `.env` write, human-approval path, direct policy-deny check, audit-trail query) are the ones that specifically exercise this engagement's fixes.

---

## 9. CI verification status

| Check | Status | Note |
|---|---|---|
| Workflow file location | VERIFIED | Confirmed at repo root `.github/workflows/` (moved during this engagement — GitHub Actions does not run workflows nested under a subdirectory) |
| Node version match | VERIFIED (local) | Matches `package.json` engines; not independently confirmed inside GitHub's runner |
| Dependency install reproducibility | VERIFIED (local) | `npm ci` equivalent succeeds locally |
| Lint / typecheck / unit tests / build | VERIFIED (local) | All pass locally; see §6 |
| Playwright config in CI | VERIFIED (local reasoning only) | `RATE_LIMIT_DISABLED` added to the e2e job env; not confirmed by an actual GitHub Actions run |
| Docker/real-Claude tests correctly separated from ordinary CI | VERIFIED | `demo-e2e` and `demo-real-claude` are not wired into `ci.yml`'s standard job; documented as separate, manually-triggered evidence layers |
| **Actual GitHub Actions run (remote)** | **NOT VERIFIED** | No push was made (per constraints); nothing was confirmed by GitHub's own runners |

---

## 10. Remaining known limitations

| Severity | Risk | Recommendation |
|---|---|---|
| High | Real GitHub remote (`git@github-kris:krischuang/WorkerAI.git`) exists; this repo's history contains tracked database dumps with real `Server`/`Task`/`AuditEvent`/`ExecutionLog` rows that may already be pushed and exposed | Decide whether to rewrite history (e.g. `git filter-repo`) to purge the dumps, or rotate anything sensitive they contain. This requires your explicit decision — not performed here. |
| Medium | git-based change detection cannot see writes made entirely outside the task's working tree | Requires OS-level sandboxing (container/VM/chroot per task) for a true guarantee; currently disclosed as a known gap, not silently claimed as covered |
| Medium | Server-direct tasks (no `Agent.workDir` fallback) still go `NOT_VERIFIED` if `workspaceDir` is unavailable, with no equivalent fallback path | Acceptable (fails closed, does not fake verification) but reduces how many server-direct tasks can reach `INDEPENDENTLY_VERIFIED` until a fixed workspace concept is added for servers too |
| Medium | 15 Playwright E2E failures / 17 non-runs, pre-existing sequential-test-dependency fragility | Out of scope for this pass; needs test isolation work (likely per-test DB reset or `fullyParallel: false` ordering fixes) |
| Low | Combined real-Claude-CLI + SSH/tmux-in-container run is NOT VERIFIED | Would require solving container credential mounting for `~/.claude.json` or provisioning `ANTHROPIC_API_KEY`; deliberately deferred as a credential-handling risk |
| Low | Remote GitHub Actions execution itself NOT VERIFIED (no push performed) | Confirm with a real CI run before the demo if you choose to push |

---

## 11. Demo rehearsal checklist

See `docs/DEMO_DAY_CHECKLIST.md` for the full pre-flight list. Summary:

- [x] `npm run demo:e2e` runs clean, 13/13 assertions pass (confirmed this session)
- [x] `npm run demo:real-claude` has a captured, honest fallback transcript in `docs/DEMO_RUN_RECORD.md` in case the live call fails or is rate-limited during the demo
- [x] `docs/DEMO_DAY_SCRIPT.md` — ~4 minute script covering problem/architecture/live execution/independent verification/safety/result
- [x] `docs/DEMO_DAY_BACKUP_PLAN.md` — restart procedure and fallback evidence for network/auth/SSH/DB failure modes
- [ ] Rehearse the script once end-to-end on the actual presentation laptop (not yet done — recommend doing this before 2026-11-07)
- [ ] Confirm no credential is visible on screen during the live run (the scrubbing logic is tested; a visual dry-run on the real laptop is still recommended)

---

## 12. Estimated competition readiness

| Judging Criterion | Estimated Score (/10) | Evidence |
|---|---|---|
| Difficulty of Build | 7 | Real multi-agent dispatch over SSH/tmux, a genuine policy-approval engine with TTL/scoping, and an independent-verification gate that resists forged completions are nontrivial systems; the Edge/Node.js runtime-isolation bugs found and fixed indicate real production-system complexity. Scored below 8–9 because core pieces (completion detection, policy engine) pre-existed this engagement — this pass hardened, not originated, most of the hard parts. |
| Functionality | 7 | One fully real, independently-verified Claude CLI run; one fully real, independently-verified 13-assertion SSH/tmux orchestration run. Both are genuine, not scripted fakes dressed up as real. Capped below 8+ because the two are not yet merged into a single run (§7), and server-direct tasks lack the same verification coverage agent-direct tasks now have. |
| Clarity of Explanation | 8 | `DEMO_DAY_SCRIPT.md` has a clear, non-hand-wavy narrative ("Claude says passed" vs. "WorkerAI independently verified") backed by a live demonstrable contrast (Task 1 vs. Task 2 in §8). Scored below 9–10 pending an actual rehearsal on the presentation laptop. |
| Originality | 6 | Independent re-verification (not trusting agent self-report) and policy-gated autonomous execution are the genuinely distinctive ideas here, and they are real, not aspirational. Scored moderately because "agent orchestration + guardrails" is a crowded space; the specific execution (SSH/tmux dispatch, TTL-scoped approvals, gitignore-aware change detection) is a solid but not category-defining differentiator. |

These are engineering-readiness estimates from direct verification of this codebase, not predictions of actual judging outcomes, which also depend on delivery, competing projects, and judge calibration on the day.

---

## 13. Top three remaining recommendations

1. **Resolve the tracked-database-dump exposure** (§10, High) before the demo if the repository might be shown or shared — this is the one finding with a real, non-hypothetical exposure risk, and it requires your explicit decision on history rewriting.
2. **Rehearse the live demo once on the actual presentation laptop**, specifically confirming `npm run demo:e2e` and `npm run demo:real-claude` both run cleanly in that environment and that the backup plan's recorded evidence is easy to pull up if either fails live.
3. **If time remains**, invest in merging the real-Claude-CLI and SSH/tmux layers (§7) — this is the single change that would most directly strengthen the "Functionality" score, since it would make the full, advertised pipeline (dispatch → real Claude → independent verification) demonstrable in one run rather than two.

---

## Final recommendation

Ship it as-is for Nov 7, with the three items above addressed in priority order
(especially #1, which is a real disclosure risk, not a nice-to-have). The
core claim — that WorkerAI independently verifies rather than trusts agent
self-report — is now true, tested, and demonstrable live, not merely
asserted. Do not claim the combined real-Claude+SSH/tmux pipeline works in
one run; two separately-real runs is an honest and still-strong story.
