#!/bin/sh
set -e

echo "Checking database initialization..."
node dist/db-init.js

echo "Running database migrations..."
node dist/db-migrate.js

# In demo mode, seed the demo user and data if not already present
if [ "$DEMO_MODE" = "true" ]; then
  echo "Demo mode detected — checking if demo user exists..."
  node -e "
    const { Client } = require('pg');
    (async () => {
      const c = new Client({
        host: process.env.DATABASE_HOST,
        port: process.env.DATABASE_PORT || 5432,
        user: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
        database: process.env.DATABASE_NAME,
      });
      await c.connect();
      const r = await c.query(\"SELECT id FROM users WHERE email = 'demo@monize.com'\");
      await c.end();
      process.exit(r.rows.length > 0 ? 0 : 1);
    })().catch(() => process.exit(1));
  " && echo "Demo user already exists, skipping seed." || {
    echo "Seeding demo data..."
    node dist/database/seed.js
  }
fi

echo "Starting application..."
exec node dist/main.js
