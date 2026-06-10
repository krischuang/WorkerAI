@AGENTS.md

# Claude Task Monitor

Task management platform for tracking AI-assisted work across projects. Password-protected; single-user.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.7, App Router, Turbopack |
| Language | TypeScript, React 19 |
| Database | PostgreSQL (Docker), Prisma 7, `@prisma/adapter-pg` |
| Styling | Tailwind CSS v4 (CSS-based config, no `tailwind.config.js`) |
| SSH | `ssh2` Node.js library |
| Terminal | `xterm.js` + WebSocket (`ws`) for interactive PTY |
| Font | Geist (via `next/font`) |

## Running the Project

```bash
npm run dev          # start Next.js + WebSocket terminal server (concurrently)
npm run ws           # start WebSocket terminal server only
npm run db:migrate   # run pending migrations
npm run db:seed      # seed with sample projects/tasks
npm run db:generate  # regenerate Prisma client after schema changes
npm run db:studio    # open Prisma Studio
npm run db:reset     # wipe and re-migrate (destructive)
```

PostgreSQL runs in Docker container `medflow-postgres` on port 5432.
Credentials: user `postgres`, password `postgres_dev`, database `claude_task_monitor`.

## Project Structure

```
app/
  _components/        # shared UI components
    ui.tsx            # design system: PageHeader, Btn, Modal, FormField, EmptyState, inputCls, …
    Nav.tsx           # sidebar navigation
    StatusBadge.tsx   # task/project/agent status badge
    PriorityBadge.tsx # P1–P4 priority badge
    InteractiveTerminal.tsx  # xterm.js client, loaded with next/dynamic (ssr: false)
  api/                # route handlers
    auth/             # POST (login) + DELETE (logout) — session cookie
    dashboard/        # GET aggregate stats
    projects/         # CRUD
    tasks/            # CRUD + status update + execution logs + run
    queue/            # GET pending tasks sorted by priority
    reports/daily/    # GET list + POST generate
    servers/          # CRUD + SSH connect + exec + run + claude-usage + launch-claude
    agents/           # CRUD + claude-usage + launch-claude
  login/page.tsx
  dashboard/page.tsx
  projects/page.tsx
  projects/[id]/page.tsx
  tasks/page.tsx
  tasks/[id]/page.tsx      # task detail — server/agent assignment, usage gate, run controls
  queue/page.tsx
  reports/daily/page.tsx
  servers/page.tsx
  servers/new/page.tsx
  servers/[id]/page.tsx
  servers/[id]/terminal/page.tsx
  generated/prisma/   # auto-generated — never edit by hand
lib/
  prisma.ts           # Prisma singleton with pg.Pool (idleTimeoutMillis: 30s)
  ssh.ts              # SSH execution utility (execSSH + runSSHCommand allowlist)
  ssh-claude-tmux.ts  # Claude usage fetch + idle detection + task dispatch via tmux
  ssh-claude.ts       # Legacy PTY/exec approach — kept but not used by active routes
  usage-parser.ts     # Pure functions: parse /usage output, cleanPane, classifyIdlePane
  task-dispatch.ts    # tryDispatchTaskToServer + tryDispatchTaskToAgent (atomic, locked)
  dispatch-lock.ts    # Per-resource mutex (globalThis map, survives HMR)
  dispatch-backoff.ts # Exponential backoff for failed dispatches; agent-offline backoff
  exec-guards.ts      # isLocalOrigin — guards WebSocket and exec routes
  api-error.ts        # serverError(tag, err) — uniform 500 response helper
  constants.ts        # USAGE_THRESHOLD = 90
  prompt-sanitiser.ts # buildDispatchPrompt — sanitises task text before sending to tmux
  ssh-key-path.ts     # resolveSSHKeyPath — expands ~ and validates key file paths
prisma/
  schema.prisma       # single source of truth for all models
  migrations/         # never edit by hand
  seed.ts             # sample data
ws-server.ts          # standalone WebSocket SSH terminal server (port 3099)
instrumentation.node.ts  # background poller — usage refresh + idle detection + queue advance
```

## Key Patterns

