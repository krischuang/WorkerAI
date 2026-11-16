# Demo Day 6-Minute Runbook — WorkerAI (browser-first)

Companion to `docs/DEMO_DAY_6MIN_SCRIPT.md`. Run this exactly, in order,
every rehearsal and on the day.

**Design note (2026-11-05)**: the live centerpiece is now a single browser
page, `/demo-day`, not a terminal. Every value on it is read live through
real, already-tested application APIs, backed by a persistent, clearly
labeled SYNTHETIC fixture (`scripts/seed-demo-day.ts`) — seeded (and
re-verified) by `npm run demo:preflight` before the talk; it is not
re-seeded live and does not auto-clean up (it must persist for the page to
show anything). The full Docker E2E run and the two terminal demo scripts
(`demo:validation`, `demo-evidence-preference.ts`) are **not part of the
live flow anymore** — they remain available as judge-follow-up material
only (§6). The Safety segment also moved into `/demo-day` itself (step 5,
"Safety & Audit") — no second browser tab is required during the live
flow anymore.

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
exact four APIs the page uses, checking both HTTP status and the specific
values the script assumes (0/100 vs 100/100 reliability, recommendation
flip, all 4 Safety & Audit assertions present) — it must print `READY`
before you open the page. If it prints `NOT READY`, fix every `[FAIL]`
line it lists and re-run it; do not open `/demo-day` or go live until it's
green. If any startup step fails, stop and fix it — do not discover a
broken environment for the first time on stage.

Then open `http://localhost:3000/demo-day`, log in, and confirm all five
sections render with real numbers (not "fixtures not found") as a final
visual check.

**Close every other heavy process before going live** (other builds, other
dev servers, video calls, etc.).

## 2. Required local services

| Service | Check |
|---|---|
| `workerai-baseline-db` Postgres container | `docker ps \| grep workerai-baseline-db` — `/demo-day` reads real rows from it |
| `.env.local` → `DATABASE_URL` on port 5432 | `npm run demo:precheck` |
| Prisma migrations current | `npm run demo:precheck` (checks this) |
| Next.js dev server | `npm run dev`, confirm `http://localhost:3000/demo-day` loads |
| Docker daemon | Only needed if a judge asks for the full E2E evidence re-run (§6c) — not needed for the live flow |
| Wi-Fi / network | **Not required** — everything runs locally |

## 3. Browser tabs / windows, in opening order

1. **`/demo-day`**, already logged in, scrolled to the top, all five
   sections confirmed rendering with real data (including step 5, Safety
   & Audit). This is the only tab needed — it stays open for the entire
   talk.

`docs/DEMO_RUN_RECORD.md` is no longer opened during the live flow; keep
it available only as the fallback if `/demo-day` itself fails (§5).

Do not have any tab open to the GitHub repository page, `git log`, or any
terminal with prior command history visible — nothing about the git
history exposure item should be on screen.

## 4. Exact demo actions and expected output

| Time | Screen | Action | Expected output |
|---|---|---|---|
| 00:00 | Presenter / `/demo-day` top | Speak, point at the header and synthetic-data banner | — |
| 00:50 | `/demo-day` | Click step **1 Task** | Section 1 scrolls into view: real task title, agent, status, "Orchestration Evidence: Captured" |
| 01:50 | `/demo-day` | Click step **2 Verification** | Section 2: large AGENT CLAIM "SUCCESS" vs INDEPENDENT VALIDATION "FAILED" (red), verified-mismatch text, verification timeline with real `AuditEvent` rows |
| 02:55 | `/demo-day` | Click step **3 Reliability Evidence**, then step **4 Agent Recommendation** | Reliability cards: baseline agent 0/100 (n=3, 3 caught lies), alternative agent 100/100 (n=5); Recommendation: BASELINE vs EVIDENCE-PREFERRED flips (amber highlight), WHY explanation citing the real 100-point gap |
| 03:35 | `/demo-day` | Click step **5 Safety & Audit** | 4 assertions render: high-risk autonomous BLOCKED, high-risk human APPROVAL REQUIRED, secret-file edit DENIED, kill switch DISPATCH REFUSED |
| 04:25 | Presenter | Speak, no screen (or back to `/demo-day` top) | — |
| 05:30 | — | **Buffer — stop talking, let it be silence** | — |

## 5. Recovery actions if a live segment fails

- **`/demo-day` shows "Demo Day fixtures not found":** this should already
  have been caught by `npm run demo:preflight` (§1) before you went live —
  it was not run, or the database was reset after it ran. Do not attempt
  to seed live on stage. Say "let me show you a captured version of this,"
  switch to `docs/DEMO_RUN_RECORD.md` for the remainder of the talk, and
  narrate from there.
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
drawer at the bottom — click it to show the raw JSON from all four real
API calls (`GET /api/tasks/...`, `GET /api/audit` for the task, the
reliability `GET /api/agents/.../compare`, and `GET /api/audit` for the
Safety & Audit assertions) for a judge who wants to see the actual data,
not just the formatted view. This is the primary "terminal output in
an optional drawer" surface — prefer it over opening an actual terminal.

### 6b. "Does the recommendation ever actually change — can I see another example?"
Run the direct-bash evidence-preference script (separate fixture from
`/demo-day`'s, same underlying function):
```bash
set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts
```
~31s, not `npm run demo:evidence-preference` (fails reliably on this
machine — a `npm run` process-spawning/connection-timeout issue, not a
code defect, documented in the script's own header).

### 6c. "What about more scenarios — ties, infra failures, policy blocks?"
```bash
set -a; source .env.local; set +a; npx tsx scripts/adaptive-trust-evidence.ts
```
Runs the same real functions across 7 labeled scenarios. Note:
`getAdvisoryRecommendation` (what this script exercises) only *annotates*
the baseline pick — it never changes it. For "does it ever actually
change," use §6b instead.

### 6d. "Can I see the full orchestration pipeline run live?"
`npm run demo:e2e` — measured 71s–6:08 on this machine, too unpredictable
for the timed segment. Offer the captured record
(`docs/DEMO_RUN_RECORD.md`) first; only run it live if the judge
specifically wants to watch it and there's time after the formal
presentation.

## 7. Final closing statement

Use the script's 04:25–05:30 text verbatim or close to it:

"Plenty of tools make an agent write code. WorkerAI is different... That's
WorkerAI: not just an agent that writes code, but a system that tells you
whether to believe it — and shows its work."

Then stop talking. Let 05:30–06:00 be silence, not filler.

## 8. No live credentials or private server details

- Never run `env | grep`, open `~/.claude.json`, or show terminal history
  from before the demo started.
- `/demo-day`'s fixture (`scripts/seed-demo-day.ts`) and both terminal
  follow-up scripts are entirely local and synthetic/disposable — no real
  credentials or infrastructure involved in any of them. The
  "Technical evidence" drawer's raw JSON was inspected for secrets before
  this runbook was written — none present (host shown is a placeholder
  `127.0.0.1`, no keys, no cookies).
- Do not open the GitHub repository page — see the git-history exposure
  item in the final risk report.

## 9. Teardown (after the talk, not before)

```bash
set -a; source .env.local; set +a; npx tsx scripts/seed-demo-day.ts --cleanup
```
Removes the persistent `/demo-day` fixture. Not required before Demo Day
itself — the fixture is meant to persist for the live presentation.
