import { Client } from 'pg'
import * as dotenv from 'dotenv'
import { randomUUID } from 'crypto'
import {
  readTable,
  parseMnyDate,
  parseAccountType,
  parseFrequency,
  buildCurrencyMap,
} from './transform'

dotenv.config()

const MDB_FILE = 'source.mdb'

// --- Deletion ---

async function deleteExistingData(client: Client, userId: string) {
  console.log('Deleting existing data...')

  const deletes: [string, string][] = [
    // Budget tables
    [
      'budget_period_categories',
      `DELETE FROM budget_period_categories WHERE budget_period_id IN (SELECT id FROM budget_periods WHERE budget_id IN (SELECT id FROM budgets WHERE user_id = $1))`,
    ],
    [
      'budget_periods',
      `DELETE FROM budget_periods WHERE budget_id IN (SELECT id FROM budgets WHERE user_id = $1)`,
    ],
    ['budget_alerts', `DELETE FROM budget_alerts WHERE user_id = $1`],
    [
      'budget_categories',
      `DELETE FROM budget_categories WHERE budget_id IN (SELECT id FROM budgets WHERE user_id = $1)`,
    ],
    ['budgets', `DELETE FROM budgets WHERE user_id = $1`],

    // Scheduled transactions
    [
      'scheduled_transaction_overrides',
      `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
    ],
    [
      'scheduled_transaction_splits',
      `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
    ],
    [
      'scheduled_transactions',
      `DELETE FROM scheduled_transactions WHERE user_id = $1`,
    ],

    // Investments
    [
      'investment_transactions',
      `DELETE FROM investment_transactions WHERE user_id = $1`,
    ],
    [
      'holdings',
      `DELETE FROM holdings WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)`,
    ],
    [
      'security_prices',
      `DELETE FROM security_prices WHERE security_id IN (SELECT id FROM securities WHERE user_id = $1)`,
    ],
    ['securities', `DELETE FROM securities WHERE user_id = $1`],

    // Transactions (clear circular FK first)
    [
      'transactions (clear linked_transaction_id)',
      `UPDATE transactions SET linked_transaction_id = NULL WHERE user_id = $1`,
    ],
    [
      'transaction_splits',
      `DELETE FROM transaction_splits WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = $1)`,
    ],
    ['transactions', `DELETE FROM transactions WHERE user_id = $1`],

    // Accounts (clear self-referencing FKs first)
    [
      'accounts (clear links)',
      `UPDATE accounts SET linked_account_id = NULL, source_account_id = NULL WHERE user_id = $1`,
    ],
    [
      'monthly_account_balances',
      `DELETE FROM monthly_account_balances WHERE user_id = $1`,
    ],
    ['accounts', `DELETE FROM accounts WHERE user_id = $1`],

    // Reference data
    ['payees', `DELETE FROM payees WHERE user_id = $1`],
    ['categories', `DELETE FROM categories WHERE user_id = $1`],
  ]

  for (const [label, sql] of deletes) {
    const result = await client.query(sql, [userId])
    const count = result.rowCount ?? 0
    if (count > 0) {
      console.log(`  ${label}: ${count} rows`)
    }
  }
}

// --- Currencies ---

async function ensureCurrencies(
  client: Client,
  crncRows: Record<string, string>[],
) {
  // Always ensure NZD exists
  await client.query(
    `INSERT INTO currencies (code, name, symbol, decimal_places)
     VALUES ('NZD', 'New Zealand Dollar', 'NZ$', 2)
     ON CONFLICT (code) DO NOTHING`,
  )

  // Insert any currencies from the Money file that don't already exist
  for (const row of crncRows) {
    const code = row['szIsoCode']?.trim()
    const name = row['szName']?.trim()
    if (!code || !name) continue

    await client.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ($1, $2, $1, 2)
       ON CONFLICT (code) DO NOTHING`,
      [code, name],
    )
  }
}

// --- Payees ---

async function migratePayees(
  client: Client,
  userId: string,
): Promise<Map<number, string>> {
  const rows = readTable(MDB_FILE, 'PAY')
  const payeeMap = new Map<number, string>()
  let count = 0

  for (const row of rows) {
    const hpay = parseInt(row['hpay']!)
    const name = row['szFull']?.trim()
    if (!hpay || !name) continue

    const id = randomUUID()
    await client.query(
      `INSERT INTO payees (id, user_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [id, userId, name],
    )
    payeeMap.set(hpay, id)
    count++
  }

  console.log(`  Payees: ${count}`)
  return payeeMap
}

