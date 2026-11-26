import { EntityManager, SelectQueryBuilder } from "typeorm";
import { Transaction } from "../transactions/entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import { FIAT_MONEY_DECIMALS, roundMoney } from "../common/round.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import {
  convertRateParts,
  foldRateParts,
  splitByRateBasis,
} from "./rate-basis-parts";

/** One account's row of a detail page's per-account breakdown. */
export interface AccountTotalsRow {
  accountId: string;
  accountName: string;
  accountType: string;
  currencyCode: string;
  transactionCount: number;
  /** In the account's currency, rounded at its precision. */
  total: number;
  lastTransactionDate: string | null;
  /** The reader's reporting currency, which `convertedTotal` is in. */
  convertedCurrency: string;
  /** `total` at each part's own rate or date; null without one. */
  convertedTotal: number | null;
  /**
   * The provisional transfer legs (`amountIsProvisional`, an imported
   * estimate) inside `total`, and so inside `convertedTotal`, which is null
   * rather than partial while a part has no rate.
   */
  provisionalCount: number;
}

/**
 * The per-account totals of `scope`, most transactions first, with each one's
 * figure in the reader's reporting currency beside it, for a detail page that
 * ranks accounts of several currencies.
 *
 * `scope` is a query over the page's transactions, aliased `t` and joined to
 * `account`, with no select of its own. The one read splits a foreign
 * account's rows by day and own rate ({@link splitByRateBasis}), so each part
 * converts at the rate it settled at or the market rate on its own date rather
 * than the whole lifetime total at today's rate (issue #2106), and the native
 * totals fold the parts back together; the rows are not read a second time
 * (issue #2130). `countExpr` counts the scope's transactions; `convertedTotal`
 * is `null` while a part has no admissible rate. The reporting currency is
 * read on `m`, inside the caller's transaction.
 */
export async function readAccountTotalsInReportingCurrency(
  m: EntityManager,
  userId: string,
  scope: SelectQueryBuilder<Transaction>,
  amountExpr: string,
  countExpr: string,
): Promise<AccountTotalsRow[]> {
  const reportingCurrency = preferredCurrency(
    await m.getRepository(UserPreference).findOne({ where: { userId } }),
  );
  scope
    .select("account.id", "accountId")
    .addSelect("account.name", "accountName")
    .addSelect("account.account_type", "accountType")
    .addSelect("account.currency_code", "currencyCode")
    .addSelect(countExpr, "transactionCount")
    .addSelect(`SUM(${amountExpr})`, "total")
    // Whole rows only: a split's lines are never provisional, so a leg lies
    // in one part and the parts' counts add up.
    .addSelect(
      "COUNT(DISTINCT t.id) FILTER (WHERE t.amount_is_provisional = true)",
      "provisionalCount",
    )
    // Formatted in Postgres so the day never shifts through a time zone.
    .addSelect(
      "TO_CHAR(MAX(t.transaction_date), 'YYYY-MM-DD')",
      "lastTransactionDate",
    )
    .groupBy("account.id")
    .addGroupBy("account.name")
    .addGroupBy("account.account_type")
    .addGroupBy("account.currency_code");
  splitByRateBasis(
    scope,
    {
      currency: "account.currency_code",
      date: "t.transaction_date",
      originalCurrency: "t.original_currency_code",
      exchangeRate: "t.exchange_rate",
      // A payee's or category's transfer legs count here, as they do in the
      // summary the same page reads.
      transferLegs: { transactionAlias: "t" },
    },
    reportingCurrency,
  );
  const parts = await scope.getRawMany();
  if (parts.length === 0) return [];

  const keyOf = (row: Record<string, any>) => String(row.accountId);
  const provisionalCounts = new Map<string, number>();
  for (const part of parts) {
    const key = keyOf(part);
    provisionalCounts.set(
      key,
      (provisionalCounts.get(key) ?? 0) + (Number(part.provisionalCount) || 0),
    );
  }
  const accounts = foldRateParts(parts, keyOf, {
    sums: ["total"],
    count: "transactionCount",
    latest: "lastTransactionDate",
  }).sort((a, b) => b.count - a.count);
  const converted = await convertRateParts(
    (sql, params) => m.query(sql, params),
    parts,
    reportingCurrency,
    keyOf,
    { sums: ["total"], currency: "currencyCode" },
    // A detail page's breakdown, not a report figure: four places, as the
    // page's own totals are.
    FIAT_MONEY_DECIMALS,
  );
  const places = await loadCurrencyPlacesForRead(
    m,
    accounts.map((account) => account.first.currencyCode),
  );
  return accounts.map((account) => {
    const currencyCode = String(account.first.currencyCode);
    const total = roundMoney(
      account.sums.total,
      moneyDecimalsForCode(places, currencyCode),
    );
    return {
      accountId: account.key,
      accountName: account.first.accountName,
      accountType: account.first.accountType,
      currencyCode,
      transactionCount: account.count,
      total,
      lastTransactionDate: account.latest,
      convertedCurrency: reportingCurrency,
      convertedTotal:
        currencyCode === reportingCurrency
          ? total
          : (converted.get(account.key)?.total ?? null),
      provisionalCount: provisionalCounts.get(account.key) ?? 0,
    };
  });
}
