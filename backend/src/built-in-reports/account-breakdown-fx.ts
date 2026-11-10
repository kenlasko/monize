import { EntityManager, SelectQueryBuilder } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import { convertDatedRows } from "./report-currency.service";

const TX_DAY = "TO_CHAR(t.transaction_date, 'YYYY-MM-DD')";

/**
 * Per-account totals with each one's figure in the reader's reporting currency
 * beside it, for a detail page that ranks accounts of several currencies.
 *
 * `datedRows` builds a fresh query over the same transactions the breakdown
 * summed, aliased `t` and joined to `account`, with no select of its own; the
 * foreign accounts' rows are re-read from it by day and own rate, so each part
 * converts at the rate it settled at or the market rate on its own date rather
 * than the whole lifetime total at today's rate (issue #2106).
 * `convertedTotal` is `null` while a part has no admissible rate. The
 * reporting currency is read on `m`, inside the caller's transaction.
 */
export async function withAccountTotalsInReportingCurrency<
  T extends { accountId: string; currencyCode: string; total: number },
>(
  m: EntityManager,
  userId: string,
  rows: T[],
  datedRows: () => SelectQueryBuilder<Transaction>,
  amountExpr: string,
): Promise<
  Array<T & { convertedCurrency: string; convertedTotal: number | null }>
> {
  if (rows.length === 0) return [];
  const reportingCurrency = preferredCurrency(
    await m.getRepository(UserPreference).findOne({ where: { userId } }),
  );
  const converted = rows.some((row) => row.currencyCode !== reportingCurrency)
    ? await convertDatedRows(
        (sql, params) => m.query(sql, params),
        (
          await datedRows()
            .andWhere("account.currency_code <> :fxReportingCurrency", {
              fxReportingCurrency: reportingCurrency,
            })
            .select("account.id", "accountId")
            .addSelect("account.currency_code", "currencyCode")
            .addSelect(TX_DAY, "txDate")
            .addSelect("t.original_currency_code", "originalCurrencyCode")
            .addSelect("t.exchange_rate", "exchangeRate")
            .addSelect(`SUM(${amountExpr})`, "total")
            .groupBy("account.id")
            .addGroupBy("account.currency_code")
            .addGroupBy(TX_DAY)
            .addGroupBy("t.original_currency_code")
            .addGroupBy("t.exchange_rate")
            .getRawMany<{
              accountId: string;
              currencyCode: string;
              txDate: string;
              originalCurrencyCode: string | null;
              exchangeRate: string | null;
              total: string;
            }>()
        ).map((row) => ({
          key: row.accountId,
          currencyCode: row.currencyCode,
          txDate: row.txDate,
          originalCurrencyCode: row.originalCurrencyCode,
          exchangeRate: row.exchangeRate,
          amounts: { total: Number(row.total) || 0 },
        })),
        reportingCurrency,
      )
    : new Map<string, Record<string, number | null>>();

  return rows.map((row) => ({
    ...row,
    convertedCurrency: reportingCurrency,
    convertedTotal:
      row.currencyCode === reportingCurrency
        ? row.total
        : (converted.get(row.accountId)?.total ?? null),
  }));
}