// --- Categories ---

async function migrateCategories(
  client: Client,
  userId: string,
): Promise<Map<number, string>> {
  const rows = readTable(MDB_FILE, 'CAT')
  const categoryMap = new Map<number, string>()

  // Sort by nLevel ascending so parents are inserted before children
  const sorted = [...rows].sort((a, b) => {
    const aLevel = parseInt(a['nLevel'] ?? '0')
    const bLevel = parseInt(b['nLevel'] ?? '0')
    return aLevel - bLevel
  })

  let count = 0
  for (const row of sorted) {
    const hcat = parseInt(row['hcat']!)
    const name = row['szFull']?.trim()
    if (!hcat || !name) continue

    const parentMnyId = parseInt(row['hcatParent'] ?? '') || null
    const parentId = parentMnyId ? (categoryMap.get(parentMnyId) ?? null) : null

    const id = randomUUID()
    await client.query(
      `INSERT INTO categories (id, user_id, parent_id, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, name, parent_id) DO NOTHING`,
      [id, userId, parentId, name],
    )
    categoryMap.set(hcat, id)
    count++
  }

  console.log(`  Categories: ${count}`)
  return categoryMap
}

// --- Securities ---

async function migrateSecurities(
  client: Client,
  userId: string,
  currencyMap: Map<string, string>,
): Promise<Map<number, string>> {
  const rows = readTable(MDB_FILE, 'SEC')
  const securityMap = new Map<number, string>()
  let count = 0

  for (const row of rows) {
    const hsec = parseInt(row['hsec']!)
    const name = row['szFull']?.trim()
    if (!hsec || !name) continue

    const id = randomUUID()
    const currencyCode = currencyMap.get(row['hcrnc'] ?? '') ?? 'NZD'
    let symbol = row['szSymbol']?.trim() || name
    // Strip leading "/" from symbol (Money convention)
    if (symbol.startsWith('/')) symbol = symbol.slice(1)
    const exchange = row['szExchg']?.trim() || null

    await client.query(
      `INSERT INTO securities (id, user_id, symbol, name, exchange, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, symbol) DO NOTHING`,
      [id, userId, symbol, name, exchange, currencyCode],
    )
    securityMap.set(hsec, id)
    count++
  }

  console.log(`  Securities: ${count}`)
  return securityMap
}

// --- Accounts ---

interface AccountResult {
  accountMap: Map<number, string>
  accountCurrencyMap: Map<number, string>
}

