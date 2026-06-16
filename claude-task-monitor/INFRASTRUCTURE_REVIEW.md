# WorkerAI Infrastructure Review
**Date:** 2026-06-12  
**Reviewed by:** Claude Code (Sonnet 4.6)  
**Scope:** CI/CD pipeline, deployment workflow, disk capacity, monitoring, self-healing

---

## Current Architecture

```
EC2 (16GB disk / 1.9GB RAM)
│
├── /home/ec2-user/docker-compose.yml          ← legacy root compose
│   └── workerai-postgres (port 5432→5432)     ← exposed on host localhost:5432
│
└── WorkerAI/claude-task-monitor/
    ├── docker-compose.yml                      ← active project compose
    │   ├── app (claude-task-monitor-app-1)     ← Next.js + WS server
    │   └── db  (claude-task-monitor-db-1)      ← internal-only postgres
    ├── .github/workflows/ci.yml                ← lint / unit / build / e2e
    └── (3x) claude processes on host           ← AI worker agents
```

**CI/CD Flow (before review):** Push to GitHub → CI runs tests → _no deployment step_. All deploys were manual `docker compose up` on the server.

---

## Findings by Priority

### CRITICAL

| # | Issue | Impact |
|---|-------|--------|
| C1 | **No Docker log size limits** | json-file logs grow without bound; will fill disk silently |
| C2 | **Disk at 68% (11GB/16GB) with no alerting** | One large deployment or log burst fills the volume |
| C3 | **RAM at 97% utilised** (102MB free, 698MB swap active) | Any spike OOM-kills a container |

### HIGH

| # | Issue | Impact |
|---|-------|--------|
| H1 | **App Docker image is 2.78GB** — full `node:22` base, no multi-stage build | Each rebuild consumes 2.78GB+ of overlay space; slows deploys |
| H2 | **`WorkerHealth` has no retention** — written every 60s per worker | At 3 workers × 60s = ~4,320 rows/hr → 103k rows/day → disk exhaustion within weeks |
| H3 | **`AgentUsageSnapshot` has no retention** — same write frequency | Same unbounded growth pattern |
| H4 | **`AuditEvent` / `AdminAuditLog` / `ServerCommandLog` have no retention** | Append-only forever |
| H5 | **Duplicate Postgres running** — `workerai-postgres` (host:5432) AND `claude-task-monitor-db-1` (internal) | Both have live data; wasting ~157MB RAM. Host processes write to one, app writes to the other |
| H6 | **No deployment workflow** — CI never deploys to EC2 | Manual deploy only; no rollback; no health-check gate |
| H7 | **1.1GB node_modules on production host** (app runs in Docker, not on host) | Pure wasted disk space |

### MEDIUM

| # | Issue | Impact |
|---|-------|--------|
| M1 | **No cron daemon installed** — backup and maintenance scripts existed but never ran | Backups and pruning never executed |
| M2 | **Backups stored in project directory** with no offsite copy | Lost on disk failure; consumes app disk |
| M3 | **Dockerfile uses `npm install`** instead of `npm ci` | Non-reproducible builds; lockfile not enforced |
| M4 | **No `/etc/docker/daemon.json`** — no global logging defaults | Any new container inherits unlimited log size |
| M5 | **641MB Playwright browser cache on production host** | Pure waste on a 16GB instance |
| M6 | **Misleading comment in Dockerfile CMD** — says "exec-form trap" but SIGTERM still goes to `sh` wrapper | Signal handling works but confusing |

### LOW

| # | Issue | Impact |
|---|-------|--------|
| L1 | **`coverage/` and `test-results/` committed to repo** | Repo bloat; should be in `.gitignore` |
| L2 | **No explicit `tsc --noEmit` CI step** | Type errors only caught during `next build` |
| L3 | **`ALLOWED_ORIGINS` hardcodes EC2 IP** | Breaks silently if instance IP changes |

---

## Changes Applied (2026-06-12)

### 1. Docker Log Rotation — `/etc/docker/daemon.json`

