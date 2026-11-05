# Judge Simulation & Cheat Sheet — WorkerAI

## Judge scores (planning rubric, 25 pts/criterion — not an official weighting)

| Criterion | Score | Why |
|---|---|---|
| Difficulty of Build | 21/25 | Real SSH/tmux orchestration, a layered policy engine (dispatch-time + post-execution file-level), an independent-verification gate that resists forged completions, and a structurally-isolated advisory reliability layer. **+1 this pass**: `compareBaselineWithEvidencePreference` adds a genuinely new comparison algorithm (conservative score-gap threshold, reuses rather than duplicates eligibility logic, 13 new named regression scenarios) on top of the existing engine — real, not cosmetic, but incremental rather than architectural. |
| Functionality | 21/25 | Unchanged this pass. Positive new evidence: a fresh full verification sweep is all-green (1195/1195 tests, lint, typecheck, build, precheck, `demo:e2e` 13/13, the new `demo-evidence-preference.ts` 32s/PASS) and the new comparison capability works end-to-end (lib → API → UI → demo). This is offset by two newly-surfaced negative findings this same pass: `scripts/demo-e2e/verify-real-claude.ts` was found using `bypassPermissions`, violating this project's own standing safety rule (unfixed pending an approved paid re-run — see `docs/REAL_CLAUDE_INTEGRATION_FEASIBILITY.md`), and the DB-dump "removed from tracking" claim in two docs was found to be inaccurate (a removal was staged locally but never committed/pushed — corrected this pass, see `docs/GIT_HISTORY_REMEDIATION_PLAN.md`). Still capped below 23+ because the fully-combined real-Claude-CLI-over-SSH pipeline remains unverified by design, re-confirmed this pass. |
| Clarity of Explanation | 22/25 | Unchanged this pass. New evidence (the Agent Detail page's "Baseline vs. Evidence-Preferred" card, screenshot-verified against real seeded data) is real but targets a judge-follow-up surface, not the timed 6-minute narration itself. Still capped pending an actual timed rehearsal on the real presentation hardware — not performed this pass either. |
| Originality | 17/25 | **+1 this pass**: previously the advisory layer could only *annotate* the baseline pick, never change it — a fair "so what, it never actually does anything different" challenge from a judge. `compareBaselineWithEvidencePreference` is the first capability that can genuinely flip the recommendation when evidence clearly justifies it, while staying structurally advisory-only. That's a sharper, more defensible answer to "what's actually original here" than before. Still a crowded category overall, hence a modest, not large, increase. |
| **Total** | **81/100** | Up from 79 — two +1s with specific new evidence cited per criterion (not a blanket reassessment), one unchanged despite new positive evidence because new negative findings offset it, one unchanged because its capping reason (no rehearsal) is untouched. |

---

## The three questions most likely to challenge credibility

### 1. "You're not running the full pipeline live anymore — is that because it doesn't actually work reliably?"

**Honest answer:** No — it ran successfully 5 out of 5 times today, with identical 13/13 results each time, including once that took nearly 5 minutes under heavy concurrent load on this machine. The switch to captured evidence for that segment is explicitly a *time-budget* decision for a hard 6-minute slot, not a reliability admission — and it's disclosed as such in the script itself, not hidden. If you want to see it live after the judged segment, I can run it right now.

### 2. "The Adaptive Trust Engine demo uses synthetic data — isn't that fabricating evidence?"

**Honest answer:** The *data* is synthetic and explicitly labeled `SYNTHETIC FIXTURE DATA` in every line of the script's own output, then deleted afterward. The *code* computing the score — the database queries, the deterministic formula, the false-positive weighting — is the same real production code that would run against real history. This repository doesn't yet have enough accumulated real task history to show a genuine A-vs-B difference honestly, so I used clearly-labeled fixtures to demonstrate the algorithm instead of fabricating a "real" result. That's the difference between a calculator demo using example numbers and a fake invoice.

### 3. "'Independent verification of an AI agent' isn't new — CI does this already. What's actually novel?"

**Honest answer:** Re-running tests isn't the novel part — the novel part is the state machine refusing to ever call something "verified" from self-report alone, even in the inconvenient case a naive system gets wrong: no workspace available to check. That case resolves to `NOT_VERIFIED`, not a silent pass. Layer that with a *second*, post-execution policy gate that re-checks what actually changed on disk — including gitignored files a plain `git status` would miss — and a kill switch that fails *closed* on a database outage rather than open. It's the specific combination, each piece independently tested, that's the claim — not any single piece in isolation.

---

## Quick-reference: other likely questions (full answers in `docs/DEMO_DAY_6MIN_QA.md`)

| Question | One-line answer |
|---|---|
| Is Claude actually executing the task? | Yes, two separately-verified ways (mocked-SSH pipeline + real Claude CLI call) — deliberately not merged; explained if asked. |
| What happens when an agent fails? | Three distinct outcomes: honest failure, caught lie (false positive), or not-verified — never collapsed into one bucket. |
| How do you prevent unsafe operations? | Layered: dispatch-time risk gate, post-execution file-level gate, scoped/expiring approvals, fail-closed kill switch. |
| What would you improve next? | Git-history hygiene decision; the fully-combined real-Claude+SSH pipeline; OS-level sandboxing; graduating the trust engine beyond advisory once real history accumulates. |

---

## Final GO/NO-GO verdict

See `docs/DEMO_DAY_GO_NO_GO.md` for the full checklist. Summary: **GO**, pending a timed rehearsal on the actual presentation laptop (not yet performed) and your decision on the git-history exposure item.
