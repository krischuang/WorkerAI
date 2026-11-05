# Demo Day 6-Minute Runbook — WorkerAI (optimized)

Companion to `docs/DEMO_DAY_6MIN_SCRIPT.md`. Run this exactly, in order,
every rehearsal and on the day.

**Design note**: this runbook no longer runs `npm run demo:e2e` live.
Measured today: 71s best case, and a re-verification run during this
final hardening pass took 6:08 — i.e. it can exceed the entire 6-minute
slot on its own, not just come close to it — too unpredictable for a
hard 6-minute slot. The live centerpiece is now
two fast, consistently-timed scripts: `npm run demo:validation` (~2s,
reliable via `npm run`) and `scripts/demo-evidence-preference.ts` (~31s,
but **must be run via the direct bash command below, not `npm run
demo:evidence-preference`** — tested successful via direct invocation
today; the npm-script form fails reliably with a ~5s connection-timeout
from `npm run`'s own process-spawning overhead on this machine, not a
code defect — same known issue as `demo-adaptive-trust.ts`). The full
orchestration pipeline is shown as authentic captured evidence
(`docs/DEMO_RUN_RECORD.md`). `demo:e2e` is still run once during
pre-flight (§1) to confirm the environment, just not live on stage.

## 1. Startup commands (morning of, on the real presentation laptop)

```bash
cd claude-task-monitor
npm install
npm run lint && npx tsc --noEmit && npx vitest run && npm run build
npm run demo:precheck
npm run demo:e2e          # pre-flight only — confirms 13/13 on THIS machine, not run live
npm run demo:validation   # the actual live segment-3 command — confirm it works here first
bash -c 'set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts'   # live segment-5 command
```

If any step fails, stop and fix it before rehearsing further — do not
discover a broken environment for the first time on stage.

**Close every other heavy process before going live** (other builds,
other dev servers, video calls, etc.) — general good practice, though the
two live commands above are fast enough that this matters far less than
it did when `demo:e2e` was the live centerpiece.

## 2. Required local services

| Service | Check |
|---|---|
| Docker daemon | `docker info` — only needed for pre-flight `demo:e2e`, not for the live segments |
| `workerai-baseline-db` Postgres container | `docker ps \| grep workerai-baseline-db` — required for `demo:evidence-preference` (it reads/writes real rows) |
| `.env.local` → `DATABASE_URL` on port 5432 | `npm run demo:precheck` |
| Prisma migrations current | `npm run demo:precheck` (checks this) |
| Wi-Fi / network | **Not required** for any live segment — everything runs locally |

## 3. Browser tabs / windows, in opening order

1. **Terminal** — full-screen or large font, ready at `claude-task-monitor/`, nothing else visible (clear scrollback / `clear` first — no leftover command history that might show a path or token).
2. `docs/DEMO_DAY_ARCHITECTURE.md` open, scrolled to the diagram — for segment 2.
3. `docs/DEMO_RUN_RECORD.md` open, with the `demo:e2e` 13/13 assertion list and the safety-assertion lines both easy to scroll to — for segments 3 and 6.
4. *(Optional, stretch — see §6)* A browser tab logged in, parked on `/tasks`, not yet opened to a specific task.

Do not have any tab open to the GitHub repository page or `git log` — see
the git-history exposure note in the final risk report; nothing about
that should be visible during the demo.

## 4. Exact demo actions and expected output

| Time | Screen | Action | Expected output |
|---|---|---|---|
| 00:00 | Presenter | Speak, no screen | — |
| 00:25 | `DEMO_DAY_ARCHITECTURE.md` | Point at diagram | — |
| 00:50 | `DEMO_RUN_RECORD.md` | Scroll to the 13-assertion list — task orchestration evidence | All 13 lines read `[PASS]`, timestamp visible |
| 01:50 | Terminal | Run `npm run demo:validation` | Completes in ~2s: agent self-report PASSED, independent re-execution FAILED, `add(2,2) should be 4` / `'22' !== 4` |
| 02:50 | Terminal | Run the **direct bash command** (`set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts`) — **not** `npm run demo:evidence-preference`, which fails reliably on this machine | Completes in ~31s: baseline picks `a_weak`, evidence-preferred flips to `b_strong`, real 80-point gap cited |
| 03:40 | `DEMO_RUN_RECORD.md` | Scroll to the safety assertions (high-risk block, approval, secret-file deny, kill switch) | All read `[PASS]` |
| 04:25 | Presenter | Speak, no screen | — |
| 05:00 | Presenter | Speak, no screen | — |
| 05:30 | — | **Buffer — stop talking, let it be silence** | — |

## 5. Recovery actions if a live segment fails

- **`demo:validation` fails or errors:** this is a ~2s script with no
  Docker/network dependency — a failure here would be unusual. Say "let
  me show you a captured run of this instead," switch to
  `DEMO_RUN_RECORD.md`'s "independent validation run record" section.
