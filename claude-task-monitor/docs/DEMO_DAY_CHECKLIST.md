# Demo Day Checklist — November 7, 2026

Minimal, ordered checklist. Run everything against a disposable local
database — never the real `.env` / production `DATABASE_URL`.

## 1. Night before / morning of — run once, keep the output

```bash
cd claude-task-monitor

# Clean checks — must all be clean before anything else
npm run lint
npm run typecheck
npm test
npm run build

# Independent-validation demo (no Docker, ~instant)
npm run demo:validation

# Full E2E safety-gate demo (Docker required, ~1–2 min, 13 live assertions)
npm run demo:e2e

# Real Claude CLI verification (small real cost, ~$0.15–0.20, ~15–20s)
npm run demo:real-claude
```

If any of these fail, do **not** present them as working — see §4 (fallback).
Save the terminal output; `docs/DEMO_RUN_RECORD.md` already has a captured
good run as a backup if live execution isn't possible on the day.

## 2. What to actually show, in order

1. **CI is real** — point at `.github/workflows/ci.yml` in the repo root
   (not inside `claude-task-monitor/`) and the green badge in the README.
2. **A task completes end to end** — run `npm run demo:e2e` live if Docker
   is available; narrate each step as it prints (dispatch → real SSH →
   real test run → independent re-verification → git diff → task marked
   completed). Takes ~60–90s including the Docker build.
3. **Independent validation catches a lie** — two ways to show this:
   - Fast, no Docker: `npm run demo:validation` (~1s, agent says "passed",
     real re-execution says "failed").
   - Inside the real dispatch pipeline: `demo:e2e`'s Task 2
     `[LYING_AGENT]` step — same lie, but caught over real SSH, through the
     real completion detector and the real validation gate.
4. **A policy violation is caught even when the agent hides it** —
   `demo:e2e`'s Task 3 `[TOUCHES_ENV]` step: the agent makes a correct fix
   *and* writes to a gitignored `.env` file. Plain `git status` would never
   show that file at all — point out the `git status --short
   --ignored=matching` evidence line showing `?? .env` and that completion
   is still blocked.
5. **Real Claude, not a stand-in** — show `docs/DEMO_RUN_RECORD.md`'s "Real
   Claude CLI execution" section (the captured diff, cost, and real exit
   codes). Only re-run `npm run demo:real-claude` live if you want to spend
   the ~$0.15–0.20 again; otherwise the captured record is enough.
6. **Safety gates** — in the same `demo:e2e` run: a high-risk autonomous
   task is hard-blocked outright; a high-risk *human-created* task instead
   requires approval (a distinct, real code path — `policy_requires_approval`,
   not a hard block); a secret-file edit is denied; the kill switch halts
   dispatch mid-run.
7. **Task detail UI** — open a task with `isAutonomous` + a validation
   failure and show the "Validation failed — Evidence" panel
   (`app/_components/TaskDetailPanel.tsx`) with the real exit codes
   expanded.

## 3. Things to say precisely, not loosely

- "Independent validation" means: the same lint/typecheck/test/build
  commands are **re-run for real** against the agent's own workspace, not
  that we trust what the agent printed. A passing claim only becomes
  `INDEPENDENTLY_VERIFIED` after that re-run agrees — never from the claim
  alone, and never when no workspace is available to check (that case is
  `NOT_VERIFIED`, and still blocks completion).
- `fake-claude.sh` in the Docker E2E demo is **explicitly a scripted
  stand-in**, used only to make the SSH/tmux dispatch path (and its negative
  scenarios) reproducible on demand — say so if asked. The real-Claude-CLI
  demo (`demo:real-claude`) is the one that used the actual `claude` binary.
- The Docker E2E demo and the real-Claude-CLI demo are two **separate**
  scripts, deliberately not merged — running the real `claude` CLI inside
  the disposable container would require mounting this machine's own Claude
  Code credentials into it, which was judged not worth the risk for a demo.
  Say this plainly if asked rather than implying they're connected.

## 4. If something breaks live

- **Docker demo won't build / no Docker available**: fall back to
  `npm run demo:validation` (no Docker needed) plus
  `docs/DEMO_RUN_RECORD.md`'s captured `demo:e2e` output.
- **`claude` CLI not authenticated here**: fall back to the captured diff
  in `docs/DEMO_RUN_RECORD.md`'s "Real Claude CLI execution" section.
- **Anything asks for a password/secret on screen**: stop, don't type real
  credentials into anything during the demo. Everything above is designed
  to need none.
- See `docs/DEMO_DAY_BACKUP_PLAN.md` for the full restart procedure and
  recorded fallback.

## 5. Known, disclosed gaps — do not claim these work

- `claudePermissionMode` (e.g. `full_autonomous`) is stored and displayed
  but not yet enforced in the real dispatch path — only `riskLevel` +
  `allowHighRiskAutonomy` are. If asked, say so directly.
- A fully-connected single run (real Claude CLI, driven over real SSH/tmux,
  inside the disposable container) is NOT VERIFIED — see §3 above.
- Live, mid-run tests of database-outage fail-closed behavior and of a real
  command timeout were not attempted inside the Docker demo (judged too
  fragile/slow to orchestrate live) — both are proven instead at the unit
  level (`lib/__tests__/kill-switch.test.ts`, `lib/__tests__/validation-gate.test.ts`).
- The Playwright E2E suite (`npm run test:e2e`, distinct from the demo
  scripts above) improved substantially this pass (a real Edge-Runtime bug
  in the rate limiter was found and fixed — see `docs/DEMO_DAY_FINAL_AUDIT.md`)
  but is not 100% green; the remainder is pre-existing sequential-test
  fragility unrelated to this work. Do not run it live as a demo step.
- The real GitHub Actions run of `ci.yml`/`deploy.yml` has not been
  triggered from this environment — the workflow structure and every
  command it runs were verified locally, but an actual push-triggered CI
  run is outstanding.
- Symlink-escape and writes made entirely outside the task's git workspace
  are not detectable by WorkerAI's git-based file-change checks by
  construction (git only sees its own working tree) — true prevention of
  that needs OS-level sandboxing on the worker host, outside this app's
  control. Disclosed, not silently claimed as solved.
