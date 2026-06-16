#!/usr/bin/env bash
# maintenance.sh — nightly cleanup and health checks for the WorkerAI EC2 host.
#
# Cron: 0 2 * * * /home/ec2-user/WorkerAI/claude-task-monitor/scripts/maintenance.sh >> /var/log/workerai-maintenance.log 2>&1

set -euo pipefail

TIMESTAMP=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
echo "=== WorkerAI Maintenance — ${TIMESTAMP} ==="

# ── 1. Disk usage check ───────────────────────────────────────────────────────
DISK_PCT=$(df / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
echo "[disk] Root filesystem: ${DISK_PCT}% used"

if [[ "${DISK_PCT}" -ge 90 ]]; then
  echo "[disk] CRITICAL: disk ≥ 90% — forcing aggressive Docker cleanup"
  sudo docker system prune -af --volumes 2>/dev/null || true
elif [[ "${DISK_PCT}" -ge 80 ]]; then
  echo "[disk] WARNING: disk ≥ 80% — pruning dangling Docker resources"
  sudo docker system prune -f 2>/dev/null || true
fi

# ── 2. Docker cleanup (safe — only removes unused resources) ──────────────────
echo "[docker] Pruning dangling images and stopped containers..."
sudo docker image prune -f 2>/dev/null || true
sudo docker container prune -f 2>/dev/null || true
sudo docker builder prune -f --keep-storage=500MB 2>/dev/null || true

# Remove images that are not tagged and not used by a running container
echo "[docker] Current images:"
sudo docker images --format "  {{.Repository}}:{{.Tag}}  {{.Size}}" 2>/dev/null || true

# ── 3. npm cache trim ─────────────────────────────────────────────────────────
echo "[npm] Trimming npm cache..."
npm cache clean --force 2>/dev/null || true

# ── 4. Playwright cache — not needed on production host ───────────────────────
PLAYWRIGHT_CACHE="${HOME}/.cache/ms-playwright"
if [[ -d "${PLAYWRIGHT_CACHE}" ]]; then
  SIZE=$(du -sh "${PLAYWRIGHT_CACHE}" 2>/dev/null | cut -f1)
  echo "[playwright] Cache found (${SIZE}). To free this space run:"
  echo "  rm -rf ${PLAYWRIGHT_CACHE}"
fi

# ── 5. Claude session temp files ─────────────────────────────────────────────
# Claude CLI may leave temp files under /tmp — clean those older than 1 day.
find /tmp -maxdepth 2 -name 'claude-*' -mtime +1 -delete 2>/dev/null || true
find /tmp -maxdepth 2 -name '.claude-*' -mtime +1 -delete 2>/dev/null || true

# ── 6. Backup retention check ─────────────────────────────────────────────────
BACKUP_DIR="$(dirname "$0")/../backups"
if [[ -d "${BACKUP_DIR}" ]]; then
  BACKUP_COUNT=$(ls "${BACKUP_DIR}"/backup_*.sql.gz 2>/dev/null | wc -l)
  BACKUP_SIZE=$(du -sh "${BACKUP_DIR}" 2>/dev/null | cut -f1)
  echo "[backup] ${BACKUP_COUNT} backup(s) in ${BACKUP_DIR} (${BACKUP_SIZE})"
fi

# ── 7. Disk summary ───────────────────────────────────────────────────────────
echo "[disk] Post-cleanup usage:"
df -h / 2>/dev/null | awk 'NR<=2'
echo "[docker] Post-cleanup Docker storage:"
sudo docker system df 2>/dev/null || true

echo "=== Maintenance complete ==="
