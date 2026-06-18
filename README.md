# WorkerAI

A local-first task management platform for orchestrating AI-assisted work across remote servers. Manage projects and tasks, dispatch them to Claude CLI sessions running on worker servers, and monitor execution — all from a single web UI.

No authentication. Designed to run on localhost only.

---

## Features

- **Project & Task Management** — create projects with P1–P4 priority, track tasks through their full lifecycle (pending → queued → running → paused → completed / failed)
- **Server Management** — register remote SSH servers, verify connectivity, and inspect environment details
- **Claude Usage Monitoring** — fetch real-time session and weekly usage percentages from a remote Claude CLI tmux session; automatically blocks task dispatch when usage ≥ 90%
- **Task Dispatch via tmux** — send task descriptions directly into a running `claude` tmux session on a worker server; task status advances automatically
- **Interactive SSH Terminal** — full PTY terminal in the browser via WebSocket + xterm.js
- **Priority Queue** — view all pending tasks sorted by priority
- **Daily Reports** — generate and browse per-day execution summaries

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 16.2.7, App Router, Turbopack |
| Language | TypeScript 5, React 19 |
| Database | PostgreSQL (Docker), Prisma 7, `@prisma/adapter-pg` |
| Styling | Tailwind CSS v4 (CSS-only config, no `tailwind.config.js`) |
| SSH | `ssh2` Node.js library |
| Terminal | `xterm.js` + WebSocket (`ws`) for interactive PTY |
| Font | Geist (via `next/font`) |

---

## Project Structure

```
WorkerAI/
└── claude-task-monitor/          # main application
    ├── app/
    │   ├── _components/
    │   │   ├── ui.tsx                  # design system (PageHeader, Btn, Modal, FormField, …)
    │   │   ├── Nav.tsx                 # sidebar navigation
    │   │   ├── StatusBadge.tsx         # task/project status badge
    │   │   ├── PriorityBadge.tsx       # P1–P4 priority badge
    │   │   └── InteractiveTerminal.tsx # xterm.js client (loaded with next/dynamic, ssr: false)
    │   ├── api/
    │   │   ├── dashboard/route.ts      # GET aggregate stats
    │   │   ├── projects/               # CRUD for projects
    │   │   ├── tasks/                  # CRUD, status updates, execution logs, task run
    │   │   ├── queue/route.ts          # GET pending tasks sorted by priority
    │   │   ├── reports/daily/route.ts  # GET list + POST generate
    │   │   └── servers/                # CRUD, SSH connect/exec/run, Claude usage
    │   ├── dashboard/page.tsx
    │   ├── projects/
    │   │   ├── page.tsx
    │   │   └── [id]/page.tsx
    │   ├── tasks/
    │   │   ├── page.tsx                # task list with quick-create modal
    │   │   └── [id]/page.tsx           # task detail: server assignment, usage gate, run controls
    │   ├── queue/page.tsx
    │   ├── reports/daily/page.tsx
    │   ├── servers/
    │   │   ├── page.tsx
    │   │   ├── new/page.tsx
    │   │   ├── [id]/page.tsx           # server detail with Claude usage meters
    │   │   └── [id]/terminal/page.tsx  # full-screen interactive SSH terminal
    │   ├── generated/prisma/           # auto-generated Prisma client — never edit
    │   ├── globals.css                 # Tailwind v4 theme tokens via @theme inline {}
    │   └── layout.tsx
    ├── lib/
    │   ├── prisma.ts                   # Prisma singleton with pg.Pool
    │   ├── ssh.ts                      # execSSH + allowlist-enforced runSSHCommand
    │   ├── ssh-claude-tmux.ts          # Claude usage fetch + task dispatch via tmux
    │   └── ssh-claude.ts               # legacy PTY approach (not used by active routes)
    ├── prisma/
    │   ├── schema.prisma               # single source of truth for all models
    │   ├── migrations/                 # managed by Prisma — never edit by hand
    │   └── seed.ts                     # sample projects, tasks, servers
    ├── ws-server.ts                    # standalone WebSocket SSH terminal server (port 3099)
    ├── next.config.ts
    ├── prisma.config.ts
    ├── tsconfig.json
    └── package.json
```

---

## Data Models

```
Project  (P1–P4 priority, active/paused/archived)
  └── Task  (P1–P4, pending/queued/running/paused/completed/failed, taskType, estimatedCostLevel)
        └── ExecutionLog  (status, logText, outputSummary, errorMessage)

Server  (host, username, port, sshKeyPath, status: unknown/connected/failed)
  ├── Task[]            — tasks assigned to this server
  ├── ServerCommandLog  — SSH command history
  └── Claude usage fields (sessionPct, weekPct, resetsAt, …)

DailyReport  (completedCount, failedCount, runningCount, pendingCount, reportText)
```

All IDs are cuid strings. Cascade deletes are set on all child relations. `Task.serverId` uses `onDelete: SetNull` — deleting a server unassigns tasks rather than deleting them.

---

## Prerequisites

- Node.js 20+
- Docker (for the PostgreSQL container)
- A remote Linux server with `tmux` and `claude` CLI installed (for task dispatch and usage monitoring)

---

## Setup

### 1. Clone and install

```bash
git clone git@github.com:krischuang/WorkerAI.git
cd WorkerAI/claude-task-monitor
npm install
```

### 2. Start PostgreSQL

