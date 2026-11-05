# Demo Day 6-Minute Script — WorkerAI (browser-first)

Target: **5:30 (330s) rehearsed, 6:00 (360s) hard ceiling** — 30s of
deliberate, unfilled buffer.

**Design change (2026-11-05)**: the presentation now centers on a single
browser page, `/demo-day`, instead of a terminal. The browser is the
primary interface; terminal output only appears in that page's own
collapsible "Technical evidence" drawer, for judges who ask to see it.
Every number on `/demo-day` is read live, through real, already-tested
application APIs (`GET /api/tasks/[id]`, `GET /api/audit`,
`GET /api/agents/[id]/compare`) — not re-run on stage, not hardcoded. The
underlying rows are a persistent, clearly-labeled SYNTHETIC fixture (see
`scripts/seed-demo-day.ts`) — the same architecture principle as every
other demo in this project: real logic, real reads, labeled synthetic data.

**Update (2026-11-05)**: the Safety segment no longer switches to
`docs/DEMO_RUN_RECORD.md`. `/demo-day` now has a 5th step, **Safety &
Audit**, which reads the same four assertions live through
`GET /api/audit?entityType=task&entityId=_demo_day_safety` — no tab switch,
no markdown on screen during the live flow. `DEMO_RUN_RECORD.md` remains
the source-of-truth capture and the fallback if `/demo-day` itself fails
(see the Fallback cue at the bottom).

The full Docker E2E orchestration run is **not** part of the live
presentation (measured up to 6+ minutes on this machine — see
`docs/DEMO_RUN_RECORD.md` for the captured evidence instead).

**Pre-flight (once, before doors open):**
```bash
npm run dev   # separate terminal, leave running
set -a; source .env.local; set +a; npm run demo:preflight
```
`demo:preflight` checks the environment, seeds/re-seeds the fixture
(idempotent), and verifies the exact three API calls and values `/demo-day`
depends on — including the Safety & Audit assertions — before you ever
open the page. Only open `http://localhost:3000/demo-day` once it prints
`READY`. No second tab is needed anymore — see the design update above.

---

| # | Time | Screen | Action |
|---|---|---|---|
| 1 | 00:00–00:50 | Presenter / `/demo-day` top (already loaded) | Problem statement; point at the page header and synthetic-data banner |
| 2 | 00:50–01:50 | `/demo-day` | Click step **1 Task** — Section 1, Task Execution |
| 3 | 01:50–02:55 | `/demo-day` | Click step **2 Verification** — Section 2, Independent Verification |
| 4 | 02:55–03:35 | `/demo-day` | Click steps **3 Reliability Evidence** then **4 Agent Recommendation** — Section 3, Adaptive Trust |
| 5 | 03:35–04:25 | `/demo-day` | Click step **5 Safety & Audit** — live safety assertions |
| 6 | 04:25–05:30 | Presenter, no screen (or back to `/demo-day` top) | Business value and conclusion |
| — | 05:30–06:00 | — | **Buffer — do not script content into this time** |

---

## 1. Problem and architecture (00:00–00:50, ~104 words)

**Screen:** `/demo-day`, already loaded, scrolled to the top.

"AI coding agents write good code, but they don't know when to stop, what
they're allowed to touch, or whether what they did actually worked. An
overconfident agent will happily say it passed when it didn't.

This is WorkerAI — a task is created, a policy gate decides if it's
allowed, it dispatches over real SSH into a tmux session running Claude,
and then — the part most agent frameworks skip — WorkerAI independently
re-runs the real test suite before calling it done. Everything you'll see
for the next few minutes is read live out of the real application, right
here in the browser."

## 2. Task orchestration evidence (00:50–01:50, ~82 words, LIVE)

**Click:** step **1 Task**.

"Here's a real task: add a `subtract()` function, assigned to an agent.
Status, assigned agent, project — all read live from the real task API.
The dispatch itself — the actual SSH connection, the tmux session, the
Claude invocation — is shown as captured evidence rather than re-run live
on stage; a full run takes anywhere from 70 seconds to 6 minutes, too
unpredictable for a hard slot. What's live here is a real database read
of this task's actual stored result."

## 3. Visual independent verification (01:50–02:55, ~90 words)

**Click:** step **2 Verification**.

"The agent's own completion report says SUCCESS. Independent validation —
WorkerAI actually re-running the real test suite against the agent's own
workspace, not trusting its word — says FAILED. Real exit code, real
assertion error, right there in the mismatch.

That's the entire thesis of this project: 'the agent said so' is a claim;
a real re-run is evidence. And below it — the verification timeline — is
the actual audit trail, the same `AuditEvent` rows the rest of the system
reads, not a log formatted to look convincing."

## 4. Evidence-preferred recommendation (02:55–03:35, ~71 words)

**Click:** step **3 Reliability Evidence**, then step **4 Agent Recommendation**.

"Two agents. One of them — the one that just lied — has a real reliability
score, computed from real independently-verified history, not a vibe:
zero out of a hundred. The other: a clean hundred. The baseline scheduler
would still pick alphabetically, ignoring that gap entirely. This
evidence-preference layer catches it and flips the recommendation — but
notice the badge: advisory only. It can recommend. It can never override
real dispatch."

## 5. Safety and audit evidence (03:35–04:25, ~75 words)

**Click:** step **5 Safety & Audit**.

"One more layer, read live right here, same database, same code paths: a
high-risk autonomous task gets blocked outright — no approval path at all.
A human-created high-risk task instead requires explicit approval — a
different, real code path. A secret-file edit is denied by policy. And the
kill switch: activate it, dispatch is refused immediately; deactivate it,
normal operation resumes. All enforced before or during dispatch, not
logged after the fact."

## 6. Business value and conclusion (04:25–05:30, ~106 words)

**Screen:** presenter, no screen (or back to `/demo-day`'s top).

"Plenty of tools make an agent write code. WorkerAI is different: it's an
evidence-driven control system that coordinates the work *and*
independently decides whether to trust it — and now, shows you that
evidence in a real product UI, not a terminal transcript. Every completion
carries a named verification state. Every reliability number traces back
to real, independently-verified history. The recommendation layer you just
watched is advisory only, by design — it can surface evidence, it can
never bypass a safety gate.

That's WorkerAI: not just an agent that writes code, but a system that
tells you whether to believe it — and shows its work."

**[05:30–06:00 — buffer. If running early, pause; if running late, this
is where it's absorbed. Do not add scripted content here.]**

---

## Fallback cue

If `/demo-day` fails to load or shows "fixtures not found" (should not
happen if `npm run demo:preflight` printed `READY`): say "let me show you
the captured version of this," switch straight to
`docs/DEMO_RUN_RECORD.md` for the whole remainder of the talk, and narrate
from there. Do not attempt to debug or re-seed live. See
`docs/DEMO_DAY_6MIN_RUNBOOK.md` for the full recovery procedure.