### Prisma 7 (breaking change from v5/v6)

Always use the driver adapter. The client requires it — `new PrismaClient()` alone will throw.

```typescript
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
```

Import path is `@/app/generated/prisma/client` — not `@prisma/client`.

After any schema change: `npm run db:generate`. After any schema change that adds a relation, also restart the dev server — Turbopack caches the old generated client.

Use the **callback form** of `$transaction` when issuing multiple writes — it gives the adapter a single connection and prevents "client already executing a query" pg warnings:

```typescript
await prisma.$transaction(async (tx) => {
  await tx.task.update({ where: { id }, data: { status: "running" } });
  await tx.executionLog.create({ data: { … } });
});
```

### Next.js App Router route params

Params are async in Next.js 16:

```typescript
type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
}
```

### Turbopack workspace root

A `package-lock.json` at `/Users/kai/` confuses Turbopack's workspace detection. Fixed in `next.config.ts`:

```typescript
turbopack: { root: path.resolve(__dirname) }
```

Do not remove this.

### Tailwind CSS v4

Config is CSS-only — there is no `tailwind.config.js`. Theme tokens are set in `app/globals.css` with `@theme inline { … }`. To add custom tokens, edit that file.

### All pages are client components

Every page uses `"use client"` and fetches data with `useEffect` + `fetch`. There are no server components fetching data — keep it that way for simplicity.

### Error-safe data loading pattern

Always return `null` on non-OK responses and guard the next `.then`. Missing the `return` causes `.json()` to be called on an empty error body:

```typescript
fetch(`/api/foo/${id}`)
  .then((r) => {
    if (!r.ok) { router.push("/fallback"); return null; }
    return r.json();
  })
  .then((data) => { if (!data) return; /* use data */ });
```

## Authentication

Password authentication is required. The password is set via the `APP_PASSWORD` env var (hashed with bcrypt and stored in the DB or compared at runtime — see `app/api/auth/route.ts`).

- `POST /api/auth` — validates password, sets a session cookie
- `DELETE /api/auth` — clears the session cookie (logout)
- `/login` — login page; redirects to dashboard on success

The WebSocket server (`ws-server.ts`) still only accepts connections from `localhost` or origins listed in `ALLOWED_ORIGINS`. The REST API also enforces `isLocalOrigin` on sensitive routes.

**`ALLOWED_ORIGINS` env var** — comma-separated extra hostnames/IPs that `isLocalOrigin` should accept (in addition to `localhost`, `127.0.0.1`, `::1`). Useful when the app is accessed via a local tunnel or secondary NIC.

## Design System (`app/_components/ui.tsx`)

Import shared components from here:

```typescript
import { PageHeader, BackLink, EmptyState, LoadingState, Modal, Btn, ModalActions, FormField, inputCls } from "@/app/_components/ui";
```

- **`inputCls`** — standard class string for all `<input>`, `<select>`, `<textarea>`. Includes WCAG-AA focus ring and placeholder color. Use `${inputCls} font-mono` for code inputs.
- **`Btn`** — variants: `primary`, `secondary`, `danger`, `ghost`. Sizes: `sm`, `md`.
- **`Modal`** — sizes: `md` (max-w-md), `lg` (max-w-lg). Always pair with `ModalActions` for the footer.
- **`FormField`** — wraps label + input + optional hint text.

### Color rules (WCAG AA)

| Use | Class | Contrast on white |
|---|---|---|
| Primary text | `text-zinc-900` | 18:1 ✓ |
| Secondary text, descriptions | `text-zinc-700` | 9.7:1 ✓ |
| Meta, timestamps, captions | `text-zinc-600` | 7.3:1 ✓ |
| Placeholder | `text-zinc-500` | 4.6:1 ✓ |
| **Never on light bg** | `text-zinc-400` | 2.4:1 ✗ |

Nav uses `bg-zinc-900` dark sidebar — `text-zinc-400` passes there (7.1:1) and is used for inactive labels.

### Status badge colours

| Status | Colour |
|---|---|
| pending | zinc (grey) |
| queued | violet — assigned to a server/agent, waiting to run |
| running | blue |
| paused | amber |
| completed | green |
| failed | red |

