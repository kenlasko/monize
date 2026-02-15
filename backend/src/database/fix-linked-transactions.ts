/**
 * Fix existing transactions that were created from transfer splits.
 *
 * When a transfer split is created, a linked transaction is created in the target account.
 * Previously, the linkedTransactionId was only set on the split entity, not on the created
 * transaction. This script fixes existing data by setting linkedTransactionId on transactions
 * that were created from transfer splits.
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/database/fix-linked-transactions.ts
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

async function fixLinkedTransactions() {
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
    // Find all splits that have a linkedTransactionId (these are transfer splits)
    // and update the corresponding transaction to point back to the parent transaction
    const result = await dataSource.query(`
      UPDATE transactions t
      SET linked_transaction_id = s.transaction_id
      FROM transaction_splits s
      WHERE s.linked_transaction_id = t.id
        AND t.linked_transaction_id IS NULL
        AND t.is_transfer = true
    `);

    console.log("Fixed linked transactions:", result);

    // Verify the fix
    const verification = await dataSource.query(`
      SELECT COUNT(*) as count
      FROM transactions t
      JOIN transaction_splits s ON s.linked_transaction_id = t.id
      WHERE t.linked_transaction_id IS NULL
        AND t.is_transfer = true
    `);

    console.log("Remaining unfixed transactions:", verification[0].count);
  } finally {
    await dataSource.destroy();
  }
}

fixLinkedTransactions().catch(console.error);
