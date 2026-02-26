import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

export async function runMigrations() {
  const client = new Client({
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });

  try {
    await client.connect();

    // Find migrations directory
    const possiblePaths = [
      path.join(__dirname, "..", "migrations"), // /app/migrations (Docker)
      path.join(__dirname, "..", "..", "database", "migrations"), // Development
      path.join(process.cwd(), "migrations"), // Current directory
      path.join(process.cwd(), "..", "database", "migrations"), // Parent/database
    ];

    let migrationsDir: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        migrationsDir = p;
        break;
      }
    }

    if (!migrationsDir) {
      console.log("No migrations directory found. Skipping migrations.");
      return;
    }

    // Ensure schema_migrations table exists (bootstrap)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Get list of already-applied migrations
    const applied = await client.query(
      "SELECT filename FROM schema_migrations",
    );
    const appliedSet = new Set(applied.rows.map((r) => r.filename));

    // Find all .sql migration files, sorted by filename
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // Run pending migrations in order
    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) continue;

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, "utf8");

      console.log(`Applying migration: ${file}`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file],
        );
        await client.query("COMMIT");
        count++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`Migration ${file} failed:`, err);
        process.exit(1);
      }
    }

    if (count > 0) {
      console.log(`Applied ${count} migration(s) successfully.`);
    } else {
      console.log("Database is up to date. No pending migrations.");
    }
  } catch (error) {
    console.error("Migration runner failed:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runMigrations();
}
