#!/bin/sh
set -e

# Wait for the database to be ready before running migrations.
# docker-compose.yml uses depends_on condition: service_healthy so the db
# container has already passed its own pg_isready healthcheck by the time this
# script runs. We poll with a lightweight Node.js TCP check as a belt-and-
# suspenders guard — pg_isready is not available in the node:22 base image.
echo "Waiting for database..."
until node -e "
  const net = require('net');
  const s = net.createConnection(parseInt(process.env.DB_PORT || '5432'), process.env.DB_HOST || 'db');
  s.on('connect', () => { s.destroy(); process.exit(0); });
  s.on('error',   () => process.exit(1));
" 2>/dev/null; do
  sleep 1
done
echo "Database is ready."

# ── SSH key validation ────────────────────────────────────────────────────────
# SSH_KEY_PATH must point to a readable private key file. The file is
# bind-mounted by docker-compose.yml from the host via SSH_KEY_FILE.

if [ -z "${SSH_KEY_PATH:-}" ]; then
  echo "ERROR: SSH_KEY_PATH is not set." >&2
  echo "  Set SSH_KEY_PATH in docker-compose.yml or via an environment variable." >&2
  exit 1
fi

if [ ! -f "$SSH_KEY_PATH" ]; then
  echo "ERROR: SSH key not found at: $SSH_KEY_PATH" >&2
  echo "  Ensure the key file exists on the host and SSH_KEY_FILE is set correctly." >&2
  echo "  Example: SSH_KEY_FILE=/home/your-user/.ssh/WorkerAI.pem docker compose up" >&2
  exit 1
fi

if [ ! -r "$SSH_KEY_PATH" ]; then
  echo "ERROR: SSH key is not readable: $SSH_KEY_PATH" >&2
  echo "  Check file permissions on the host key file." >&2
  exit 1
fi

PERMS=$(stat -c "%a" "$SSH_KEY_PATH" 2>/dev/null || echo "unknown")
if [ "$PERMS" != "400" ] && [ "$PERMS" != "600" ]; then
  echo "WARNING: SSH key permissions are $PERMS (expected 400 or 600)." >&2
  echo "  Fix on the host with: chmod 400 \"\${SSH_KEY_FILE:-$SSH_KEY_PATH}\"" >&2
fi

echo "SSH key validated: $SSH_KEY_PATH (permissions: $PERMS)"
# ─────────────────────────────────────────────────────────────────────────────

# Apply any pending migrations (safe to run repeatedly; no-op if up to date).
# Prisma 7 reads the datasource URL from prisma.config.ts (via DATABASE_URL env var).
npx prisma migrate deploy

# Hand off to the main process (npm start + ws-server via the Dockerfile CMD).
exec "$@"
