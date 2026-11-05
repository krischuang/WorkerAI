# Demo Day Final Verification — Independent QA Audit

Date: 2026-11-05. Demo date: 2026-11-07. Previous estimated readiness: 82/100
(stated by the requester, not derived by this audit).

This is an independent verification pass. It does not trust the prior
`docs/DEMO_DAY_FINAL_AUDIT.md` report's claims — every item below was
re-verified against the current repository by reading the actual code and/or
executing real commands today. No code was modified. Nothing was committed
or pushed.

---

## 1. Overall: PASS / FAIL / NOT VERIFIED

**PASS, with disclosed gaps.** All four Phase-1 P0 security/correctness
properties are genuinely implemented and covered by tests that actually
exercise the failure mode, not just happy-path assertions. A live,
non-mocked orchestration run (SSH/tmux/Docker/policy/kill-switch) passed
13/13 assertions on two independent re-executions today. Lint, typecheck,
the full unit suite, and the production build all pass cleanly.

Two things are explicitly **NOT VERIFIED**, consistent with prior
disclosure, not newly discovered gaps:
- The fully combined pipeline (WorkerAI → SSH/tmux → **real** Claude CLI →
  independent validation → completed) in one run. Two separately-real
  halves are proven; they are not merged.
- Remote GitHub Actions execution (no push was performed, per constraints).

One **new** finding this pass that was not in the prior report: dependency
vulnerabilities (see §4), including a critical one reachable through a
package that is misclassified as a production dependency.

---

## 2. Exact test counts and commands

All commands run today (2026-11-05), against the current working tree,
after a full `npm install` (dependencies had been deliberately cleared
earlier in this engagement to reclaim disk space).

| # | Command | Result | Exit code |
|---|---|---|---|
| 1 | `npm run lint` (ESLint) | 0 errors, 0 warnings | 0 |
| 2 | `npx tsc --noEmit` | 0 errors | 0 |
| 3 | `npx vitest run` | 60 files, **1160/1160 tests passed**, 0 failed, 0 skipped | 0 |
| 4 | `npm run build` (production build) | succeeded, all routes compiled | 0 |
| 5 | `npx tsx scripts/demo-e2e/run.ts --teardown` (run A, this session) | **13/13 acceptance assertions PASS** | 0 |
| 6 | `npx tsx scripts/demo-e2e/run.ts --teardown` (run B, repeated to confirm non-flakiness) | **13/13 acceptance assertions PASS** | 0 |
| 7 | `npm run test:e2e` (Playwright, first attempt) | 36 passed / **51 failed** / 21 did not run | non-zero |
| 8 | `npm run test:e2e` (Playwright, corrected re-run) | **77 passed / 14 failed / 17 did not run** | non-zero |

**About row 7 vs. row 8 — a methodology note, not a hidden detail:**
Row 7's 51 failures looked like a severe regression (near-every API route
returning 500). Investigation traced the cause to this audit itself: a local
disposable Postgres container (`workerai-baseline-db`, port 5432) had been
removed during this engagement's own cleanup, but `.env.local`'s
`DATABASE_URL` still pointed at it — so the dev server Playwright spawns
could not reach a database at all. This was **not** an application defect;
it was a byproduct of this QA session's own earlier actions. The container
was recreated, migrations re-applied (`npx prisma migrate deploy` —
"All migrations have been successfully applied"), and the suite was re-run
cleanly (row 8), producing a result consistent with the previously-recorded
baseline (76 passed / 15 failed / 17 did not run). Reporting row 7 as a real
finding would have been exactly the kind of unverified, fabricated-by-omission
claim this audit exists to prevent — it is disclosed here instead of
discarded silently.

**Row 8's remaining 14 failures and 17 non-runs are pre-existing
test-ordering fragility**, not a new regression: the failures cascade from
one early test in a shared-state sequential file (`core-workflows.spec.ts`'s
"creates a server" returning 400 instead of 201, or a mid-suite 429 from the
login rate limiter) into every subsequent test in that same file that
depends on IDs created earlier. This is a test-isolation problem (shared
mutable fixtures across sequential tests, occasionally colliding with the
real rate limiter), not evidence that the application's HTTP layer is
broken — the same routes are exercised successfully by dozens of other
passing tests in the same run.

