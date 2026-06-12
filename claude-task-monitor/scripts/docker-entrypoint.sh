#!/bin/sh
set -e

# Wait for the database to be ready before running migrations.
# The 'db' service has a healthcheck so Docker marks it healthy only after
# pg_isready succeeds — we just need to poll until the flag appears.
echo "Waiting for database..."
until pg_isready -h "${DB_HOST:-db}" -p "${DB_PORT:-5432}" -U "${DB_USER:-postgres}" -q; do
  sleep 1
done
echo "Database is ready."

# Apply any pending migrations (safe to run repeatedly; no-op if up to date).
npx prisma migrate deploy

# Hand off to the main process (npm start + ws-server via the Dockerfile CMD).
exec "$@"
