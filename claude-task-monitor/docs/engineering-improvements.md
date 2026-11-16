# Engineering Improvements: 2026-11-11 Session

## Problems identified (audit)

Full audit method: read `package.json`, `prisma/schema.prisma` (30 models),
`middleware.ts`, `lib/task-dispatch.ts`, `lib/kill-switch.ts`,
`lib/policy-engine.ts`, `lib/validation-gate.ts`, `lib/resource-access.ts`,
`lib/secret-broker.ts`, `lib/prompt-firewall.ts`, `.github/workflows/ci.yml`,
and the three prior audit documents (`security-audit-2026-06-20.md`,
`security-review-2026-06-20.md`, `INFRASTRUCTURE_REVIEW.md`) before writing
any code, per the instruction not to assume a capability is missing without
checking.

| Existing capability | Evidence | Risk / gap | Priority |
|---|---|---|---|
| Independent verification (agent claim ≠ truth) | `lib/validation-gate.ts` | None found, already strong | n/a |
| Kill switch | `lib/kill-switch.ts` | None found, fails closed correctly | n/a |
| Policy engine, approvals | `lib/policy-engine.ts` | None found | n/a |
| Concurrency-safe dispatch | `lib/task-dispatch.ts`, `lib/dispatch-lock.ts` | None found | n/a |
| CI (lint/typecheck/coverage/build/e2e) | `.github/workflows/ci.yml` | None found | n/a |
| **Tenant isolation / RBAC** | `lib/resource-access.ts` docstring: *"single-user"*; zero `userId`/`tenantId` columns in 30 models | Real, acknowledged gap vs. EAI's enterprise-platform requirements | **High** |
| Secret Broker | `lib/secret-broker.ts` fully implemented, zero callers | Dead code; secrets still injected as env vars at dispatch (`task-dispatch.ts`) | High (architectural, pre-existing finding `DB-1/AC-2`) |
| Prompt firewall | `lib/prompt-firewall.ts`, regex-pattern based | Bypassable via encoding/homoglyphs (pre-existing finding `NEW-3`); XML structural fencing is the real defense | Medium, defense-in-depth only |
| Python/FastAPI | Not present anywhere in the repo | Explicit JD requirement with zero coverage | High (opportunity, not a defect) |

## Changes actually implemented

1. **`ApiClient` model + migration**: `prisma/schema.prisma`,
   `prisma/migrations/20261111000000_add_api_client/migration.sql`.
   Additive only: one new table, zero changes to existing columns.

2. **Scoped service-account auth**: `lib/service-account.ts`. Key
   generation/hashing (raw key never persisted), scope check
   (`isProjectInScope`), revocation, admin-minting helpers.

3. **External `/api/v1` surface**:
   `app/api/v1/projects/route.ts`,
   `app/api/v1/projects/[id]/route.ts`,
   `app/api/v1/projects/[id]/tasks/route.ts`.
   Every query scoped at the Prisma layer by `ApiClient.projectIds`.
   Task creation through this surface reuses the exact same validation
   (`validateTaskCreate`), risk classification (`classifyTaskRisk`), and
   prompt-firewall screening (`evaluateTaskContent`) as the internal UI
   path, no lighter-weight copy.

4. **Admin management of service accounts**:
   `app/api/admin/service-accounts/route.ts` (mint/list),
   `app/api/admin/service-accounts/[id]/route.ts` (revoke). Admin-cookie
   gated via the existing `requireAdmin`.

5. **`middleware.ts` changes**: added `isServiceAccountPath`; `/api/v1/**`
   is now bearer-token-only (never cookie auth, never redirects to
   `/login`), exempted from the cookie-CSRF origin check (no ambient
   credential exists for a cross-site request to ride on), still subject
   to the existing global rate limiter. Every other path's behavior is
   byte-for-byte unchanged.

6. **Tenant-isolation regression tests**:
   `lib/__tests__/service-account.test.ts` (16 tests). The load-bearing
   one: `isProjectInScope: cross-tenant leakage`, proving a key scoped to
   project A is denied project B.

7. **Python/FastAPI verifier microservice**: `verifier-service/`
   (`app/main.py`, `models.py`, `verdict.py`, `auth.py`,
   `logging_config.py`). Pydantic-typed contracts, HMAC service-to-service
   auth with replay-window protection, structured JSON logging with
   request correlation IDs, a hard per-request timeout middleware, Docker
   support with a healthcheck. 20 pytest tests
   (`verifier-service/tests/`), including a genuinely tampered-body test
   proving the HMAC binds the payload, not just header presence.

