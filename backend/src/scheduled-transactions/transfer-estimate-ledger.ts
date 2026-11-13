import { EntityManager } from "typeorm";
import {
  LEDGER_BALANCE_EXPRESSION,
  LEDGER_MOVEMENT_PREDICATE,
  ledgerBalanceJoin,
} from "../common/ledger-balance.sql";
import {
  TransferDestinationFacts,
  TransferDestinationLedger,
  hasStatementCycle,
  settlementDatesAround,
} from "./transfer-estimate-floor";

/**
 * The reads behind an estimated scheduled transfer (issue #2164,
 * docs/specs/scheduled-amount-estimate.md section 10): its history, and what
 * its destination is owed. Each takes the caller's `EntityManager`, so they
 * run in the estimate's one read transaction.
 */

/** One transfer leg out of a schedule's source account into its destination. */
export interface TransferHistoryRow {
  account_id: string;
  transfer_account_id: string;
  tx_date: string;
  currency_code: string;
  amount: string;
}

/**
 * Every non-void transfer from each pair's source into its destination inside
 * the window, read on the source account's leg: its amount is in the
 * schedule's currency and negative. A transfer the other way is positive on
 * this leg and is not a payment of this schedule, which always posts out of
 * the source, so it is not read: were it the larger side, the estimate would
 * turn positive, the opposite of what posting moves.
 */
export async function loadTransferHistory(
  m: EntityManager,
  userId: string,
  pairs: readonly { accountId: string; transferAccountId: string }[],
  windowStart: string,
  today: string,
): Promise<TransferHistoryRow[]> {
  if (pairs.length === 0) return [];
  return m.query(
    `
    SELECT t.account_id, lt.account_id AS transfer_account_id,
           TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
           t.currency_code, t.amount
      FROM transactions t
      JOIN transactions lt ON lt.id = t.linked_transaction_id
     WHERE t.user_id = $1
       AND (t.account_id, lt.account_id) IN (
         SELECT k.account_id, k.transfer_account_id
           FROM unnest($2::uuid[], $3::uuid[]) AS k(account_id, transfer_account_id)
       )
       AND t.is_transfer = true
       AND t.amount < 0
       AND COALESCE(t.is_split, false) = false
       AND ${LEDGER_MOVEMENT_PREDICATE}
       AND t.transaction_date > $4
       AND t.transaction_date <= $5
    `,
    [
      userId,
      pairs.map((p) => p.accountId),
      pairs.map((p) => p.transferAccountId),
      windowStart,
      today,
    ],
  );
}

/** A transfer destination as the balance floor reads it. */
export interface TransferDestination {
  facts: TransferDestinationFacts;
  currencyCode: string;
  ledger: TransferDestinationLedger;
}

interface RawDestinationRow {
  id: string;
  account_type: string;
  statement_settlement_day: number | null;
  statement_due_day: number | null;
  currency_code: string;
}

/**
 * Each of the user's accounts in `accountIds` with its ledger: the balance
 * today and the credits dated after it, and for a card with both statement
 * days the balance at the closed statement and the credits since. A balance is the one ledger spelling
 * (`ledger-balance.sql.ts`), so it is the figure the account shows as of that
 * date. An account the user does not own is absent: no floor is read for it.
 */
