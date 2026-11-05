# Demo Day Script — WorkerAI

Target: 4 minutes (240s) **total, including the live command's real run
time** — measured today at **71s** for `npm run demo:e2e` on this machine
(three consecutive clean local runs, 13/13 PASS each time). Budget below
reserves 75s for it. Natural spoken English — read through once before the
day, don't recite verbatim.

Four things this script must land, explicitly: **autonomous agent
orchestration**, **independent verification**, **detection of false AI
success**, and **safety/approval controls**. Each is called out below.

Core story: *AI agents can generate code, but WorkerAI goes further by
coordinating execution, enforcing policies, and independently verifying
results.*

---

## A. Problem (18s, ~45 words)

"AI coding agents write good code, but they don't know when to stop, what
they're allowed to touch, or whether what they did actually worked.
Unsupervised, the only evidence you get is what the agent typed.

WorkerAI runs AI coding agents on real servers [**orchestration**]. The
question isn't 'can it write code' — it's: can you trust what it reports,
and can you stop it before it does something dangerous?"

## B. Architecture (17s, ~45 words)

"The pipeline [**orchestration**]: a task is created, WorkerAI picks a
server or agent, a policy check decides if that's allowed, the task
dispatches over SSH into a tmux session running Claude, Claude makes real
changes to a real repo — and then WorkerAI independently re-runs the real
lint, typecheck, test, and build commands before calling it done
[**independent verification**]."

## C. Live execution (start the command here — runs ~75s)

Run: `npm run demo:e2e`

**Say this, then let it run** (~15 words — don't fill all 75s with talk,
let the output speak):

"Real pipeline, not a mock — real Postgres, real SSH into a disposable
container, a real tmux session."

**While it runs**, point at lines as they appear; narrate briefly, e.g.
"there's the dispatch" / "there's the independent re-run — lint, typecheck,
test, build, against the agent's own workspace, not trusted from what it
printed" [**independent verification**].

**Once finished** (~30s, ~75 words) — point at Task 2 (`[LYING_AGENT]`):

"That agent self-reported 'passed.' WorkerAI re-ran the real test suite
anyway — it failed for real, so the task does not complete, no matter what
the agent said [**detection of false AI success**]. That's the difference
between 'Claude says it passed' and 'WorkerAI independently verified it.'
One is a claim. The other is evidence."

## D. Safety (40s, ~95 words)

Point at the remaining assertions on the same finished output — no more
waiting:

"A high-risk autonomous task is blocked outright — no approval path at
all. A human-created high-risk task requires explicit approval instead. A
secret-file edit, like writing to a gitignored `.env`, is denied even
though plain `git status` would never show it. And the kill switch: flip
it on, dispatch is refused immediately; flip it off, normal operation
resumes [**safety / approval controls**]. All enforced before or during
dispatch, not logged after."

## E. Final result (15s, ~40 words)

"What you watched: a real task, dispatched over real SSH, independently
verified rather than trusted, with a full audit trail. The verdict is a
specific, named state — independently verified, not merely
agent-reported."

---

**Running total: ~18+17+75+30+40+15 ≈ 195s of a 240s budget — ~45s of
margin for pauses, a slow container pull, or a question.**

## Fallback cue

If live execution fails or runs long: "I have a captured run of exactly
this from earlier today" — switch to `docs/DEMO_RUN_RECORD.md` and
`docs/DEMO_DAY_BACKUP_PLAN.md`. State plainly it's a prior run, not live —
never present it as live.
