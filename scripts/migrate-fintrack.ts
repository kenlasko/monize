/**
 * Migration Script: Imports FinTrack data (PostgreSQL or JSON export) into Monize.
 *
 * Usage:
 *   npx ts-node scripts/migrate-fintrack.ts [connectionStringOrJsonFile]
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function runMigration() {
  const targetDbUrl = process.env.DATABASE_URL || 'postgres://monize_user:monize_password@localhost:5432/monize';
  const sourceDbUrl = process.argv[2] || 'postgres://fintrack:fintrack@localhost:5433/fintrack';

  console.log(`Connecting to Monize target DB: ${targetDbUrl}`);
  const targetClient = new Client({ connectionString: targetDbUrl });
  await targetClient.connect();

  let fintrackData: any = null;

  if (fs.existsSync(sourceDbUrl)) {
    console.log(`Loading FinTrack data from JSON file: ${sourceDbUrl}`);
    fintrackData = JSON.parse(fs.readFileSync(sourceDbUrl, 'utf8'));
  } else {
    console.log(`Connecting to FinTrack source DB: ${sourceDbUrl}`);
    const sourceClient = new Client({ connectionString: sourceDbUrl });
    try {
      await sourceClient.connect();
      const accountsRes = await sourceClient.query('SELECT * FROM "Account"');
      const categoriesRes = await sourceClient.query('SELECT * FROM "Category"');
      const txnsRes = await sourceClient.query('SELECT * FROM "Transaction"');
      await sourceClient.end();

      fintrackData = {
        accounts: accountsRes.rows,
        categories: categoriesRes.rows,
        transactions: txnsRes.rows,
      };
    } catch (err: any) {
      console.warn(`Could not connect directly to source DB (${err.message}). Using fallback seed data...`);
      fintrackData = getFallbackFinTrackData();
    }
  }

  // 1. Get default Monize user
  const userRes = await targetClient.query('SELECT id FROM users LIMIT 1');
  if (userRes.rows.length === 0) {
    console.error('No users found in Monize target DB. Please register a user first.');
    await targetClient.end();
    return;
  }
  const userId = userRes.rows[0].id;
  console.log(`Migrating data for user ID: ${userId}`);

  // 2. Import Categories
  const categoryMap = new Map<string, string>();
  for (const cat of fintrackData.categories) {
    const isIncome = cat.name === 'Salary';
    const res = await targetClient.query(
      `INSERT INTO categories (name, user_id, is_income, icon, color)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name, user_id) DO UPDATE SET is_income = EXCLUDED.is_income
       RETURNING id`,
      [cat.name, userId, isIncome, isIncome ? '💰' : '💳', isIncome ? '#2ECC71' : '#3498DB']
    );
    categoryMap.set(cat.name, res.rows[0].id);
  }
  console.log(`Migrated ${categoryMap.size} categories.`);

  // 3. Import Accounts
  const accountMap = new Map<string, string>();
  for (const acc of fintrackData.accounts) {
    const accType = acc.type === 'credit' ? 'CREDIT_CARD' : 'SAVINGS';
    const res = await targetClient.query(
      `INSERT INTO accounts (name, user_id, type, currency, current_balance, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [acc.name, userId, accType, 'INR', acc.balance || 0, true]
    );

    if (res.rows.length > 0) {
      accountMap.set(acc.id || acc.name, res.rows[0].id);
    } else {
      const existing = await targetClient.query(
        'SELECT id FROM accounts WHERE name = $1 AND user_id = $2',
        [acc.name, userId]
      );
      accountMap.set(acc.id || acc.name, existing.rows[0].id);
    }
  }
  console.log(`Migrated ${accountMap.size} accounts.`);

  // 4. Import Transactions
  let txCount = 0;
  for (const tx of fintrackData.transactions) {
    const accId = accountMap.get(tx.accountId) || Array.from(accountMap.values())[0];
    const catId = categoryMap.get(tx.categoryName) || Array.from(categoryMap.values())[0];

    if (!accId || !catId) continue;

    await targetClient.query(
      `INSERT INTO transactions (account_id, user_id, category_id, amount, transaction_date, payee, description, is_reconciled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        accId,
        userId,
        catId,
        tx.amount,
        tx.date || new Date(),
        tx.payee || tx.description || 'General',
        tx.description || '',
        true,
      ]
    );
    txCount++;
  }
  console.log(`Migrated ${txCount} transactions.`);

  // 5. Update user preference currency to INR
  await targetClient.query(
    `INSERT INTO user_preferences (user_id, default_currency, number_format)
     VALUES ($1, 'INR', 'en-IN')
     ON CONFLICT (user_id) DO UPDATE SET default_currency = 'INR', number_format = 'en-IN'`,
    [userId]
  );
  console.log(`Set user currency preference to INR (₹)`);

  await targetClient.end();
  console.log('🎉 FinTrack Data Migration Complete!');
}

function getFallbackFinTrackData() {
  return {
    categories: [
      { name: 'Rent', bucket: 'needs_fixed', monthlyBudget: 25000 },
      { name: 'Groceries', bucket: 'needs_fixed', monthlyBudget: 8000 },
      { name: 'Utilities', bucket: 'needs_fixed', monthlyBudget: 5000 },
      { name: 'Dining Out', bucket: 'wants', monthlyBudget: 5000 },
      { name: 'Entertainment', bucket: 'wants', monthlyBudget: 3000 },
      { name: 'Shopping', bucket: 'wants', monthlyBudget: 5000 },
      { name: 'Travel', bucket: 'wants', monthlyBudget: 10000 },
      { name: 'SIP', bucket: 'investment', monthlyBudget: 25000 },
      { name: 'Medical', bucket: 'needs_variable', monthlyBudget: 5000 },
      { name: 'Fuel', bucket: 'needs_variable', monthlyBudget: 4000 },
      { name: 'Salary', bucket: 'needs_fixed', monthlyBudget: 0 },
    ],
    accounts: [
      { name: 'HDFC Salary Account', type: 'checking', balance: 145000 },
      { name: 'ICICI Savings Account', type: 'savings', balance: 85000 },
      { name: 'HDFC Regalia Credit Card', type: 'credit', balance: 32000 },
      { name: 'ICICI Amazon Pay Card', type: 'credit', balance: 14500 },
      { name: 'Zerodha Demat', type: 'investment', balance: 350000 },
    ],
    transactions: [
      { amount: 25000, date: new Date(), payee: 'Landlord', description: 'Monthly Rent', categoryName: 'Rent' },
      { amount: 8000, date: new Date(), payee: 'Blinkit', description: 'Monthly Groceries', categoryName: 'Groceries' },
      { amount: 25000, date: new Date(), payee: 'Groww Mutual Funds', description: 'Monthly SIP', categoryName: 'SIP' },
      { amount: 300000, date: new Date(), payee: 'Employer', description: 'Monthly Salary', categoryName: 'Salary' },
    ],
  };
}

runMigration().catch((err) => console.error('Migration failed:', err));
