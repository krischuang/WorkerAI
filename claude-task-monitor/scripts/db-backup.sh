#!/usr/bin/env bash
# scripts/db-backup.sh
# Create a timestamped pg_dump backup of the WorkerAI database.
# Runs pg_dump inside the Docker container so no local Postgres install is needed.
#
# Usage:
#   npm run db:backup
#   BACKUP_DIR=/mnt/backups npm run db:backup
#
# Rotation policy (applied at end of each run):
#   - Keep the 7 most-recent daily backups
#   - Keep 1 backup per calendar week for the 4 most-recent weeks
#   - Delete everything else

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Configuration ────────────────────────────────────────────────────────────

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_DIR}/backups}"
ENV_FILE="${PROJECT_DIR}/.env"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-workerai-postgres}"
KEEP_DAILY=7
KEEP_WEEKLY=4

# ── Parse DATABASE_URL ───────────────────────────────────────────────────────

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "${ENV_FILE}" | grep 'DATABASE_URL' | xargs)
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERROR: DATABASE_URL is not set. Check ${ENV_FILE}" >&2
  exit 1
fi

# Extract components from postgresql://user:password@host:port/dbname?...
DB_USER=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://([^:]+):.*|\1|')
DB_PASS=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^:]+:([^@]+)@.*|\1|')
DB_HOST=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^@]+@([^:/]+)[:/].*|\1|')
DB_PORT=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^@]+@[^:]+:([0-9]+)/.*|\1|')
DB_NAME=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://[^/]+/([^?]+).*|\1|')

if [[ -z "${DB_NAME}" ]]; then
  echo "ERROR: Could not parse database name from DATABASE_URL" >&2
  exit 1
fi

# ── Setup ────────────────────────────────────────────────────────────────────

mkdir -p "${BACKUP_DIR}"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.sql.gz"

echo "▶  WorkerAI Database Backup"
echo "   Container : ${DOCKER_CONTAINER}"
echo "   Database  : ${DB_NAME}"
echo "   Output    : ${BACKUP_FILE}"
echo ""

# ── Run pg_dump via docker exec ──────────────────────────────────────────────

if ! sudo docker inspect "${DOCKER_CONTAINER}" > /dev/null 2>&1; then
  echo "ERROR: Docker container '${DOCKER_CONTAINER}' not found." >&2
  echo "       Start it with: docker compose up -d" >&2
  exit 1
fi

PGPASSWORD="${DB_PASS}" sudo docker exec \
  -e PGPASSWORD="${DB_PASS}" \
  "${DOCKER_CONTAINER}" \
  pg_dump \
    --username="${DB_USER}" \
    --host=localhost \
    --port="${DB_PORT}" \
    --dbname="${DB_NAME}" \
    --format=plain \
    --no-password \
    --verbose \
  2>/dev/null \
  | gzip -9 > "${BACKUP_FILE}"

SIZE=$(du -sh "${BACKUP_FILE}" | cut -f1)
echo "✓  Backup complete: ${BACKUP_FILE} (${SIZE})"

# ── Rotation ─────────────────────────────────────────────────────────────────
# Strategy:
#   1. Sort all backup_*.sql.gz files newest-first
#   2. Keep the KEEP_DAILY (7) most recent — these are "daily" slots
#   3. For files older than the daily window, keep one per calendar week
#      for up to KEEP_WEEKLY (4) weeks
#   4. Delete everything else

echo ""
echo "▶  Running backup rotation (keep ${KEEP_DAILY} daily, ${KEEP_WEEKLY} weekly)…"

# Collect all backup files, newest first
mapfile -t ALL_BACKUPS < <(ls -t "${BACKUP_DIR}"/backup_*.sql.gz 2>/dev/null || true)
TOTAL=${#ALL_BACKUPS[@]}

if [[ ${TOTAL} -le ${KEEP_DAILY} ]]; then
  echo "   ${TOTAL} backup(s) — within daily limit, nothing to rotate."
  exit 0
fi

# Files to keep unconditionally (the KEEP_DAILY newest)
KEEP_SET=()
for i in $(seq 0 $((KEEP_DAILY - 1))); do
  KEEP_SET+=("${ALL_BACKUPS[$i]}")
done

# Among the remaining files, keep one per calendar week (up to KEEP_WEEKLY weeks)
WEEKS_KEPT=0
declare -A WEEK_SEEN

for file in "${ALL_BACKUPS[@]:${KEEP_DAILY}}"; do
  # Extract date from filename: backup_YYYYMMDD_HHMMSS.sql.gz
  FNAME=$(basename "${file}")
  FDATE=$(echo "${FNAME}" | sed -E 's/backup_([0-9]{8})_.*/\1/')

  if [[ ${#FDATE} -ne 8 ]]; then
    continue  # Can't parse — leave alone
  fi

  FYEAR="${FDATE:0:4}"
  FMONTH="${FDATE:4:2}"
  FDAY="${FDATE:6:2}"

  # Get ISO week number
  WEEK_KEY=$(date -d "${FYEAR}-${FMONTH}-${FDAY}" +%G-W%V 2>/dev/null || \
             python3 -c "import datetime; d=datetime.date(${FYEAR},${FMONTH},${FDAY}); print(f'{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}')" 2>/dev/null || echo "")

  if [[ -z "${WEEK_KEY}" ]]; then
    continue
  fi

  if [[ -z "${WEEK_SEEN[$WEEK_KEY]+_}" ]] && [[ ${WEEKS_KEPT} -lt ${KEEP_WEEKLY} ]]; then
    WEEK_SEEN[$WEEK_KEY]=1
    KEEP_SET+=("${file}")
    ((WEEKS_KEPT++)) || true
  fi
done

# Delete any file not in KEEP_SET
DELETED=0
for file in "${ALL_BACKUPS[@]}"; do
  SHOULD_KEEP=0
  for keep in "${KEEP_SET[@]}"; do
    if [[ "${file}" == "${keep}" ]]; then
      SHOULD_KEEP=1
      break
    fi
  done
  if [[ ${SHOULD_KEEP} -eq 0 ]]; then
    echo "   Removing: $(basename "${file}")"
    rm -f "${file}"
    ((DELETED++)) || true
  fi
done

if [[ ${DELETED} -eq 0 ]]; then
  echo "   Nothing to remove."
else
  echo "   Removed ${DELETED} old backup(s)."
fi

REMAINING=$(ls "${BACKUP_DIR}"/backup_*.sql.gz 2>/dev/null | wc -l)
echo "✓  Rotation complete. ${REMAINING} backup(s) retained in ${BACKUP_DIR}"
