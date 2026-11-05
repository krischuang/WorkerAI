# Real Claude Integration Feasibility Report

**Read-only investigation. No execution, no infrastructure changes, no paid
API calls were made to produce this report.**

## Question

Can a single demo run show the **real Claude CLI** making a change **through
the real SSH/tmux dispatch path**, combined, in one disposable
container/VM — safely (non-root, least-privilege, no production SSH
credentials, no host credential store mounted into the agent's workspace,
restricted network, resource limits, disposable git repo)?

## What exists today — re-inspected directly, not assumed

Two genuinely separate, real paths exist. Neither has ever been combined
into one execution:

| Path | What it proves | What it does NOT prove |
|---|---|---|
| `npm run demo:e2e` → `scripts/demo-e2e/` (Docker: `Dockerfile.worker` + `fake-claude.sh`) | Real SSH connection, real tmux session, real dispatch/policy/kill-switch/validation-gate code, real git diff, real `npm test` — all against a disposable container | **Not real Claude.** `fake-claude.sh` is an explicitly-labeled scripted stand-in (confirmed by reading the file: it waits for the real dispatch prompt, then branches on the task title to make a real-but-scripted code change). No `claude` binary runs inside this container at all. |
| `npm run demo:real-claude` → `scripts/demo-e2e/verify-real-claude.ts` | Real `claude` CLI (confirmed installed locally: `claude --version` → `2.1.220`), invoked non-interactively against a real disposable local git repo, with real independent re-verification via the production `runIndependentValidation` function | **No SSH, no tmux, no Docker.** Runs directly on the host, in a plain temp directory — it does not exercise `lib/task-dispatch.ts`'s SSH/tmux path at all. |

**Conclusion, re-verified**: there is still no single run that is both "real
Claude" and "real SSH/tmux dispatch" at once. The prior report's finding
holds.

## New finding this pass: an existing safety-rule violation

`scripts/demo-e2e/verify-real-claude.ts` line 123 invokes the real CLI as:

```ts
spawnSync("claude", ["-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json"], ...)
```

**This uses `bypassPermissions`, which the standing global safety rules for
this work explicitly prohibit** ("Do not use bypassPermissions"). This is a
pre-existing script, not something added this session, but it is a real
finding that must be reported, not silently carried forward.

This is **not fixed in this pass**, for the same reason the combined
pipeline is not built in this pass: the script makes one real, billed
Anthropic API call every time it runs, and verifying any change to its
Claude-invocation flags requires actually re-running it — i.e. a paid
execution — which requires your explicit approval under the standing rules
("Do not execute paid API calls without approval"). Changing the flag
without re-running it would mean shipping an unverified change to the one
script whose entire purpose is "proof it actually ran," which is worse than
leaving it as a disclosed, known issue.

**Recommended fix (not applied)**: replace `bypassPermissions` with a
narrower, still-non-interactive mode — e.g. `acceptEdits` (auto-accepts file
edits without a full permission bypass) combined with `--allowedTools`
scoped to exactly what the fixture task needs (`Read`, `Edit`, `Bash(npm
test)` or similar) — mirroring the least-privilege pattern
`lib/ssh-claude-tmux.ts`'s `read_only` mode already uses via
`--allowedTools`. This requires one approved, real, small-cost re-run to
confirm the task still completes and the acceptance assertions still pass
under the narrower permission mode.

## Why the combined pipeline is not built in this pass

Swapping `fake-claude.sh` for the real CLI inside `Dockerfile.worker`'s
container is the only way to get one execution that is both real-Claude and
real-SSH/tmux. Re-inspecting what that would actually require:

1. **Install the `claude` CLI inside the container image** — not currently
   present in `Dockerfile.worker` (it only installs `openssh-server tmux git
   coreutils procps`). This is a real Dockerfile change.
2. **Authenticate it inside the container, non-interactively.** The CLI
   needs either an API key injected at container-start time (`docker run -e
   ANTHROPIC_API_KEY=...`) or a mounted credential file. Both routes put a
   real, usable credential inside the demo container — exactly the
   "no host credential store mounted into the agent workspace" risk the
   brief calls out. An env-var-only injection (never baked into the image,
   never written to a mounted volume) is the least-bad option, but it is
   still a new credential-handling path that does not exist today and would
   need its own review before being called "safe."
3. **Network**: re-checked `scripts/demo-e2e/run.ts`'s actual `docker run`
   invocation — it passes no `--network` flag, so the container uses
   Docker's default bridge network with full outbound internet access. That
   happens to be sufficient to reach Anthropic's API, but it means the
   container is **not currently network-restricted** in the way the brief
   asks for ("restricted network") — reaching the stated safety bar would
   need an explicit egress allowlist (e.g. a custom network policy limiting
   the container to Anthropic's API endpoint only), which does not exist
   today.
4. **Resource limits**: re-checked the same `docker run` calls for both the
   worker and Postgres containers — neither sets `--memory` or `--cpus`.
   The brief's "resource limits" requirement is also not currently met,
   for either container, independent of the Claude question.
5. **A real, billed API call** to prove any of the above actually works —
   paid execution, requiring approval.

Items 1–4 are genuine infrastructure changes (new Dockerfile steps, a new
credential-injection path, a new network policy, new resource-limit flags)
— not a "safe, minimal improvement." Item 5 requires paid-execution
approval. Both independently trigger this task's own STOP condition.

## What IS already safe and already works (no blocker)

- `npm run demo:real-claude` on the host, alone — confirmed working, real,
  captured in `docs/DEMO_RUN_RECORD.md`, no Docker, no SSH, no production
  credentials, a disposable temp directory, modest real cost (~$0.19 per the
  existing captured record).
- `npm run demo:e2e` alone — confirmed working (13/13, this session),
  disposable containers, non-root, no production credentials, localhost-only
  port binding.
- Showing both, back-to-back, clearly labeled as two separate pieces of
  evidence (mocked-but-real-dispatch, and real-CLI-but-no-dispatch) is
  accurate and defensible. This is what the current 6-minute script and
  `DEMO_RUN_RECORD.md` already do, and it is not changed by this report.

## Verdict

**NOT VERIFIED — and not attempted this pass, by design.** A fully safe,
combined real-Claude + SSH/tmux execution is not currently implemented, and
building it safely would require Dockerfile changes, a new credential path,
a network policy, resource limits, and a paid verification run. Per the
explicit STOP instruction for this phase, this is reported as a blocker
rather than attempted as an unsafe shortcut. Do not claim the full pipeline
works live — it has not been run as one execution, mocked or real.

Separately: the existing `bypassPermissions` usage in
`verify-real-claude.ts` is a real, disclosed violation of the standing
safety rules, left unfixed pending your approval for the one paid re-run
needed to verify a safer replacement.
