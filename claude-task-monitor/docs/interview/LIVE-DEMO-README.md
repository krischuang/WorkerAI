# Live Two-Agent Comparison (interview-only, local)

`/interview/live-comparison` runs a realistic, evidence-based backend
engineering workflow with two real, separate local `claude` CLI processes
against a deliberately seeded multi-tenant authorization vulnerability, plus
a real, independent `npm test` re-execution via the existing
`runIndependentValidation` (`lib/validation-gate.ts`, unmodified). Nothing is
simulated: every panel is a real process's real output, the implementation
diff is a real `git diff`, and the backend verdict comes from a real exit
code, never from either agent's language.

## Start it

```bash
cd claude-task-monitor
npm run dev
```

Log in at http://localhost:3000/login with your `AUTH_SECRET`, then open
http://localhost:3000/interview/live-comparison and press **Start Live
Two-Agent Comparison**.

Requires: Postgres running (`docker ps` shows `medflow-postgres`), the
`claude` CLI installed and authenticated (`claude doctor`), and `AUTH_SECRET`
set in `.env.local`.

## The scenario

A synthetic `GET /tasks` handler (`tasks-api.js`) starts with a real,
reproducible cross-tenant authorization bug: it trusts a caller-supplied
`tenantId` instead of deriving scope only from the authenticated caller, the
same class of bug this app's own `lib/resource-access.ts` and
`lib/service-account.ts` exist to prevent in production. All tenants, tasks,
and data are synthetic; see `REQUIREMENTS.md` (written into the disposable
workspace each run) for the full acceptance criteria given to both agents.

## What each agent can do

| | Agent A, Implementation Agent | Agent B, Independent Reviewer |
|---|---|---|
| Tools | `Read`, `Edit`, `Write`, `Bash` | `Read`, `Bash` (no `Edit`/`Write`) |
| Task | Fix the vulnerability, run the tests itself | Independently review the resulting code and run the tests itself |
| Sees the other agent's reasoning? | No (runs first) | No, only the resulting code and the same `REQUIREMENTS.md` |
| Can modify the submission? | Yes, that is its job | No, no write-capable tool at all |
| Timeout | 180s | 120s |

Agents run sequentially: Agent A edits first, a real `git diff` is captured
against the seeded vulnerable baseline, then Agent B reviews the resulting
code, then WorkerAI's backend independently re-runs the real acceptance
tests. The evidence hierarchy shown in the UI:

- `SELF-REPORTED`, Agent A's own claim about its own work
- `REVIEWED`, Agent B's own claim after independently inspecting and running tests
- `INDEPENDENTLY_VERIFIED` / `VERIFICATION_FAILED` / `NOT_VERIFIED`, WorkerAI's
  own real `npm test` re-execution, the authoritative layer

## 2-minute walkthrough (spoken, English)

Say this while the run is progressing on screen, it takes about 2 minutes at
a normal pace:

> "This page runs two separate, real Claude Code CLI processes against a
> deliberately seeded bug: a multi-tenant task API that trusts a
> caller-supplied `tenantId` instead of deriving scope from the
> authenticated user, the same class of bug our own `resource-access.ts`
> exists to prevent in production.
>
> Agent A, the Implementation Agent, has Read, Edit, Write, and Bash. It
> reads the requirements, fixes the handler, and runs the tests itself.
> That's stage one.
>
> Agent B, the Independent Reviewer, is a second, separate process. It never
> sees Agent A's reasoning, only the resulting code and the same
> requirements file. It has Read and Bash only, no Edit or Write, so it
> cannot alter the submission even if it wanted to. That's stage two.
>
> Stage three is the one that actually matters: WorkerAI's own backend
> independently re-runs the real `npm test`, and the real exit code, not
> either agent's language, is what sets the verdict you see at the top,
> `INDEPENDENTLY_VERIFIED` or `VERIFICATION_FAILED`. You can open 'Final
> Verification Report' to see the exact commands and exit codes, and 'View
> Implementation Diff' to see the real `git diff`, not a description of one.
>
> The honest point here isn't that the agents always get it right, it's that
> the verdict doesn't depend on them being right. If you refresh the page
> right now, you'll see the same verdict, it's read from the same backend
> state, not recomputed from anything in the browser."

