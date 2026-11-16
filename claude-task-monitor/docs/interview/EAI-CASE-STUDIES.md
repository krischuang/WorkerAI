# Three Backend Case Studies

Each case names the exact file and test backing every claim. Nothing here is
simulated for this document, the commands below were actually run against
this repository.

---

## Case A: Independent Task Verification

**File:** `lib/validation-gate.ts`. **Live demo:** `npm run demo:validation`.

### The state machine

```ts
type VerificationState =
  | "NOT_VERIFIED"           // mandatory verification could not run at all
  | "AGENT_REPORTED"         // raw, unverified input from the agent itself
  | "INDEPENDENTLY_VERIFIED" // real commands re-run, real exit codes agree
  | "VERIFICATION_FAILED";   // agent said failed, or re-execution disagreed
```

Invariant enforced in one place: `allowed === true` implies
`verificationState === "INDEPENDENTLY_VERIFIED"`. There is no code path that
sets `allowed = true` from `AGENT_REPORTED` or `NOT_VERIFIED` alone, including
when verification is mandatory but unavailable (no workspace, or the
verification attempt itself fails), that resolves to `NOT_VERIFIED`, which
blocks completion rather than silently trusting the claim.

### What actually happens, step by step

1. **Agent self-reported success.** A task's tmux pane contains
   `[WORKERAI_VALIDATION] result: passed`. This is parsed and labeled
   `AGENT_REPORTED`, a raw claim, not yet trusted.
2. **Actual command execution.** `runIndependentValidation()` re-runs a fixed
   allowlist (`npm run lint`, `typecheck`, `test`, `build`) against the task's
   real workspace, over the real SSH connection, and captures the real exit
   codes. The allowlist is a literal `Set` checked on every call, even if a
   caller supplies a custom command list, there is no way to smuggle an
   arbitrary command through.
3. **Test failure.** In the recorded demo run, `test` exits non-zero:
   `AssertionError: add(2,2) should be 4, got '22' !== 4` (the agent's edit made
   `add()` concatenate instead of sum).
4. **Backend verification decision.** `independent.allPassed` is `false`
   because one command's exit code was non-zero. The gate ignores the
   agent's "passed" claim entirely at this point.
5. **Persisted task outcome.** `applyValidationGate` writes, in one place:
   - `Task.status = "failed"`, `Task.validationStatus = "failed"`
   - `Task.validationEvidence` = the agent's claim plus every command's real
     exit code, stdout/stderr (scrubbed of secrets), and `git diff --stat`
   - `Task.lastFailReason = "Independent validation failed despite the agent
     reporting success, see validationEvidence."`
   - an `AuditEvent` (`task.validation_failed`, actor `poller`) carrying the
     same evidence
   - a new follow-up `Task` (`taskType: maintenance`, `priority: P2`,
     `riskLevel: medium`, `isAutonomous: false`) whose description quotes the
     evidence verbatim, so a human (or another cycle) has something concrete
     to act on

### A second, separate gate most people miss

Even when every command passes, `applyValidationGate` runs one more check:
it re-reads `git status --short --ignored=matching` (the `--ignored` flag is
load-bearing: plain `git status` never lists gitignored paths, and `.env` is
gitignored by convention) and evaluates the **actually changed files**
through `policy-engine.ts`'s `file_change` category. A task that was fine to
*dispatch* can still *touch* a file it shouldn't have; this is evaluated
against what really changed on disk, independent of anything the agent
claimed.

### Failure-handling summary

| Scenario | Result |
|---|---|
| Agent claims pass, no workspace available | `NOT_VERIFIED`, status `needs_review` |
| Agent claims pass, verification attempt itself fails (e.g. SSH error) | `NOT_VERIFIED`, status `needs_review` |
| Agent claims pass, real re-execution disagrees | `VERIFICATION_FAILED`, status `failed`, follow-up task created |
| Agent claims pass, all commands pass, but changed a denied file | `VERIFICATION_FAILED`, status `failed`, follow-up task created |
| Agent explicitly claims failure | `VERIFICATION_FAILED`, status `failed`, follow-up task created |
| No validation block at all | `NOT_VERIFIED`, status `failed` (`validationStatus: "missing"`), no follow-up (no evidence to build one from) |
| Agent claims pass, all commands pass, no policy violation | `INDEPENDENTLY_VERIFIED`, `allowed: true` |

---

## Case B: Scoped Service-Account API

**Files:** `lib/service-account.ts`, `app/api/v1/**`, `app/api/admin/service-accounts/**`.
**Tests:** `lib/__tests__/service-account.test.ts`, 16 passing.

### Bearer-token authentication

```ts
// lib/service-account.ts
const keyHash = hashApiKey(rawKey);           // sha256, raw key never stored
const record = await prisma.apiClient.findUnique({ where: { keyHash } });
if (!record || record.revokedAt) return null; // revoked == unknown, same response
```

The raw key (`wai_sk_...`) is returned exactly once, at creation time
(`POST /api/admin/service-accounts`). Only the hash and a short, non-secret
prefix are persisted.

### Explicit project scoping: no wildcard

```ts
export async function createServiceAccount(opts: {
  name: string;
  projectIds: string[];   // never optional, never "*"
  ...
})
```

The admin route that mints a key (`app/api/admin/service-accounts/route.ts`)
rejects an empty `projectIds` array and rejects any ID that doesn't resolve
to a real project. A key can never be scoped to "everything" or to a typo.

