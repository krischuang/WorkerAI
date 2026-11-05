# Demo Day Backup Plan — WorkerAI

Live AI demos fail for mundane reasons: flaky network, SSH hiccups, Docker
being slow to pull a layer, a laptop on guest wifi. This document is the
plan for when that happens, not just the one for when it doesn't.

## 1. What's captured and ready right now

`docs/DEMO_RUN_RECORD.md` holds **real, non-fabricated** captured output
from this session, for both halves of the demo:

- A full `demo:e2e` run — 13 real acceptance assertions, all PASS, including
  the two negative scenarios (`[LYING_AGENT]`, `[TOUCHES_ENV]`).
- A `demo:validation` run — agent says "passed," real re-execution says
  "failed," with the real stderr.
- A `demo:real-claude` run — the actual `claude` CLI, a real $0.19 API
  call, a real diff, independently re-verified.

Every one of these is labeled with the date it was captured and is honestly
described as *captured*, not live — if you show it, say "captured earlier
today," not "watch this happen now."

## 2. Restart procedure (if the live demo hangs or a container is stuck)

```bash
cd claude-task-monitor

# Nuke any stuck demo containers and retry
npx tsx scripts/demo-e2e/run.ts --clean
npm run demo:e2e
```

If Docker itself is the problem (daemon not running, out of disk):

```bash
docker ps        # confirm the daemon responds at all
docker system df # check disk space if builds are failing
```

If none of that resolves it within ~30 seconds, stop trying live and switch
to the captured record (§1) without apology — say what it is and move on.

## 3. Pre-flight — run on the actual presentation laptop, not just here

Do this the morning of, on the machine you'll actually present from:

```bash
cd claude-task-monitor
npm install          # confirm dependencies install cleanly on this machine
npm run lint && npm run typecheck && npm test && npm run build
npm run demo:e2e     # confirms Docker works on THIS laptop specifically
```

Docker/network conditions vary by machine — a run that worked on one laptop
is not proof it will work on another. This is the one step in this whole
plan that cannot be delegated to a prior capture.

## 4. No credentials on screen

- The demo never touches the real `.env` (production `DATABASE_URL`) —
  everything runs against a disposable local Postgres container (port 5432
  or whichever is free) and a disposable SSH worker container.
- `npm run demo:real-claude` uses whatever `claude` CLI auth is already
  configured on the presenting machine — don't open `~/.claude.json` or any
  terminal history that might echo it. The demo script itself never prints
  credential contents.
- If a terminal has old command history visible, clear it (`clear` /
  `Cmd+K`) before starting, in case an earlier debugging session left a
  connection string or token on screen.
- Do not run `env | grep -i key` or similar on stage.

## 5. Does not depend on any new deployment

Everything in this demo runs **locally**: a disposable Docker Postgres
container, a disposable Docker SSH worker container, and (for
`demo:real-claude`) a direct local CLI call. Nothing is deployed to a new
cloud resource for this demo, and nothing depends on the production
EC2/Docker Compose stack described in the root README being up or
reachable. A dead production server, or no internet access beyond what
`demo:real-claude`'s single API call needs, does not block the rest of the
demo.

## 6. Honesty labels — use these exact distinctions if asked

| What you're showing | What to call it |
|---|---|
| `demo:e2e` output (live or captured) | "The real dispatch pipeline — SSH, tmux, policy, kill switch — all real code. The agent inside the container is `fake-claude.sh`, an explicit scripted stand-in, not the real Claude CLI." |
| `demo:real-claude` output | "The real `claude` CLI, genuinely invoked, a real billed API call, a real diff." |
| Anything from `docs/DEMO_RUN_RECORD.md` | "A captured run from earlier today — not happening live right now." |
| `demo-adaptive-trust.ts` output | "Real production code computing a real score — the agent history it's scoring is synthetic fixture data, clearly labeled in the output itself, built to demonstrate the algorithm since there isn't yet enough real accumulated history to show this honestly." |
| Playwright E2E suite | Don't show live — known not fully green (see `docs/DEMO_DAY_FINAL_AUDIT.md`); not part of the demo narrative. |
