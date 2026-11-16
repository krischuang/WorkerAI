# Live Two-Agent Comparison, a genuine captured run (recorded, not live)

**This is a captured record of a real run, executed once on 2026-11-16 against
`/interview/live-comparison`.** Everything below is quoted verbatim from
`LIVE-DEMO-RECORDED-RUN.json` in this same directory, the full raw event log
from that run. Nothing here was edited, re-worded, or re-run to get a nicer
result. If live CLI auth or network conditions make the real demo unreliable
right before the interview, use this as the fallback and say so explicitly:
*"this is a recorded run from earlier, not live."*

Run ID: `run_1794839786821`. Scenario: multi-tenant task-API authorization
(synthetic fixture, see `REQUIREMENTS.md` content embedded below).

## What happened, in order

1. **Agent A (Implementation Agent)**, real `claude` CLI process, `Read,Edit,Write,Bash`.
   Read `REQUIREMENTS.md`, `tasks-api.js`, `test.js`. Made a first edit
   (naive: derive scope only from `user.tenantId`), then, based on the raw
   event log, refined it to a second, better version: explicitly deny the
   request when a caller supplies a mismatched `tenantId`, rather than only
   silently ignoring it. Ran the tests itself. **40.7s, $0.262.**

2. **Real `git diff` captured directly from the process** (not Agent A's
   description of its own change):

   ```diff
   diff --git a/tasks-api.js b/tasks-api.js
   index 2d543c1..02c0037 100644
   --- a/tasks-api.js
   +++ b/tasks-api.js
   @@ -12,11 +12,14 @@ const TASKS = [
     * `query` is the raw request query/params the caller supplied.
     */
    function getTasks(user, query) {
   -  // VULNERABLE: trusts the tenantId from the query string instead of the
   -  // authenticated user's own tenantId, letting any caller pass
   -  // ?tenantId=tenant-b and read another tenant's tasks.
   -  const tenantId = query.tenantId || user.tenantId;
   -  return TASKS.filter((t) => t.tenantId === tenantId);
   +  // Tenant scope is always derived from the authenticated caller, never from
   +  // client-supplied input. If the caller explicitly supplies a tenantId that
   +  // doesn't match their own, deny the request rather than silently
   +  // overriding it with their own scope.
   +  if (query.tenantId && query.tenantId !== user.tenantId) {
   +    return [];
   +  }
   +  return TASKS.filter((t) => t.tenantId === user.tenantId);
    }

    module.exports = { getTasks, TASKS };
   ```

3. **Agent B (Independent Reviewer)**, a separate real `claude` CLI process,
   `Read,Bash` only (no `Edit`/`Write`, structurally cannot alter the
   submission). Given the same `REQUIREMENTS.md`, not Agent A's reasoning.
   Independently read the resulting code and ran the tests itself.
   **12.8s, $0.166.**

4. **WorkerAI backend's own independent verification**, `runIndependentValidation`
   from `lib/validation-gate.ts`, unmodified, re-running the real `npm test`
   (and lint/typecheck/build) against the final workspace state:

   | command | real exit code | duration |
   |---|---|---|
   | `npm run lint` | 0 | 231ms |
   | `npm run typecheck` | 0 | 199ms |
   | `npm test` | 0 | 213ms |
   | `npm run build` | 0 | 203ms |

   **Backend verdict: `INDEPENDENTLY_VERIFIED`.**

## The three claims, side by side

| Layer | Label | Claim |
|---|---|---|
| Agent A's own text | `SELF-REPORTED` | "Both tests pass... This satisfies both the positive-path test... and the negative-path test... STATUS: COMPLETE" |
| Agent B's own text | `REVIEWED` | "Both tests pass (`2 passing`)... This matches all four acceptance criteria in REQUIREMENTS.md... VERDICT: SATISFIES_REQUIREMENTS" |
| WorkerAI backend | `INDEPENDENTLY_VERIFIED` | Real `npm test` exit code `0`, computed from the process directly, not parsed from either agent's language |

In this particular captured run, all three agree, Agent A genuinely fixed the
vulnerability and iterated to a better fix on its own, Agent B's independent
read of the same code concurred, and the backend's real test execution backs
both up. **That agreement is not guaranteed on every run**, the honest point
of this demo is that the backend verdict is the one that doesn't depend on
either agent being right; this run happens to show all three evidence layers
converging, which is itself a legitimate, useful outcome to show, not a
staged one.

## Full raw data

See `LIVE-DEMO-RECORDED-RUN.json` in this same directory, 40 real events,
including every tool call, tool result, and the exact NDJSON-derived text
each agent produced.
