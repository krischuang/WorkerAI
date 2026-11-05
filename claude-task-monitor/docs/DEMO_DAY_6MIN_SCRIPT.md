# Demo Day 6-Minute Script — WorkerAI (optimized)

Target: **5:30 (330s) rehearsed, 6:00 (360s) hard ceiling** — 30s of
deliberate, unfilled buffer. Every segment below states exactly what's on
screen, what command runs, what evidence it produces, and the expected
result — nothing is left to improvisation.

**Design change from the earlier version**: the live centerpiece is no
longer `npm run demo:e2e` (measured today: 71s best case; a
re-verification run during this final hardening pass took 6:08 — it can
exceed the entire 6-minute slot on its own — too unpredictable for a hard
6-minute slot). The full SSH/tmux/policy/kill-switch orchestration is shown as
**authentic captured evidence** (`docs/DEMO_RUN_RECORD.md`, real output
from a real run earlier today, clearly labeled as captured, not live).
What runs live on stage are two **fast, consistently-timed** scripts:
`demo:validation` (~2s via `npm run`, reliable) and
`demo-evidence-preference.ts` (~31s via **direct bash invocation** — tested
successfully today; the `npm run` equivalent fails reliably on this
machine, a consistent ~5s connection-timeout from `npm run`'s own
process-spawning overhead, not a code defect — the same known issue
affecting `demo-adaptive-trust.ts` too. Always use the direct command,
never the npm script, for either):

```bash
set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts
```

See `docs/DEMO_DAY_ARCHITECTURE.md` for the diagram referenced in segment 2.

---

| # | Time | Screen | Action | Evidence produced | Expected result |
|---|---|---|---|---|---|
| 1 | 00:00–00:25 | Presenter, no screen | — | — | — |
| 2 | 00:25–00:50 | Architecture diagram (`DEMO_DAY_ARCHITECTURE.md`, pre-opened) | Point at the diagram | — | — |
| 3 | 00:50–01:50 | `docs/DEMO_RUN_RECORD.md`, pre-opened, scrolled to the `demo:e2e` section | Point at captured 13/13 assertion list — task orchestration (dispatch, real SSH, real tmux, real change) | Real captured output from a run earlier today — timestamp visible | All 13 lines read `[PASS]` |
| 4 | 01:50–02:55 | Terminal, `claude-task-monitor/` | Run `npm run demo:validation` | Real stdout: regression in `add.js`, agent self-report "passed", real `npm test` exit 1, `AssertionError: add(2,2) should be 4` | Script prints verdict: self-report PASSED, independent re-execution FAILED |
| 5 | 02:55–03:35 | Terminal | Run the **direct bash command** (not `npm run demo:evidence-preference` — see note below) — **~40s total, the evidence-preferred recommendation segment** | Real stdout: baseline picks `a_weak` (tie-break), evidence-preferred flips to `b_strong`, explanation names the real score gap | Printed comparison, `recommendationChanged: true`, ends with cleanup confirmation |
| 6 | 03:35–04:25 | Same `DEMO_RUN_RECORD.md` view | Point at the safety assertions (high-risk block, approval path, secret-file deny, kill switch) | Same captured record, different lines | All read `[PASS]` |
| 7 | 04:25–05:00 | Presenter, no screen (or the architecture diagram) | — | — | — |
| 8 | 05:00–05:30 | Presenter, no screen | — | — | — |
| — | 05:30–06:00 | — | **Buffer — do not script content into this time** | — | — |

---

## 1. Problem and hook (00:00–00:25, ~55 words)

"AI coding agents write good code, but they don't know when to stop, what
they're allowed to touch, or whether what they did actually worked. An
overconfident agent will happily say it passed when it didn't.

Today I'll show you one agent lying about a test result, caught live, by
actually re-running the test — not by trusting what it said."

## 2. Architecture (00:25–00:50, ~65 words)

"The pipeline: a task is created, a policy gate decides if it's allowed,
it dispatches over real SSH into a tmux session running Claude, Claude
makes a real change — and then, the part most agent frameworks skip,
WorkerAI independently re-runs the real test suite before calling it
done. That re-run decides completion, not the agent's own words. The
advisory layer on the right [point] never touches that decision path —
it only reads history after the fact."

