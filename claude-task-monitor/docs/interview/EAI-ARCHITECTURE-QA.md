# Senior Backend Interview Q&A: Grounded in This Repository

Every answer names the file it's backed by. Where the honest answer is a
limitation, it's stated as one, not spun.

---

**Q1. Your `/api/v1` auth check happens in Edge middleware, but the real key
verification needs a database lookup. How do you avoid a timing/auth bypass
in that gap?**

Middleware only checks "is there a bearer token at all": presence, not
validity. Every actual data read in `app/api/v1/**` calls
`authenticateServiceAccountRequest` itself before touching Postgres (see
`app/api/v1/projects/[id]/route.ts`), so a request that slips past
middleware with a garbage token still gets a 401 from the route handler
before any row is read. This is the same split already used for admin auth
(`requireAdmin`, bcrypt, Node-only). I followed the existing pattern rather
than inventing a new one. Edge middleware literally cannot do the real check
here: it runs on the Edge runtime, and `@prisma/adapter-pg` needs a real TCP
`pg.Pool`, which is Node-only.

---

**Q2. How do you know your independent-verification re-execution step isn't
trivially bypassable, e.g. an agent that touches no files and reports
success?**

Two separate gates, not one. The dispatch-time risk/policy gate
(`task-dispatch.ts`) runs *before* any work starts. The validation gate's
file-level check (`validation-gate.ts`) runs *after*, against the real
`git status --short --ignored=matching` output, not what the agent claims it
touched. `--ignored=matching` is load-bearing: plain `git status` never
lists gitignored paths, and `.env` is gitignored by convention, so without
that flag an agent editing `.env` directly would produce an empty diff and
slip past undetected. Confirmed by direct reproduction while building this.

---

**Q3. Your tenant-scoped API key hashes the raw key with sha256 and does an
equality lookup by hash in Postgres. Isn't that a timing side-channel on the
key?**

No, because it's an indexed *equality* lookup on a unique btree index
(`ApiClient.keyHash`), not a character-by-character comparison in
application code. Postgres resolves it to roughly one index page lookup
regardless of how many prefix characters happen to match a decoy, so there's
no exploitable timing differential the way there would be with a naive
`===` compare. That's the exact vulnerability `lib/timing-safe.ts` exists to
prevent *elsewhere* in this codebase, for session cookie tokens, which are
compared in application code, not via a DB index. I considered a
`timingSafeCompare` wrapper here too and decided against it: it would be
theater, the comparison never happens in JS at all.

---

**Q4. Does your Python verifier's HMAC timestamp actually prevent replay
attacks?**

No, and I want to be precise about why. The ±5-minute clock-skew window
(`verifier-service/app/auth.py`) bounds how long a captured, valid request
stays acceptable, that's strictly better than a bare signature with no
expiry, but there's no nonce store or used-signature cache anywhere in the
service. A captured request can be replayed freely within that window. The
one test covering this, `test_verify_with_expired_timestamp_is_rejected`,
proves the window boundary is enforced; it does not and cannot prove replay
is blocked inside the window, because it isn't. I found this exact gap in
the project's own documentation while preparing for this interview and
corrected the wording rather than leaving an overstated claim in place. The
real fix would be a seen-(timestamp, signature) cache held for the window's
duration, not implemented, because this service was never load-bearing in
production.

---

**Q5. Why is the dispatch lock an in-process `Map`, not a distributed lock?
What happens if you run more than one instance of this app?**