Agent status: `idle` (green), `running` (blue), `offline` (zinc), `error` (red).

## SSH Module (`lib/ssh.ts`)

Two exported functions:

- **`execSSH(config, command, timeoutMs?, signal?)`** — runs any shell command. No allowlist. Accepts an `AbortSignal` to close the connection when the caller cancels. Default timeout 15 s.
- **`runSSHCommand(config, command: AllowedCommand)`** — allowlist-enforced wrapper. Used by environment check buttons only.

### SSH security rules (must remain in effect)

- SSH private key content is **never** stored in the database and **never** sent to the frontend. Only `sshKeyPath` (a filesystem path) is stored.
- `runSSHCommand` only executes commands in `ALLOWED_COMMANDS`. Do not bypass this for the environment check buttons.
- The `/api/servers/[id]/exec` route (custom terminal) allows arbitrary commands intentionally — this is a deliberate product decision.

### Timeouts

| Route | Timeout |
|---|---|
| `/api/servers/[id]/run` (env checks) | 15 s |
| `/api/servers/[id]/exec` (terminal) | 10 min (`maxDuration = 600`) |
| `/api/servers/[id]/claude-usage` | 30 s |
| `/api/tasks/[id]/run` | 30 s |

## Claude Usage Monitoring (`lib/ssh-claude-tmux.ts`)

Fetches Claude CLI usage by interacting with a `claude` tmux session on the remote server.

**Setup required once on the worker server (per session name):**
```bash
tmux new-session -d -s <sessionName>
tmux send-keys -t <sessionName> 'claude' Enter
```

**Key exports (all require an explicit `tmuxSession: string` — no default):**
- `fetchClaudeUsageViaTmux(config, tmuxSession)` — sends `/usage` to the tmux session and parses the output. Returns `ClaudeUsageResult`.
- `detectClaudeIdle(config, tmuxSession)` — captures the pane and calls `classifyIdlePane`. Returns `ClaudeIdleResult` with `isIdle`, `paneText`, optional `error`, and `tmuxMissing` flag.
- `sendTaskToTmux(config, task, tmuxSession)` — base64-encodes the task and pastes it via `tmux load-buffer` + `paste-buffer`.
- `launchClaudeInTmux(config, mode, tmuxSession, workDir?)` — kills the running process and relaunches Claude CLI with the correct permission-mode flags.

Both `fetchClaudeUsageViaTmux` and `detectClaudeIdle` return an `offline`/`tmuxMissing` result immediately if `tmuxSession` is empty or blank — no SSH call is made.

**Why tmux capture-pane instead of PTY/exec:**
- Claude Code renders a TUI with cursor-positioning escape codes — PTY capture is unreliable
- `tmux capture-pane -p` returns the terminal screen as already-rendered plain text, no ANSI codes

**Usage data persisted to DB** (identical fields on both `Server` and `Agent` models):
```
claudeSessionPct      Float?
claudeSessionResets   String?    // e.g. "Jun 10, 1:10 am (Sydney)"
claudeSessionResetsAt DateTime?  // UTC — used for task execution countdown
claudeWeekPct         Float?
claudeWeekResets      String?
claudeWeekResetsAt    DateTime?
claudeUsageRaw        String?
claudeUsageFetchedAt  DateTime?
```

Reset times are converted from UTC to `Australia/Sydney` timezone for display.

## Idle Pane Detection (`lib/usage-parser.ts`)

`classifyIdlePane(pane: string): IdleClassification` — pure function; takes already-cleaned pane text and returns `{ isIdle, hasPrompt, isBusy }`.