## 3. Task orchestration, captured (00:50–01:50, ~90 words)

**Show:** `docs/DEMO_RUN_RECORD.md`

"Here's the full dispatch pipeline running end to end — real SSH, a real
disposable server, a real tmux session, a real code change. I captured a
run of this earlier today rather than risk a multi-minute live wait on
stage — here's the real output, timestamped, not edited. Thirteen real
assertions, all passing: the task dispatches, Claude makes a real change,
a lying agent on Task 2 gets caught — you'll see exactly how, live, in a
moment — and a third task that writes to a gitignored `.env` file gets
caught too — invisible to a plain `git status`, caught anyway."

## 4. Independent verification catches a lie (01:50–02:55, ~110 words, LIVE)

**Run:** `npm run demo:validation`

"Now watch that same catch happen live, in isolation: this script plants a
real regression — `add(2,2)` now returns the string `'22'` instead of the
number `4`. The simulated agent self-reports `result: passed` anyway,
exactly the format WorkerAI scans for in real task completions.

[let it run — ~2 seconds]

There it is: agent self-report, PASSED. Independent re-execution, FAILED
— real exit code 1, real assertion error: `add(2,2) should be 4`, `'22'
!== 4`. Fed through the actual completion gate, this flips the verdict
from 'completed' to 'failed', and generates a follow-up task carrying
this exact evidence. That's the core of WorkerAI: 'the agent said so' is
a claim; a real re-run is evidence."

## 5. Evidence-preferred recommendation — live (02:55–03:35, ~40s total, ~65 words, LIVE, narrated throughout the run)

**Run** (direct bash, not `npm run` — see note above):
`set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts`

(Upgraded from the earlier annotation-only demo: this one shows the
recommendation actually *change*, not just get a note attached — same
~31s real runtime, stronger evidence of the claim.)

**Say before starting** (~6s): "Can real evidence actually change a
recommendation — not just annotate one?"

**Start the command, then narrate while it runs** (~31s, say this
*during*, not after — the script takes almost exactly that long,
measured):

"Two agents, identical on health and load — the baseline scheduler picks
alphabetically. But look at real history: this one has two caught lies;
the other, five clean verified completions. The evidence layer catches
that gap."

**Once it finishes** (~3s): "Eighty-point gap — recommendation flips.
Still advisory only."

A deeper, 7-scenario reproducible version of this same comparison exists
at `scripts/adaptive-trust-evidence.ts` for judge follow-up questions —
not timed for live narration, but real, and runnable on request.

## 6. Safety, same captured record (03:35–04:25, ~75 words)

**Show:** `docs/DEMO_RUN_RECORD.md` (same tab, scroll to remaining assertions)

"Same captured run, the safety layer: a high-risk autonomous task is
blocked outright — no approval path at all. A human-created high-risk
task instead requires explicit approval — a different, real code path. A
secret-file edit is denied by policy. And the kill switch: activate it,
dispatch is refused immediately; deactivate it, normal operation resumes.
All enforced before or during dispatch, not logged after the fact."

## 7. Originality and real-world value (04:25–05:00, ~65 words)

"Plenty of tools make an agent write code. WorkerAI is different: it's an
evidence-driven control system that coordinates the work *and*
independently decides whether to trust it. Every completion carries a
named verification state, not a vibe. That reliability layer you just
watched is advisory only, by design — it can recommend, it can never
override a safety gate."

## 8. Conclusion (05:00–05:30, ~40 words)

"What you watched: a real lie, caught live, by actually re-running the
test. A real reliability signal, built from real history. And a full
pipeline, proven, not just claimed. That's WorkerAI — not just an agent
that writes code, but a system that tells you whether to believe it."

**[05:30–06:00 — buffer. If running early, pause; if running late, this
is where it's absorbed. Do not add scripted content here.]**

---

## Fallback cue

If `demo:validation` or `demo-evidence-preference.ts` fails or hangs unexpectedly
(not observed in rehearsal, but): say "I have a captured run of exactly
this from earlier today," switch to `docs/DEMO_RUN_RECORD.md`'s matching
section, state plainly it's a prior run, not live. See
`docs/DEMO_DAY_6MIN_RUNBOOK.md` for the full recovery procedure.
