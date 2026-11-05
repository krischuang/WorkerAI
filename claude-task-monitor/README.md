# Claude Task Monitor

[![CI](https://github.com/krischuang/WorkerAI/actions/workflows/ci.yml/badge.svg)](https://github.com/krischuang/WorkerAI/actions/workflows/ci.yml)

A task management platform for tracking AI-assisted work across projects, powered by Next.js and Claude AI.

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Quick Start (Docker — one command)

> Requires [Docker](https://docs.docker.com/get-docker/) with the Compose plugin.

```bash
# 1. Copy the example env file and set AUTH_SECRET (everything else has safe defaults)
cp .env.example .env
# Edit .env: set AUTH_SECRET to a random string

# 2. Start the database and app in one command
docker compose up --build
```

The app will be available at <http://localhost:3000> once the database is ready and migrations have run automatically.

**Ports**

| Port | Service |
|---|---|
| 3000 | Next.js web UI |
| 3099 | WebSocket SSH terminal server |

**Hot-reload development**

```bash
cp docker-compose.override.yml.example docker-compose.override.yml
docker compose up --build
```

With the override in place, your local source files are mounted into the container and `npm run dev` is used instead of the production build, so changes are reflected immediately.

**Stop everything**

```bash
docker compose down          # stop containers (keep db volume)
docker compose down -v       # stop and delete the db volume
```

---

## Manual Setup (without Docker)

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Safety & Validation

See the root [README's Safety & Validation section](../README.md#safety--validation) for the kill switch, policy engine, and independent (not self-reported) completion validation gate.

To see the independent validation gate catch a false "passed" self-report for real — a disposable git repo, a real failing test, real exit codes, no production access:

```bash
npm run demo:validation
```

A captured run is recorded in [`docs/DEMO_RUN_RECORD.md`](docs/DEMO_RUN_RECORD.md) as a fallback if a live run isn't possible during the demo.

For the fuller lifecycle — task creation, SSH dispatch, a scripted stand-in for Claude making a real commit, completion detection, and three safety-gate demonstrations (high-risk-autonomous block, policy-engine deny, kill-switch block) — against two disposable, localhost-only Docker containers (never any production host, credentials, or database):

```bash
npm run demo:e2e
```

This calls the real `lib/task-dispatch.ts`, `lib/kill-switch.ts`, `lib/policy-engine.ts`, and `lib/validation-gate.ts` over a real SSH connection to a throwaway container. Requires Docker. Run `npx tsx scripts/demo-e2e/run.ts --clean` if a previous run's containers were left up.

## Database Backup & Restore

WorkerAI includes shell scripts for backing up and restoring the PostgreSQL database.
Backups are created by running `pg_dump` inside the `workerai-postgres` Docker container —
no local Postgres installation is required.

### Manual backup

```bash
npm run db:backup
# Writes a timestamped .sql.gz to ./backups/ by default.

# Custom backup directory:
BACKUP_DIR=/mnt/backups npm run db:backup
```

### Restore from a backup

```bash
npm run db:restore -- ./backups/backup_20260611_020000.sql.gz
# Prompts for confirmation before dropping and recreating the database.

# Restore the most-recent backup automatically:
npm run db:restore
```

### Backup rotation

Each `db:backup` run automatically rotates old files:

- **7 daily** — the 7 most-recent backup files are always kept
- **4 weekly** — 1 backup per calendar week for the 4 weeks before the daily window
- Everything older is deleted

### Automated daily backup (cron)

Add the following cron entry to run a backup every day at 2 AM:

```cron
# Daily WorkerAI database backup at 02:00
0 2 * * * cd /home/ec2-user/WorkerAI/claude-task-monitor && npm run db:backup >> /var/log/workerai-backup.log 2>&1
```

Install with `crontab -e` and paste the line above (adjust the path to match your deployment).

To verify the cron job ran, check the log:

```bash
tail -50 /var/log/workerai-backup.log
ls -lh backups/
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (from `.env`) | PostgreSQL connection string |
| `BACKUP_DIR` | `./backups/` | Directory where backup files are written |
| `DOCKER_CONTAINER` | `workerai-postgres` | Name of the Postgres Docker container |

## Deployment

This app needs a persistent Postgres connection, a standalone WebSocket server (`ws-server.ts`, port 3099), and outbound SSH to worker servers — it does not run on serverless platforms like Vercel. See the root [README's CI/CD section](../README.md#cicd) for the actual deploy pipeline (`.github/workflows/deploy.yml`, EC2 + Docker Compose over SSH).