export async function loadTransferDestinations(
  m: EntityManager,
  userId: string,
  accountIds: readonly string[],
  today: string,
): Promise<Map<string, TransferDestination>> {
  const result = new Map<string, TransferDestination>();
  if (accountIds.length === 0) return result;
  const accounts: RawDestinationRow[] = await m.query(
    `SELECT a.id, a.account_type, a.statement_settlement_day,
            a.statement_due_day, a.currency_code
       FROM accounts a
      WHERE a.user_id = $1 AND a.id = ANY($2::uuid[])`,
    [userId, [...new Set(accountIds)]],
  );
  if (accounts.length === 0) return result;

  // The settlement a card's statement closed on, read whatever the schedule's
  // frequency: the plan decides per schedule whether it uses it.
  const lastSettlementOf = new Map<string, string>();
  for (const row of accounts) {
    const facts = factsOf(row);
    if (hasStatementCycle(facts)) {
      lastSettlementOf.set(
        row.id,
        settlementDatesAround(facts.statementSettlementDay, today)
          .lastSettlement,
      );
    }
  }

  const asOf: { accountId: string; date: string }[] = accounts.map((row) => ({
    accountId: row.id,
    date: today,
  }));
  for (const [accountId, date] of lastSettlementOf) {
    asOf.push({ accountId, date });
  }
  const balances: { account_id: string; as_of: string; balance: string }[] =
    await m.query(
      `SELECT a.id AS account_id, TO_CHAR(d.as_of, 'YYYY-MM-DD') AS as_of,
              ${LEDGER_BALANCE_EXPRESSION} AS balance
         FROM unnest($2::uuid[], $3::date[]) AS d(account_id, as_of)
         JOIN accounts a ON a.id = d.account_id AND a.user_id = $1
         ${ledgerBalanceJoin("d.as_of", ["t.user_id = $1"])}
        GROUP BY a.id, a.opening_balance, d.as_of`,
      [userId, asOf.map((p) => p.accountId), asOf.map((p) => p.date)],
    );
  // Credits are counted whenever they are dated: a payment posted early is
  // dated on its due date, after today, and has already settled what it pays.
  // For a card, those after its closed statement; for any account, those
  // after today, which today's balance does not hold yet.
  const creditsFrom = accounts.map((row) => ({
    accountId: row.id,
    after: lastSettlementOf.get(row.id) ?? today,
  }));
  const credits: {
    account_id: string;
    credits_since: string;
    credits_ahead: string;
  }[] = await m.query(
    `SELECT d.account_id,
            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date > d.after_date), 0)
              AS credits_since,
            COALESCE(SUM(t.amount) FILTER (WHERE t.transaction_date > $4), 0)
              AS credits_ahead
       FROM unnest($2::uuid[], $3::date[]) AS d(account_id, after_date)
       LEFT JOIN transactions t ON t.account_id = d.account_id
        AND t.user_id = $1
        AND ${LEDGER_MOVEMENT_PREDICATE}
        AND t.amount > 0
        AND t.transaction_date > LEAST(d.after_date, $4::date)
      GROUP BY d.account_id`,
    [
      userId,
      creditsFrom.map((c) => c.accountId),
      creditsFrom.map((c) => c.after),
      today,
    ],
  );

  const balanceAt = new Map(
    balances.map((b) => [`${b.account_id}|${b.as_of}`, Number(b.balance)]),
  );
  const creditsOf = new Map(credits.map((c) => [c.account_id, c]));
  for (const row of accounts) {
    const lastSettlement = lastSettlementOf.get(row.id) ?? null;
    const rowCredits = creditsOf.get(row.id);
    result.set(row.id, {
      facts: factsOf(row),
      currencyCode: row.currency_code,
      ledger: {
        balanceToday: balanceAt.get(`${row.id}|${today}`) ?? 0,
        balanceAtLastSettlement: lastSettlement
          ? (balanceAt.get(`${row.id}|${lastSettlement}`) ?? 0)
          : null,
        creditsSinceLastSettlement: lastSettlement
          ? Number(rowCredits?.credits_since ?? 0)
          : 0,
        creditsAfterToday: Number(rowCredits?.credits_ahead ?? 0),
      },
    });
  }
  return result;
}

function factsOf(row: RawDestinationRow): TransferDestinationFacts {
  return {
    accountType: row.account_type,
    statementSettlementDay:
      row.statement_settlement_day === null
        ? null
        : Number(row.statement_settlement_day),
    statementDueDay:
      row.statement_due_day === null ? null : Number(row.statement_due_day),
  };
}
