import { ServiceUnavailableException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import type { MonthlySnapshotRow } from "../net-worth/net-worth-rows";
import {
  ledgerBalanceJoin,
  LEDGER_BALANCE_EXPRESSION,
} from "../common/ledger-balance.sql";
import { readAccrualSystemBalances } from "./reporting-system-balances";

interface NativeAccount {
  id: string;
  account_type: string;
  account_sub_type: string | null;
  currency_code: string;
}
/** Cash snapshots remain cash. Earlier recognition months get native ledger
 * balances explicitly; an absent investment valuation never becomes zero.
 */
export async function accrualNetWorthSnapshots(
  manager: EntityManager,
  userId: string,
  native: MonthlySnapshotRow[],
  start: string,
  end: string,
  jointIds: readonly string[] = [],
) {
  const bounds = await manager.query(
    `SELECT TO_CHAR(MIN(a.recognition_date),'YYYY-MM-DD') AS first
    FROM accrual_schedules s JOIN accrual_allocations a ON a.schedule_id=s.id AND a.user_id=s.user_id
    JOIN transactions t ON t.id=s.source_transaction_id AND t.user_id=s.user_id
    JOIN accounts source_account ON source_account.id=t.account_id
    WHERE ((s.user_id=$1 AND NOT source_account.exclude_from_net_worth) OR t.account_id=ANY($2::uuid[]))
      AND t.status IS DISTINCT FROM 'VOID' AND NOT t.is_transfer`,
    [userId, [...jointIds]],
  );
  if (!bounds[0]?.first && native.length === 0) return native;
  const accounts: NativeAccount[] = await manager.query(
    `SELECT id,account_type,account_sub_type,currency_code FROM accounts
    WHERE (user_id=$1 AND NOT exclude_from_net_worth) OR id=ANY($2::uuid[])`,
    [userId, [...jointIds]],
  );
  const asDate = (date: string | Date) =>
    date instanceof Date
      ? date.toISOString().slice(0, 10)
      : String(date).slice(0, 10);
  const nativeFirst = native.map((row) => asDate(row.month)).sort()[0];
  const earliest = [nativeFirst, bounds[0].first].filter(Boolean).sort()[0];
  const first = earliest > start ? earliest : start;
  const months: { month: string; date: string }[] = await manager.query(
    `SELECT TO_CHAR(day,'YYYY-MM-DD') AS month,
    TO_CHAR(LEAST((day+INTERVAL '1 month - 1 day')::date,CURRENT_DATE),'YYYY-MM-DD') AS date
    FROM generate_series(date_trunc('month',$1::date),date_trunc('month',LEAST($2::date,CURRENT_DATE)),INTERVAL '1 month') day
    LIMIT 6001`,
    [first, end],
  );
  if (months.length > 6000)
    throw new ServiceUnavailableException({
      code: "REPORTING_ROW_LIMIT",
      limit: 6000,
    });
  const result: MonthlySnapshotRow[] = [];
  const nativeRows = new Map(
    native.map((row) => [
      `${row.account_id}:${asDate(row.month).slice(0, 7)}`,
      row,
    ]),
  );
  for (const account of accounts) {
    const missing = months.filter((month) => {
      const existing = nativeRows.get(
        `${account.id}:${month.month.slice(0, 7)}`,
      );
      return !existing || existing.market_value === null;
    });
    if (
      missing.length &&
      (account.account_type === "INVESTMENT" ||
        account.account_sub_type === "INVESTMENT_BROKERAGE")
    )
      throw new ServiceUnavailableException({
        code: "REPORTING_BALANCE_HISTORY_INCOMPLETE",
        accountId: account.id,
        dates: missing.map((month) => month.date),
        repair: "refresh_balance_history",
      });
    for (let offset = 0; offset < months.length; offset += 600) {
      const chunk = months.slice(offset, offset + 600);
      const balances: { date: string; balance: string }[] = await manager.query(
        `SELECT TO_CHAR(d.as_of,'YYYY-MM-DD') AS date,
        (CASE WHEN a.account_type='ASSET' AND a.date_acquired>d.as_of THEN 0 ELSE ${LEDGER_BALANCE_EXPRESSION} END)::text AS balance
        FROM accounts a CROSS JOIN unnest($2::date[]) d(as_of)
        ${ledgerBalanceJoin("d.as_of")}
        WHERE a.id=$1 GROUP BY a.id,a.opening_balance,d.as_of`,
        [account.id, chunk.map((month) => month.date)],
      );
      const byDate = new Map(balances.map((row) => [row.date, row.balance]));
      for (const month of chunk) {
        const balance = byDate.get(month.date);
        if (balance === undefined)
          throw new ServiceUnavailableException({
            code: "REPORTING_BALANCE_HISTORY_INCOMPLETE",
            accountId: account.id,
            date: month.date,
            repair: "refresh_balance_history",
          });
        result.push({
          month: month.month,
          balance,
          market_value:
            nativeRows.get(`${account.id}:${month.month.slice(0, 7)}`)
              ?.market_value ?? null,
          account_id: account.id,
          account_type: account.account_type,
          account_sub_type: account.account_sub_type,
          currency_code: account.currency_code,
        });
      }
    }
  }
  for (let offset = 0; offset < months.length; offset += 600) {
    const chunk = months.slice(offset, offset + 600);
    const timing = await readAccrualSystemBalances(
      manager,
      userId,
      chunk.map((month) => month.date),
      undefined,
      { jointAccountIds: jointIds, netWorthOnly: true },
    );
    const monthByDate = new Map(
      chunk.map((month) => [month.date, month.month]),
    );
    for (const row of timing)
      result.push({
        month: monthByDate.get(row.date)!,
        balance: row.balance,
        market_value: null,
        account_id: row.id,
        account_type: row.family === "expense" ? "ASSET" : "LOAN",
        account_sub_type: null,
        currency_code: row.currencyCode,
        timing_family: row.family,
        valuation_date: row.date,
      });
  }
  return result;
}