async function migrateAccounts(
  client: Client,
  userId: string,
  currencyMap: Map<string, string>,
): Promise<AccountResult> {
  const rows = readTable(MDB_FILE, 'ACCT')
  const accountMap = new Map<number, string>()
  const accountCurrencyMap = new Map<number, string>()

  // Build set of account IDs to close: "z " prefixed accounts and their hacctRel targets
  const zClosedIds = new Set<number>()
  for (const row of rows) {
    const name = row['szFull']?.trim() ?? ''
    if (name.startsWith('z ')) {
      const id = parseInt(row['hacct']!)
      if (id) zClosedIds.add(id)
      const relId = parseInt(row['hacctRel'] ?? '')
      if (relId) zClosedIds.add(relId)
    }
  }

  let count = 0
  for (const row of rows) {
    const hacct = parseInt(row['hacct']!)
    const rawName = row['szFull']?.trim()
    if (!hacct || !rawName) continue

    const name = rawName.startsWith('z ') ? rawName.slice(2) : rawName
    const closed = row['fClosed'] === '1' || zClosedIds.has(hacct)
    const favourite = row['fFavorite'] === '1'
    const accountType = parseAccountType(parseInt(row['at'] ?? '0'))
    const currencyCode = currencyMap.get(row['hcrnc'] ?? '') ?? 'NZD'
    const openingBalance = row['amtOpen'] || '0'

    const id = randomUUID()
    await client.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
         opening_balance, current_balance, is_closed, is_favourite)
       VALUES ($1, $2, $3::account_type, $4, $5, $6, $6, $7, $8)`,
      [id, userId, accountType, name, currencyCode, openingBalance, closed, favourite],
    )

    accountMap.set(hacct, id)
    accountCurrencyMap.set(hacct, currencyCode)
    count++
  }

  // Process investment-cash account links (at=5 with hacctRel)
  let linkCount = 0
  for (const row of rows) {
    if (parseInt(row['at'] ?? '0') !== 5) continue
    const investmentHacct = parseInt(row['hacct']!)
    const cashHacct = parseInt(row['hacctRel'] ?? '')
    if (!investmentHacct || !cashHacct) continue

    const investmentId = accountMap.get(investmentHacct)
    const cashId = accountMap.get(cashHacct)
    if (!investmentId || !cashId) continue

    await client.query(
      `UPDATE accounts SET linked_account_id = $1, account_sub_type = 'INVESTMENT_BROKERAGE'
       WHERE id = $2`,
      [cashId, investmentId],
    )
    await client.query(
      `UPDATE accounts SET linked_account_id = $1, account_sub_type = 'INVESTMENT_CASH'
       WHERE id = $2`,
      [investmentId, cashId],
    )
    linkCount++
  }

  console.log(`  Accounts: ${count} (${linkCount} investment-cash links)`)
  return { accountMap, accountCurrencyMap }
}

// --- Transactions ---

async function migrateTransactions(
  client: Client,
  userId: string,
  accountMap: Map<number, string>,
  accountCurrencyMap: Map<number, string>,
  payeeMap: Map<number, string>,
  categoryMap: Map<number, string>,
): Promise<Map<number, string>> {
  const trnRows = readTable(MDB_FILE, 'TRN')
  const splitRows = readTable(MDB_FILE, 'TRN_SPLIT')
  const billRows = readTable(MDB_FILE, 'BILL')
  const xferRows = readTable(MDB_FILE, 'TRN_XFER')

  const trnMap = new Map(trnRows.map((r) => [r['htrn'], r]))

  // Exclude split children
  const splitChildIds = new Set(
    splitRows.map((r) => r['htrn']).filter(Boolean),
  )

  // Exclude recurring bill templates
  const billTemplateIds = new Set(
    billRows
      .map((r) => r['lHtrn'])
      .filter((id) => id && id !== '-1'),
  )

  // Exclude orphaned transfer sides: the "from" transaction of a transfer whose "to"
  // counterpart has no account (deleted in MS Money, leaving a phantom)
  const orphanedFromIds = new Set(
    xferRows
      .filter((r) => {
        const toTrn = trnMap.get(r['htrnLink'] ?? '')
        return toTrn && !toTrn['hacct']
      })
      .map((r) => r['htrnFrom'])
      .filter(Boolean),
  )

  const excluded = new Set([
    ...splitChildIds,
    ...billTemplateIds,
    ...orphanedFromIds,
  ])

  const transactionMap = new Map<number, string>()
  let count = 0
  let skipped = 0

  for (const row of trnRows) {
    const htrnStr = row['htrn']!
    if (excluded.has(htrnStr)) continue

    const htrn = parseInt(htrnStr)
    const hacct = parseInt(row['hacct'] ?? '')
    const date = parseMnyDate(row['dt'] ?? '')
    if (!htrn || !hacct || !date) continue

    const grftt = parseInt(row['grftt'] ?? '0') || 0
    const frq = row['frq'] ?? '-1'

    // frq != -1: recurring bill instance (auto-entered by scheduler, possibly replaced).
    // grftt bit 15 (0x8000): auto-entered transaction.
    // grftt bit 7 (0x80): voided transaction.
    if ((frq !== '-1' && frq !== '') || grftt & 0x8000 || grftt & 0x80) {
      skipped++
      continue
    }

    const accountId = accountMap.get(hacct)
    if (!accountId) continue

    const amtStr = row['amt'] || '0'

    // Warn on sub-penny amounts
    const amtNum = parseFloat(amtStr)
    if (Math.abs(Math.round(amtNum * 100) - amtNum * 100) > 0.001) {
      console.warn(
        `  WARN: sub-penny amount  htrn=${htrn}  hacct=${hacct}  dt=${row['dt']}  amt=${amtStr}`,
      )
    }

    const payeeMnyId = parseInt(row['lHpay'] ?? '') || null
    const payeeId =
      payeeMnyId && payeeMnyId > 0
        ? (payeeMap.get(payeeMnyId) ?? null)
        : null
    const catMnyId = parseInt(row['hcat'] ?? '') || null
    const categoryId =
      catMnyId && catMnyId > 0
        ? (categoryMap.get(catMnyId) ?? null)
        : null

    const status = row['cs'] === '2' ? 'RECONCILED' : 'UNRECONCILED'
    const currencyCode = accountCurrencyMap.get(hacct) ?? 'NZD'
    const memo = row['mMemo']?.trim() || null
    const reference = row['szId']?.trim() || null

    const id = randomUUID()
    await client.query(
      `INSERT INTO transactions
         (id, user_id, account_id, transaction_date, payee_id, category_id,
          amount, currency_code, status, description, reference_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id, userId, accountId, date, payeeId, categoryId,
        amtStr, currencyCode, status, memo, reference,
      ],
    )
    transactionMap.set(htrn, id)
    count++
  }

  console.log(
    `  Transactions: ${count}  (${skipped} recurring phantoms, ${orphanedFromIds.size} orphaned transfers skipped)`,
  )
  return transactionMap
}