8. **Optional TS client**: `lib/verifier-client.ts` (never throws, returns
   `null` on any failure, matching the codebase's existing
   "best-effort, never block the primary flow" convention). 4 vitest
   tests (`lib/__tests__/verifier-client.test.ts`) against a local HTTP
   server re-implementing the Python signature-check algorithm. A
   cross-language demo script (`scripts/demo-python-verifier.ts`) was run
   against a real `uvicorn` process in this session, not mocked, with
   three scenarios (pass / disagreement / sensitive-file) all producing
   correct verdicts.

9. **CI**: `.github/workflows/ci.yml` gained a `verifier-service` job
   (Python 3.12, pip install, pytest) alongside the existing four jobs.

## Tests and results (this session)

| Check | Result |
|---|---|
| `npx tsc --noEmit` (TypeScript) | **PASS**: zero errors |
| `npm run lint` (ESLint) | **PASS**: 0 errors, 1 pre-existing warning in `app/demo-day/page.tsx` (unrelated file, not touched this session) |
| `npm run test:coverage` (Vitest) | **PASS**: 64 files, 1215 tests, 0 failures. Coverage 95.95% stmts / 91.59% branch / 92.3% funcs / 97.63% lines, all above the enforced 85/80/90/85 thresholds |
| `npm run build` (production) | **PASS**: compiled cleanly, new `/api/v1/*` routes present in route manifest |
| `python -m pytest` (verifier-service) | **PASS**: 20 tests, 0 failures |
| Cross-language round trip (Node → HMAC → FastAPI) | **PASS**: verified against a real running `uvicorn` process, three scenarios, correct verdicts for each |
| `npm run test:e2e` (Playwright) | **NOT RUN**: requires a live Postgres instance; no Docker daemon available in this sandbox (`docker ps` fails with a socket-connect error) |
| Live SSH/tmux-based demo scripts (`demo:validation`, `demo:e2e`) | **NOT RUN**: require either a remote worker server or Docker; not available here |
| Secret Broker end-to-end wiring | **NOT ATTEMPTED**: see Remaining risks |

No check is reported as passing without having actually been executed in
this session; "NOT RUN" above is not "assumed fine."

## Remaining risks / technical debt

- **Secret Broker still unwired** (`lib/secret-broker.ts`). Concrete next
  step: change `lib/task-dispatch.ts` to stop injecting
  `getDecryptedTaskSecrets` results directly as env vars, and instead have
  the wrapper script (`lib/wrapper-script.ts`) call back to a new
  `POST /api/secret-broker/credential` request signed with a per-task
  token, scoped to a short TTL. This is a protocol change to what runs on
  the remote agent and must be validated against a real tmux session
  before it ships, do not wire this blind.
- **Prompt firewall remains pattern-based.** The existing XML structural
  fencing is the real defense; closing `NEW-3` fully would mean
  base64/hex/unicode-normalization decode-and-rescan before pattern
  matching, scoped but not done this session to keep the diff focused.
- **Full multi-tenancy not implemented.** The `/api/v1` scoped-key surface
  is a real, tested isolation primitive but is not the same thing as
  per-user accounts with UI-level tenant switching across all 30 models.
  See `docs/architecture.md` §4 for the reasoning behind not attempting
  that retrofit in this session.
- **Verifier service not load-bearing.** It exists, is tested, and was
  proven against a real process, but `lib/validation-gate.ts` does not
  call it. See `docs/architecture.md` §5 for the exact integration point.
- **E2E suite unexercised this session**: the new `/api/v1` routes have
  unit-level coverage of their authorization primitives
  (`service-account.test.ts`) but no Playwright-level HTTP test against a
  running server, because no Postgres/Docker was available. Recommended
  next step: add `e2e/api-v1.spec.ts` alongside the existing
  `exec-security.spec.ts`, following its pattern of skipping gracefully
  when guards aren't detected as active.

## Recommended next steps, in priority order

1. Add a Playwright e2e spec for `/api/v1/**` once a CI/dev environment
   with Postgres is available, mirroring `exec-security.spec.ts`'s style.
2. Design and wire the Secret Broker protocol change, tested against a
   real remote tmux session before merging.
3. Decide whether to wire `verifier-client.ts` into
   `applyValidationGate` as a corroborating (not replacing) signal, after
   running it against real Demo Day infrastructure.
4. If genuine multi-tenancy becomes a real product requirement (not just
   an interview talking point), design it as its own initiative, a
   `User`/`Organization` model, a migration plan for the other 29 models,
   and a UI redesign, rather than retrofitting it piecemeal.
