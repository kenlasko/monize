import type { EntityManager } from "typeorm";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { accrualErrors } from "./accrual-errors";

export interface AccrualSystemBalance {
  date: string;
  id: string;
  family: "expense" | "income";
  currencyCode: string;
  /** Signed, exact native-currency asset (expense) or liability (income). */
  balance: string;
}

/** Derive timing balances from the current source and allocations in one scoped read.
 * No cached materialized totals or ledger entries can outlive a source edit.
 */
export async function readAccrualSystemBalances(
  manager: EntityManager,
  userId: string,
  dates: readonly string[],
  accountIds?: readonly string[],
  options: { jointAccountIds?: readonly string[]; netWorthOnly?: boolean } = {},
): Promise<AccrualSystemBalance[]> {
  if (dates.length > 600 || dates.some((date) => !isCalendarDate(date)))
    throw accrualErrors.period();
  if (dates.length === 0) return [];
  return manager.query(
    `
    WITH dates AS (SELECT DISTINCT unnest($2::date[]) AS day),
    contributions AS (
      SELECT s.user_id, s.family, s.currency_code, d.day,
        CASE WHEN s.family='expense' THEN 1 ELSE -1 END * (
          COALESCE((SELECT SUM(a.amount) FROM accrual_allocations a
            WHERE a.user_id=s.user_id AND a.schedule_id=s.id AND a.recognition_date<=d.day),0)
          - CASE WHEN t.transaction_date<=d.day THEN COALESCE(sp.amount,t.amount) ELSE 0 END
        ) AS balance
      FROM accrual_schedules s
      JOIN transactions t ON t.id=s.source_transaction_id AND t.user_id=s.user_id
      LEFT JOIN transaction_splits sp ON sp.id=s.source_split_id AND sp.transaction_id=t.id
      JOIN accounts source_account ON source_account.id=t.account_id
      CROSS JOIN dates d
      WHERE (s.user_id=$1 OR t.account_id=ANY($4::uuid[])) AND t.status IS DISTINCT FROM 'VOID' AND NOT t.is_transfer
        AND ($3::uuid[] IS NULL OR t.account_id=ANY($3::uuid[]))
        AND (NOT $5::boolean OR (s.user_id=$1 AND NOT source_account.exclude_from_net_worth) OR t.account_id=ANY($4::uuid[]))
    )
    SELECT to_char(d.day,'YYYY-MM-DD') AS date, a.id, a.family,
      a.currency_code AS "currencyCode", COALESCE(SUM(c.balance),0)::numeric(20,4)::text AS balance
    FROM accrual_system_accounts a CROSS JOIN dates d
    LEFT JOIN contributions c ON c.user_id=a.user_id AND c.family=a.family
      AND c.currency_code=a.currency_code AND c.day=d.day
    WHERE a.user_id=$1 OR EXISTS (SELECT 1 FROM contributions visible WHERE visible.user_id=a.user_id AND visible.family=a.family AND visible.currency_code=a.currency_code)
    GROUP BY d.day,a.id,a.family,a.currency_code ORDER BY d.day,a.family,a.currency_code
  `,
    [
      userId,
      [...dates],
      accountIds ? [...accountIds] : null,
      [...(options.jointAccountIds ?? [])],
      options.netWorthOnly ?? false,
    ],
  );
}
