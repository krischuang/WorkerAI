# Engineering Trade-offs

Each section: what exists today, what the alternative was, and why. The
Azure and MongoDB sections are explicitly design sketches, not implemented
or tested, labeled as such.

---

## Why TypeScript is the main orchestrator

**What exists:** Next.js (App Router) + Prisma/Postgres owns HTTP routes,
the data model, and the SSH/tmux process-management path
(`lib/ssh.ts`, `lib/ssh-claude-tmux.ts`).

**Alternative considered:** Python as the primary backend, given this is an
"AI platform" and much of that ecosystem is Python-native.

**Why TypeScript won:** the orchestrator's actual job is conventional
backend work, HTTP routes, a relational schema, remote process management,
a web UI, not AI/ML computation. It's also what the pre-existing
single-operator app was already built in; rewriting a working orchestrator
to chase language fashion would have been pure risk for the interview
window, with no functional benefit. The one genuinely Python-native piece
(independent evidence classification) got its own service instead of being
forced into the Node app.

---

## Why the Python verifier is a separate service

**What exists:** `verifier-service/`, a standalone FastAPI microservice,
HMAC-authenticated, that classifies already-captured command results into a
verdict. It does not execute commands or hold SSH credentials.

**Alternative considered:** a Python library imported into (or called via
subprocess from) the Node backend.

**Why separate-service won:** the Node backend already owns the one
credentialed path to remote workers. An in-process Python library doing the
same classification would need either its own copy of SSH credentials (a
second credentialed path, more attack surface, no benefit) or to call back
into Node for execution (pointless indirection for a pure classification
step). A network-separated service that only ever receives *results*, never
commands to run, keeps the credential boundary exactly where it already is.
The cost: an extra service to deploy and keep healthy, paid deliberately,
and currently not load-bearing (see "Known technical debt" below).

---

## Why PostgreSQL was selected

**What exists:** Prisma 7 + Postgres, 30 relational models.

**Alternative considered:** MongoDB, listed as a priority for this role,
so addressed directly rather than ignored.

**Why Postgres fits this domain:** the data is relational by nature,
`Task` → `Project`, `ExecutionLog` → `Task`, policy approvals reference a
category for a specific task, audit events reference an entity by
type+id. The tenant-scoping guarantee in Case B
(`where: { id: { in: client.projectIds } }`) is fundamentally a relational
query-layer operation. Enforcing that same guarantee against a document
store would mean re-implementing referential integrity and scoped joins in
application code, for a schema that doesn't actually need flexibility.

**Where MongoDB would be the right call instead:** a genuinely
document-shaped, schema-heterogeneous problem, e.g. storing raw,
differently-shaped event payloads from many unrelated external integrations
where enforcing one schema up front would be the wrong constraint. That's
not this system today.

---

## How project-scoped access works (what's implemented)

- `ApiClient.projectIds: string[]` is the scope, explicit, never a wildcard.
  Enforced at creation (`POST /api/admin/service-accounts` rejects an empty
  or unknown-ID array).
- Raw keys (`wai_sk_...`) are never persisted, only a sha256 hash
  (`ApiClient.keyHash`) and a short display prefix. The raw key is returned
  exactly once.
- Every `/api/v1` route filters its Prisma query by `projectIds` *before*
  reading a row, not as a post-fetch filter, see `lib/service-account.ts`
  and `app/api/v1/projects/route.ts`.
- An out-of-scope ID returns 404, identical to an unknown ID, so a key
  cannot distinguish "exists but isn't yours" from "doesn't exist."
- 16 passing tests, including an explicit cross-tenant-leakage case.

This is implemented and tested today. It is a scope boundary for machine
clients, not a multi-user account system, see next section for the gap.

---

## What full multi-tenancy would require (not implemented)

In order of disruption:

1. **A `tenantId`/`ownerId` column on all ~30 Prisma models**, plus a
   backfill migration. The scoped-service-account work added isolation to
   one new surface; it did not touch the other 29+ models' existing shape.
