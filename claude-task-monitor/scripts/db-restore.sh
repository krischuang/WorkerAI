#!/usr/bin/env bash
# scripts/db-restore.sh
# Restore the WorkerAI database from a .sql.gz backup file.
# Runs psql inside the Docker container so no local Postgres install is needed.
#
# Usage:
#   npm run db:restore -- ./backups/backup_20260611_020000.sql.gz
#   BACKUP_FILE=./backups/backup_20260611_020000.sql.gz npm run db:restore

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_DIR}/.env"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-workerai-postgres}"

# ── Resolve backup file ──────────────────────────────────────────────────────

BACKUP_FILE="${1:-${BACKUP_FILE:-}}"

if [[ -z "${BACKUP_FILE}" ]]; then
  # Auto-select the most recent backup if none is provided
  BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
  LATEST=$(ls -t "${BACKUP_DIR}"/backup_*.sql.gz 2>/dev/null | head -n1 || true)
  if [[ -z "${LATEST}" ]]; then
    echo "ERROR: No backup file specified and no backups found in ${BACKUP_DIR}" >&2
    echo "       Usage: npm run db:restore -- <path/to/backup.sql.gz>" >&2
    exit 1
  fi
  echo "No backup file specified. Using most recent: ${LATEST}"
  BACKUP_FILE="${LATEST}"
fi

if [[ ! -f "${BACKUP_FILE}" ]]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

BACKUP_ABS=$(cd "$(dirname "${BACKUP_FILE}")" && pwd)/$(basename "${BACKUP_FILE}")

# ── Parse DATABASE_URL ───────────────────────────────────────────────────────

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "${ENV_FILE}" | grep 'DATABASE_URL' | xargs)
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Check ${ENV_FILE}" >&2
  exit 1
fi

DB_USER=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://([^:]+):.*|\1|')
DB_PASS=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
DB_PORT=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^@]+@[^:]+:([0-9]+)/.*|\1|')
DB_NAME=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^/]+/([^?]+).*|\1|')

if [[ -z "${DB_NAME}" ]]; then
  echo "ERROR: Could not parse database name from DATABASE_URL" >&2
  exit 1
fi

# ── Confirmation prompt ──────────────────────────────────────────────────────

FILESIZE=$(du -sh "${BACKUP_ABS}" | cut -f1)
FILEDATE=$(basename "${BACKUP_ABS}" | sed -E 's/backup_([0-9]{8}_[0-9]{6}).*/\1/')

echo ""
echo "⚠   WorkerAI Database Restore"
echo "    ────────────────────────────────────────────────"
echo "    Backup file  : $(basename "${BACKUP_ABS}") (${FILESIZE})"
echo "    Backup date  : ${FILEDATE}"
echo "    Container    : ${DOCKER_CONTAINER}"
echo "    Target DB    : ${DB_NAME}"
echo "    ────────────────────────────────────────────────"
echo ""
echo "    WARNING: This will DROP and recreate the '${DB_NAME}' database."
echo "    All current data will be permanently lost."
echo ""
printf "    Type 'yes' to confirm: "
read -r CONFIRM

if [[ "${CONFIRM}" != "yes" ]]; then
  echo ""
  echo "Aborted. No changes made."
  exit 0
fi

echo ""

# ── Check container ──────────────────────────────────────────────────────────

if ! sudo docker inspect "${DOCKER_CONTAINER}" > /dev/null 2>&1; then
  echo "ERROR: Docker container '${DOCKER_CONTAINER}' not found." >&2
  echo "       Start it with: docker compose up -d" >&2
  exit 1
fi

# ── Stop the Next.js server to avoid open connections ───────────────────────

echo "▶  Checking for active connections to ${DB_NAME}…"
CONN_COUNT=$(PGPASSWORD="${DB_PASS}" sudo docker exec \
  -e PGPASSWORD="${DB_PASS}" \
  "${DOCKER_CONTAINER}" \
  psql --username="${DB_USER}" --host=localhost --port="${DB_PORT}" \
    --tuples-only --no-align \
    --command="SELECT count(*) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" \
  2>/dev/null | tr -d ' ' || echo "0")

if [[ "${CONN_COUNT}" -gt 0 ]]; then
  echo "   ${CONN_COUNT} active connection(s) detected."
  echo "   Terminating them before restore…"
  PGPASSWORD="${DB_PASS}" sudo docker exec \
    -e PGPASSWORD="${DB_PASS}" \
    "${DOCKER_CONTAINER}" \
    psql --username="${DB_USER}" --host=localhost --port="${DB_PORT}" \
      --command="SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" \
    > /dev/null 2>&1 || true
fi

# ── Drop and recreate the database ──────────────────────────────────────────

echo "▶  Dropping database '${DB_NAME}'…"
PGPASSWORD="${DB_PASS}" sudo docker exec \
  -e PGPASSWORD="${DB_PASS}" \
  "${DOCKER_CONTAINER}" \
  psql --username="${DB_USER}" --host=localhost --port="${DB_PORT}" \
    --command="DROP DATABASE IF EXISTS \"${DB_NAME}\";" \
  > /dev/null 2>&1

echo "▶  Creating database '${DB_NAME}'…"
PGPASSWORD="${DB_PASS}" sudo docker exec \
  -e PGPASSWORD="${DB_PASS}" \
  "${DOCKER_CONTAINER}" \
  psql --username="${DB_USER}" --host=localhost --port="${DB_PORT}" \
    --command="CREATE DATABASE \"${DB_NAME}\";" \
  > /dev/null 2>&1

# ── Restore ──────────────────────────────────────────────────────────────────

echo "▶  Restoring from $(basename "${BACKUP_ABS}")…"

gunzip -c "${BACKUP_ABS}" | PGPASSWORD="${DB_PASS}" sudo docker exec \
  -i \
  -e PGPASSWORD="${DB_PASS}" \
  "${DOCKER_CONTAINER}" \
  psql \
    --username="${DB_USER}" \
    --host=localhost \
    --port="${DB_PORT}" \
    --dbname="${DB_NAME}" \
    --quiet \
    2>/dev/null

echo ""
echo "✓  Restore complete."
echo "   Database '${DB_NAME}' has been restored from:"
echo "   ${BACKUP_ABS}"
echo ""
echo "   Restart the application server to reconnect: npm start"
