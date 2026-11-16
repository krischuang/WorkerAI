# WorkerAI: Architecture

This document describes what WorkerAI actually is, how its subsystems fit
together, and the tradeoffs behind the two additions made in this pass:
the scoped service-account (`/api/v1`) surface and the standalone Python
verifier service. It is written to be read alongside the code, not instead
of it, every claim below names the file that backs it.

## 1. What WorkerAI is

A local-first platform for dispatching tasks to Claude CLI sessions running
on remote servers (over SSH + tmux), monitoring their execution, and
governing what an autonomous agent is allowed to do, independently of
whatever the agent itself reports. It is a single-operator tool by design
(one shared `AUTH_SECRET`/`ADMIN_PASSWORD`), not a multi-user SaaS product,
see §4 for why that matters to this document.

## 2. Component map

```
app/_components/           UI design system (client components only)
app/api/**                 Internal REST API, cookie-session auth
app/api/v1/**               NEW: external/service-account API, bearer auth
app/api/admin/**           Admin-only operations, separate ADMIN_PASSWORD session
middleware.ts              Edge-runtime auth/CSRF/rate-limit gate for every request
lib/
  task-dispatch.ts         Atomic, locked dispatch to a server/agent tmux session
  dispatch-lock.ts         Per-resource mutex (survives HMR)
  kill-switch.ts           Fail-closed emergency halt, scoped per subsystem
  policy-engine.ts         Declarative allow/deny/require-approval rules
  prompt-firewall.ts       Pattern-based injection/exfiltration screening
  validation-gate.ts       Independent re-verification of autonomous task completion
  secret-broker.ts         TTL-scoped credential issuance (built, not yet wired, see §5)
  service-account.ts       NEW: scoped API-key auth for app/api/v1/**
  verifier-client.ts       NEW: optional client for verifier-service (off by default)
instrumentation.node.ts    60s background poller: usage refresh, idle detection, queue advance
prisma/schema.prisma       30 models, single Postgres database
verifier-service/          NEW: standalone Python/FastAPI verification microservice
```

## 3. Request authentication: three independent boundaries

WorkerAI deliberately runs three separate auth schemes side by side rather
than unifying them, because they protect different things and unifying
them would either weaken one or over-complicate the others:

