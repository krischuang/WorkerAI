@AGENTS.md

# Claude Task Monitor

Local-first task management platform for tracking AI-assisted work across projects. No auth — single-user, runs on localhost only.

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
    StatusBadge.tsx   # task/project status badge (pending/queued/running/paused/completed/failed)
    PriorityBadge.tsx # P1–P4 priority badge
    InteractiveTerminal.tsx  # xterm.js client, loaded with next/dynamic (ssr: false)
  api/                # route handlers (all "use server" by default)
    dashboard/        # GET aggregate stats
    projects/         # CRUD
    tasks/            # CRUD + status update + execution logs + run (task→server dispatch)
    queue/            # GET pending tasks sorted by priority
    reports/daily/    # GET list + POST generate
    servers/          # CRUD + SSH connect + exec + run + claude-usage (tmux)
  dashboard/page.tsx
  projects/page.tsx
  projects/[id]/page.tsx
  tasks/page.tsx           # standalone task list with quick-create modal
  tasks/[id]/page.tsx      # task detail with server assignment, usage gate, run controls
  queue/page.tsx
  reports/daily/page.tsx
  servers/page.tsx
  servers/new/page.tsx
  servers/[id]/page.tsx    # server detail with Claude usage meters
  servers/[id]/terminal/page.tsx  # full-screen interactive terminal
  generated/prisma/   # auto-generated — never edit by hand
lib/
  prisma.ts           # Prisma singleton with pg.Pool (idleTimeoutMillis: 30s)
  ssh.ts              # SSH execution utility (execSSH + runSSHCommand allowlist)
  ssh-claude-tmux.ts  # Claude usage fetch + task dispatch via tmux
  ssh-claude.ts       # Legacy PTY/exec approach — kept but not used by active routes
prisma/
  schema.prisma       # single source of truth for all models
  migrations/         # never edit by hand
  seed.ts             # sample data
ws-server.ts          # standalone WebSocket SSH terminal server (port 3099)
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
// correct
fetch(`/api/foo/${id}`)
  .then((r) => {
    if (!r.ok) { router.push("/fallback"); return null; }
    return r.json();
  })
  .then((data) => { if (!data) return; /* use data */ });
```

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
| queued | violet — assigned to a server, waiting to run |
| running | blue |
| paused | amber |
| completed | green |
| failed | red |

## SSH Module (`lib/ssh.ts`)

Two exported functions:

- **`execSSH(config, command, timeoutMs?, signal?)`** — runs any shell command. No allowlist. Accepts an `AbortSignal` to close the connection when the caller cancels. Default timeout 15 s.
- **`runSSHCommand(config, command: AllowedCommand)`** — allowlist-enforced wrapper. Used by environment check buttons only.

### SSH security rules (must remain in effect)

- SSH private key content is **never** stored in the database and **never** sent to the frontend. Only `sshKeyPath` (a filesystem path) is stored.
- `runSSHCommand` only executes commands in `ALLOWED_COMMANDS`. Do not bypass this for the environment check buttons.
- The `/api/servers/[id]/exec` route (custom terminal) allows arbitrary commands intentionally — this is a deliberate product decision for a local-only tool.

### Timeouts

| Route | Timeout |
|---|---|
| `/api/servers/[id]/run` (env checks) | 15 s |
| `/api/servers/[id]/exec` (terminal) | 10 min (`maxDuration = 600`) |
| `/api/servers/[id]/claude-usage` | 30 s |
| `/api/tasks/[id]/run` | 30 s |

## Claude Usage Monitoring (`lib/ssh-claude-tmux.ts`)

Fetches Claude CLI usage by interacting with a `claude` tmux session on the remote server.

**Setup required once on the worker server:**
```bash
tmux new-session -d -s claude
tmux send-keys -t claude 'claude' Enter
```

**Key exports:**
- `fetchClaudeUsageViaTmux(config)` — sends `/usage` to the tmux session and parses the output. Returns `ClaudeUsageResult` with `parsed.sessionPct`, `parsed.sessionResets`, `parsed.weekPct`, `parsed.weekResets`, plus `sessionResetsAt`/`weekResetsAt` (UTC Date) for countdown math.
- `sendTaskToTmux(config, { title, description })` — base64-encodes the task text and pastes it into the Claude tmux session via `tmux load-buffer` + `paste-buffer`. Called by `POST /api/tasks/[id]/run`.

**Why tmux capture-pane instead of PTY/exec:**
- Claude Code renders a TUI with cursor-positioning escape codes — PTY capture is unreliable
- `tmux capture-pane -p` returns the terminal screen as already-rendered plain text, no ANSI codes

**Usage data persisted to DB** (`Server` model fields):
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

## Task Execution Flow

Tasks can be assigned to a server and dispatched to the Claude CLI running in tmux.

**Assignment:** `PUT /api/tasks/[id]` with `{ serverId }` — auto-advances status from `pending` → `queued`.

**Execution gate (`POST /api/tasks/[id]/run`):**
1. Reads cached usage from DB (no SSH round-trip at run-time)
2. If `sessionPct >= 90` OR `weekPct >= 90` → returns `{ blocked: true, nearestResetsAt }` — does NOT run
3. If clear → calls `sendTaskToTmux`, marks task `running`, creates an `ExecutionLog`

**Frontend (task detail page):**
- Shows usage progress bars for the assigned server
- Run button is disabled if either metric ≥ 90%
- If the API returns `blocked`: shows an amber panel with a live countdown (`H:MM:SS`) to the nearest reset — auto-fires the run when the countdown hits zero

## Interactive Terminal (`ws-server.ts`)

`npm run dev` starts both Next.js and the WebSocket terminal server via `concurrently`. The WebSocket server can also be started alone with `npm run ws`.

| Process | Port | Purpose |
|---|---|---|
| Next.js (Turbopack) | 3000 | App UI and REST API |
| WebSocket SSH server | 3099 | Interactive PTY terminal (override with `WS_PORT=xxxx`) |

**Architecture:**
- `ws-server.ts` — standalone `tsx` process; manages SSH sessions with `ssh2.shell()` + PTY allocation
- `app/_components/InteractiveTerminal.tsx` — xterm.js client component; loaded via `next/dynamic` with `ssr: false`
- `app/servers/[id]/terminal/page.tsx` — full-screen terminal page

**Protocol** (JSON over WebSocket):

```
// Client → server
{ type: "input", data: string }            // user keystrokes
{ type: "resize", cols: number, rows: number }  // terminal resize

