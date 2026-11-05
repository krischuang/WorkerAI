#!/bin/bash
# Pre-demo health check — run this before any demo rehearsal or the live
# Nov 7 run. Verifies every local precondition the demo depends on, so a
# missing container or stale migration fails loudly here instead of
# silently breaking the live run (see docs/DEMO_DAY_FINAL_VERIFICATION.md —
# this exact failure mode, a missing local Postgres container, broke the
# entire Playwright suite mid-audit on 2026-11-05).
#
# Checks only — never starts/stops containers or applies migrations itself,
# so it's always safe to run repeatedly.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PASS=1
ok()   { echo "  [OK]   $1"; }
fail() { echo "  [FAIL] $1"; PASS=0; }
warn() { echo "  [WARN] $1"; }

echo "=== Docker ==="
if docker info >/dev/null 2>&1; then
  ok "Docker daemon is running"
else
  fail "Docker daemon is not running — start Docker before the demo"
fi

echo ""
echo "=== Local disposable Postgres (workerai-baseline-db) ==="
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "workerai-baseline-db"; then
  ok "Container workerai-baseline-db is running"
  if docker exec workerai-baseline-db pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres inside the container is accepting connections"
  else
    fail "Container is running but Postgres is not ready yet (pg_isready failed)"
  fi
else
  fail "Container workerai-baseline-db is not running — start it with:"
  echo "         docker run -d --name workerai-baseline-db -p 5432:5432 -e POSTGRES_PASSWORD=<match .env.local> -e POSTGRES_DB=claude_task_monitor postgres:16-alpine"
fi

echo ""
echo "=== .env.local ==="
if [ -f .env.local ]; then
  ok ".env.local exists"
  DB_URL_LINE=$(grep -E '^DATABASE_URL=' .env.local || true)
  if [ -n "$DB_URL_LINE" ]; then
    PORT=$(echo "$DB_URL_LINE" | sed -E 's#.*@[^:]+:([0-9]+)/.*#\1#')
    if [ "$PORT" = "5432" ]; then
      ok "DATABASE_URL targets port 5432 (matches workerai-baseline-db)"
    else
      warn "DATABASE_URL targets port $PORT, not 5432 — confirm this is intentional"
    fi
  else
    fail "DATABASE_URL is not set in .env.local"
  fi
  for key in AUTH_SECRET ADMIN_PASSWORD; do
    if grep -qE "^${key}=.+" .env.local; then
      ok "$key is set (value not shown)"
    else
      warn "$key is not set in .env.local"
    fi
  done
else
  fail ".env.local is missing"
fi

echo ""
echo "=== Prisma migrations ==="
if npx prisma migrate status 2>&1 | grep -q "Database schema is up to date"; then
  ok "All migrations applied"
else
  fail "Migrations are not up to date — run: npx prisma migrate deploy"
fi

echo ""
echo "=== Dependencies ==="
if [ -d node_modules ]; then
  ok "node_modules is present"
else
  fail "node_modules is missing — run: npm install"
fi

echo ""
echo "=== Leftover demo-e2e containers ==="
LEFTOVER=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^workerai-demo-" | tr '\n' ' ' || true)
if [ -z "$LEFTOVER" ]; then
  ok "No leftover demo-e2e containers"
else
  warn "Leftover demo-e2e container(s) found: $LEFTOVER (torn down automatically on the next 'npm run demo:e2e' run, or remove now with: docker rm -f $LEFTOVER)"
fi

echo ""
if [ "$PASS" -eq 1 ]; then
  echo "=== READY — all required checks passed ==="
  exit 0
else
  echo "=== NOT READY — fix the [FAIL] items above before rehearsing or presenting ==="
  exit 1
fi
