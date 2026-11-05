#!/bin/bash
# Produces a clean, shareable source archive of the WorkerAI monorepo.
#
# Deliberately uses `git ls-files` (the current INDEX — i.e. staged changes
# included) rather than `git archive HEAD` (the last COMMIT): as of this
# writing, three real database dump files are staged for removal
# (`git rm --cached`) but not yet committed — `git archive HEAD` would still
# include them. `git ls-files` reflects what's actually about to be
# committed, which is what we want to export.
#
# Explicitly re-excludes (on top of whatever .gitignore already covers,
# belt-and-suspenders in case anything slipped into the index by mistake):
#   - .env and .env.* (except .env.example)
#   - .git itself (git ls-files never includes it, but asserted below anyway)
#   - node_modules, .next (git ls-files never includes these if .gitignored —
#     asserted below anyway)
#   - *.sql, *.sql.gz, *.dump (local database backups)
#   - *.pem, *.key, id_rsa* (private keys)
#   - *.log (logs that might carry sensitive runtime output)
#
# Usage:
#   bash scripts/export-clean-package.sh [output-dir]
# Default output: ../workerai-export-<timestamp>/ (sibling of the repo root,
# so the export is never nested inside itself).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TIMESTAMP=$(date +%Y%m%d_%H%M%S 2>/dev/null || echo "export")
OUT_DIR="${1:-../workerai-export-$TIMESTAMP}"

if [ -e "$OUT_DIR" ]; then
  echo "ERROR: $OUT_DIR already exists — refusing to overwrite." >&2
  exit 1
fi

echo "Exporting tracked (and about-to-be-committed) files to: $OUT_DIR"
mkdir -p "$OUT_DIR"

# Walk every path git currently considers part of the project (index, not
# just HEAD) and copy it, preserving directory structure.
git ls-files -z | while IFS= read -r -d '' f; do
  mkdir -p "$OUT_DIR/$(dirname "$f")"
  cp "$f" "$OUT_DIR/$f"
done

echo "Applying explicit secret/artifact exclusions (belt-and-suspenders)..."
REMOVED=0
remove_matching() {
  # $1 = find's -path/-name pattern, $2 = find flag ("-name" or "-path")
  while IFS= read -r -d '' match; do
    base="$(basename "$match")"
    if [ "$base" = ".env.example" ]; then continue; fi
    rm -f "$match"
    REMOVED=$((REMOVED + 1))
  done < <(find "$OUT_DIR" -type f "$2" "$1" -print0 2>/dev/null)
}

# .env* (anywhere) — except .env.example, which is meant to be shared.
remove_matching "*.env" -name
remove_matching ".env.*" -name
# Database dumps are scoped to backups/ specifically — *.sql ALSO matches
# legitimate, necessary Prisma schema migrations elsewhere in the tree
# (prisma/migrations/**/migration.sql), which must be kept.
remove_matching "*/backups/*.sql" -path
remove_matching "*/backups/*.sql.gz" -path
remove_matching "*/backups/*.dump" -path
remove_matching "*.sql.gz" -name
remove_matching "*.dump" -name
# Private keys.
remove_matching "*.pem" -name
remove_matching "*.key" -name
remove_matching "id_rsa*" -name
remove_matching "id_dsa*" -name
remove_matching "id_ecdsa*" -name
remove_matching "id_ed25519*" -name
# Logs that might carry sensitive runtime output.
remove_matching "*.log" -name

echo "Removed $REMOVED additional file(s) matching exclusion patterns."

# Defense-in-depth assertions — fail loudly if anything sensitive survived.
echo "Verifying the export is clean..."
FAIL=0
if [ -d "$OUT_DIR/.git" ]; then echo "FAIL: .git present"; FAIL=1; fi
if find "$OUT_DIR" -type d -name node_modules | grep -q .; then echo "FAIL: node_modules present"; FAIL=1; fi
if find "$OUT_DIR" -type d -name ".next" | grep -q .; then echo "FAIL: .next present"; FAIL=1; fi
if find "$OUT_DIR" -type f -path "*/backups/*" \( -name "*.sql" -o -name "*.sql.gz" -o -name "*.dump" \) | grep -q .; then echo "FAIL: database dump present"; FAIL=1; fi
if find "$OUT_DIR" -type f \( -name "*.sql.gz" -o -name "*.dump" \) | grep -q .; then echo "FAIL: database dump/export file present"; FAIL=1; fi
if find "$OUT_DIR" -type f -name ".env" | grep -q .; then echo "FAIL: .env present"; FAIL=1; fi
if find "$OUT_DIR" -type f \( -name "*.pem" -o -name "*.key" \) | grep -q .; then echo "FAIL: key file present"; FAIL=1; fi

if [ "$FAIL" -eq 1 ]; then
  echo "EXPORT FAILED VERIFICATION — not safe to share. See FAIL lines above." >&2
  exit 1
fi

echo "OK — export verified clean: no .git, no node_modules, no .next, no database dumps, no .env, no key files."
echo "Total files exported: $(find "$OUT_DIR" -type f | wc -l | tr -d ' ')"
echo "Output: $OUT_DIR"
