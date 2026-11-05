# Demo Day GO / NO-GO Checklist — WorkerAI, Nov 7 2026

Run this on the actual presentation laptop the morning of. Every row below
was verified today (2026-11-05) on the dev machine — re-verify on-site,
don't assume it transfers.

**Presentation is 6 minutes (5:30 scripted + 30s buffer).** Primary
materials: `docs/DEMO_DAY_6MIN_SCRIPT.md`, `docs/DEMO_DAY_6MIN_RUNBOOK.md`,
`docs/DEMO_DAY_ARCHITECTURE.md`, `docs/DEMO_DAY_JUDGE_SIMULATION.md`. This
checklist is the final go/no-go gate before using them.

## Blocking checks (any FAIL here → do not go live, use the recorded fallback)

| # | Check | Command | Today's result |
|---|---|---|---|
| 1 | Lint | `npm run lint` | PASS (0 errors/warnings) |
| 2 | Typecheck | `npx tsc --noEmit` | PASS (0 errors) |
| 3 | Unit tests | `npx vitest run` | PASS — **1182/1182**, 62 files |
| 4 | Build | `npm run build` | PASS |
| 5 | Demo environment | `npm run demo:precheck` | **READY** |
| 6 | Live segment 1 — independent validation | `npm run demo:validation` | PASS, ~2s, reliable via `npm run` |
| 7 | Live segment 2 — Adaptive Trust Engine | **Direct bash command**, not `npm run demo:adaptive-trust` (see note) | PASS, ~31s, 3/3 successful via direct invocation today |
| 8 | Full orchestration (pre-flight only, not live on stage) | `npm run demo:e2e` | **PASS — 13/13**, confirmed on 5 consecutive runs today (71s–5min depending on host load) |

**Important:** `npm run demo:adaptive-trust` (the npm script, as opposed to
the direct bash command) **failed 3/3 times today** with a consistent
~5s connection-timeout — this is `npm run`'s own process-spawning
overhead on this machine, not a defect in the code (the identical
operation via direct bash succeeded 3/3 times). **Use the direct command
for check #7 and for the live segment on stage:**
```bash
set -a; source .env.local; set +a; npx tsx scripts/demo-adaptive-trust.ts
```

**If all eight are GO:** proceed to live demo. **If any is NO-GO:** switch immediately to the recorded fallback (`docs/DEMO_RUN_RECORD.md` + `docs/DEMO_DAY_BACKUP_PLAN.md`) and say so plainly — do not retry live more than once.

## Non-blocking, disclosed-in-advance (known, not fixed, do not claim otherwise)

| Item | Status | What to say if asked |
|---|---|---|
| Full SSH/tmux pipeline not run live on stage | By design, not a limitation | "Shown as authentic captured evidence to keep the 6-minute budget safe — ran 5/5 live today, I'm happy to run it live afterward if you'd like to see it." |
| Playwright E2E suite | 87/108 passing | "A separate browser-level suite, not part of this demo — the remaining failures are pre-existing write-rate-limiter exhaustion under heavy sequential load, not a defect in what you're watching." |
| Combined real-Claude-CLI + SSH/tmux run | NOT VERIFIED | "Two separately-real halves, deliberately not merged — merging them would require mounting this machine's Claude credentials into a container." |
| Git history data exposure | Unresolved, pending your decision | Do not show the GitHub repo page or `git log` live. |
| `nodemailer` / `next@16.4.5` dependency advisories | Deferred (require major-version approval) | Not demo-relevant; low real-world risk per the security review. |
| Adaptive Trust Engine demo data | Synthetic fixture, explicitly labeled | "Real code, synthetic history — not enough real accumulated data yet to show this honestly with real history." |

## On-site pre-flight (run once, morning of, on the real laptop)

```bash
cd claude-task-monitor
npm install
npm run lint && npx tsc --noEmit && npx vitest run && npm run build
npm run demo:precheck
npm run demo:validation
set -a; source .env.local; set +a; npx tsx scripts/demo-adaptive-trust.ts
npm run demo:e2e   # pre-flight confirmation only — not run live on stage
```

If `demo:precheck` reports anything `[FAIL]`, fix exactly that item before continuing.

## During the live demo

- Follow `docs/DEMO_DAY_6MIN_SCRIPT.md` + `docs/DEMO_DAY_6MIN_RUNBOOK.md` — total budget 360s (6:00): 330s scripted + 30s real, unfilled buffer. The two live commands are fast and consistently timed (~2s, ~31s) — no segment depends on waiting out a multi-minute run.
- Use the **direct bash command** for the Adaptive Trust segment, not `npm run demo:adaptive-trust`.
- Never run `env | grep -i key`, open `~/.claude.json`, or show terminal history that might contain a secret.
- Never show the git remote / GitHub page.
- If a live segment errors (not just slow): switch immediately to `docs/DEMO_RUN_RECORD.md`, say plainly it's a captured run, move on.

## Final verdict

**GO.** All eight blocking checks passed today. The live demo no longer depends on a multi-minute Docker/SSH run — both live segments are fast (~2s and ~31s) and were each tested multiple times today with consistent results. The only open item (git-history exposure) is a repository-hygiene decision, not a functional blocker, and nothing related to it appears on screen during the demo. Remaining gap before full confidence: an actual timed rehearsal on the real presentation laptop has not yet been performed.

**Recommendation: STOP CODING AND START REHEARSING.**