// --- Splits ---

async function migrateSplits(
  client: Client,
  transactionMap: Map<number, string>,
  categoryMap: Map<number, string>,
) {
  const splitRows = readTable(MDB_FILE, 'TRN_SPLIT')
  const trnRows = readTable(MDB_FILE, 'TRN')
  const trnMap = new Map(trnRows.map((r) => [r['htrn'], r]))

  let count = 0
  // Track parent IDs that need is_split = true
  const parentIds = new Set<string>()

  for (const row of splitRows) {
    const htrn = parseInt(row['htrn']!)
    const htrnParent = parseInt(row['htrnParent'] ?? '')
    if (!htrn || !htrnParent) continue

    const parentId = transactionMap.get(htrnParent)
    if (!parentId) continue

    const trnRow = trnMap.get(row['htrn']!)
    if (!trnRow) continue

    const catMnyId = parseInt(trnRow['hcat'] ?? '') || null
    const categoryId =
      catMnyId && catMnyId > 0
        ? (categoryMap.get(catMnyId) ?? null)
        : null
    const amount = trnRow['amt'] || '0'
    const memo = trnRow['mMemo']?.trim() || null

    const id = randomUUID()
    await client.query(
      `INSERT INTO transaction_splits (id, transaction_id, category_id, amount, memo)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, parentId, categoryId, amount, memo],
    )
    parentIds.add(parentId)
    count++
  }

  // Mark parents as split transactions
  for (const parentId of parentIds) {
    await client.query(
      `UPDATE transactions SET is_split = true WHERE id = $1`,
      [parentId],
    )
  }

  console.log(`  Splits: ${count}`)
}

// --- Transfers ---

async function migrateTransfers(
  client: Client,
  transactionMap: Map<number, string>,
) {
  const xferRows = readTable(MDB_FILE, 'TRN_XFER')
  let count = 0

  for (const row of xferRows) {
    const fromMnyId = parseInt(row['htrnFrom']!)
    const toMnyId = parseInt(row['htrnLink']!)
    if (!fromMnyId || !toMnyId) continue

    const fromId = transactionMap.get(fromMnyId)
    const toId = transactionMap.get(toMnyId)
    if (!fromId || !toId) continue

    await client.query(
      `UPDATE transactions SET is_transfer = true, linked_transaction_id = $1
       WHERE id = $2`,
      [toId, fromId],
    )
    await client.query(
      `UPDATE transactions SET is_transfer = true, linked_transaction_id = $1
       WHERE id = $2`,
      [fromId, toId],
    )
    count++
  }

  console.log(`  Transfers: ${count}`)
}

// --- Investment Transactions ---

async function migrateInvestmentTransactions(
  client: Client,
  userId: string,
  accountMap: Map<number, string>,
  securityMap: Map<number, string>,
  transactionMap: Map<number, string>,
  accountCurrencyMap: Map<number, string>,
) {
  const invRows = readTable(MDB_FILE, 'TRN_INV')
  const trnRows = readTable(MDB_FILE, 'TRN')
  const trnMap = new Map(trnRows.map((r) => [r['htrn'], r]))

  let count = 0
  for (const row of invRows) {
    const htrn = parseInt(row['htrn']!)
    if (!htrn) continue

    const trnRow = trnMap.get(row['htrn']!)
    if (!trnRow) continue

    const hacct = parseInt(trnRow['hacct'] ?? '')
    const hsec = parseInt(trnRow['hsec'] ?? '')
    const date = parseMnyDate(trnRow['dt'] ?? '')
    if (!hacct || !hsec || !date) continue

    const accountId = accountMap.get(hacct)
    const securityId = securityMap.get(hsec)
    if (!accountId || !securityId) continue

    // Ensure the parent transaction exists (investment TRNs may have been excluded)
    let transactionId = transactionMap.get(htrn)
    if (!transactionId) {
      transactionId = randomUUID()
      const amtStr = trnRow['amt'] || '0'
      const currencyCode = accountCurrencyMap.get(hacct) ?? 'NZD'
      const memo = trnRow['mMemo']?.trim() || null

      await client.query(
        `INSERT INTO transactions
           (id, user_id, account_id, transaction_date, amount, currency_code, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [transactionId, userId, accountId, date, amtStr, currencyCode, memo],
      )
      transactionMap.set(htrn, transactionId)
    }

    const qty = parseFloat(row['qty'] ?? '0')
    const action: string = qty > 0 ? 'BUY' : qty < 0 ? 'SELL' : 'DIVIDEND'
    const quantity = String(Math.abs(qty))
    const price = row['dPrice'] || '0'
    const commission = row['amtCmn'] || '0'
    const totalAmount = trnRow['amt'] || '0'

    const id = randomUUID()
    await client.query(
      `INSERT INTO investment_transactions
         (id, user_id, account_id, transaction_id, security_id, action,
          transaction_date, quantity, price, commission, total_amount)
       VALUES ($1, $2, $3, $4, $5, $6::investment_action, $7, $8, $9, $10, $11)`,
      [
        id, userId, accountId, transactionId, securityId, action,
        date, quantity, price, commission, totalAmount,
      ],
    )
    count++
  }

  console.log(`  Investment transactions: ${count}`)
}

