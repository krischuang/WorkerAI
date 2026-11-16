# Demo Day 6-Minute Runbook — WorkerAI (browser-first, interactive)

Companion to `docs/DEMO_DAY_6MIN_SCRIPT.md`. Run this exactly, in order,
every rehearsal and on the day.

**Design note (2026-11-06)**: a 4-slide deck (`WorkerAI_Demo_Day_2026_Web_Showcase.pptx`,
in Downloads) opens and closes the talk. The middle is a single interactive
browser page, `/demo-day`. It no longer renders on load — it opens on a
**"Run This Task" button** over a real, live-read task card. Pressing it
plays a ~5.5s staged dispatch→verify feed (a replay of this task's real
captured timeline — a live SSH/tmux/Claude run takes 70s–6min, too
unpredictable for a hard slot), then unlocks the step-by-step evidence
below, auto-scrolled to Section 1. Everything the button unlocks is still
read live through real, already-tested application APIs, backed by a
persistent, clearly labeled SYNTHETIC fixture (`scripts/seed-demo-day.ts`)
— seeded (and re-verified) by `npm run demo:preflight` before the talk.
The full Docker E2E run and the two terminal demo scripts (`demo:validation`,
`demo-evidence-preference.ts`) are **not part of the live flow** — judge
follow-up material only (§6).

## 1. Startup commands (morning of, on the real presentation laptop)

```bash
cd claude-task-monitor
npm install
npm run lint && npx tsc --noEmit && npx vitest run && npm run build
npm run dev   # separate terminal/pane, leave running
set -a; source .env.local; set +a; npm run demo:preflight
```

`demo:preflight` runs the full environment check (`demo:precheck`), seeds
the `/demo-day` fixture (idempotent — safe to re-run), and then calls the
exact four APIs the page's Run button unlocks, checking both HTTP status
and the specific values the script assumes (0/100 vs 100/100 reliability,
recommendation flip, all 4 Safety & Audit assertions present) — it must
print `READY` before you open the page. If it prints `NOT READY`, fix
every `[FAIL]` line it lists and re-run it; do not open `/demo-day` or go
live until it's green.

Then open `http://localhost:3000/demo-day`, log in, and confirm the
**"Ready to dispatch"** card renders with the real task title (not
"fixtures not found"). **Do not press Run This Task during this check** —
leave it unclicked so the page is in its opening state when you walk on
stage. If you do press it while testing, just refresh the page before
going live; nothing is mutated server-side, it only resets client state.

**Close every other heavy process before going live** (other builds, other
dev servers, video calls, etc.).

## 2. Required local services

| Service | Check |
|---|---|
| `workerai-baseline-db` Postgres container | `docker ps \| grep workerai-baseline-db` — `/demo-day` reads real rows from it |
| `.env.local` → `DATABASE_URL` on port 5432 | `npm run demo:precheck` |
| Prisma migrations current | `npm run demo:precheck` (checks this) |
| Next.js dev server | `npm run dev`, confirm `http://localhost:3000/demo-day` loads |
| Docker daemon | Only needed if a judge asks for the full E2E evidence re-run (§6d) — not needed for the live flow |
| Wi-Fi / network | **Not required** — everything runs locally |

## 3. Windows, in opening order

1. **The slide deck** (Keynote/PowerPoint), slide 1 up, presenter view if
   you use one.
2. **`/demo-day`**, already logged in, in its unclicked "Ready to dispatch"
   state. Keep this tab ready to alt-tab/switch into at ~0:50.

`docs/DEMO_RUN_RECORD.md` is not opened during the live flow — keep it
available only as the fallback if `/demo-day` itself fails (§5).

Do not have any tab open to the GitHub repository page, `git log`, or any
terminal with prior command history visible — nothing about the git
history exposure item should be on screen.

## 4. Exact demo actions and expected output

