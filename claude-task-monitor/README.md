# Claude Task Monitor

[![CI](https://github.com/kevinshuang1029/WorkerAI/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinshuang1029/WorkerAI/actions/workflows/ci.yml)

A task management platform for tracking AI-assisted work across projects, powered by Next.js and Claude AI.

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

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

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

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

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
