import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { FxAggregate } from "../common/fx-aggregate";
import { roundFxRate } from "../common/fx-entry.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import { loadCurrencyPlacesForRead } from "../common/currency-places.util";
import { moneyDecimalsFor, sumMoney } from "../common/round.util";
import {
  convertRateBasis,
  ownRateSql,
  rateBasisColumnsSql,
  RATE_BASIS_GROUP_BY,
  toOwnRate,
} from "../built-in-reports/report-currency.service";
import {
  ownTransferLegs,
  transferRateSql,
} from "../built-in-reports/transfer-rate-sql";
import { resolveIndexedRate } from "../common/time-series/rate-index.util";
import { ExchangeRateService } from "./exchange-rate.service";
import { STORED_RATE_ROW_CAP } from "./exchange-rate-history.service";

/**
 * What the reader's own ledger holds in one currency.
 *
 * A transaction "uses" the currency when it is posted in an account
 * denominated in it, or when it was paid in it from an account in another
 * currency (a foreign entry, `original_currency_code`). VOID rows and split
 * children are not movements (`LEDGER_MOVEMENT_PREDICATE`), so neither is
 * counted.
 *
 * The totals are gross: the sum of each transaction's absolute amount, so an
 * expense and a refund add up to the money that moved rather than cancel out.
 */
export interface CurrencyUsageSummary {
  code: string;
  /** The reader's reporting currency, which `totalInReportingCurrency` is in. */
  reportingCurrency: string;
  transactionCount: number;
  /** `YYYY-MM-DD`, or `null` when no transaction uses the currency. */
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  /**
   * The gross total in `code` itself. `null` when a foreign entry in `code`
   * carries no original amount, so its value in `code` is unknown.
   */
  totalInCurrency: number | null;
  /**
   * The gross total in the reporting currency, each transaction at its own
   * rate where it carries one (INV-FX-002) and at the market rate on its own
   * date otherwise (INV-FX-001). `null` while any transaction has no rate.
   */
  totalInReportingCurrency: number | null;
  /** What did convert, safe to show beside `missingPairs` only. */
  knownReportingSubtotal: number;
  /** Transactions left out of the reporting-currency total for want of a rate. */
  unconvertedCount: number;
  /** `"EUR->CAD"` for each pair with no rate; empty when the total is complete. */
  missingPairs: string[];
}

/**
 * A rate one of the reader's own transactions settled at, between `code` and
 * the reporting currency, in the direction the stored rates are listed:
 * reporting-currency units per 1 unit of `code`.
 */
export interface TransactionRate {
  transactionId: string;
  /** `YYYY-MM-DD`, the transaction's own date. */
  rateDate: string;
  rate: number;
  /**
   * `foreignEntry`: a payment entered in one currency and posted in the other
   * (its stored `exchange_rate`). `transfer`: a transfer whose two legs posted
   * in the two currencies (the ratio of the amounts that moved).
   */
  kind: "foreignEntry" | "transfer";
  accountName: string;
  payeeName: string | null;
  /**
   * The stored market rate for `rateDate` in the same direction
   * (`resolveIndexedRate`: the newest observation on or before it within
   * `FX_MAX_RATE_AGE_DAYS`), which the page measures the spread against.
   * `null` when no stored rate applies to the date, never the settled rate.
   */
  marketRate: number | null;
}

export interface TransactionRateList {
  code: string;
  reportingCurrency: string;
  /** Newest date first. */
  rates: TransactionRate[];
  /** More transactions carry a rate than `limit`; the oldest are not listed. */
  truncated: boolean;
  limit: number;
}

interface RawUsageGroup {
  currency_code: string;
  tx_date: string | null;
  own_rate: string | null;
  cnt: string;
  first_date: string | null;
  last_date: string | null;
  in_code: string | null;
  in_account: string | null;
  missing_original: string;
}

interface RawTransactionRate {
  id: string;
  rate_date: string;
  account_name: string;
  payee_name: string | null;
  transfer_rate: string | null;
  stored_rate: string | null;
  direct_rate: string | null;
}

/**
 * The figures the currency detail page reads off the reader's own ledger: how
 * much of it is in the currency, and the rates their own transactions settled
 * at. The stored provider history is `ExchangeRateHistoryService`'s.
 */
@Injectable()
export class CurrencyDetailService {
  private readonly logger = new Logger(CurrencyDetailService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly exchangeRateService: ExchangeRateService,
  ) {}

