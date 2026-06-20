# Security Review — WorkerAI Branch (commits e85c8f2 → 38f0843)

**Date:** 2026-06-20
**Scope:** 14 files modified across 11 commits, covering admin secret rotation, webhook secret handling, agent status protection, workspace lifecycle, improvement-review prompt encoding, trigger-cycle hardening, artifact MIME-type allow-listing, and bulk task deletion.

---

## Findings

No confirmed HIGH or MEDIUM severity vulnerabilities were found in this PR.

---

## Candidate Findings Reviewed and Rejected

### Candidate 1 — Shell injection in `checkDiskSpace` (`workspace-lifecycle.ts`)
**Rejected — dead code, no callers**
`checkDiskSpace` is only reachable via `provisionTemporaryWorkspace`, which itself has zero callers anywhere in the codebase. No HTTP input can reach the interpolated shell string. Latent risk only; no exploitable attack path.

### Candidate 2 — Shell injection in `cleanupWorkspace` (`workspace-lifecycle.ts`)
**Rejected — no write path to `workspaceDir` from user input**
`Task.workspaceDir` is written exclusively by server-side code (`path.posix.join(baseDir, "workerai_<cuid>_<timestamp>")`). No API route — including the task import endpoint — accepts `workspaceDir` as a user-supplied field. Additionally, `workspace-lifecycle.ts` has no callers outside the file itself; the lifecycle functions are currently dead code.

### Candidate 3 — Prompt injection with embedded DB credentials (`improvement-review-service.ts`)
**Rejected — excluded by policy**
Applicable exclusion rule: *"Including user-controlled content in AI system prompts is not a vulnerability."* The `CLAUDE_SCAN_DB_URL` is an intentional design choice for the autonomous AI agent to write suggestions; XML-escaping and meta-instruction guardrails are present as defence-in-depth.

### Candidate 4 — Trigger-cycle endpoint missing admin gate (`/api/projects/[id]/trigger-cycle`)
**Rejected — single-operator model, no meaningful privilege boundary**
The route is protected by the standard `__auth` session cookie (checked in middleware) and a CSRF origin guard. In a single-operator deployment there is one user; the `__admin` / `__auth` tier distinction protects different UI surfaces for the same person, not separate users.

### Candidate 5 — Bulk task DELETE accessible without admin auth (`/api/tasks`)
**Rejected — single-operator model, adequate auth in place**
`DELETE /api/tasks` is fully gated by the session cookie and CSRF origin check in middleware. No unauthenticated path exists. In a single-user deployment the session cookie holder is the operator; requiring `__admin` on top would add no security value. The PR also added meaningful safeguards: terminal-status allow-list, 5,000-row cap, and `dryRun` mode.

---

## Positive Observations

The changes in this PR represent a genuine improvement to the security posture:

| Area | What was fixed |
|---|---|
| `requireAdmin` | Reads live session nonce; uses `timingSafeCompare` to eliminate timing side-channel |
| `escapeXml` | Full five-entity encoding replaces the prior broken import that only stripped closing tags |
| Webhook secret GET | Now returns `{ configured: boolean }` instead of the raw secret |
| Agent status | `status` field stripped from PUT accepted body; system-controlled only |
| Trigger-cycle | `autoImprovementPaused` guard + per-project rate limit added |
| Artifact download | MIME-type allow-list; executable types downgraded to `application/octet-stream`; `X-Content-Type-Options: nosniff` |
| Bulk task DELETE | Allow-list of terminal statuses; 5,000-row cap; `dryRun` support |
| Key rotation | `apiRateLimit` call that was documented but absent is now present |
| Shell args (git clone) | Switched from shell-string `execSync` to `spawnSync(argv)` locally; POSIX single-quote escaping for SSH path |

---

## Residual Risks (pre-existing, not introduced by this PR)

- **`AUTH_SECRET` missing in production** causes middleware to pass all requests through (warning only). Not new to this PR, but remains a misconfiguration footgun for public exposure.
- **Workspace lifecycle functions are dead code.** `provisionTemporaryWorkspace` / `cleanupWorkspace` contain a latent `rm -rf "${workspaceDir}"` shell injection. The fix (replace with `spawnSync("rm", ["-rf", workspaceDir])`) is low-effort and should be applied before these functions are wired to any route.