- **Evidence-preference script fails or hangs:** this should not happen if
  using the direct bash command (§4) — it succeeded in testing today,
  including a repeat run minutes before this document was last updated. If
  you accidentally ran it via `npm run demo:evidence-preference` instead
  and see a "connection attempt failed, retrying" message: don't wait for
  it — that command fails reliably on this machine even after its own
  internal retries. Switch immediately to the direct command, or if
  there's no time left in the segment, narrate the numbers directly
  (baseline picks `a_weak`; evidence-preferred flips to `b_strong`, an
  80-point score gap, 100/100 n=5 vs 20/100 n=3) without a live run — the
  claim is still accurate, just not demonstrated live in that moment.
- **Any script shows an actual error, not just a retry message:** do not
  debug live. Say "that's not the result I expected — let me show you a
  verified run from earlier today," switch to `DEMO_RUN_RECORD.md`. Do
  not claim a live run passed if it didn't.
- **General rule:** one fallback switch, stated plainly, is a normal part
  of a live technical demo. Don't apologize more than once; keep going.

## 6. Optional stretch: showing the Task Detail UI live

The Task Detail page renders the real verification state
(`INDEPENDENTLY VERIFIED` / `NOT VERIFIED` / `VERIFICATION FAILED` /
`MISSING EVIDENCE`, each visually distinct, plus evidence expandable
inline) and the Agent page renders the Adaptive Trust reliability badge.
Both are genuine strengthenings of visual clarity — **but both require
pre-staging and are not part of the core, rehearsed, reliable path.**

If you want to use either:

1. For the validation-state UI: run `npx tsx scripts/demo-e2e/run.ts` (no
   `--teardown`) once before the talk — leaves its disposable Postgres on
   port 5434. In a separate terminal, point a second `next dev` instance
   at that port and open the Task 2 (`[LYING_AGENT]`) detail page.
2. For the reliability badge UI (the existing "Reliability (evidence-based)"
   section): `scripts/demo-adaptive-trust.ts` seeds its synthetic agent and
   then cleans up after itself in the same run — to leave the data in place
   for a live UI view, comment out its final `cleanup()` call for this one
   offline rehearsal run, run it, then open
   `/agents/_demo_trust_agent_unreliable`. Remember to restore the cleanup
   call and re-run it once (or run the cleanup block directly) afterward so
   no synthetic data is left in the database.
2b. For the new "Baseline vs. Evidence-Preferred" card on the same Agent
   Detail page: `scripts/demo-evidence-preference.ts` seeds two *different*
   synthetic agents (`_demo_evidence_pref_a_weak`,
   `_demo_evidence_pref_b_strong`) — same comment-out-`cleanup()` trick,
   then open either agent's detail page (the card appears on both; open
   `/agents/_demo_evidence_pref_a_weak` to see the flip from that agent's
   own baseline perspective). Restore and re-run `cleanup()` afterward the
   same way.
3. Leave the relevant tab parked, already loaded, for the entire talk.
4. Flip to it briefly (~5–8s) during segment 4 or 5, then flip back.
5. **If pre-staging wasn't done successfully ahead of time, skip this
   entirely** — the script in §4 works completely without any UI flip.
   Do not attempt to set this up live.

Label it honestly if asked: "this was created by a run earlier today,
same scenario, same code path — not a different, staged database."

## 6b. If a judge asks for deeper Adaptive Trust evidence

Two different follow-up scripts, for two different follow-up questions —
don't conflate them:

- **"What about more scenarios — ties, infra failures, policy blocks?"**
  → `scripts/adaptive-trust-evidence.ts` runs the same real functions
  (`selectBestAgent`, `getAdvisoryRecommendation`, `evaluateDispatchPolicy`)
  across 7 labeled scenarios — verified success, honest failure, caught
  lie, infrastructure failure, insufficient evidence, hard eligibility
  exclusion, and a high-risk policy check — and prints a compact table.
  Note: `getAdvisoryRecommendation` only *annotates* the existing pick, it
  never changes it — this script will not show a flipped recommendation.
- **"Does the recommendation ever actually change — show me another
  example"** → re-run the live segment-5 command
  (`scripts/demo-evidence-preference.ts`, direct bash, §1) again, or point
  to the "Baseline vs. Evidence-Preferred" card on the Agent Detail page
  (§6 item 2b) if it's already staged. This is the only script/UI path
  that demonstrates `compareBaselineWithEvidencePreference` actually
  recommending a different, still-eligible agent.

Both take ~31s via the same direct-bash pattern as the live segment. Not
rehearsed for timed narration; use either only if a judge specifically
asks a follow-up question matching it.

## 7. Final closing statement

Use the script's 05:00–05:30 text verbatim or close to it:

"What you watched: a real lie, caught live, by actually re-running the
test. A real reliability signal, built from real history. And a full
pipeline, proven, not just claimed. That's WorkerAI — not just an agent
that writes code, but a system that tells you whether to believe it."

Then stop talking. Let 05:30–06:00 be silence, not filler.

## 8. No live credentials or private server details

- Never run `env | grep`, open `~/.claude.json`, or show terminal history
  from before the demo started.
- `demo:validation`'s and `demo:evidence-preference`'s data is entirely local
  and synthetic/disposable — no real credentials or infrastructure
  involved in either.
- Do not open the GitHub repository page — see the git-history exposure
  item in the final risk report.