// --- Security Prices ---

async function migrateSecurityPrices(
  client: Client,
  securityMap: Map<number, string>,
) {
  const rows = readTable(MDB_FILE, 'SP')
  const BATCH = 500

  // Deduplicate in memory — source data may have duplicate (securityId, date) pairs
  const seen = new Set<string>()
  const deduplicated: { securityId: string; date: string; price: string }[] = []

  for (const row of rows) {
    const hsec = parseInt(row['hsec'] ?? '')
    const date = parseMnyDate(row['dt'] ?? '')
    const price = parseFloat(row['dPrice'] || '0')
    if (!hsec || !date || price <= 0) continue

    const securityId = securityMap.get(hsec)
    if (!securityId) continue

    const key = `${securityId}|${date}`
    if (seen.has(key)) continue
    seen.add(key)
    deduplicated.push({ securityId, date, price: row['dPrice'] || '0' })
  }

  let count = 0
  for (let i = 0; i < deduplicated.length; i += BATCH) {
    const batch = deduplicated.slice(i, i + BATCH)
    const values: string[] = []
    const params: unknown[] = []

    for (let j = 0; j < batch.length; j++) {
      const offset = j * 3
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`)
      params.push(batch[j].securityId, batch[j].date, batch[j].price)
    }

    await client.query(
      `INSERT INTO security_prices (security_id, price_date, close_price)
       VALUES ${values.join(', ')}
       ON CONFLICT DO NOTHING`,
      params,
    )
    count += batch.length
  }

  console.log(`  Security prices: ${count}`)
}

// --- Exchange Rates ---

async function migrateExchangeRates(
  client: Client,
  currencyMap: Map<string, string>,
) {
  const rows = readTable(MDB_FILE, 'CRNC_EXCHG')
  let count = 0

  for (const row of rows) {
    const fromCurrency = currencyMap.get(row['hcrncFrom'] ?? '') ?? null
    const toCurrency = currencyMap.get(row['hcrncTo'] ?? '') ?? null
    const date = parseMnyDate(row['dt'] ?? '')
    const rate = parseFloat(row['rate'] ?? '0')

    if (!fromCurrency || !toCurrency || !date || rate <= 0) continue

    await client.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (from_currency, to_currency, rate_date) DO NOTHING`,
      [fromCurrency, toCurrency, row['rate'], date],
    )
    count++
  }

  console.log(`  Exchange rates: ${count}`)
}

