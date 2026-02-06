#!/bin/sh
set -e

echo "Checking database initialization..."
node dist/db-init.js

echo "Starting application..."
exec node dist/main.js