If asked "what if both agents say it passed but it's actually broken":
point at the Final Decision panel's real exit codes, that's the layer that
would catch it, independent of either agent's claim.

## Safety

- Every non-public path (including this one) requires the existing
  `__auth` cookie session by default (`middleware.ts`), unchanged.
- `--dangerously-skip-permissions` is never passed. `--permission-mode
  dontAsk` + a narrow `--allowedTools` list per agent is the only
  permission surface. Agent B structurally cannot edit the submission,
  it has no `Edit`/`Write` tool at all, not just an instruction not to.
- Runs only inside a fresh `fs.mkdtempSync` directory under the OS temp
  dir, destroyed on Reset (and before the next Start).
- One run at a time, enforced by a single `globalThis`-held run slot
  (`lib/interview-live-demo.ts`, same HMR-safe pattern as
  `lib/dispatch-lock.ts`).
- Both agent processes have a hard timeout and are killed (`SIGTERM`, then
  `SIGKILL` after 3s) on Cancel, Reset, or timeout.
- The API routes additionally reject any request whose `Host` header
  isn't `localhost`/`127.0.0.1` on top of the existing cookie auth, see
  Known Limitations below for what that check does and doesn't cover.

## Known limitations

- **The `Host`-header check is not a hard network boundary.** `Host` is
  client-supplied; a sufficiently motivated client could spoof it. The
  app's dev server binds `0.0.0.0` (`package.json`'s existing `dev`
  script), so the real localhost guarantee for this feature depends on
  cookie auth (unchanged, already required) plus not exposing port 3000
  beyond your own machine during the interview.
- **Agent A is not guaranteed to fix the vulnerability, and is not
  deliberately prevented from succeeding.** In this session's own
  validation run it fixed it correctly on the first real attempt, and even
  improved on the obvious fix (denying a mismatched tenantId rather than
  only ignoring it). That is shown honestly; the demo's point is that the
  backend verdict is authoritative regardless of whether either agent's
  own language happens to be right, there is no LLM judgement anywhere in
  the actual verification computation.
- **Timeout path is implemented, not exercised live in this session**, real
  timeouts were not forced during validation; the path reuses the exact
  same `kill()` logic already proven live via Cancel.
- **Cost:** each full run costs real API usage. In the most recent captured
  run (`docs/interview/LIVE-DEMO-RECORDED-RUN.md`): Agent A $0.247 (34.0s),
  Agent B $0.173 (18.6s), about $0.42 total, visible in the UI per panel.
- **No E2E Docker/Postgres isolation beyond what already exists**: this
  feature doesn't touch the database at all except a best-effort,
  non-blocking `emitAudit` call on start/cancel (same pattern used
  everywhere else in this codebase).

## If the live run fails or won't be reliable on interview day

- `docs/interview/LIVE-DEMO-RECORDED-RUN.md` (and the raw
  `LIVE-DEMO-RECORDED-RUN.json` beside it), a genuine captured run from this
  session, clearly labeled as recorded, not live. Walk through that instead.
- `npm run demo:validation`, a real disposable-repo run of a different
  (simpler) seeded regression directly against `runIndependentValidation`
  (no Claude CLI spawning), see `docs/DEMO_RUN_RECORD.md` for its own
  captured transcript.
- `docs/interview/EAI-WALKTHROUGH.md` / `../eai-interview-demo.md` for the
  scripted walkthrough that doesn't require this page at all.

If `claude doctor` or a quick `claude -p "say hi"` fails right before the
call, use one of the fallbacks above rather than debugging CLI auth live on
screen-share.
