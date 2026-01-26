/**
 * Script to delete all transactions from all accounts
 *
 * Usage: docker exec -it moneymate-backend npx ts-node scripts/delete-all-transactions.ts
 *
 * WARNING: This will permanently delete ALL transactions and reset account balances!
 */

import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432'),
    username: process.env.DATABASE_USER || 'moneymate_user',
    password: process.env.DATABASE_PASSWORD || 'moneymate_password',
    database: process.env.DATABASE_NAME || 'moneymate',
  });

  try {
    await dataSource.initialize();
    console.log('Connected to database');

    // Start a transaction for safety
    await dataSource.transaction(async (manager) => {
      // Delete transaction splits first (foreign key constraint)
      const splitsResult = await manager.query('DELETE FROM transaction_splits');
      console.log(`Deleted transaction splits`);

      // Delete all transactions
      const txResult = await manager.query('DELETE FROM transactions');
      console.log(`Deleted all transactions`);

      // Reset all account balances to their opening balance
      await manager.query(`
        UPDATE accounts
        SET current_balance = opening_balance
      `);
      console.log('Reset all account balances to opening balance');
    });

    console.log('\nAll transactions have been deleted successfully!');
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
  }
}

main();
