/**
 * Add skip_price_updates column to securities table.
 *
 * This column is used to mark auto-generated securities that should not have
 * their prices updated from external sources.
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/database/add-skip-price-updates-column.ts
 */

import { DataSource } from "typeorm";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.join(__dirname, "../../../.env") });

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  console.error(`Missing required environment variable: ${names.join(" or ")}`);
  process.exit(1);
}

async function addSkipPriceUpdatesColumn() {
  const dataSource = new DataSource({
    type: "postgres",
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432"),
    username: requiredEnv("DATABASE_USER", "POSTGRES_USER"),
    password: requiredEnv("DATABASE_PASSWORD", "POSTGRES_PASSWORD"),
    database: requiredEnv("DATABASE_NAME", "POSTGRES_DB"),
  });

  await dataSource.initialize();
  console.log("Database connected");

  try {
    // Check if column already exists
    const columnExists = await dataSource.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'securities' AND column_name = 'skip_price_updates'
    `);

    if (columnExists.length > 0) {
      console.log("Column skip_price_updates already exists");
      return;
    }

    // Add the column
    await dataSource.query(`
      ALTER TABLE securities
      ADD COLUMN skip_price_updates BOOLEAN NOT NULL DEFAULT false
    `);

    console.log("Added skip_price_updates column to securities table");
  } finally {
    await dataSource.destroy();
  }
}

addSkipPriceUpdatesColumn().catch(console.error);
