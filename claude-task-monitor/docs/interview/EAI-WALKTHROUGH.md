# WorkerAI: 4-Minute Technical Walkthrough (EAI Senior Backend Engineer)

For a technical round where screen-sharing the repo and/or the showcase site
is expected. If this is an HR round instead, use the shorter
`../eai-interview-demo.md`. Timings are approximate; the point is to leave
room for questions, not to race through slides.

## Before you start

- [ ] `npx tsc --noEmit` clean (run it live if asked "does this even compile")
- [ ] `npx vitest run` passing (36 tests: 16 service-account + 4 verifier-client + others)
- [ ] `cd verifier-service && . .venv/bin/activate && python -m pytest -v` → 20 passed
- [ ] Showcase site open in a tab: https://krischuang.github.io/WorkerAI/#walkthrough
- [ ] Repo open in a tab, specifically `lib/validation-gate.ts`

## 0:00-0:30: Frame the problem, not the product

Say: *"The question I kept asking myself building this: if an autonomous
coding agent tells you it succeeded, how do you know? WorkerAI's answer is
narrow and enforced in one file: an agent's own claim is never, by itself,
sufficient to mark a task complete."* Point at the showcase site's hero line
or `validation-gate.ts`'s top comment, either works.

## 0:30-1:45: Case A, Independent Verification (the strongest piece)

Open `lib/validation-gate.ts`, scroll to the `VerificationState` type.
Walk through the four states out loud: `NOT_VERIFIED`, `AGENT_REPORTED`,
`INDEPENDENTLY_VERIFIED`, `VERIFICATION_FAILED`. Say the invariant: *"allowed
is only ever true when verificationState is INDEPENDENTLY_VERIFIED, there's
no path that sets allowed=true from the agent's report alone, including when
verification is mandatory but unavailable."*

Run it live:

```bash
npm run demo:validation
```

Narrate as it prints: agent edits `add.js`, introduces a bug, self-reports
`passed`. Independent re-execution finds `test` exits 1. Point at the final
lines: agent self-report `PASSED`, independent re-execution `FAILED`, task
marked `FAILED` not completed. Mention the follow-up task it creates with
the evidence attached, that's the actual persisted outcome, not just a log
line.

If asked "how do you know this isn't theater", point to the file-level
policy gate right below it in the same file: even if every command passes,
a second check re-reads real `git status --short --ignored=matching` output
and can still deny completion if the agent touched a file it shouldn't have.
The `--ignored` flag is deliberate; without it, a `.env` edit would produce
an empty diff and slip through undetected.

## 1:45-2:45: Case B, Scoped Service-Account API

Open `lib/service-account.ts`'s header comment, then
`app/api/v1/projects/[id]/route.ts`. Say: *"WorkerAI's main UI is
single-operator by design, one shared password, zero tenantId columns across
30 models. Rather than retrofit tenant isolation onto that, I added a new,
additive surface with a real, backend-enforced scope boundary."*

Show the query: `where: { id: { in: client.projectIds } }`, scoping happens
in the Prisma query, not a UI filter. Run the tests live:

```bash
npx vitest run lib/__tests__/service-account.test.ts
```

16 tests. Name the one that matters most out loud:
`isProjectInScope: cross-tenant leakage`, a key scoped to project A gets
`false` for project B, full stop. Mention the 404-not-403 detail if there's
time: an out-of-scope ID looks identical to a nonexistent one.

Be ready for: *"Isn't this just an API key, not real multi-tenancy?"* Answer
directly: *"Correct, it's a scope boundary for machine clients, not per-user
accounts. Full multi-tenancy needs a tenantId on the other 30 models and a
UI redesign, that's a real next step, not something I'm claiming is done."*

## 2:45-3:45: Case C, Python / FastAPI Verifier

```bash
cd verifier-service && . .venv/bin/activate
VERIFIER_SHARED_SECRET=demo-secret uvicorn app.main:app --port 8008 &
cd ../claude-task-monitor
VERIFIER_SERVICE_URL=http://localhost:8008 VERIFIER_SHARED_SECRET=demo-secret \
  npx tsx scripts/demo-python-verifier.ts
```

Three scenarios print live: all-green, agent-claims-success-but-build-failed,
agent-touched-a-.env-file. Say: *"This is a second, independently-authored
verdict classifier, HMAC-authenticated service-to-service. It never executes
commands or holds SSH credentials, that stays in Node, which already owns
that trust boundary."*

**Say this part even if not asked, it's the most senior-sounding thing in
the whole demo:** *"The HMAC signature is timestamp-bound to a five-minute
window, which bounds how long a captured request stays valid. That is not
full replay prevention, there's no nonce store, so a captured request can be
resent within that window. I'd add a seen-signature cache before this ever
touched production traffic. I'm not going to claim a stronger guarantee than
what's actually implemented."*

Close with the honest status: *"The client exists, it's tested, it's proven
against a real running process, not a mock. It is not called from the live
completion path. Wiring it in is a one-line change at a specific call site,
documented in architecture.md, that I chose not to force in without real
SSH/tmux infrastructure to test it against."*

## 3:45-4:00: Close

*"Three things I'd point to as representative of how I work: the validation
gate already existed and I reviewed it rather than rebuilding it, I added
the service-account boundary and the Python verifier as new, tested,
narrowly-scoped surfaces rather than retrofitting the whole app, and when I
found a place where my own documentation overstated what the code does, the
replay-protection wording, I fixed the wording to match the code instead of
leaving it."*

## If they ask to see the showcase site

https://krischuang.github.io/WorkerAI/, the `#walkthrough` section mirrors
this script with an architecture diagram; the screenshots section is clearly
labeled LIVE vs SEEDED SCENARIO so nothing reads as fabricated production
data.
