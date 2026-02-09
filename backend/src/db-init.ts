import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";

async function initDatabase() {
  const client = new Client({
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432", 10),
    user: process.env.DATABASE_USER || "moneymate_user",
    password: process.env.DATABASE_PASSWORD || "moneymate_password",
    database: process.env.DATABASE_NAME || "moneymate",
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
    const possiblePaths = [
      path.join(__dirname, "..", "schema.sql"), // /app/schema.sql (Docker)
      path.join(__dirname, "..", "..", "database", "schema.sql"), // Development
      path.join(process.cwd(), "schema.sql"), // Current directory
      path.join(process.cwd(), "..", "database", "schema.sql"), // Parent/database
    ];

    let schemaPath: string | null = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        schemaPath = p;
        break;
      }
    }

    if (!schemaPath) {
      console.error("schema.sql not found. Searched paths:");
      possiblePaths.forEach((p) => console.error(`  - ${p}`));
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
