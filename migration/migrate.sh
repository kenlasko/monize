#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Validate required vars
if [ -z "${MONEY_FILE_PASSWORD:-}" ]; then
  echo "Error: MONEY_FILE_PASSWORD is not set in .env" >&2
  exit 1
fi

if [ -z "${MIGRATION_USER_EMAIL:-}" ]; then
  echo "Error: MIGRATION_USER_EMAIL is not set in .env" >&2
  exit 1
fi

MNY_FILE="source.mny"
MDB_FILE="source.mdb"
JAR_FILE="sunriise-export-0.0.1-SNAPSHOT-exec.jar"

if [ ! -f "$MNY_FILE" ]; then
  echo "Error: $MNY_FILE not found. Copy your .mny file here and retry." >&2
  exit 1
fi

# Download sunriise JAR if missing
if [ ! -f "$JAR_FILE" ]; then
  echo "Downloading sunriise JAR..."
  curl -fSL -o "$JAR_FILE" \
    "https://github.com/hung-le/sunriise2-misc/blob/master/out/sunriise-export-0.0.1-SNAPSHOT-exec.jar?raw=true"
  echo "  Done."
fi

# Check prerequisites
if ! command -v java &> /dev/null; then
  echo "Error: java is required but not installed." >&2
  exit 1
fi

if ! command -v mdb-export &> /dev/null; then
  echo "Error: mdbtools is required but not installed. Install with: brew install mdbtools" >&2
  exit 1
fi

echo "Step 1: Decrypting .mny -> .mdb via sunriise..."
java -jar "$JAR_FILE" export.mdb "$MNY_FILE" "$MONEY_FILE_PASSWORD" "$MDB_FILE" 2>/dev/null
echo "  Done: $MDB_FILE"

echo ""
echo "Step 2: Running import..."
npx tsx migrate.ts
echo ""
echo "Import complete."
