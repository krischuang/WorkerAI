# Live Two-Agent Comparison, a genuine captured run (recorded, not live)

**This is a captured record of a real run, executed once on 2026-11-16 against
`/interview/live-comparison`, after the verification-status consistency fix.**
Everything below is quoted verbatim from `LIVE-DEMO-RECORDED-RUN.json` in this
same directory, the full raw event log from that run. Nothing here was
edited, re-worded, or re-run to get a nicer result. If live CLI auth or
network conditions make the real demo unreliable right before the interview,
use this as the fallback and say so explicitly: *"this is a recorded run from
earlier, not live."*

Run ID: `run_1794842728847`, started `2026-11-16T15:25:28.847Z`. Scenario:
multi-tenant task-API authorization (synthetic fixture, see `REQUIREMENTS.md`
content embedded in the raw JSON).

This run was also used to verify the fix for a real bug found and fixed in
this same session: the SSE route's `run-complete` event sent a hand-picked
field list that had fallen out of sync with `RunState`, so the Final
Decision panel could show "not run" while the execution log already showed
the real verdict. This run's own execution log and Final Decision panel were
confirmed consistent, both reading `INDEPENDENTLY_VERIFIED`, including after
a real browser page refresh.

## What happened, in order

1. **Agent A (Implementation Agent)**, real `claude` CLI process, `Read,Edit,Write,Bash`.
   Read `REQUIREMENTS.md`, `tasks-api.js`, `test.js`, then fixed the handler
   so tenant scope is derived only from the authenticated caller and a
   mismatched caller-supplied `tenantId` is denied rather than silently
   ignored. Ran the tests itself. **34.0s, $0.247.**

2. **Real `git diff` captured directly from the process** (not Agent A's
   description of its own change):

   ```diff
   diff --git a/tasks-api.js b/tasks-api.js
   index 2d543c1..fea834e 100644
   --- a/tasks-api.js
   +++ b/tasks-api.js
   @@ -12,11 +12,13 @@ const TASKS = [
      * `query` is the raw request query/params the caller supplied.
      */
    function getTasks(user, query) {
   -  // VULNERABLE: trusts the tenantId from the query string instead of the
   -  // authenticated user's own tenantId, letting any caller pass
   -  // ?tenantId=tenant-b and read another tenant's tasks.
   -  const tenantId = query.tenantId || user.tenantId;
   -  return TASKS.filter((t) => t.tenantId === tenantId);
   +  // Tenant scope always comes from the authenticated user. If the caller
   +  // supplied a tenantId that doesn't match their own, deny the request
   +  // rather than silently ignoring it and serving their own data instead.
   +  if (query.tenantId !== undefined && query.tenantId !== user.tenantId) {
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
   **18.6s, $0.173.**

4. **WorkerAI backend's own independent verification**, `runIndependentValidation`
   from `lib/validation-gate.ts`, unmodified, re-running the real `npm test`
   (and lint/typecheck/build) against the final workspace state:

   | command | real exit code | duration |
   |---|---|---|
   | `npm run lint` | 0 | 238ms |
   | `npm run typecheck` | 0 | 201ms |
   | `npm test` | 0 | 210ms |
   | `npm run build` | 0 | 206ms |

   **Backend verdict: `INDEPENDENTLY_VERIFIED`.**

## The three claims, side by side

| Layer | Label | Claim |
|---|---|---|
| Agent A's own text | `SELF-REPORTED` | "Both tests pass... In `tasks-api.js:14-20`, `getTasks` no longer trusts `query.tenantId` for scoping... STATUS: COMPLETE" |
| Agent B's own text | `REVIEWED` | "`getTasks` filters strictly by `user.tenantId`... `node test.js` output: `2 passing`... VERDICT: SATISFIES_REQUIREMENTS" |
| WorkerAI backend | `INDEPENDENTLY_VERIFIED` | Real `npm test` exit code `0`, computed from the process directly, not parsed from either agent's language |

In this particular captured run, all three agree again. Agent A fixed the
vulnerability correctly, Agent B's independent read of the same code
concurred, and the backend's real test execution backs both up. **That
agreement is not guaranteed on every run**, the honest point of this demo is
that the backend verdict is the one that doesn't depend on either agent
being right; this run happens to show all three evidence layers converging,
which is itself a legitimate, useful outcome to show, not a staged one.

## Full raw data

See `LIVE-DEMO-RECORDED-RUN.json` in this same directory, 39 real events,
including every tool call, tool result, and the exact NDJSON-derived text
each agent produced.
