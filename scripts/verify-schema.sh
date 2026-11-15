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
# Requires: docker, diff. Uses an ephemeral postgres:18-alpine container,
# pulled from mirror.gcr.io, Google's mirror of the official image (the same digest the
# integration job's service container uses in .github/workflows/ci.yml), so the
# run needs no Docker Hub login and no Docker Hub rate limit applies. Override
# with PG_IMAGE=... to use another source.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_IMAGE="${PG_IMAGE:-mirror.gcr.io/library/postgres:18-alpine@sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015}"
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

# Migrations should be no-ops on a schema.sql baseline (per CLAUDE.md they
# must use IF NOT EXISTS / IF EXISTS). A migration that fails here -- or
# that succeeds but mutates the schema -- means schema.sql is missing the
# change and would diverge from upgraded installs.
#
# Applied TWICE (task B1): pass 1 proves each body is a no-op on an up-to-date
# schema, pass 2 proves it is a no-op on the state it just produced -- the case
# that bites in production, when a migration half-applies (crash between the DDL
# and the schema_migrations INSERT, restore from a mid-deploy snapshot) and the
# next boot re-runs the whole body. The static counterpart is
# `backend/npm run migration:lint`; see docs/database-migrations.md.
#
# Apply order is NUMERIC on the filename prefix, then the full filename -- the
# order `backend/src/common/db/migration-filename.ts` gives db-migrate. A shell
# glob is a string sort, which agrees with that only while every historical
# prefix begins with 0 or 1 and every timestamp with 2; `sort -n` reads the
# leading digits as a number and breaks ties on the whole line, which is the
# same rule. `migration-filename.spec.ts` runs this exact pipeline against the
# TypeScript comparator to keep them agreeing.
mapfile -t MIGRATION_FILES < <(ls "$REPO_ROOT/database/migrations" | grep '\.sql$' | sort -n)

for pass in 1 2; do
  echo "Applying migrations on top of db_migrations (pass $pass of 2)..."
  for fname in "${MIGRATION_FILES[@]}"; do
    f="$REPO_ROOT/database/migrations/$fname"
    docker cp "$f" "$CONTAINER:/tmp/migration.sql"
    if ! psql_in -d db_migrations -f /tmp/migration.sql >/dev/null 2>&1; then
      echo "FAIL: migration $fname errored when applied on top of schema.sql (pass $pass)"
      echo "      (likely missing IF NOT EXISTS / IF EXISTS guards -- see"
      echo "       docs/database-migrations.md and npm run migration:lint)"
      psql_in -d db_migrations -f /tmp/migration.sql || true
      exit 1
    fi
  done
done

DUMP_OPTS=(--schema-only --no-comments --no-owner --no-privileges --no-tablespaces)

echo "Dumping schemas..."
docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  pg_dump "${DUMP_OPTS[@]}" -U postgres db_schema > /tmp/monize-schema-dump.sql
docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" \
  pg_dump "${DUMP_OPTS[@]}" -U postgres db_migrations > /tmp/monize-migrations-dump.sql

# Normalize: strip pg_dump headers, SET statements, comments, blank lines,
# and the per-run \restrict/\unrestrict tokens pg_dump adds for security
# (these contain a random nonce that differs every run). Real schema
# differences (column types, constraints, indexes, defaults) survive.
normalize() {
  sed -E \
    -e '/^--/d' \
    -e '/^SET /d' \
    -e '/^SELECT pg_catalog/d' \
    -e '/^\\connect/d' \
    -e '/^\\restrict /d' \
    -e '/^\\unrestrict /d' \
    -e '/^$/d' \
    "$1"
}

if diff -u <(normalize /tmp/monize-schema-dump.sql) <(normalize /tmp/monize-migrations-dump.sql) > /tmp/monize-schema-diff.txt; then
  # Deliberately precise about what was proven. Both databases start from the
  # current schema.sql (older migrations were rolled into it), so this shows the
  # retained migrations are no-ops when replayed on top of it -- which is also how
  # the app boots: db-init applies schema.sql, db-migrate then replays the whole
  # directory. It does NOT show that an old database upgraded through every
  # migration arrives at the current schema; the repository has no earliest
  # historical schema to start such a replay from.
  echo "OK: every retained migration is a no-op when replayed on top of schema.sql"
  exit 0
fi

echo "FAIL: replaying the migrations on top of schema.sql changes the schema"
echo
echo "Diff (schema.sql <-> migrations applied to fresh db):"
echo "-----------------------------------------------------"
cat /tmp/monize-schema-diff.txt
echo "-----------------------------------------------------"
echo
echo "Fix: update database/schema.sql to match the migrations,"
echo "or fix the migrations to produce the schema.sql state."
exit 1