**Targeted P0-area regression tests** (subset of row 3, re-run in isolation
to directly answer this audit's Phase 1 questions):

```
npx vitest run lib/__tests__/validation-gate.test.ts lib/__tests__/policy-engine.test.ts \
  lib/__tests__/kill-switch.test.ts lib/__tests__/auto-recovery.test.ts \
  lib/__tests__/task-dispatch.test.ts lib/__tests__/completion-marker.test.ts
→ 6 files, 108 tests, 108 passed, 0 failed. Exit 0.
```

---

## 3. Phase 1 — P0 fixes, verified by reading the actual implementation

### 3.1 Independent Validation (`lib/validation-gate.ts`)
- Read the full current source. The type system and control flow make
  `allowed: true` reachable **only** through the branch that: (a) has a
  `workspaceDir`, (b) ran `runIndependentValidation()` successfully, (c) got
  `allPassed === true` from real exit codes, and (d) passed file-level
  policy. Every other branch (`!opts.workspaceDir`, `!independent.ran`,
  `!independent.allPassed`, explicit agent-failure, missing block entirely)
  returns `allowed: false` with an explicit non-`INDEPENDENTLY_VERIFIED`
  state. **VERIFIED.**
- "Missing workspace cannot create false verification": confirmed — the
  `!opts.workspaceDir` branch returns `NOT_VERIFIED`, not a pass. **VERIFIED.**
- "Failed tests always prevent verified completion": confirmed — a lying
  agent's self-report is independently re-executed against real allowlisted
  commands; disagreement flips the result to `VERIFICATION_FAILED`.
  Confirmed **live** today: Task 2 (`[LYING_AGENT]`) in both demo-e2e runs
  → `allowed=false verificationState=VERIFICATION_FAILED`. **VERIFIED.**

### 3.2 Policy Engine (`lib/policy-engine.ts`, `lib/task-dispatch.ts`)
- `requiresApproval` enforced: `task-dispatch.ts` calls
  `evaluateDispatchPolicy`, and on `requiresApproval === true` requires a
  matching, unexpired `getPolicyApproval(taskId, "code_execution")` result
  before proceeding. Confirmed by code read and by a passing test:
  *"dispatches once a policy approval has actually been granted, and
  consumes it so it cannot be reused."* **VERIFIED.**
- Expired/invalid approval rejected: `getPolicyApproval` checks
  `new Date(record.expiresAt).getTime() <= Date.now()`, consumes and denies
  on expiry. Covered by test *"an expired approval is treated as absent and
  is removed."* **VERIFIED.**
- High-risk dispatch denied when unauthorized: confirmed **live** today —
  "high-risk autonomous dispatch was blocked (hard gate, no approval path)"
  passed in both demo-e2e runs. **VERIFIED.**
- Ignored files such as `.env` protected: `runIndependentValidation` uses
  `git status --short --ignored=matching` specifically because plain
  `git status --short` never lists gitignored paths. Confirmed **live**
  today — Task 3 (`[TOUCHES_ENV]`) correctly shows `?? .env` in the
  evidence and blocks completion in both runs. **VERIFIED.**
- "Check actual filesystem isolation, not only Git status": **this is
  explicitly NOT fully solved and is disclosed as such**, both in the prior
  report and confirmed again by this audit. Detection is git-based; a write
  made entirely outside the task's git working tree (e.g. to a path outside
  the repo) is invisible to this mechanism. This requires OS-level sandboxing
  (container/VM/chroot per task) to truly prevent rather than detect. **This
  is a known, disclosed limitation — not fixed, and not claimed to be
  fixed.**

### 3.3 E2E Reliability
- "Prompt output cannot trigger false completion": the demo-e2e scenario's
  own completion-marker assertion explicitly checks the marker was found
  "post-dispatch, not echoed from the prompt" — passed live, both runs.
  **VERIFIED.**
- "Production completion detection is exercised": the live run calls the
  actual `detectValidationBlock`/`runIndependentValidation` production
  functions (same code path `instrumentation.node.ts` uses), not a
  reimplementation. **VERIFIED.**
- "Assertions fail with non-zero exit code": confirmed by reading
  `scripts/demo-e2e/scenario.ts` — `process.exit(1)` fires whenever any
  assertion's `pass` boolean is false, and each `pass` is a real boolean
  expression over actual returned values (`decision === "deny"`,
  `.ok === false`, etc.), not a hardcoded `true`. **VERIFIED.**
- "Negative test cases correctly reject false success": the lying-agent and
  `.env`-write scenarios are exactly this, and both passed live. **VERIFIED.**

### 3.4 Kill Switch (`lib/kill-switch.ts`)
- "Dispatch is blocked when activated": confirmed live — "kill switch
  blocked dispatch while active" passed in both demo-e2e runs, plus a
  dedicated unit test suite (`kill-switch.test.ts`, 15 tests).
  **VERIFIED.**
