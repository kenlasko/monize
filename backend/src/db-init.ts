import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

const SCHEMA_FILENAME = "schema.sql";

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name] || fallback;
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

/**
 * Resolve a path and verify it stays within the given base directory.
 * Returns the resolved path or null if validation fails.
 */
function safePath(base: string, relative: string): string | null {
  const resolved = path.resolve(base, relative);
  if (
    !resolved.startsWith(path.resolve(base) + path.sep) &&
    resolved !== path.resolve(base)
  ) {
    return null;
  }
  return resolved;
}

async function initDatabase() {
  const client = new Client({
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: requiredEnv("DATABASE_USER"),
    password: requiredEnv("DATABASE_PASSWORD"),
    database: requiredEnv("DATABASE_NAME"),
  });

  try {
    await client.connect();
    console.log("Connected to database");

    // Check if tables already exist
    const result = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'users'
      );
    `);

    if (result.rows[0].exists) {
      console.log("Database tables already exist. Skipping initialization.");
      return;
    }

    console.log("Tables not found. Initializing database...");

    // Try multiple possible locations for schema.sql
    // All base directories are trusted (derived from __dirname or cwd)
    const baseDirs = [
      path.resolve(__dirname, ".."), // /app (Docker)
      path.resolve(__dirname, "..", "..", "database"), // Development
      path.resolve(process.cwd()), // Current directory
      path.resolve(process.cwd(), "..", "database"), // Parent/database
    ];

    let schemaPath: string | null = null;
    for (const base of baseDirs) {
      const candidate = safePath(base, SCHEMA_FILENAME);
      if (candidate && fs.existsSync(candidate)) {
        schemaPath = candidate;
        break;
      }
    }

    if (!schemaPath) {
      console.error("schema.sql not found. Searched directories:");
      baseDirs.forEach((d) => console.error(`  - ${d}`));
      process.exit(1);
    }

    console.log(`Using schema from: ${schemaPath}`);
    const schema = fs.readFileSync(schemaPath, "utf8");

    await client.query(schema);
    console.log("Database initialized successfully!");
  } catch (error) {
    console.error("Database initialization failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDatabase();