| Surface | Scheme | Enforced in | Used by |
|---|---|---|---|
| Main UI / internal API | `__auth` cookie = SHA-256(`AUTH_SECRET`) | `middleware.ts` (Edge runtime, Web Crypto) | The operator's browser |
| Admin panel | `__admin` cookie = HMAC(`ADMIN_PASSWORD`, nonce) + optional TOTP | `middleware.ts` + `lib/require-admin.ts` (bcrypt check happens in the Node-runtime route handler, never in Edge middleware, see `lib/admin-auth.ts`'s header comment) | The operator's admin actions |
| **External `/api/v1`** (new) | `Authorization: Bearer wai_sk_...` | `middleware.ts` passes the request through on presence of *any* bearer token (Edge runtime cannot query Postgres, the app uses `@prisma/adapter-pg` over a real TCP `pg.Pool`, which is Node-only); the actual hash lookup, revocation check, and project-scope check happen in the route handler via `lib/service-account.ts` | Partner integrations, CI callbacks, the verifier service's caller, or any other machine client |

This is the same division of labor already used for the admin bcrypt check.
Edge middleware can only do presence/shape checks; real verification that
needs Node APIs or a database round-trip happens in the route handler.
`isServiceAccountPath`/`isAdminPath` in `middleware.ts` keep these three
surfaces from ever interfering with each other's request flow.

## 4. Why tenant isolation was added as a new surface, not retrofitted

Before this pass, WorkerAI had **zero** `userId`/`orgId`/`tenantId` columns
across all 30 Prisma models, confirmed by inspection, not assumption (see
`lib/resource-access.ts`'s own docstring: *"Since WorkerAI is single-user,
the access model is: owner / admin"*). `IDOR-1` in the prior security audit
(`security-audit-2026-06-20.md`) explicitly calls this an intentional
single-operator design decision, not an oversight.

Retrofitting real per-tenant row isolation across 30 models, in an app
whose entire UI assumes one operator, would be:

- **A large migration** touching every list/detail route, not "a small
  coherent vertical slice."
- **A regression risk to the Demo Day showcase**, which depends on the
  existing single-operator cookie flow working exactly as it does today.
- **Dishonest if rushed**: a `tenantId` column bolted onto 30 models in one
  sitting, without redesigning every query path and the UI's assumptions
  about "my data," would be the "complex tenant system merely to claim
  multi-tenancy" this task was explicitly warned against building.

Instead, `lib/service-account.ts` + `app/api/v1/**` adds a **new, additive**
surface with a **real, backend-enforced isolation boundary**:

- `ApiClient.projectIds` is the tenant scope, explicit, never a wildcard.
- Every `/api/v1` route filters its Prisma query by `projectIds` *before*
  reading the row (`app/api/v1/projects/route.ts`: `where: { id: { in:
  client.projectIds } }`), scoping happens at the query layer, not as a
  post-fetch filter, and never in the UI.
- An out-of-scope ID returns 404, identical to an unknown ID (same IDOR
  philosophy as `lib/resource-access.ts`), so a scoped key cannot
  distinguish "exists but isn't yours" from "doesn't exist."
- The existing single-operator cookie surface is completely untouched, a
  cookie-authenticated request never passes through
  `service-account.ts` at all.

This is a genuine foundation for multi-tenant SaaS evolution (partner
integrations today, could become per-customer accounts tomorrow) without
having bet the existing, working, demoable product on an unfinished
migration. Full multi-tenancy, one operator per account, project
ownership, UI-level account switching, remains a real next step; see
`docs/engineering-improvements.md`.

## 5. Agent execution & verification lifecycle

```
Task created (riskLevel auto-classified by lib/risk-classifier.ts)
  → assigned to a server/agent → status: queued
  → tryDispatchTaskToServer/Agent (lib/task-dispatch.ts):
      1. kill switch check (lib/kill-switch.ts): fails CLOSED on DB error
      2. dispatch-time policy check (lib/policy-engine.ts, category=code_execution)
         (high-risk autonomous tasks blocked unless explicitly opted in)
      3. prompt-firewall scan (lib/prompt-firewall.ts)
      4. per-resource lock acquired (lib/dispatch-lock.ts): prevents double-dispatch
      5. task text sent into the tmux session; status → running
  → background poller (instrumentation.node.ts) detects completion marker
  → lib/validation-gate.ts, for isAutonomous tasks only:
      agent's own "[WORKERAI_VALIDATION] passed" claim is AGENT_REPORTED,
      never trusted alone. Independent commands (lint/typecheck/test/build)
      are RE-EXECUTED against the task's real workspace; only if the real
      exit codes agree does the task resolve to INDEPENDENTLY_VERIFIED.
      No workspace / verification attempt itself fails → NOT_VERIFIED
      (never silently treated as success). Exit codes disagree →
      VERIFICATION_FAILED. A file-level policy check then runs against the
      actual `git status` diff, a task can be fine to dispatch and still
      touch a file it shouldn't have.
```

This state machine (`NOT_VERIFIED` / `AGENT_REPORTED` / `INDEPENDENTLY_VERIFIED`
/ `VERIFICATION_FAILED`) already existed before this pass and is the
strongest piece of the existing system, it was reviewed, not rebuilt.

### The Python verifier service: what it adds, and what it deliberately does not

`verifier-service/` is a second, independently-authored implementation of
the "classify evidence into a verdict" step, built in Python/FastAPI rather
than TypeScript. It demonstrates a genuine polyglot service boundary, but
it was scoped deliberately narrowly:

- **It does not execute commands or hold SSH credentials.** The Node
  backend already owns the SSH/tmux execution path
  (`lib/ssh.ts`, `lib/validation-gate.ts`'s `runIndependentValidation`).
  Duplicating that in Python would mean two credentialed code paths to the
  same remote servers, unjustified complexity and a bigger attack surface
  for no benefit. Instead, the Python service receives *already-captured*
  command results (exit codes, stdout/stderr summaries) and the actual
  changed-files list, and independently classifies them into the same
  `NOT_VERIFIED`/`INDEPENDENTLY_VERIFIED`/`VERIFICATION_FAILED` vocabulary
  (`verifier-service/app/verdict.py`), including its own, independently
  re-implemented "sensitive file" check, a genuine defense-in-depth
  cross-check against `lib/policy-engine.ts`'s rules, not a copy of them.
- **It authenticates service-to-service, not as a user.** Every request is
  HMAC-SHA256-signed over `{timestamp}.{raw_body}` with a shared secret
  (`verifier-service/app/auth.py`), with a ±5-minute clock-skew window,
  there is no bearer token, no session, no user identity here; this is
  backend-to-backend trust. This bounds how long a captured request stays
  valid, but it is not full replay prevention: there is no nonce/used-
  signature store, so a captured, still-valid request can be resent
  repeatedly within that window. True replay prevention would need a
  seen-signature cache for the window's duration, not implemented.
- **It is not wired into the live task-completion pipeline.** `lib/
  verifier-client.ts` exists, is unit-tested, and was proven against a real
  running `uvicorn` process (`scripts/demo-python-verifier.ts`, not a
  mock), but `lib/validation-gate.ts` does not call it. Wiring it in would
  mean the autonomous task pipeline's completion decision depends on an
  additional network service staying up, a real operational change that
  deserves to be tested against the actual Demo Day SSH/tmux infrastructure
  before it's load-bearing, which this environment cannot do (no Docker
  daemon, no remote server). The integration point, if/when this is wired
  in, is a single additional `await callVerifierService(...)` call inside
  `applyValidationGate` after the existing independent re-execution, with
  its result treated as a second, corroborating signal, never a
  replacement for the existing TypeScript gate's own verdict.

## 6. Reliability primitives already in place (unchanged by this pass)

- **Kill switch** (`lib/kill-switch.ts`): env var override, DB-persisted
  scoped halt, fails closed on DB read failure, 5s in-memory cache.
- **Dispatch locking** (`lib/dispatch-lock.ts`): per-resource mutex on
  `globalThis`, survives Next.js HMR; prevents the Run button and the
  poller racing to double-dispatch the same task.
- **Backoff** (`lib/dispatch-backoff.ts`): exponential (1-5 min) per-task
  backoff on dispatch failure; fixed 5-min backoff for an agent whose tmux
  session has gone missing.
- **Policy approvals** (`lib/policy-engine.ts`): a `require_approval`
  decision is never self-granting; an approval is one-time-use, scoped to
  exactly one policy category, and hard-capped at 4 hours regardless of
  what TTL is requested.

## 7. Known, acknowledged gaps (see docs/engineering-improvements.md for detail)

- **Secret Broker is built but has no callers** (`lib/secret-broker.ts`):
  task secrets are still injected as env vars at dispatch time rather than
  fetched on-demand through the TTL broker. Wiring this in requires a
  protocol change on the agent side that cannot be safely validated without
  a real remote tmux session.
- **Prompt firewall is pattern-based**, not encoding-aware, the structural
  XML fencing around task content is the real defense; the firewall is
  explicitly documented (prior audit, `NEW-3`) as defense-in-depth, not the
  primary control.
- **Full multi-tenancy** (per-user accounts, UI-level tenant switching) is
  not implemented, see §4.