2. **Rewriting every existing list/detail query in the main app** (not just
   `/api/v1`) to filter by tenant. Today those routes implicitly assume one
   operator and would silently leak across tenants if just given a login
   screen without this.
3. **A UI/auth redesign** for per-user accounts and account switching. The
   entire app currently authenticates with one shared `AUTH_SECRET` cookie;
   there is no user table at all today.

Deliberately not attempted here: a `tenantId` column added without steps 2
and 3 would be a system that *claims* multi-tenancy without enforcing it,
which is a worse outcome than the honest, narrower boundary that exists
today.

---

## How Azure deployment could be approached (design sketch, not implemented)

Current deploy target: a single EC2 host, Docker Compose
(`.github/workflows/deploy.yml`, `docker-compose.yml`). An Azure-equivalent
sketch:

| Component | Today | Azure sketch |
|---|---|---|
| App container | Docker Compose on EC2 | Azure Container Apps or App Service |
| Database | Self-managed Postgres container | Azure Database for PostgreSQL Flexible Server |
| Secrets | Plain env vars (`AUTH_SECRET`, `VERIFIER_SHARED_SECRET`) | Azure Key Vault + managed identity |
| Verifier service | Started manually alongside the app | Its own Container App, deployed and scaled independently, since it's explicitly not load-bearing for task completion |

One correctness gate before any multi-instance Azure deployment: the
dispatch lock (`lib/dispatch-lock.ts`) is an in-process `Map`, correct for
exactly one running instance. Scaling the app container to >1 instance
without first replacing that with a real distributed lock (e.g. a Postgres
advisory lock, since the app already holds a `pg.Pool`) would silently
reintroduce the double-dispatch race it exists to prevent. This entire
section is a sketch; none of it has been built or tested against real Azure
infrastructure.

---

## How observability and reliability could scale

**What exists today:** every policy decision, kill-switch transition, and
validation outcome writes an `AuditEvent` row via `emitAudit`
(`lib/audit.ts`), queryable through a generic `/api/audit` endpoint.
`emitAudit` is deliberately non-blocking, it catches and logs its own
failures rather than failing the operation it's describing.

**What's missing for production scale:**
- Structured log shipping (today: `console.error`/`console.warn`)
- Alerting specifically on `emitAudit` failures (currently silent beyond a
  console log) and on kill-switch activations
- The dispatch lock becoming distributed before horizontal scaling (see
  above), this is a correctness fix, not just an observability nice-to-have
- Alerting on `VERIFICATION_FAILED` rate from the validation gate, a spike
  there is the single most actionable signal this system produces today

Priority order if I were building this out: distributed lock first
(correctness), then kill-switch/validation-failure alerting (the signals
that already exist but aren't surfaced), then full log shipping.

---

## Known technical debt, ranked

1. **Dispatch lock is single-instance only** (`lib/dispatch-lock.ts`):
   correct today, silently incorrect the moment the app runs as more than
   one process, with no error at the point that assumption breaks. This is
   the one I'd fix first; it fails silently under a deployment change, not
   loudly.
2. **Python verifier has zero production callers**: built, tested against
   a real running process, deliberately not wired into
   `lib/validation-gate.ts`'s completion path. Documented, not hidden
   (`architecture.md` §5). Low risk: nothing depends on it.
3. **Secret Broker has zero callers** (`lib/secret-broker.ts`): task
   secrets still go in as plain env vars at dispatch time. Wiring it in
   needs an agent-side protocol change I can't validate without real
   SSH/tmux infrastructure.
4. **HMAC replay protection is window-bounded, not nonce-based**
   (`verifier-service/app/auth.py`): a captured, still-valid request can be
   replayed within the ±5-minute window. Acceptable today only because this
   service isn't load-bearing; would need a seen-signature cache before it
   ever became production-critical.
5. **No full multi-tenancy**: see above. Deliberate, not an oversight.