Correctly identified: `lib/dispatch-lock.ts`'s `withServerDispatchLock`
chains promises in a `globalThis` map, scoped to one Node process (it
survives Next.js's hot-module reload, but not a second instance). It
prevents the 60-second poller, the Run button, and the auto-run PUT path
from double-dispatching the same server *within one process*. Running two
app instances behind a load balancer would reintroduce the exact race this
exists to prevent. This app is deployed as a single Docker Compose
container today (`docker-compose.yml`), so it hasn't been a live problem,
but it's a real constraint, not a theoretical one: moving to a
horizontally-scaled deployment (the kind a multi-tenant SaaS or an Azure
App Service with >1 instance would want) requires moving this to a real
distributed lock, e.g. a Postgres advisory lock (`pg_advisory_lock`) since
the app already holds a `pg.Pool`, or a Redis-based lock if one gets
introduced for other reasons.

---

**Q6. Your kill switch fails closed on a database error. Why is that the
right default, and when would it be wrong?**

`lib/kill-switch.ts`'s `loadStateFromDb` catches a DB read failure and
returns `active: true, reason: "db_unavailable"` rather than assuming it's
safe to proceed. For a platform whose entire job is gating *autonomous*
agent actions, "we can't confirm it's safe" and "it's unsafe" should produce
the same outcome: halt. It would be the wrong default for something whose
cost of a false-positive halt is high and whose blast radius if wrong is
low, there it's a judgment call per subsystem, which is why the kill switch
has a `scope` (taskDispatch, selfHealing, autoCommit, autoPush,
agentExecution) instead of one global boolean, you can reason about each
independently.

---

**Q7. Why didn't you wire the Secret Broker in, even though your own audit
flagged it as a known gap?**

`lib/secret-broker.ts` is fully built, TTL-scoped credential issuance, but
has zero callers; task secrets are still injected as plain env vars at
dispatch time. Wiring it in means changing what the remote agent does to
fetch a credential, a protocol change on the agent side that I cannot
validate without a real SSH/tmux session against live worker infrastructure.
Forcing an unvalidated protocol change into the credential path, in an
environment where I can't test it end-to-end, is how you ship a security
regression, not how you fix one. I documented the exact integration point
instead of guessing at it.

---

**Q8. Why does `evaluatePolicy`'s glob matcher need a special case for
`**/`?**

`matchGlob` in `policy-engine.ts` converts `**/` to `(?:.*/)?` specifically,
not just `.*` for `**` followed by a literal slash. A naive substitution
would leave the slash as a required literal character, which means a
pattern like `**/.env` would match a *nested* `.env` (`a/b/.env`) but fail
to match a repo-root `.env`, the single most common and most sensitive
location, because there's no leading directory segment to satisfy the
required slash. `(?:.*/)?` makes that segment optional: zero or more
directories, not "at least one." This is the kind of off-by-one that only
shows up when you actually test the root-level case, which the test suite
does.

---

**Q9. What happens if `emitAudit` itself fails, does the operation it was
auditing get rolled back?**

No, and that's intentional, but worth being explicit about the trade-off.
`lib/audit.ts`'s `emitAudit` wraps its `prisma.auditEvent.create` in a
try/catch that only logs to `console.error`, it never throws. The design
choice is: an audit-logging failure should never cascade into blocking the
actual task/policy/validation operation it's describing, that would make
observability infrastructure a single point of failure for the product
itself. The honest cost is that a DB hiccup at exactly the wrong moment
silently drops an audit row with no retry and no dead-letter queue. For a
platform where audit completeness genuinely matters (this one included), a
production version should alert on `emitAudit` failures even though it
doesn't block on them, and ideally durably queue instead of just logging.

---

**Q10. Why TypeScript as the primary orchestrator instead of Python, given
this is an "AI platform" and Python is where most of that ecosystem lives?**

The orchestrator's job here is mostly conventional backend work: HTTP
routes, a relational data model, SSH/tmux process management, and a web UI,
Next.js and Prisma are a strong fit for that, and it's what the existing
single-operator app was already built in. The one piece that's
Python-native, independently classifying verification evidence, got its own
service instead of being bolted onto the Node app or used as an excuse to
rewrite the orchestrator. I'd make the same call again: pick the
orchestrator by what it orchestrates (processes, DB rows, HTTP), not by
language fashion.

---

**Q11. Why is the Python verifier a separate service instead of a library
call from the Node backend?**

Because of what it would need to *not* do to be a library call safely. The
Node backend already owns the SSH/tmux credential path
(`lib/ssh.ts`, `validation-gate.ts`'s `runIndependentValidation`). If the
verifier were an in-process Python library, it would either need its own
copy of those credentials (two credentialed code paths to the same remote
servers, a bigger attack surface for no benefit) or need to call back into
Node (pointless indirection). As a separate HTTP service that only
*classifies already-captured* evidence, HMAC-authenticated, it never touches
a credential at all. The network boundary is the point, not incidental.

---

**Q12. Why PostgreSQL instead of MongoDB for this domain?**

The domain is genuinely relational: a `Task` belongs to a `Project`, an
`ExecutionLog` belongs to a `Task`, a policy approval references a specific
category for a specific task, an `AuditEvent` references an entity by
type+id. `Prisma` + Postgres gives typed, enforced foreign keys and the
exact query-layer scoping Case B depends on
(`where: { id: { in: client.projectIds } }`) is a relational operation, not
a document-shape concern. MongoDB would work, but you'd be reimplementing
referential integrity in application code for no gain, this isn't a
document-shaped or schema-flexible problem. If the role specifically needs
MongoDB experience, I'd frame it honestly as: I'd reach for it on a
genuinely document-shaped problem (e.g. heterogeneous event payloads with no
shared schema), not as a default.

---

**Q13. What would full multi-tenancy actually require here, beyond what
`/api/v1` already does?**

Three things, in order of how disruptive they are: (1) a `tenantId`/`ownerId`
column on all ~30 Prisma models, plus a migration to backfill it, (2)
rewriting every existing list/detail query in the main app (not just
`/api/v1`) to filter by tenant, today they implicitly assume one operator,
(3) a UI redesign for account switching and the login flow, since the whole
app currently authenticates with one shared `AUTH_SECRET`. I deliberately
didn't attempt this: doing it properly is a real, multi-week migration with
regression risk across the entire app; doing it partially, a `tenantId`
column bolted onto 30 models without rewriting the query paths or the UI's
assumptions, would be building a system that merely *claims* multi-tenancy
without the enforcement backing it up, worse than not claiming it. The
scoped-service-account work is the genuine first slice.

---

**Q14. How would you approach deploying this on Azure, given that's a
listed priority for the role?**

This is a design sketch, not something implemented here; I want to be clear
about that distinction. The current deploy target is a single EC2 host via
Docker Compose (`deploy.yml`). An Azure equivalent: Azure Container Apps or
App Service for the Next.js container (note Q5's dispatch-lock caveat if
that means >1 instance), Azure Database for PostgreSQL Flexible Server in
place of the current self-managed Postgres container, Azure Key Vault for
`AUTH_SECRET`/`VERIFIER_SHARED_SECRET` instead of plain env vars, and the
verifier-service as its own Container App so its independent-scaling and
independent-failure properties (it's explicitly not load-bearing for task
completion) are preserved rather than accidentally coupled to the main
app's lifecycle. I have not built or tested any of this.

---

**Q15. How would observability and reliability scale from here?**

What exists today: every policy decision, kill-switch transition, and
validation outcome writes an `AuditEvent` row (queryable via a generic
`/api/audit` endpoint), and `emitAudit` is deliberately non-blocking (see
Q9). What's missing for real production scale: structured log shipping
(today it's `console.error`/`console.warn`), metrics/alerting on audit-write
failures and on kill-switch activations specifically, and the dispatch-lock
becoming a real distributed lock (Q5) before horizontal scaling. I'd
prioritize the distributed lock first, it's a correctness issue, not just an
observability gap, then alerting on kill-switch state and on validation
`VERIFICATION_FAILED` rates, since a spike there is the single most
actionable signal this system produces.

---

**Q16. What's the most important technical debt in this codebase right
now, in your own assessment?**

The Python verifier and the Secret Broker are both fully built, tested, and
unused, that's visible debt, clearly documented, low risk because nothing
depends on them. The debt I'd actually worry about first is the dispatch
lock (Q5): it's correct today and would silently become incorrect the
moment this app runs as more than one instance, with no error or warning at
the point that assumption breaks. Debt that fails loudly is cheap; debt
that fails silently under a deployment change nobody connects to it is the
expensive kind.