**File created.** New containers capped at 150MB of logs total (3 × 50MB files).

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "50m",
    "max-file": "3"
  }
}
```

> **Action required:** Recreate existing containers to pick up the new defaults:
> ```bash
> cd /home/ec2-user/WorkerAI/claude-task-monitor
> sudo docker compose down && sudo docker compose up -d
> ```

---

### 2. Multi-Stage Alpine Dockerfile

**File updated:** `Dockerfile`

| | Before | After |
|---|--------|-------|
| Base image | `node:22` (Debian, ~1GB) | `node:22-alpine` (~170MB) |
| Install command | `npm install` | `npm ci` (reproducible) |
| Build tools in runtime | Yes (python3/make/g++) | No (builder stage only) |
| Estimated image size | ~2.78GB | ~1.5GB |
| Expected savings | — | ~1.3GB |

```dockerfile
# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# Stage 2: runtime (alpine only — no build tools)
FROM node:22-alpine AS runner
...
```

> **Action required:** Rebuild the image:
> ```bash
> cd /home/ec2-user/WorkerAI/claude-task-monitor
> sudo docker compose build --no-cache app
> sudo docker compose up -d app
> ```

---

### 3. Database Table Retention

**Files updated:** `lib/execution-log-archival.ts`, `instrumentation.node.ts`

New `pruneHighVolumeTables()` function runs nightly at 1 AM UTC alongside the existing `archiveOldLogs()`.

| Table | Retention | Write frequency |
|-------|-----------|----------------|
| `WorkerHealth` | 7 days | Every 60s per worker |
| `AgentUsageSnapshot` | 7 days | Every 60s per agent |
| `AuditEvent` | 90 days | Every state change |
| `AdminAuditLog` | 365 days | Every admin action |
| `ServerCommandLog` | 30 days | Every SSH command |

> Row counts at time of review: WorkerHealth=425, AgentUsageSnapshot=32, AuditEvent=100, ServerCommandLog=19.

---

### 4. Nightly Maintenance Script

**File created:** `scripts/maintenance.sh`

Runs daily at 2 AM UTC. Performs:
- Disk usage check — triggers Docker prune at ≥80%, aggressive prune at ≥90%
- `docker image prune` and `docker container prune` (safe — unused only)
- `docker builder prune --keep-storage=500MB`
- npm cache clean
- Claude `/tmp` cleanup (files older than 1 day)
- Backup count and size report
- Post-cleanup disk and Docker storage summary

Logs to `/var/log/workerai-maintenance.log`.

---

### 5. cronie Installed + Cron Jobs Scheduled

**cronie installed** via `dnf install cronie` (was missing from the base AMI).

```
0 2 * * *   scripts/maintenance.sh     → /var/log/workerai-maintenance.log
0 3 * * *   npm run db:backup           → /var/log/workerai-backup.log
```

---

### 6. GitHub Actions Deploy Workflow

**File created:** `.github/workflows/deploy.yml`

| Feature | Detail |
|---------|--------|
| Trigger | Auto after CI passes on `main`; manual `workflow_dispatch` |
| Pre-deploy checks | Disk space (>3GB required), Docker health, DB connectivity |
| Rollback preservation | Tags current image `rollback-<timestamp>` before each build; keeps 2 most recent |
| Health check gate | Polls `/api/health` for 60s post-deploy |
| Auto-rollback | Reverts to previous image if health check fails |
| Manual rollback | `workflow_dispatch` with `rollback: true` |

**Required GitHub Secrets** (Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `DEPLOY_HOST` | EC2 public IP or hostname |
| `DEPLOY_USER` | `ec2-user` |
| `DEPLOY_SSH_KEY` | Content of `WorkerAI.pem` private key |

---

### 7. Playwright Cache Removed

Freed **641MB** immediately. Disk usage: **68% → 64%**.

```bash
rm -rf /home/ec2-user/.cache/ms-playwright/
```

---

## Disk Usage: Before vs After

| Category | Before | After full cleanup | Savings |
|----------|--------|--------------------|---------|
| Playwright cache | 641MB | 0MB | **641MB freed** |
| Docker logs | Unlimited | ≤150MB per container | Blowup prevented |
| App Docker image | 2.78GB | ~1.5GB (after rebuild) | **~1.3GB** |
| Host node_modules | 1.1GB | 0MB (if removed) | **1.1GB** |
| DB high-volume tables | Unbounded | Bounded (7–365 day windows) | Blowup prevented |
| **Root filesystem** | **68% (11GB/16GB)** | **~54% (after full cleanup)** | **~2.3GB freed** |

---

## Remaining Manual Actions

### Immediate

**A. Recreate containers** to apply log rotation:
```bash
cd /home/ec2-user/WorkerAI/claude-task-monitor
sudo docker compose down && sudo docker compose up -d
```

**B. Rebuild Docker image** with new alpine multi-stage Dockerfile:
```bash
sudo docker compose build --no-cache app
sudo docker compose up -d app
```

**C. Resolve duplicate Postgres** — both `workerai-postgres` and `claude-task-monitor-db-1` are running with live data:
```bash
# Investigate which tables differ between the two instances
sudo docker exec workerai-postgres psql -U postgres -d claude_task_monitor -c "SELECT count(*) FROM \"WorkerHealth\";"
sudo docker exec claude-task-monitor-db-1 psql -U postgres -d claude_task_monitor -c "SELECT count(*) FROM \"WorkerHealth\";"