// Server → client
{ type: "connected" }                      // SSH shell ready
{ type: "output", data: string }           // base64-encoded PTY output
{ type: "disconnected", reason?: string }  // shell exited
{ type: "error", message: string }         // connection failure
```

Terminal output is base64-encoded so binary ANSI/UTF-8 bytes survive JSON serialization.

**Security:**
- SSH private key is read on the server; never sent to the browser
- WebSocket server rejects connections from non-localhost origins
- Port defaults to 3099; override with `WS_PORT=xxxx npm run ws` (update `WS_URL` in `InteractiveTerminal.tsx` to match)
- Sessions auto-close after 30 minutes of idle

**The exec-mode terminal** (one-off commands, no PTY) is preserved on the server detail page at `/servers/[id]`. The interactive terminal lives at `/servers/[id]/terminal`.

## Data Models (summary)

```
Project  (P1–P4 priority, active/paused/archived)
  └── Task  (P1–P4, pending/queued/running/paused/completed/failed, taskType, estimatedCostLevel)
        └── ExecutionLog  (status, logText, outputSummary, errorMessage)

Server  (host, username, port, sshKeyPath, status: unknown/connected/failed)
  ├── Task[]           — tasks assigned to this server for execution
  ├── ServerCommandLog — SSH command history
  └── Claude usage fields (sessionPct, weekPct, resetsAt, …)

DailyReport  (completedCount, failedCount, runningCount, pendingCount, reportText)
```

All IDs are cuid strings. Cascade deletes are set on all child relations. `Task.serverId` uses `onDelete: SetNull` — deleting a server unassigns its tasks rather than deleting them.

## Environment Variables

```
DATABASE_URL="postgresql://postgres:postgres_dev@localhost:5432/claude_task_monitor?schema=public"
```

Set in `.env`. `prisma/seed.ts` requires `import "dotenv/config"` at the top because `tsx` does not auto-load `.env`.

## Known Limitations

- **No authentication** — do not expose this app to the network.
- **`ssh2` is incompatible with Turbopack's production build** (`non-ecmascript placeable asset`). The dev server works fine. Production builds are blocked until this upstream issue is resolved.
- **Usage data is cached** — the task execution gate reads usage from the DB, not from a live SSH check. Refresh usage from the server detail page before running if the cached data is stale (>10 min warning shown).