| Time | Screen | Action | Expected output |
|---|---|---|---|
| 00:00 | Slide 1 | Speak the hook | — |
| 00:20 | Slide 2 | Speak the architecture beat | — |
| 00:50 | Slide 3 → `/demo-day` | Switch windows | "Ready to dispatch" card, task title visible, Run button idle |
| 00:50 | `/demo-day` | Press **▶ Run This Task** | Feed streams 7 lines over ~5.5s, ending `✓ verification complete`; page auto-scrolls to Section 1 |
| 01:50 | `/demo-day` | Click step **2 Verification** | Large AGENT CLAIM "SUCCESS" vs INDEPENDENT VALIDATION "FAILED" (red), verified-mismatch text, verification timeline with real `AuditEvent` rows |
| 02:50 | `/demo-day` | Click step **3 Reliability Evidence**, then step **4 Agent Recommendation** | Reliability cards: baseline agent 0/100 (n=3, 3 caught lies), alternative agent 100/100 (n=5); Recommendation: BASELINE vs EVIDENCE-PREFERRED flips (amber highlight) |
| 03:30 | `/demo-day` | Click step **5 Safety & Audit** | 4 assertions render: high-risk autonomous BLOCKED, high-risk human APPROVAL REQUIRED, secret-file edit DENIED, kill switch DISPATCH REFUSED |
| 04:15 | Slide 4 | Switch back, speak the close | — |
| 05:20 | — | **Buffer — stop talking, let it be silence** | — |

## 5. Recovery actions if a live segment fails

- **`/demo-day` shows "Demo Day fixtures not found":** this should already
  have been caught by `npm run demo:preflight` (§1) before you went live.
  Do not attempt to seed live on stage. Say "let me show you a captured
  version of this," switch to `docs/DEMO_RUN_RECORD.md` for the remainder
  of the talk, and narrate from there.
- **The Run button's feed starts but Section 1 never appears:** this is a
  client-side animation, not a network call — a refresh resets it to the
  opening state. Refresh once, press Run again. If it still fails, switch
  to `DEMO_RUN_RECORD.md` — do not debug live.
- **A section shows a loading spinner that never resolves:** the dev
  server or Postgres container may have stopped. Refresh once. If it still
  fails, switch to `DEMO_RUN_RECORD.md` — do not debug live.
- **Numbers on screen don't match what you expect to say** (e.g. the
  reliability gap isn't what you rehearsed): re-check against this
  runbook's §4 expected-output column before the talk, not during it — if
  they still don't match on stage, narrate what's actually on screen
  rather than describing a number that isn't there.
- **General rule:** one fallback switch, stated plainly, is a normal part
  of a live technical demo. Don't apologize more than once; keep going.

## 6. Judge follow-up material (not part of the timed flow)

### 6a. Deeper look at the live page's own data
The `/demo-day` page has its own collapsible **"Technical evidence"**
drawer at the bottom (visible after pressing Run) — click it to show the
raw JSON from all four real API calls for a judge who wants to see the
actual data, not just the formatted view.

### 6b. "Does the recommendation ever actually change — can I see another example?"
```bash
set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts
```
~31s, not `npm run demo:evidence-preference` (fails reliably on this
machine — a process-spawning/connection-timeout issue, documented in the
script's own header).

### 6c. "What about more scenarios — ties, infra failures, policy blocks?"
```bash
set -a; source .env.local; set +a; npx tsx scripts/adaptive-trust-evidence.ts
```
Runs the same real functions across 7 labeled scenarios.

### 6d. "Can I see the full orchestration pipeline run live?"
`npm run demo:e2e` — measured 71s–6:08 on this machine, too unpredictable
for the timed segment. Offer `docs/DEMO_RUN_RECORD.md` first; only run it
live if a judge specifically wants to watch it after the formal
presentation.

## 7. Final closing statement

Use the script's 04:15–05:20 text verbatim or close to it:

"So — who checks the work? WorkerAI does... WorkerAI: not just an agent
that writes code — a system that tells you whether to believe it, and
shows its work."

Then stop talking. Let 05:20–06:00 be silence, not filler.

## 8. No live credentials or private server details

- Never run `env | grep`, open `~/.claude.json`, or show terminal history
  from before the demo started.
- `/demo-day`'s fixture (`scripts/seed-demo-day.ts`), the Run button's feed,
  and both terminal follow-up scripts are entirely local and
  synthetic/disposable — no real credentials or infrastructure involved.
  The "Technical evidence" drawer's raw JSON was inspected for secrets —
  none present (host shown is a placeholder `127.0.0.1`, no keys, no
  cookies).
- Do not open the GitHub repository page — see the git-history exposure
  item in the final risk report.

## 9. Teardown (after the talk, not before)

```bash
set -a; source .env.local; set +a; npx tsx scripts/seed-demo-day.ts --cleanup
```
Removes the persistent `/demo-day` fixture. Not required before Demo Day
itself — the fixture is meant to persist for the live presentation.