# Once confirmed the app DB (claude-task-monitor-db-1) is canonical:
cd /home/ec2-user && sudo docker compose down

# Remove the legacy root docker-compose.yml or leave stopped
```

**D. Remove host node_modules** (frees 1.1GB — only needed if running dev outside Docker):
```bash
rm -rf /home/ec2-user/WorkerAI/claude-task-monitor/node_modules
```

**E. Set GitHub Secrets** for deploy workflow:
- `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` in GitHub repo Settings → Secrets → Actions.

### Short-Term (within 1 week)

**F. Add email/webhook disk alert** — extend `scripts/maintenance.sh`:
```bash
if [[ "${DISK_PCT}" -ge 80 ]]; then
  curl -s -X POST "$SLACK_WEBHOOK" -d "{\"text\":\"WorkerAI disk at ${DISK_PCT}%\"}"
fi
```

**G. Upgrade instance RAM** — current usage is 97% (1.2GB/1.9GB) with 698MB swap active. Three Claude processes plus the Docker stack saturate a `t3.small`. Upgrading to `t3.medium` (4GB RAM) would eliminate swap pressure.

**H. Move backups offsite** — add S3 upload to `scripts/db-backup.sh`:
```bash
aws s3 cp "${BACKUP_FILE}" "s3://your-bucket/workerai-backups/$(basename ${BACKUP_FILE})"
```

**I. Add `tsc --noEmit` to CI** — catches type errors independently of the Next.js build:
```yaml
- name: Type check
  run: npx tsc --noEmit
```

---

## Self-Healing Matrix

| Failure Mode | Recovery Mechanism | Status |
|---|---|---|
| Claude process crash | Tmux session survives; re-attach or manual relaunch | Pre-existing |
| Container crash | `restart: unless-stopped` in compose | Pre-existing |
| EC2 reboot | Docker service enabled on boot; containers auto-start | Pre-existing |
| Failed deploy | Health-check gate + auto-rollback in deploy workflow | **Added** |
| DB table growth | `pruneHighVolumeTables()` nightly at 1 AM UTC | **Added** |
| Docker log blowup | Log rotation via `/etc/docker/daemon.json` | **Added** |
| Disk creep (images, cache) | Nightly `maintenance.sh` prune at 2 AM UTC | **Added** |
| Backup accumulation | Existing 7-daily / 4-weekly rotation in `db-backup.sh` | Pre-existing |
| Stalled poller | Heartbeat written to `SystemConfig` each cycle; `/api/health` detects staleness | Pre-existing |
| Zombie tasks | `zombie-detection.ts` in poller | Pre-existing |
| Auto-recovery | `auto-recovery.ts` in poller (max 3 attempts per worker) | Pre-existing |

---

## Files Changed

| File | Change |
|------|--------|
| `Dockerfile` | Multi-stage alpine build; `npm ci`; Prisma generate before build |
| `lib/execution-log-archival.ts` | Added `pruneHighVolumeTables()` with per-table retention constants |
| `instrumentation.node.ts` | Wired `pruneHighVolumeTables()` into nightly archival block |
| `scripts/maintenance.sh` | **New** — nightly disk + Docker + cache cleanup |
| `.github/workflows/deploy.yml` | **New** — full CI-gated deploy with pre/post checks and auto-rollback |
| `/etc/docker/daemon.json` | **New** — global log rotation (50MB × 3 files per container) |
| `~/.cache/ms-playwright/` | **Deleted** — freed 641MB |
| `crontab` | **New entries** — maintenance at 02:00, backup at 03:00 UTC |
