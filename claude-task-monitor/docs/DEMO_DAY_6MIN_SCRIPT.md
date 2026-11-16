# Demo Day 6-Minute Script — WorkerAI (browser-first, interactive)

Target: **5:20 (320s) rehearsed, 6:00 (360s) hard ceiling** — 40s of
deliberate, unfilled buffer.

**Design (2026-11-06)**: a 4-slide deck opens and closes the talk; the
middle is a single interactive browser page, `/demo-day`. The page no
longer renders its results on load — it opens on a **"Run This Task"**
button over a real, live-read task card. Pressing it plays a ~5.5s staged
dispatch→verify feed (a replay of this exact task's real captured
timeline — a live SSH/tmux/Claude run takes 70s–6min, too unpredictable
for a hard slot), then unlocks the step-by-step evidence below — all of
which is still read live through real, already-tested application APIs
(`GET /api/tasks/[id]`, `GET /api/audit`, `GET /api/agents/[id]/compare`).
The underlying rows are a persistent, clearly-labeled SYNTHETIC fixture
(see `scripts/seed-demo-day.ts`).

The full Docker E2E orchestration run is **not** part of the live
presentation — see `docs/DEMO_RUN_RECORD.md` for the captured evidence.

**Pre-flight (once, before doors open):**
```bash
npm run dev   # separate terminal, leave running
set -a; source .env.local; set +a; npm run demo:preflight
```
`demo:preflight` checks the environment, re-seeds the fixture (idempotent),
and verifies the exact API values `/demo-day` depends on — including the
0/100 vs 100/100 reliability flip and all 4 Safety & Audit assertions —
before you ever open the page. Only open `http://localhost:3000/demo-day`
once it prints `READY`, and **do not click "Run This Task" during
rehearsal-only checks** — leave the page unclicked so it's in its opening
state when you walk on stage.

---

| # | Time | Screen | Action |
|---|---|---|---|
| 1 | 00:00–00:20 | Slide 1 | Hook — who checks the work? |
| 2 | 00:20–00:50 | Slide 2 | One workflow, four stages |
| 3 | ~00:50 | Slide 3 → switch to `/demo-day` | "Let's not just talk about it." |
| 4 | 00:50–01:50 | `/demo-day` | Press **▶ Run This Task**, watch the feed, read Section 1 |
| 5 | 01:50–02:50 | `/demo-day` | Click step **2 Verification** |
| 6 | 02:50–03:30 | `/demo-day` | Click steps **3 Reliability Evidence** then **4 Agent Recommendation** |
| 7 | 03:30–04:15 | `/demo-day` | Click step **5 Safety & Audit** |
| 8 | 04:15–05:20 | Slide 4 | Close |
| — | 05:20–06:00 | — | **Buffer — do not script content into this time** |

---

## 1. Hook (00:00–00:20, ~40 words)

**Screen:** Slide 1.

"AI agents write code fast. The problem isn't speed — it's trust. An
overconfident agent will tell you 'done' whether it's true or not. So:
who actually checks the work?"

## 2. Architecture (00:20–00:50, ~70 words)

**Click to Slide 2.**

"Meet WorkerAI. One workflow, four stages: orchestrate the work; authorise
it through real risk gates and a kill switch; execute it over real SSH,
inside a real tmux session, running real Claude Code; and verify —
independently re-run the result instead of just trusting what the agent
says. Every verified outcome becomes an audit trail, feeding a fully
advisory trust layer that learns from it — without ever taking the wheel."

## 3. Transition (~00:50, ~8 words)

**Click to Slide 3, then switch to the already-open `/demo-day` tab.**

"Let's not just talk about it — let's run one."

## 4. Run it live (00:50–01:50, ~60 words, INTERACTIVE)

**Screen:** `/demo-day`, opening state — the "Ready to dispatch" card.

"This is a real task, sitting in the real database right now: add a
`subtract()` function, assigned to one of our agents."

**Press the ▶ Run This Task button.** Let the feed play — don't talk over
it, let the room read it: policy gate → SSH → tmux → Claude running →
*"agent reports: SUCCESS."*

"Dispatched, ran, and reported back. Agent says success. Let's not take
its word for it."

The page auto-scrolls to Section 1 once the feed finishes — point at the
task card (status, assigned agent, "Orchestration Evidence: Captured")
while it settles.

## 5. Independent verification (01:50–02:50, ~90 words)

**Click:** step **2 Verification**.

"WorkerAI doesn't just log that claim — it independently re-runs the real
test suite, against the agent's own workspace. And there it is: the agent
said SUCCESS. Independent verification says FAILED. Real exit code, real
assertion error, right there in the mismatch.

That's the whole thesis of this product: 'the agent said so' is a claim.
A re-run is evidence. And right below — that's not a curated log, that's
the real audit trail, the same rows the rest of the system reads."

## 6. Evidence-preferred recommendation (02:50–03:30, ~75 words)

**Click:** step **3 Reliability Evidence**, then step **4 Agent Recommendation**.

"Now zoom out. This agent that just lied to us — its real,
independently-verified track record is zero out of a hundred. The other
agent on the team: a clean hundred. A naive scheduler would still pick
alphabetically and miss that completely. WorkerAI's evidence layer catches
it, and flips the recommendation. But look at the badge: advisory only.
It can speak up. It can never take control."

## 7. Safety and audit evidence (03:30–04:15, ~80 words)

**Click:** step **5 Safety & Audit**.

"One more layer, same database, same real code paths. A high-risk
autonomous task? Blocked outright. The same risk, but human-created? Held
for approval instead — a genuinely different path. Touch a secret file?
Denied by policy before it ever reaches disk. And the kill switch: flip it
on, every dispatch stops immediately. All of this enforced before anything
runs — not written up afterward."

## 8. Close (04:15–05:20, ~85 words)

**Switch back to Slide 4.**

"So — who checks the work? WorkerAI does. Not with a vibe — with
evidence: it proves what happened, controls what's allowed, and improves
its own recommendations from real history. You just watched it catch a
lying agent, live, in under a minute.

That's the move from AI execution to accountable engineering. WorkerAI:
not just an agent that writes code — a system that tells you whether to
believe it, and shows its work."

**[05:20–06:00 — buffer. If running early, pause; if running late, this
is where it's absorbed. Do not add scripted content here.]**

---

## Fallback cue

If `/demo-day` fails to load, shows "fixtures not found", or the Run
button's feed hangs (should not happen if `npm run demo:preflight` printed
`READY`): say "let me show you the captured version of this," switch
straight to `docs/DEMO_RUN_RECORD.md` for the whole remainder of the talk,
and narrate from there. Do not attempt to debug, re-seed, or re-click Run
live. See `docs/DEMO_DAY_6MIN_RUNBOOK.md` for the full recovery procedure.
