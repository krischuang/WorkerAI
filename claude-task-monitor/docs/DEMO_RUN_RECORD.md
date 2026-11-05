# Demo Day fallback: independent validation run record

This is a real, captured run of `npm run demo:validation`
(`scripts/demo-independent-validation.ts`), kept here as a fallback in case a
live run during the demo is not possible. It is not a mock and not invented —
it is the actual stdout of a run executed on 2026-11-05.

Nothing in this scenario touches the project's database, SSH credentials, or
any production system. It runs entirely against a disposable git repo created
in the OS temp directory.

## Scenario

An "agent" edits `add.js`, introduces a regression (`add(2, 2)` returns the
string `"22"` instead of the number `4`), and then self-reports completion via
a `[WORKERAI_VALIDATION] ... result: passed ...` block — exactly the format
`lib/validation-gate.ts` scans for in real task completions. The script then
calls the real `runIndependentValidation()` function (the same one wired into
`instrumentation.node.ts`'s completion poller) against the agent's workspace.

## Captured result

```
agent self-report:        PASSED
independent re-execution: FAILED
```

| Command | Exit code | Duration |
|---|---|---|
| `npm run lint` | 0 | 187ms |
| `npm run typecheck` | 0 | 187ms |
| `npm test` | **1** | 193ms |
| `npm run build` | 0 | 184ms |

Captured failure (`npm test`, real stderr):

```
AssertionError [ERR_ASSERTION]: add(2,2) should be 4

'22' !== 4

    at Object.<anonymous> (.../test.js:3:8)
```

Git evidence:

```
git diff --stat:
add.js | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

git status --short:
M add.js
```

Timestamps (UTC, ISO-8601): `startedAt`/`finishedAt` per command are recorded
in the full JSON report (`demo-validation-report.json`, written next to the
disposable repo on each run — not committed, since the path is a tmpdir).

## Verdict

The independent check disagrees with the agent's self-report. Fed through
`applyValidationGate()`, this flips the outcome from "completed" to "failed"
and generates an English-language follow-up task carrying this exact
evidence — proven directly (mocked DB, real gate logic) in
`lib/__tests__/validation-gate.test.ts`, in the test named *"does not trust a
passing agent report when independent re-execution disagrees"*.

## What this does and does not cover

- **Covered, real**: independent command re-execution, exit codes, git diff,
  timestamps, and the gate's resulting pass/fail decision.
- **Not covered here**: the actual dispatch call over real SSH, the
  kill-switch / policy-engine / high-risk-autonomous safety gates in front of
  it, and real Claude CLI execution. See `npm run demo:e2e` and
  `npm run demo:real-claude` below for those.

## Real Claude CLI execution: `npm run demo:real-claude`

`scripts/demo-e2e/verify-real-claude.ts` invokes the actual `claude` CLI
(`claude -p`, non-interactive) against an isolated, disposable local demo
project — not `fake-claude.sh`, not a mock. It uses the real
`buildDispatchPrompt` (the exact prompt WorkerAI pastes into a worker's tmux
session) and the real `detectCompletionBlock` / `detectValidationBlock` /
`runIndependentValidation` production functions to check what Claude actually
did. No Docker, no SSH, no WorkerAI credentials — only whatever `claude` auth
is already configured locally.

Real captured result, most recent re-run (2026-11-05, `claude` 2.1.220, cost $0.19, ~19s — re-executed after the Phase 1/2 security pass to confirm current code, not cited from a stale run):

```
[PASS] claude CLI ran successfully (exit 0, is_error=false)
[PASS] a real completion marker was produced, matching taskId+nonce
[PASS] independent re-execution actually passes (real exit codes)
[PASS] a non-empty, expected git diff exists (math.js changed)
```

**Architecture note — deliberately NOT merged with the SSH/tmux layer below.**
This script calls the real `claude` CLI directly (`claude -p`) on the host,
using this machine's already-authenticated Claude Code session. Running the
real CLI *inside* the disposable Docker worker (so it's driven over the same
SSH/tmux dispatch path as `demo:e2e`) was considered and deliberately not
attempted: it would require mounting this session's own Claude Code OAuth
credential store (`~/.claude.json`) into a container, and no `ANTHROPIC_API_KEY`
is configured as an alternative. That credential-handling risk was judged to
outweigh the demo value of combining what are otherwise two independently
real, independently verified layers:

- **SSH/tmux/policy/kill-switch dispatch** — real, proven via `demo:e2e`
  against a disposable container, using a clearly-labeled scripted stand-in
  for the LLM step (`fake-claude.sh`) so the mechanism is reproducible on
  demand without a live API dependency.
- **Real Claude CLI execution + independent verification** — real, proven
  here, via a direct (non-SSH) invocation.

A combined single run (real Claude CLI, driven over real SSH/tmux, inside
the disposable container) is NOT VERIFIED. The missing dependency is
authenticated Claude CLI access from inside a container — see above.

Real diff Claude produced (task: "Implement multiply(a, b) in math.js so the
existing test passes"):

```diff
 function add(a, b) { return a + b; }
-module.exports = { add };
-// TODO: implement multiply(a, b)
+function multiply(a, b) { return a * b; }
+module.exports = { add, multiply };
```

This makes a small, real, billed API call each time it runs — don't re-run it
repeatedly before the demo; once to confirm is enough. Full detail (full
prompt, full Claude output, full independent-validation evidence) is written
to `real-claude-report.json` next to the disposable project on each run.

## Fuller scenario: `npm run demo:e2e`

`scripts/demo-e2e/run.ts` builds a disposable sshd+tmux+git worker container
and a disposable Postgres container (never any production host, credential,
or database), then calls the real `lib/task-dispatch.ts`, `lib/kill-switch.ts`,
`lib/policy-engine.ts`, and `lib/validation-gate.ts` against them over a real
SSH connection. A scripted stand-in for the Claude CLI (explicitly labeled as
such, not the real CLI — see `scripts/demo-e2e/fake-claude.sh`) makes a real
code change and runs a real test inside the container.

Real captured summary from the most recent run (2026-11-05):

```
Task 1 (real work)           : COMPLETED (independently verified)
High-risk task (Step 6)      : BLOCKED — high_risk_requires_explicit_opt_in
Policy engine, .env (Step 7) : deny
Kill switch (Step 8)         : BLOCKED as expected
```

Full detail, including the real git diff/status and independent-validation
exit codes captured over SSH, is written to
`scripts/demo-e2e/last-run-report.json` on each run (git-ignored — regenerate
it with the command below rather than relying on a stale copy).

Note: an earlier run of this exact scenario caught a real bug — the policy
engine's glob matcher didn't correctly block a bare, repo-root `.env` file
(only a nested one), which Step 7 above exercises as a regression check. See
`lib/policy-engine.ts`'s `matchGlob` and `lib/__tests__/policy-engine.test.ts`.

## Reproduce it yourself

```bash
npm run demo:validation    # independent validation only, no Docker required
npm run demo:e2e           # full lifecycle, requires Docker
npm run demo:real-claude   # real Claude CLI, no Docker required, small real cost
```
