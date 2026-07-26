/**
 * Migration Script: Imports FinTrack data (PostgreSQL or JSON export) into Monize.
 *
 * Usage:
 *   npx ts-node scripts/migrate-fintrack.ts [connectionStringOrJsonFile] [userEmail]
 *   MONIZE_USER_EMAIL=<email> npx ts-node scripts/migrate-fintrack.ts
 *
 * userEmail (or MONIZE_USER_EMAIL) is required whenever the target DB has more
 * than one user -- otherwise the script refuses to guess which account to import into.
 */

import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

async function runMigration() {
  const targetDbUrl = process.env.DATABASE_URL || 'postgres://monize_user:monize_password@localhost:5432/monize';
  const sourceDbUrl = process.argv[2] || 'postgres://fintrack:fintrack@localhost:5433/fintrack';
  const targetUserEmail = process.env.MONIZE_USER_EMAIL || process.argv[3];

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

  // 1. Get target Monize user (explicit email required whenever the DB has more than one user)
  const userRes = targetUserEmail
    ? await targetClient.query('SELECT id FROM users WHERE email = $1', [targetUserEmail])
    : await targetClient.query('SELECT id FROM users');
  if (userRes.rows.length === 0) {
    console.error(
      targetUserEmail
        ? `No user found with email ${targetUserEmail}. Please register the user first.`
        : 'No users found in Monize target DB. Please register a user first.'
    );
    await targetClient.end();
    return;
  }
  if (!targetUserEmail && userRes.rows.length > 1) {
    console.error(
      'Multiple users found in Monize target DB. Pass MONIZE_USER_EMAIL=<email> (or a third CLI arg) to select one.'
    );
    await targetClient.end();
    return;
  }
  const userId = userRes.rows[0].id;
  console.log(`Migrating data for user ID: ${userId}`);

  // 2. Import Categories (explicit existence check -- parent_id is NULL for every
  // imported category, and Postgres UNIQUE treats NULL as distinct, so ON CONFLICT
  // would never dedupe re-runs even with the correct 3-column target)
  const categoryMap = new Map<string, string>();
  for (const cat of fintrackData.categories) {
    const isIncome = cat.name === 'Salary';
    const existing = await targetClient.query(
      'SELECT id FROM categories WHERE user_id = $1 AND name = $2 AND parent_id IS NULL',
      [userId, cat.name]
    );

    let categoryId: string;
    if (existing.rows.length > 0) {
      categoryId = existing.rows[0].id;
      await targetClient.query('UPDATE categories SET is_income = $1 WHERE id = $2', [isIncome, categoryId]);
    } else {
      const res = await targetClient.query(
        `INSERT INTO categories (name, user_id, is_income, icon, color)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [cat.name, userId, isIncome, isIncome ? '💰' : '💳', isIncome ? '#2ECC71' : '#3498DB']
      );
      categoryId = res.rows[0].id;
    }
    categoryMap.set(cat.name, categoryId);
  }
  console.log(`Migrated ${categoryMap.size} categories.`);

  // 3. Import Accounts (explicit existence check -- accounts has no unique
  // constraint on (name, user_id), so ON CONFLICT DO NOTHING never fires and
  // re-running the script would duplicate every account)
  const accountMap = new Map<string, string>();
  for (const acc of fintrackData.accounts) {
    const accType = acc.type === 'credit' ? 'CREDIT_CARD' : 'SAVINGS';
    const finalBalanceCents = Math.round(Number(acc.balance || 0) * 10000);
    // Only attribute a transaction to this account when both sides carry an explicit
    // accountId -- fallback demo data has neither, so it contributes 0 here and is
    // assigned to the first account by the step-4 fallback below.
    const accountTxns = fintrackData.transactions.filter(
      (tx: any) => tx.accountId !== undefined && acc.id !== undefined && tx.accountId === acc.id
    );
    const txnTotalCents = accountTxns.reduce(
      (sum: number, tx: any) => sum + Math.round(Number(tx.amount || 0) * 10000),
      0
    );
    // opening_balance is derived so that opening_balance + SUM(imported transactions)
    // reproduces fintrack's final balance -- accounts.service/net-worth.service compute
    // balance dynamically from opening_balance + transactions, not from current_balance.
    const openingBalance = (finalBalanceCents - txnTotalCents) / 10000;

    const existing = await targetClient.query(
      'SELECT id FROM accounts WHERE name = $1 AND user_id = $2',
      [acc.name, userId]
    );

    let accountId: string;
    if (existing.rows.length > 0) {
      accountId = existing.rows[0].id;
    } else {
      const res = await targetClient.query(
        `INSERT INTO accounts (name, user_id, type, currency, opening_balance, current_balance, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [acc.name, userId, accType, 'INR', openingBalance, acc.balance || 0, true]
      );
      accountId = res.rows[0].id;
    }
    accountMap.set(acc.id || acc.name, accountId);
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