  async getUsageSummary(
    userId: string,
    code: string,
  ): Promise<CurrencyUsageSummary> {
    const reportingCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const params: string[] = [userId, code, reportingCurrency];
    const legs = ownTransferLegs(userId, "$4");
    if (legs) params.push(userId);

    // One row per currency, day and own rate, so each part converts at its
    // own rate (`convertRateBasis`); a row already in the reporting currency
    // is one aggregate (`tx_date` is null for it).
    const { groups, places } = await withScopedDb(
      this.dataSource,
      async (manager) => {
        const rows: RawUsageGroup[] = await manager.query(
          `SELECT t.currency_code,
                  ${rateBasisColumnsSql("$3", "t", legs)},
                  COUNT(*)::text AS cnt,
                  TO_CHAR(MIN(t.transaction_date), 'YYYY-MM-DD') AS first_date,
                  TO_CHAR(MAX(t.transaction_date), 'YYYY-MM-DD') AS last_date,
                  SUM(ABS(CASE WHEN t.currency_code = $2 THEN t.amount
                               ELSE t.original_amount END)) AS in_code,
                  SUM(ABS(t.amount)) AS in_account,
                  COUNT(*) FILTER (
                    WHERE t.currency_code <> $2 AND t.original_amount IS NULL
                  )::text AS missing_original
             FROM transactions t
            WHERE t.user_id = $1
              AND ${LEDGER_MOVEMENT_PREDICATE}
              AND (t.currency_code = $2 OR t.original_currency_code = $2)
            GROUP BY t.currency_code, ${RATE_BASIS_GROUP_BY}`,
          params,
        );
        const loaded = await loadCurrencyPlacesForRead(manager, [code]);
        return { groups: rows, places: loaded };
      },
    );

    const converter = await this.buildConverter(groups, reportingCurrency);

    let transactionCount = 0;
    let unconvertedCount = 0;
    let missingOriginal = 0;
    let firstDate: string | null = null;
    let lastDate: string | null = null;
    const inCode: number[] = [];
    const inReporting = new FxAggregate();
    for (const group of groups) {
      const count = Number(group.cnt);
      transactionCount += count;
      missingOriginal += Number(group.missing_original);
      if (group.first_date && (!firstDate || group.first_date < firstDate)) {
        firstDate = group.first_date;
      }
      if (group.last_date && (!lastDate || group.last_date > lastDate)) {
        lastDate = group.last_date;
      }
      inCode.push(Number(group.in_code ?? 0));

      const amount = Number(group.in_account ?? 0);
      // Zero needs no rate: an aggregate of zero-amount rows is known.
      const converted = amount === 0 ? 0 : converter(amount, group);
      if (converted === null) unconvertedCount += count;
      inReporting.add(converted, group.currency_code, reportingCurrency);
    }

    return {
      code,
      reportingCurrency,
      transactionCount,
      firstTransactionDate: firstDate,
      lastTransactionDate: lastDate,
      totalInCurrency:
        missingOriginal > 0
          ? null
          : sumMoney(inCode, moneyDecimalsFor(places.get(code))),
      totalInReportingCurrency: inReporting.total,
      knownReportingSubtotal: inReporting.knownSubtotal,
      unconvertedCount,
      missingPairs: inReporting.missingPairs,
    };
  }

