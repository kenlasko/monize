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

async function fixLinkedTransactions() {
  const dataSource = new DataSource({
    type: "postgres",
    host: process.env.DATABASE_HOST || "localhost",
    port: parseInt(process.env.DATABASE_PORT || "5432"),
    username:
      process.env.DATABASE_USER || process.env.POSTGRES_USER || "monize_user",
    password:
      process.env.DATABASE_PASSWORD ||
      process.env.POSTGRES_PASSWORD ||
      "monize_password",
    database: process.env.DATABASE_NAME || process.env.POSTGRES_DB || "monize",
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
