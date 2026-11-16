# WorkerAI: 3-Minute Technical Demo (EAI HR Interview)

HR round, not the technical deep-dive, two segments, not four. Each one
maps directly to a line in the JD: independent verification → "LLM
evaluation/observability"; the Python verifier → "Python/FastAPI" +
"model-agnostic routing and monitoring." Cut tenant-isolation and
kill-switch/policy-engine segments for time; they're still in
`architecture.md` if a follow-up question goes there.

## What to show, in order

**1. Independent verification: the strongest piece of the system (90s)**

Open `lib/validation-gate.ts` and scroll to the `VerificationState` type
comment (top of the file). Say: *"An autonomous agent's own success claim
is never trusted. It's labeled `AGENT_REPORTED` and only ever resolves to
`INDEPENDENTLY_VERIFIED` after real allowlisted commands are re-executed
against the task's actual workspace and the real exit codes agree."*

Point to `runIndependentValidation` (same file), the allowlist
(`INDEPENDENT_VALIDATION_COMMANDS`) is a literal array, enforced even if a
caller tries to override it (`ALLOWLISTED_COMMANDS` check), so there's no
injection surface via a crafted command string.

Run: `npm run demo:validation`, a real, disposable-repo demo of this gate
catching a disagreement between an agent's claim and reality. Evidence file:
`docs/DEMO_RUN_RECORD.md`.

**2. The Python/FastAPI verifier service (90s)**

```bash
cd verifier-service && . .venv/bin/activate
VERIFIER_SHARED_SECRET=demo-secret uvicorn app.main:app --port 8008 &
cd ../claude-task-monitor
VERIFIER_SERVICE_URL=http://localhost:8008 VERIFIER_SHARED_SECRET=demo-secret \
  npx tsx scripts/demo-python-verifier.ts
```

Three scenarios print live: all-green, agent-claims-success-but-build-failed,
and agent-touched-a-`.env`-file, each gets a different verdict. Say: *"This
is a genuinely independent, separately-authored verdict classifier,
HMAC-authenticated service-to-service. It deliberately does not execute
commands or hold SSH credentials, that stays in the Node backend, which
already owns that trust boundary. Duplicating it in Python would be
complexity without benefit."* Show `verifier-service/app/verdict.py`:
pure functions, 12 pytest cases, zero framework dependency.

*(Cut for time in the HR round: tenant-isolation / `/api/v1` scoping and
the kill-switch/policy-engine segments. Still fully built and tested:
`npx vitest run lib/__tests__/service-account.test.ts`, bring up if asked
about multi-tenancy or safety controls specifically.)*

## How to explain the architecture decisions

- **Why didn't you wire the Python verifier into the live pipeline?**
  It's tested end-to-end against a real running process (not mocked), but
  making it load-bearing for autonomous-task completion is an operational
  decision that deserves testing against real demo infrastructure first.

## Hard backend questions, with evidence-backed answers

**Q1: "How do you know your independent-verification re-execution step
isn't itself trivially bypassable, e.g., an agent that just touches no
files and reports success?"**

A: Two separate gates, not one. The dispatch-time risk/policy gate
(`task-dispatch.ts`'s `assertDispatchAllowed`) runs *before* any work
starts. The validation gate's file-level policy check
(`validation-gate.ts`, "File-level policy gate" comment) runs *after*,
against the actual `git status --short --ignored=matching` output, not
what the agent claims it touched. The `--ignored=matching` flag is
load-bearing: plain `git status` never lists gitignored paths, and `.env`
is gitignored by convention. Without it, an agent editing `.env` directly
would produce an empty diff and slip past undetected. That's confirmed by
direct reproduction, noted in the code comment at that exact line.

## Implemented vs. simulated vs. planned

Reference only, not part of the 3-minute walkthrough, have it ready if a
follow-up question goes there.

| Capability | Status |
|---|---|
| Independent verification state machine | **Implemented**, pre-existing, reviewed not rebuilt |
| Kill switch / policy engine / dispatch locking | **Implemented**, pre-existing |
| Scoped service-account tenant isolation (`/api/v1`) | **Implemented** this session: real DB enforcement, 16 passing regression tests |
| Python/FastAPI verifier service | **Implemented** this session: real process, real HTTP round trip, 20 passing pytest tests, HMAC auth |
| Verifier service wired into live task completion | **Not implemented**: client exists and is tested, call site is not wired; documented next step |
| Secret Broker wired into dispatch | **Not implemented**: pre-existing gap, documented, not forced in |
| Full multi-tenancy (per-user accounts) | **Not implemented**: deliberately not attempted; see architecture.md §4 for why |
| E2E (Playwright) / Docker-based tests | **Not run this session**: no Docker daemon available in this environment |