  /**
   * The rates the reader's own transactions settled at between `code` and the
   * reporting currency, newest first: a foreign entry's stored rate (a stored
   * 1 between two codes is the column's default, not a rate, and is skipped,
   * as `ownRateSql` skips it) and a transfer's two posted amounts
   * (`transferRateSql`, read on the reader's own legs only). Each is stated as
   * reporting-currency units per 1 unit of `code`, the direction the stored
   * provider rates are listed in. Empty for the reporting currency itself,
   * whose rate is 1 by definition.
   */
  async getTransactionRates(
    userId: string,
    code: string,
  ): Promise<TransactionRateList> {
    const reportingCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const empty: TransactionRateList = {
      code,
      reportingCurrency,
      rates: [],
      truncated: false,
      limit: STORED_RATE_ROW_CAP,
    };
    if (code === reportingCurrency) return empty;

    const params: Array<string | number> = [
      userId,
      code,
      reportingCurrency,
      STORED_RATE_ROW_CAP + 1,
    ];
    const legs = ownTransferLegs(userId, "$5");
    if (legs) params.push(userId);

    // `transfer_rate` and `stored_rate` are the two halves of `ownRateSql` on
    // a row posted in `code`, `code` units per reporting unit: the amounts its
    // transfer moved, else its own stored rate as a foreign entry paid in the
    // reporting currency. `direct_rate` is a row posted in the reporting
    // currency and paid in `code`, whose stored rate is already reporting
    // units per `code` unit. A transfer's leg in the reporting currency is not
    // read: its other leg, posted in `code`, answers for the same transfer.
    const transferRate = legs
      ? `CASE WHEN t.currency_code = $2
                 THEN ${transferRateSql("$3::text", "t", legs)}
            END`
      : "NULL::numeric";
    const rows: RawTransactionRate[] = await withScopedDb(
      this.dataSource,
      (manager) =>
        manager.query(
          `SELECT r.*
             FROM (
               SELECT t.id,
                      TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS rate_date,
                      a.name AS account_name,
                      t.payee_name,
                      ${transferRate} AS transfer_rate,
                      CASE WHEN t.currency_code = $2
                           THEN ${ownRateSql("$3", "t")}
                      END AS stored_rate,
                      CASE WHEN t.currency_code = $3
                            AND t.original_currency_code = $2
                            AND t.exchange_rate > 0
                            AND t.exchange_rate <> 1
                           THEN t.exchange_rate
                      END AS direct_rate,
                      t.transaction_date
                 FROM transactions t
                 JOIN accounts a ON a.id = t.account_id
                WHERE t.user_id = $1
                  AND ${LEDGER_MOVEMENT_PREDICATE}
                  AND (t.currency_code = $2
                       OR (t.currency_code = $3 AND t.original_currency_code = $2))
             ) r
            WHERE r.transfer_rate IS NOT NULL
               OR r.stored_rate IS NOT NULL
               OR r.direct_rate IS NOT NULL
            ORDER BY r.transaction_date DESC, r.id
            LIMIT $4`,
          params,
        ),
    );

    const listed = rows.slice(0, STORED_RATE_ROW_CAP);
    const marketRate = await this.buildMarketRateLookup(
      listed,
      code,
      reportingCurrency,
    );
    const rates: TransactionRate[] = [];
    for (const row of listed) {
      const rate = transactionRateOf(row);
      if (rate === null) continue;
      rates.push({
        transactionId: row.id,
        rateDate: row.rate_date,
        rate: roundFxRate(rate.value),
        kind: rate.kind,
        accountName: row.account_name,
        payeeName: row.payee_name ?? null,
        marketRate: marketRate(row.rate_date),
      });
    }

    return {
      ...empty,
      rates,
      truncated: rows.length > STORED_RATE_ROW_CAP,
    };
  }

  /**
   * The stored market rate of `code` in the reporting currency for a date, from
   * one index over the listed dates, through the resolver every report uses
   * (INV-FX-001). Stored rows only: the page does not fetch from a provider
   * on a read, which is what its Fill gaps button is for.
   */
  private async buildMarketRateLookup(
    rows: readonly RawTransactionRate[],
    code: string,
    reportingCurrency: string,
  ): Promise<(date: string) => number | null> {
    if (rows.length === 0) return () => null;
    let start = rows[0].rate_date;
    let end = rows[0].rate_date;
    for (const row of rows) {
      if (row.rate_date < start) start = row.rate_date;
      if (row.rate_date > end) end = row.rate_date;
    }
    const rateIndex = await this.exchangeRateService.getRateIndex(
      new Set([code]),
      reportingCurrency,
      start,
      end,
    );
    return (date) => {
      const { rate } = resolveIndexedRate(
        rateIndex,
        code,
        reportingCurrency,
        date,
      );
      return rate === null ? null : roundFxRate(rate);
    };
  }

  private async buildConverter(
    groups: readonly RawUsageGroup[],
    reportingCurrency: string,
  ): Promise<(amount: number, row: RawUsageGroup) => number | null> {
    const foreign = new Set<string>();
    let start: string | null = null;
    let end: string | null = null;
    for (const group of groups) {
      if (group.currency_code === reportingCurrency) continue;
      if (toOwnRate(group.own_rate) !== null || !group.tx_date) continue;
      foreign.add(group.currency_code);
      if (start === null || group.tx_date < start) start = group.tx_date;
      if (end === null || group.tx_date > end) end = group.tx_date;
    }
    const rateIndex =
      start === null || end === null
        ? new Map()
        : await this.exchangeRateService.getRateIndex(
            foreign,
            reportingCurrency,
            start,
            end,
          );
    return (amount, row) =>
      convertRateBasis(amount, row, reportingCurrency, rateIndex, this.logger);
  }
}

/**
 * One row's rate as reporting units per `code` unit, the posted amounts of a
 * transfer winning over a stored rate as they do in `ownRateSql`; `null` when
 * nothing usable answers.
 */
export function transactionRateOf(row: {
  transfer_rate: string | number | null;
  stored_rate: string | number | null;
  direct_rate: string | number | null;
}): { value: number; kind: TransactionRate["kind"] } | null {
  const transfer = toOwnRate(row.transfer_rate);
  if (transfer !== null) return { value: 1 / transfer, kind: "transfer" };
  const stored = toOwnRate(row.stored_rate);
  if (stored !== null) return { value: 1 / stored, kind: "foreignEntry" };
  const direct = toOwnRate(row.direct_rate);
  if (direct !== null) return { value: direct, kind: "foreignEntry" };
  return null;
}