- **`hasPrompt`** — a bare `>` or `❯` appears in the last 6 non-empty lines (covers Claude Code's status-bar footer rendered below the prompt).
- **`isBusy`** — any of: spinner chars `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, `\bThinking\b`, or `esc to interrupt` in the tail.
- **`isIdle`** — `hasPrompt && !isBusy`.

The 6-line tail window means a prompt buried more than 6 lines from the bottom is NOT considered idle.

**Rate-limit false-positive:** `fetchClaudeUsageViaTmux` scans the full pane text for `rate-limit` / `too many requests` before sending `/usage`. If a previous task left a rate-limit error message visible in the pane, refresh will return `status: "rate_limited"` even when the API is fine. Fix: push new output into the pane (press Enter a few times) to scroll past the stale error.

## Task Dispatch (`lib/task-dispatch.ts`)

Two atomic dispatch functions, each serialised with a per-resource mutex from `lib/dispatch-lock.ts`:

- **`tryDispatchTaskToServer(opts)`** — dispatches to a server's `tmuxSession`. Requires `tmuxSession` in opts.
- **`tryDispatchTaskToAgent(opts)`** — dispatches to an agent's `tmuxSession`. Returns `tmux_missing` immediately if `tmuxSession` is blank; also marks the agent `offline` in the DB if the session doesn't exist.

Failure reasons: `already_running` | `task_not_dispatchable` | `ssh_failed` | `tmux_missing`.

The dispatch lock uses `globalThis._serverDispatchLocks` so it survives Next.js HMR module re-evaluation.

## Dispatch Backoff (`lib/dispatch-backoff.ts`)

Prevents the background poller from hammering a broken server or offline agent on every 60 s tick.

**Task dispatch backoff** — exponential, stored in `globalThis._dispatchBackoff` (`Map<taskId, BackoffEntry>`):
- Base delay: 1 min after first failure
- Cap: 5 min
- Cleared on success (`clearDispatchBackoff`)

**Agent offline backoff** — fixed 5 min window, stored in `globalThis._agentOfflineStore` (`Map<agentId, expiryMs>`):
- Set when `detectClaudeIdle` returns `tmuxMissing: true`
- Cleared when the agent comes back online

## Background Poller (`instrumentation.node.ts`)

Runs on a 60 s interval via `setInterval` inside `register()`. A `globalThis._pollerRunning` flag prevents overlapping cycles.

**Each cycle:**
1. Fetch Claude usage for every server (via its `tmuxSession`)
2. Fetch Claude usage for every agent (via its own `tmuxSession`), skipping agents in offline-backoff
3. Check running server-direct tasks for idle state → mark completed
4. Check running agent tasks for idle state → mark completed; set agent `offline` on `tmuxMissing`
5. Auto-advance server queue: dispatch next `queued` task if server is idle and usage < `USAGE_THRESHOLD` (90%)
6. Auto-advance agent queue: dispatch next `queued` agent task if agent is idle and usage < threshold

`USAGE_THRESHOLD` is imported from `lib/constants.ts` (value: 90).

## Task Execution Flow

Tasks can be assigned to a **server** (server-direct) or an **agent** (agent-direct). Both paths share the same execution gate and status lifecycle.

**Assignment:**
- `PUT /api/tasks/[id]` with `{ serverId }` → status `pending` → `queued`
- `PUT /api/tasks/[id]` with `{ agentId }` → status `pending` → `queued`

**Execution gate (`POST /api/tasks/[id]/run` or poller):**
1. Reads cached usage from DB (no SSH round-trip at run-time)
2. If `sessionPct >= 90` OR `weekPct >= 90` → blocked; returns `{ blocked: true, nearestResetsAt }`
3. If clear → calls `tryDispatchTaskToServer` or `tryDispatchTaskToAgent`, marks task `running`, creates `ExecutionLog`

**Frontend (task detail page):**
- Shows usage progress bars for the assigned server or agent
- Run button is disabled if either metric ≥ 90%
- If blocked: amber panel with live countdown (`H:MM:SS`) to nearest reset; auto-fires when countdown hits zero

## Agents (`model Agent`)

Agents are named Claude CLI instances that each have their own tmux session on a server. Unlike server-direct tasks (which share the server's single tmux session), each agent has an isolated session and working directory.

| Field | Notes |
|---|---|
| `serverId` | parent server (cascade delete) |
| `name` / `slug` | display name and URL-safe ID; `(serverId, slug)` is unique |
| `workDir` | working directory passed as `HOME=<workDir>` when launching Claude |
| `tmuxSession` | required; must be set before any dispatch |
| `status` | `idle` / `running` / `offline` / `error` |
| `claudePermissionMode` | `read_only` / `workspace_write` / `full_autonomous` |
| Claude usage fields | same set as `Server` |

**Setup required once per agent on the worker server:**
```bash
tmux new-session -d -s <agent.tmuxSession>
tmux send-keys -t <agent.tmuxSession> 'claude' Enter
```

API routes under `app/api/agents/`:
- `GET/POST /api/agents` — list / create
- `GET/PUT/DELETE /api/agents/[id]` — detail / update / delete
- `POST /api/agents/[id]/claude-usage` — refresh usage via SSH
- `POST /api/agents/[id]/launch-claude` — kill & relaunch Claude CLI in the agent's tmux session

## Interactive Terminal (`ws-server.ts`)

`npm run dev` starts both Next.js and the WebSocket terminal server via `concurrently`. The WebSocket server can also be started alone with `npm run ws`.

| Process | Port | Purpose |
|---|---|---|
| Next.js (Turbopack) | 3000 | App UI and REST API |
| WebSocket SSH server | 3099 | Interactive PTY terminal (override with `WS_PORT=xxxx`) |

**Protocol** (JSON over WebSocket):

```
// Client → server
{ type: "input", data: string }
{ type: "resize", cols: number, rows: number }

// Server → client
{ type: "connected" }
{ type: "output", data: string }           // base64-encoded PTY output
{ type: "disconnected", reason?: string }
{ type: "error", message: string }
```

Terminal output is base64-encoded so binary ANSI/UTF-8 bytes survive JSON serialization.

**Security:** SSH private key never sent to browser. WebSocket server rejects non-localhost origins (extended by `ALLOWED_ORIGINS`). Sessions auto-close after 30 minutes idle.

## Data Models (summary)

```
Project  (P1–P4 priority, active/paused/archived)
  └── Task  (P1–P4, pending/queued/running/paused/completed/failed, taskType, estimatedCostLevel)
        └── ExecutionLog  (status, logText, outputSummary, errorMessage)

Server  (host, username, port, sshKeyPath, tmuxSession, claudePermissionMode, status: unknown/connected/failed)
  ├── Task[]           — server-direct tasks
  ├── Agent[]          — agents hosted on this server
  ├── ServerCommandLog — SSH command history
  └── Claude usage fields (sessionPct, weekPct, resetsAt, …)

Agent  (name, slug, workDir, tmuxSession, claudePermissionMode, status: idle/running/offline/error)
  ├── server (parent Server)
  ├── Task[] — agent tasks
  └── Claude usage fields (same set as Server)

DailyReport  (completedCount, failedCount, runningCount, pendingCount, reportText)
```

All IDs are cuid strings. Cascade deletes on all child relations. `Task.serverId` and `Task.agentId` both use `onDelete: SetNull` — deleting a server or agent unassigns its tasks rather than deleting them.

## Environment Variables

```
DATABASE_URL="postgresql://postgres:postgres_dev@localhost:5432/claude_task_monitor?schema=public"
APP_PASSWORD="..."           # required; bcrypt-hashed password for login
ALLOWED_ORIGINS="..."        # optional; comma-separated extra hostnames for isLocalOrigin
```

Set in `.env`. `prisma/seed.ts` requires `import "dotenv/config"` at the top because `tsx` does not auto-load `.env`.

## Known Limitations

- **`ssh2` is incompatible with Turbopack's production build** (`non-ecmascript placeable asset`). The dev server works fine. Production builds are blocked until this upstream issue is resolved.
- **Usage data is cached** — the task execution gate reads usage from the DB, not from a live SSH check. Refresh usage from the server/agent detail page before running if the cached data is stale (>10 min warning shown).
- **Rate-limit false-positive on refresh** — if a previous task left a `rate_limit_error` visible in the tmux pane, the pre-flight scan in `fetchClaudeUsageViaTmux` will return `status: "rate_limited"` even though the API is fine. Press Enter in the tmux pane to push past the stale text.