### Database-level authorization

```ts
// app/api/v1/projects/[id]/route.ts
if (!isProjectInScope(client, id)) {
  return Response.json({ error: "Not found" }, { status: 404 }); // never 403
}
const project = await prisma.project.findUnique({ where: { id }, select: {...} });
```

```ts
// app/api/v1/projects/route.ts (list endpoint)
where: { id: { in: client.projectIds } }
```

The scope check happens in the Prisma query itself, not a post-fetch filter
and never in the UI. A scoped key physically cannot cause a query that reads
a row outside its `projectIds`.

### Cross-project access denial: the test that matters most

```ts
describe("isProjectInScope: cross-tenant leakage", () => {
  it("denies a project NOT in scope: the core cross-tenant-leakage guarantee", () => {
    const client = { id: "x", name: "x", projectIds: ["project-a"] };
    expect(isProjectInScope(client, "project-b")).toBe(false);
  });
});
```

An out-of-scope ID returns **404, identical to an unknown ID**: a scoped key
can never distinguish "exists but isn't yours" from "doesn't exist" (the same
IDOR philosophy already used elsewhere in this codebase, `lib/resource-access.ts`).

### What this is not

This is a backend-enforced **isolation primitive** for one additive surface
(`/api/v1`), not full multi-tenancy. There are still zero `userId`/`tenantId`
columns across the other 30 Prisma models, one shared operator password for
the main UI, and no per-user accounts or UI-level tenant switching. See
`EAI-TRADEOFFS.md` for exactly what full multi-tenancy would require.

---

## Case C: Python / FastAPI Verifier

**Files:** `verifier-service/app/{models,auth,verdict,main}.py`.
**Tests:** `verifier-service/tests/{test_api,test_verdict}.py`, 20 passing.

### API contract: Pydantic schemas

```python
class VerificationRequest(BaseModel):
    task_id: str = Field(..., min_length=1, max_length=128)
    agent_reported_status: Optional[Literal["passed", "failed"]] = None
    agent_evidence: Optional[str] = Field(default=None, max_length=8192)
    independent_results: list[CommandResult] = Field(default_factory=list, max_length=32)
    changed_files: list[str] = Field(default_factory=list, max_length=500)

class VerificationVerdict(BaseModel):
    task_id: str
    verification_state: VerificationState   # NOT_VERIFIED | INDEPENDENTLY_VERIFIED | VERIFICATION_FAILED
    allowed: bool
    reasons: list[str]
    risk_flags: list[str]
```

Every field is bounded (`max_length` on strings and lists), this is a
service that accepts evidence from a trusted peer, but it still validates
shape and size before touching it.

### Evidence processing: pure, dependency-free classification

`verdict.py`'s `classify()` takes zero I/O: it's a pure function over
already-captured command results, so it's directly unit-testable and reusable
outside the web layer. Order of checks: sensitive-file touch (independent,
re-implemented pattern match against `.env`, `.ssh/`, `id_rsa`, etc., a
second, separately-authored defense-in-depth check against the same class of
path `policy-engine.ts` denies) → agent said failed → no results supplied →
inconclusive exit codes → any non-zero exit code → only then
`INDEPENDENTLY_VERIFIED`.

### HMAC request authentication

```python
message = timestamp.encode() + b"." + raw_body
signature = hmac.new(secret.encode(), message, sha256).hexdigest()
```

`hmac.compare_digest` (timing-safe) checks the signature; an unconfigured
secret fails the request closed with a 503, never silently skips auth.

### The replay question, answered honestly

**Does the timestamp alone prevent replay? No.** The ±5-minute window bounds
*how long* a captured, valid request stays acceptable, that's strictly
better than a bare body signature with no expiry at all, but there is no
nonce store and no used-signature cache anywhere in this service (verified:
zero matches for `nonce`/`replay`/`cache` logic in `app/*.py` beyond the
docstring). A captured, still-valid request **can be resent any number of
times within that window**. The one relevant test,
`test_verify_with_expired_timestamp_is_rejected`, proves the window is
enforced; no test claims replay-within-the-window is blocked, because it
isn't. True replay prevention would need a seen-(timestamp, signature) cache
held for the window's duration. Not implemented. Documented, not hidden,
in `architecture.md` and this file's own comments (fixed during this pass,
previously overstated).

### Failure cases and tests

20 tests across two files. Representative failure-path coverage:
`test_verify_without_signature_headers_is_rejected`,
`test_verify_with_invalid_signature_is_rejected`,
`test_verify_with_expired_timestamp_is_rejected`,
`test_verify_tampered_body_after_signing_is_rejected`,
`test_sensitive_file_touched_fails_even_with_all_green_commands`,
`test_missing_exit_code_is_not_verified_not_failed` (an execution error is
never silently treated as a pass).

### What this is not

This service is demonstrated through a standalone HTTP workflow only:
`scripts/demo-python-verifier.ts` starts a real `uvicorn` process and makes
real signed HTTP calls against it. `lib/verifier-client.ts` exists and is
unit-tested (4 tests), but **nothing in the production completion path calls
it**: confirmed by searching the codebase for callers of
`callVerifierService`: only the demo script and its own test file. This is a
deliberate, documented choice (see `architecture.md` §5), not an oversight,
and this pass does not change that.
