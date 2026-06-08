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
| Font | Geist (via `next/font`) |

## Running the Project

```bash
npm run dev          # start dev server at localhost:3000
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
    StatusBadge.tsx   # task/project status badge with dot indicator
    PriorityBadge.tsx # P1–P4 priority badge
  api/                # route handlers (all "use server" by default)
    dashboard/        # GET aggregate stats
    projects/         # CRUD
    tasks/            # CRUD + status update + execution logs
    queue/            # GET pending tasks sorted by priority
    reports/daily/    # GET list + POST generate
    servers/          # CRUD + SSH connect + exec + run
  dashboard/page.tsx
  projects/page.tsx
  projects/[id]/page.tsx
  tasks/[id]/page.tsx
  queue/page.tsx
  reports/daily/page.tsx
  servers/page.tsx
  servers/new/page.tsx
  servers/[id]/page.tsx
  generated/prisma/   # auto-generated — never edit by hand
lib/
  prisma.ts           # Prisma singleton with pg.Pool (idleTimeoutMillis: 30s)
  ssh.ts              # SSH execution utility
prisma/
  schema.prisma       # single source of truth for all models
  migrations/         # never edit by hand
  seed.ts             # sample data
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

After any schema change: `npm run db:generate`.

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

## Data Models (summary)

```
Project  (P1–P4 priority, active/paused/archived)
  └── Task  (P1–P4, pending/running/paused/completed/failed, taskType, estimatedCostLevel)
        └── ExecutionLog  (status, logText, outputSummary, errorMessage)

Server  (host, username, port, sshKeyPath, status: unknown/connected/failed)
  └── ServerCommandLog  (command, status: success/failed, output, errorMessage)

DailyReport  (completedCount, failedCount, runningCount, pendingCount, reportText)
```

All IDs are cuid strings. Cascade deletes are set on all child relations.

## Environment Variables

```
DATABASE_URL="postgresql://postgres:postgres_dev@localhost:5432/claude_task_monitor?schema=public"
```

Set in `.env`. `prisma/seed.ts` requires `import "dotenv/config"` at the top because `tsx` does not auto-load `.env`.

## Known Limitations

- **No authentication** — do not expose this app to the network.
- **`ssh2` is incompatible with Turbopack's production build** (`non-ecmascript placeable asset`). The dev server works fine. Production builds are blocked until this upstream issue is resolved.
- Interactive SSH commands (e.g. bare `claude`, `vim`, `top`) do not work — the terminal uses `exec` mode with no PTY. Use `claude -p "prompt"` for non-interactive Claude CLI usage.