- "Database failure cannot silently bypass protection": read
  `loadStateFromDb()` — on any DB error it returns
  `{ active: true, reason: "db_unavailable", scope: FULL_SCOPE }`
  (fail-closed), not fail-open. Confirmed by a real test that mocks
  `prisma.systemConfig.findUnique` to reject and asserts every subsystem
  reports halted as a result — this is a genuine simulated DB outage, not a
  trivial always-pass assertion. **VERIFIED.**
- `lib/auto-recovery.ts`'s `recoverServer`/`recoverAgent` both check
  `isSubsystemHalted("selfHealing")` before acting, for both "auto" and
  "manual" triggers — confirmed by code read and 5 passing tests in
  `auto-recovery.test.ts`. **VERIFIED.**

---

## 4. Real Claude E2E evidence — A vs. B vs. C vs. D

| Layer | What it proves | Status this audit |
|---|---|---|
| **A. Unit tests** | Logic correctness in isolation | VERIFIED — 1160/1160 pass today |
| **B. Mocked Docker/SSH/tmux integration** (`demo-e2e`) | The full dispatch→validate→audit pipeline works end-to-end against a disposable container, with a clearly-labeled scripted stand-in for the LLM step | VERIFIED — 13/13 live, twice, today |
| **C. Real Claude CLI execution** (`demo:real-claude`) | A real, non-mocked `claude -p` call produces a real diff and is independently re-verified | **NOT re-executed this audit** — this requires a real, billed API call, and the audit's own constraints require authorization before any paid/externally-impactful execution. The existing captured evidence in `docs/DEMO_RUN_RECORD.md` (claude CLI 2.1.220, cost $0.19, ~19s, real diff shown) was reviewed for internal consistency and is plausible and well-formed, but **this audit did not independently re-run it**, so it is reported as reviewed-but-not-freshly-verified, not as freshly confirmed. |
| **D. Full combined pipeline** (WorkerAI → SSH/tmux → real Claude → independent validation → completed, in one run) | The actual advertised end-to-end story | **NOT VERIFIED** — explicitly and consistently disclosed, both in the prior report and here. The missing dependency is authenticated Claude CLI access from inside the disposable container (would require mounting this machine's OAuth credential store, judged out of scope for a demo). A, B, and C are each real; none of them, nor their combination as currently structured, constitutes proof of D. |

**No new real-Claude CLI call was made during this audit.** If you want C
freshly re-confirmed (not just reviewed) before the demo, that requires your
explicit authorization, since it is a real, billed, externally-impactful API
call — say so and it can be run.

---

## 5. Remaining issues by priority

| Priority | Issue | Status |
|---|---|---|
| P0 | — | None open. All four Phase-1 P0 properties verified above. |
| P1 | Tracked database dumps with real `Server`/`Task`/`AuditEvent` rows remain in git history (commit `5769a19`) on a repo with a real GitHub remote. Removal from the working tree is staged but not committed; history is not rewritten. | Still open — requires your decision (rotate vs. rewrite history), not a code fix. |
| P1 | **New this audit:** `npm audit` reports 23 advisories (3 critical, 10 high, 10 moderate) against the full tree, 12 of which (1 critical, 8 high, 3 moderate — via `shell-quote`, `nodemailer`, `postcss`, `sharp`, `source-map-js`) survive even with `--omit=dev`. Two are concretely relevant: (a) `nodemailer` (used for real at `lib/email.ts`, a runtime dependency) has multiple high-severity advisories including SSRF and recipient-spoofing bypasses; (b) `concurrently` — listed under `"dependencies"`, not `"devDependencies"`, despite only being used by the local `dev` script — pulls in `shell-quote` with a **critical** command-injection advisory. Item (b) is the same class of issue a prior commit (`bcd4e89`, "fix devDependency bleed into runtime image") was meant to address, and appears incompletely addressed. | Not fixed this audit (no code changes permitted). Smallest targeted fix, pending approval: move `concurrently` to `devDependencies`, then run `npm audit fix` (non-breaking fixes only — avoid `--force`, which bumps `nodemailer` across a major version). |
| P2 | Playwright test-ordering fragility (14 failures / 17 non-runs out of 108, after correcting for this audit's own DB-container mishap). Pre-existing, not newly introduced. | Not fixed — out of scope for this audit, flagged previously too. |
| P2 | No `engines` field in `package.json`; local dev Node is v20.20.2, while `ci.yml` declares `NODE_VERSION: "22"` and `concurrently@10` requires Node ≥22 (`npm install` emits an `EBADENGINE` warning locally). All local verification in this audit therefore ran under Node 20, not the Node 22 CI declares. | Not fixed — low risk (CI uses the correct version), but means local and CI environments are not provably identical. |
| P2 | The local demo environment's correctness depends on a manually-managed disposable Postgres container matching `.env.local`'s `DATABASE_URL` — demonstrated concretely by this very audit, where removing that container (a reasonable disk-cleanup action) silently broke the entire Playwright suite until diagnosed. | Not fixed — recommend a one-line pre-demo checklist item ("confirm `docker ps` shows the local Postgres container before testing/rehearsing"), not a code change. |

---

## 6. Estimated competition readiness: **66/100**

| Criterion | Score | Justification |
|---|---|---|
| Difficulty of Build (/25) | 18 | Real multi-service orchestration (SSH/tmux dispatch, a scoped/TTL'd policy-approval engine, a forgery-resistant independent-verification gate) is genuinely nontrivial, and the Edge/Node.js runtime-isolation bugs found and fixed this engagement show real production-system depth. Capped below 20+ because the hardest subsystems (completion detection, policy engine skeleton) pre-existed this audit's scope — this pass hardened rather than originated most of the hard parts. |
| Functionality (/25) | 16 | Layers A and B are both genuinely proven, repeatedly, by independent re-execution — not self-report. Capped well below 20+ because: layer D (the actual advertised full pipeline) is unverified by design; layer C was only reviewed, not freshly re-confirmed, this pass; and this audit's own DB-container incident is direct, fresh evidence that the local demo environment has real operational fragility that could bite on presentation day if the checklist isn't followed exactly. |
| Clarity of Explanation (/25) | 18 | A coherent ~4-minute script, checklist, and backup plan all exist and read well, with a genuine live contrast available ("agent says passed" vs. "WorkerAI verified"). Held below 20+ pending an actual rehearsal on the presentation laptop — none has been confirmed to have happened — and because the script's word count (682 words) runs closer to ~5 minutes at a normal speaking pace than the stated "~4 minutes." |
| Originality (/25) | 14 | Independent re-verification instead of trusting agent self-report is a real, demonstrable, non-trivial differentiator. Scored in the middle because "agent orchestration with guardrails/policy engines" is an increasingly crowded category, and the core novel idea, while well-executed, is incremental rather than category-defining. |
| **Total** | **66/100** | |

**This is lower than the previously-stated 82/100 estimate, on purpose —
this audit does not auto-increase or confirm a prior score without new
evidence.** The gap is driven by: the still-open P1 git-history data
exposure, the newly-surfaced dependency-vulnerability finding, the
unverified layer-D combined pipeline, and this audit's own direct
demonstration that the local demo environment is one missed Docker
container away from looking completely broken. None of these are
showstoppers — all are either already mitigated (fail-closed designs),
disclosed honestly, or fixable with a small, well-scoped change — but a
conservative, evidence-based score should reflect them rather than assume
they don't matter.

---

## 7. What is needed to reach 90+/100

1. **Resolve the git-history data exposure** (§5, P1) — this is the single
   highest-leverage fix, since it is a real, concrete risk independent of
   demo performance.
2. **Freshly re-confirm layer C and attempt a real layer-D run** (§4), with
   your explicit authorization for the cost/credential handling involved —
   this directly addresses the largest gap in the Functionality score.
3. **Fix the dependency-classification/vulnerability finding** (§5) — move
   `concurrently` to `devDependencies` and run `npm audit fix` (non-breaking).
   Small, mechanical, low-risk.
4. **Actually rehearse the ~4-minute script once on the real presentation
   laptop**, timing it for real, and add a one-line pre-flight check for the
   local Postgres container's presence to the existing checklist.
5. Optionally, invest time in the Playwright test-isolation fragility (§5,
   P2) — lower leverage for the demo itself, but would remove a persistent
   noisy-failure signal from the test suite.

None of the above, except item 2's live Claude CLI calls, costs money or
requires infrastructure beyond what already exists locally.

---

## 8. Is additional coding necessary? Is the project ready to present?

**Is additional coding necessary?** Not for the P0 security/verification
properties — all four are genuinely implemented and tested; no gaps were
found there. The two items that do involve a change are small and
mechanical: the `package.json` dependency-classification fix (§5/§7 item 3)
and, optionally, Playwright test-isolation work (§5 P2, lower priority, not
blocking). Everything else needed before Nov 7 is a decision (git history),
an authorization (a fresh real-Claude run), or rehearsal — not new code.

**Is the project ready to present?** Yes, with two caveats you should weigh
yourself: (1) the git-history exposure should be resolved or consciously
accepted before the repository is shown or shared in any form, and (2) the
script should actually be rehearsed once end-to-end on the real presentation
hardware, with the local Postgres container confirmed running beforehand —
this audit is direct proof that a missing container silently breaks
everything downstream of it.

---

STOP CODING. FOCUS ON DEMO REHEARSAL.