// --- Scheduled Transactions ---

async function migrateScheduledTransactions(
  client: Client,
  userId: string,
  accountMap: Map<number, string>,
  accountCurrencyMap: Map<number, string>,
  payeeMap: Map<number, string>,
  categoryMap: Map<number, string>,
) {
  const billRows = readTable(MDB_FILE, 'BILL')
  const trnRows = readTable(MDB_FILE, 'TRN')
  const trnMap = new Map(trnRows.map((r) => [r['htrn'], r]))
  const payRows = readTable(MDB_FILE, 'PAY')
  const payNameMap = new Map(
    payRows.map((r) => [r['hpay'], r['szFull']?.trim() ?? '']),
  )

  let count = 0
  for (const row of billRows) {
    const hbill = parseInt(row['hbill']!)
    if (!hbill) continue

    const templateId = row['lHtrn']
    const trnRow = templateId ? trnMap.get(templateId) : null

    const hacct = trnRow ? parseInt(trnRow['hacct'] ?? '') : null
    if (!hacct) continue

    const accountId = accountMap.get(hacct)
    if (!accountId) continue

    const payeeMnyId = trnRow ? parseInt(trnRow['lHpay'] ?? '') || null : null
    const payeeId =
      payeeMnyId && payeeMnyId > 0
        ? (payeeMap.get(payeeMnyId) ?? null)
        : null

    const catMnyId = trnRow ? parseInt(trnRow['hcat'] ?? '') || null : null
    const categoryId =
      catMnyId && catMnyId > 0
        ? (categoryMap.get(catMnyId) ?? null)
        : null

    const amount = trnRow?.['amt'] || '0'
    const nextDueDate = parseMnyDate(row['dt'] ?? '')
    if (!nextDueDate) continue

    const currencyCode = accountCurrencyMap.get(hacct) ?? 'NZD'
    const isActive = row['st'] === '1'

    // Name: prefer payee name, fall back to memo, then default
    let name = 'Scheduled payment'
    if (payeeMnyId && payeeMnyId > 0) {
      const payeeName = payNameMap.get(String(payeeMnyId))
      if (payeeName) name = payeeName
    }
    if (name === 'Scheduled payment' && trnRow?.['mMemo']?.trim()) {
      name = trnRow['mMemo'].trim()
    }

    const frequency = parseFrequency(parseInt(row['frq'] ?? '3'))

    const id = randomUUID()
    await client.query(
      `INSERT INTO scheduled_transactions
         (id, user_id, account_id, name, payee_id, category_id,
          amount, currency_code, frequency, next_due_date, start_date, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
      [
        id, userId, accountId, name, payeeId, categoryId,
        amount, currencyCode, frequency, nextDueDate, isActive,
      ],
    )
    count++
  }

  console.log(`  Scheduled transactions: ${count}`)
}

// --- Balance Computation ---

async function computeBalances(client: Client, userId: string) {
  const result = await client.query(
    `UPDATE accounts SET current_balance = opening_balance + COALESCE(
       (SELECT SUM(amount) FROM transactions
        WHERE transactions.account_id = accounts.id
        AND transactions.parent_transaction_id IS NULL),
       0
     )
     WHERE user_id = $1`,
    [userId],
  )
  console.log(`  Balances updated: ${result.rowCount} accounts`)
}

// --- Main ---

async function main() {
  const client = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'monize',
    user: process.env.POSTGRES_USER || 'monize_user',
    password: process.env.POSTGRES_PASSWORD,
  })

  await client.connect()
  console.log('Connected to PostgreSQL.\n')

  // Look up user
  const email = process.env.MIGRATION_USER_EMAIL
  if (!email) {
    throw new Error('MIGRATION_USER_EMAIL not set')
  }

  const userResult = await client.query(
    'SELECT id FROM users WHERE email = $1',
    [email],
  )
  if (userResult.rows.length === 0) {
    throw new Error(`User not found: ${email}`)
  }
  const userId: string = userResult.rows[0].id
  console.log(`Importing for user: ${email} (${userId})\n`)

  try {
    await client.query('BEGIN')

    await deleteExistingData(client, userId)

    // Build currency map from CRNC table
    const crncRows = readTable(MDB_FILE, 'CRNC')
    const currencyMap = buildCurrencyMap(crncRows)

    console.log('\nEnsuring currencies...')
    await ensureCurrencies(client, crncRows)
    console.log(`  Currency map: ${currencyMap.size} entries`)

    console.log('\nReference data:')
    const payeeMap = await migratePayees(client, userId)
    const categoryMap = await migrateCategories(client, userId)
    const securityMap = await migrateSecurities(client, userId, currencyMap)

    console.log('\nAccounts:')
    const { accountMap, accountCurrencyMap } = await migrateAccounts(
      client, userId, currencyMap,
    )

    console.log('\nTransactions:')
    const transactionMap = await migrateTransactions(
      client, userId, accountMap, accountCurrencyMap, payeeMap, categoryMap,
    )
    await migrateSplits(client, transactionMap, categoryMap)
    await migrateTransfers(client, transactionMap)

    console.log('\nInvestments:')
    await migrateInvestmentTransactions(
      client, userId, accountMap, securityMap, transactionMap, accountCurrencyMap,
    )

    console.log('\nPrices & rates:')
    await migrateSecurityPrices(client, securityMap)
    await migrateExchangeRates(client, currencyMap)

    console.log('\nScheduled transactions:')
    await migrateScheduledTransactions(
      client, userId, accountMap, accountCurrencyMap, payeeMap, categoryMap,
    )

    console.log('\nComputing balances:')
    await computeBalances(client, userId)

    await client.query('COMMIT')
    console.log('\nMigration complete.')
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('\nMigration failed, transaction rolled back.')
    throw error
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
