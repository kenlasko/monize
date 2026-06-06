#!/usr/bin/env bash
# Verify database/schema.sql is in sync with database/migrations/.
#
# Invariant (per database/CLAUDE.md): "Always update database/schema.sql
# alongside any migration." We check this by:
#
#   db_schema      = fresh DB + apply schema.sql
#   db_migrations  = fresh DB + apply schema.sql + apply all migrations
#
# If schema.sql is fully up to date, every migration uses IF NOT EXISTS /
# IF EXISTS guards and is a no-op on top of schema.sql, so the two dumps
# are identical. If someone adds a column in a migration but forgets to
# add it to schema.sql, db_migrations has the column and db_schema does
# not, and the diff fails the build.
#
# Note: migrations cannot recreate the full schema from scratch -- only
# the most recent ones live in database/migrations/, the older ones were
# rolled into schema.sql long ago.
#
# Usage: scripts/verify-schema.sh
#
# Requires: docker, diff. Uses an ephemeral postgres:16-alpine container.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_IMAGE="postgres:16-alpine"
PG_PASSWORD="verify_schema_pw"
CONTAINER="monize-verify-schema-$$"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -f /tmp/monize-schema-dump.sql /tmp/monize-migrations-dump.sql
}
trap cleanup EXIT

echo "Starting postgres ($PG_IMAGE)..."
docker run -d --rm --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  "$PG_IMAGE" >/dev/null

psql_in() {
  docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
    psql -U postgres -h localhost -v ON_ERROR_STOP=1 "$@"
}

# pg_isready can return ready before the server fully accepts connections
# (and the unix socket may not be created yet). Probe with an actual query
# instead so we wait until psql can really connect.
echo "Waiting for postgres to be ready..."
for _ in $(seq 1 60); do
  if psql_in -c "SELECT 1" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! psql_in -c "SELECT 1" >/dev/null 2>&1; then
  echo "FAIL: postgres did not become ready within 60s"
  docker logs "$CONTAINER" || true
  exit 1
fi

echo "Creating db_schema and db_migrations..."
psql_in -c "CREATE DATABASE db_schema;"
psql_in -c "CREATE DATABASE db_migrations;"

echo "Applying database/schema.sql to db_schema..."
docker cp "$REPO_ROOT/database/schema.sql" "$CONTAINER:/tmp/schema.sql"
psql_in -d db_schema -f /tmp/schema.sql >/dev/null

echo "Applying database/schema.sql to db_migrations (baseline)..."
psql_in -d db_migrations -f /tmp/schema.sql >/dev/null

echo "Applying migrations on top of db_migrations..."
# Migrations should be no-ops on a schema.sql baseline (per CLAUDE.md they
# must use IF NOT EXISTS / IF EXISTS). A migration that fails here -- or
# that succeeds but mutates the schema -- means schema.sql is missing the
# change and would diverge from upgraded installs.
for f in "$REPO_ROOT"/database/migrations/*.sql; do
  fname="$(basename "$f")"
  docker cp "$f" "$CONTAINER:/tmp/migration.sql"
  if ! psql_in -d db_migrations -f /tmp/migration.sql >/dev/null 2>&1; then
    echo "FAIL: migration $fname errored when applied on top of schema.sql"
    echo "      (likely missing IF NOT EXISTS / IF EXISTS guards)"
    psql_in -d db_migrations -f /tmp/migration.sql || true
    exit 1
  fi
done

DUMP_OPTS=(--schema-only --no-comments --no-owner --no-privileges --no-tablespaces)

echo "Dumping schemas..."
docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  pg_dump "${DUMP_OPTS[@]}" -U postgres db_schema > /tmp/monize-schema-dump.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  pg_dump "${DUMP_OPTS[@]}" -U postgres db_migrations > /tmp/monize-migrations-dump.sql

# Normalize: strip pg_dump headers, SET statements, comments, and blank lines
# so trivial formatting differences don't cause false positives. Real schema
# differences (column types, constraints, indexes, defaults) survive.
normalize() {
  sed -E \
    -e '/^--/d' \
    -e '/^SET /d' \
    -e '/^SELECT pg_catalog/d' \
    -e '/^\\connect/d' \
    -e '/^$/d' \
    "$1"
}

if diff -u <(normalize /tmp/monize-schema-dump.sql) <(normalize /tmp/monize-migrations-dump.sql) > /tmp/monize-schema-diff.txt; then
  echo "OK: schema.sql matches the state produced by all migrations"
  exit 0
fi

echo "FAIL: schema.sql diverges from migrations state"
echo
echo "Diff (schema.sql <-> migrations applied to fresh db):"
echo "-----------------------------------------------------"
cat /tmp/monize-schema-diff.txt
echo "-----------------------------------------------------"
echo
echo "Fix: update database/schema.sql to match the migrations,"
echo "or fix the migrations to produce the schema.sql state."
exit 1