```bash
docker run -d \
  --name medflow-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres_dev \
  -e POSTGRES_DB=claude_task_monitor \
  -p 5432:5432 \
  postgres:16
```

### 3. Configure environment

Create `.env` in `claude-task-monitor/`:

```env
DATABASE_URL="postgresql://postgres:postgres_dev@localhost:5432/claude_task_monitor?schema=public"
```

### 4. Migrate and seed the database

```bash
npm run db:migrate   # run all migrations
npm run db:seed      # load sample data (optional)
```

### 5. Start the development server

```bash
npm run dev
```

This starts both Next.js (port 3000) and the WebSocket SSH terminal server (port 3099) concurrently.

Open [http://localhost:3000](http://localhost:3000).

---

## npm Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Next.js + WebSocket terminal server |
| `npm run ws` | Start WebSocket terminal server only |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | ESLint |
| `npm run db:generate` | Regenerate Prisma client after schema changes |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:push` | Push schema without migration history |
| `npm run db:seed` | Seed with sample data |
| `npm run db:studio` | Open Prisma Studio |
| `npm run db:reset` | Wipe and re-migrate (destructive) |

---

## Worker Server Setup (Claude tmux session)

Task dispatch and usage monitoring require a persistent `claude` tmux session on the worker server. Run once after SSH-ing in:

```bash
tmux new-session -d -s claude
tmux send-keys -t claude 'claude' Enter
```

The app communicates with this session via `tmux send-keys` and `tmux capture-pane`. Never close this session while tasks are running.

---

## Task Execution Flow

1. **Create** a task under a project (priority P1–P4, type: coding/research/writing/review/maintenance)
2. **Assign** a server — status auto-advances `pending` → `queued`
3. **Check usage** on the server detail page — fetches live data from the tmux session
4. **Run** from the task detail page:
   - If `sessionPct ≥ 90%` or `weekPct ≥ 90%`, dispatch is blocked; a countdown to the next reset is shown and the run fires automatically when it hits zero
   - Otherwise, the task text is base64-encoded and pasted into the Claude tmux session; task status advances to `running` and an `ExecutionLog` is created

---

## Interactive Terminal

Full PTY terminal over WebSocket, available at `/servers/[id]/terminal`.

| Process | Port |
|---|---|
| Next.js | 3000 |
| WebSocket SSH server | 3099 |

Override the WebSocket port: `WS_PORT=xxxx npm run ws` (also update `WS_URL` in `InteractiveTerminal.tsx`).

Sessions auto-close after 30 minutes of idle. SSH private keys are read server-side and never sent to the browser.

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/api/dashboard` | Aggregate stats |
| GET/POST | `/api/projects` | List / create projects |
| GET/PUT/DELETE | `/api/projects/[id]` | Read / update / delete project |
| GET/POST | `/api/tasks` | List / create tasks |
| GET/PUT/DELETE | `/api/tasks/[id]` | Read / update / delete task |
| POST | `/api/tasks/[id]/run` | Dispatch task to tmux |
| GET | `/api/tasks/[id]/logs` | Execution logs for a task |
| PATCH | `/api/tasks/[id]/status` | Update task status |
| GET | `/api/queue` | Pending tasks sorted by priority |
| GET/POST | `/api/reports/daily` | List / generate daily reports |
| GET/POST | `/api/servers` | List / create servers |
| GET/PUT/DELETE | `/api/servers/[id]` | Read / update / delete server |
| POST | `/api/servers/[id]/connect` | Test SSH connectivity |
| POST | `/api/servers/[id]/exec` | Run arbitrary command via SSH |
| POST | `/api/servers/[id]/run` | Run allowlisted environment check |
| GET | `/api/servers/[id]/logs` | SSH command history |
| GET | `/api/servers/[id]/claude-usage` | Fetch Claude usage from tmux |

---

## Deployment

The app ships as a Docker image (`ghcr.io/krischuang/tarotai:latest`) and is deployed to an EC2 instance via GitHub Actions + AWS SSM.

### CI/CD Flow

1. Push to `main` triggers the GitHub Actions workflow (`.github/workflows/deploy.yml`)
2. The workflow assumes an IAM role via OIDC and sends an SSM command to the EC2 instance
3. The EC2 instance runs `/home/ec2-user/auto_deploy/deploy.sh`, which:
   - Stops running containers (`docker compose down`)
   - Pulls the latest image from ghcr.io
   - Prunes dangling images and containers
   - Starts containers (`docker compose up -d`)
   - Polls `http://localhost:3000/api/health` for up to 120 seconds

### One-Time EC2 Setup

Authenticate Docker with GitHub Container Registry (required to pull the image):

```bash
echo "YOUR_GITHUB_PAT" | sudo docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

The PAT needs `read:packages` scope. Credentials are stored in `/root/.docker/config.json` and persist across deploys.

### Manual Deploy

```bash
sudo bash /home/ec2-user/auto_deploy/deploy.sh
```

Deploy logs are written to `/home/ec2-user/auto_deploy/deploy.log` (overwritten each run).

---

## Known Limitations

- **No authentication** — do not expose this app to the network
- **`ssh2` is incompatible with Turbopack's production build** — dev server works fine; production builds are blocked until the upstream issue is resolved
- **Usage data is cached** — the task execution gate reads from the DB, not a live SSH check; refresh from the server detail page if the cached data is stale (a >10 min warning is shown)
