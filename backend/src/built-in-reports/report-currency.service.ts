import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import { convertAtDate } from "../common/time-series/rate-index.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { preferredCurrency } from "../common/default-currency.util";

export interface RawCategoryAggregate extends RawRateBasis {
  category_id: string | null;
  currency_code: string;
  total: string;
}

export interface RawPayeeAggregate extends RawRateBasis {
  payee_id: string | null;
  payee_name: string | null;
  currency_code: string;
  total: string;
}

export interface RawMonthlyAggregate extends RawRateBasis {
  month: string;
  currency_code: string;
  income: string;
  expenses: string;
}

/** One income/expense bucket, keyed by the date the bucket opens. */
export interface RawPeriodAggregate extends RawRateBasis {
  period_start: string;
  currency_code: string;
  income: string;
  expenses: string;
}

export interface RawMonthlyCategoryAggregate extends RawRateBasis {
  month: string;
  category_id: string | null;
  currency_code: string;
  total: string;
}

/**
 * What an aggregate row carries so it converts at its own rate: its currency,
 * the date it was struck on and the rate it settled at, if any.
 *
 * `tx_date` is null for a row already in the reporting currency (it needs no
 * rate, so its aggregate is not split by day); `own_rate` is null unless the row
 * settled into the reporting currency at a rate of its own
 * ({@link rateBasisColumnsSql}).
 */
export interface RawRateBasis {
  currency_code: string;
  tx_date?: string | null;
  own_rate?: string | number | null;
}

/**
 * Converts one aggregate amount of `row` into the reporting currency, or
 * answers `null` when there is no admissible rate for the row's date.
 */
export type ReportConverter = (
  amount: number,
  row: RawRateBasis,
) => number | null;

/**
 * The row's own rate into the reporting currency, when it carries one that
 * reaches it (INV-FX-002): a foreign entry whose original currency IS the
 * reporting currency settled at `exchange_rate` account-currency units per
 * reporting unit. A stored 1 between two different codes is the column's
 * default, not a rate, and falls back to the market rate like an absent one.
 */
export function ownRateSql(currencyParam: string, alias = "t"): string {
  return `CASE
          WHEN ${alias}.original_currency_code = ${currencyParam}::text
           AND ${alias}.original_currency_code <> ${alias}.currency_code
           AND ${alias}.exchange_rate > 0
           AND ${alias}.exchange_rate <> 1
          THEN ${alias}.exchange_rate
        END`;
}

/**
 * The `tx_date` and `own_rate` columns of a {@link RawRateBasis}, for a report
 * query's select list; the query adds {@link RATE_BASIS_GROUP_BY} to its
 * `GROUP BY`.
 *
 * A past period is converted at the rate of each row's own date, never at
 * today's (INV-FX-001's look-ahead clause, issue #2106), so a foreign aggregate
 * is split by the day it was struck on. A row in the reporting currency keeps a
 * null date and stays one aggregate, which keeps a single-currency report the
 * size it always was. `currencyParam` is the placeholder bound to the reporting
 * currency, used only by these columns.
 */
export function rateBasisColumnsSql(
  currencyParam: string,
  alias = "t",
): string {
  return `CASE
          WHEN ${alias}.currency_code = ${currencyParam}::text THEN NULL
          ELSE TO_CHAR(${alias}.transaction_date, 'YYYY-MM-DD')
        END AS tx_date,
        ${ownRateSql(currencyParam, alias)} AS own_rate`;
}

/** The `GROUP BY` entries matching {@link rateBasisColumnsSql}'s columns. */
export const RATE_BASIS_GROUP_BY = "tx_date, own_rate";

/**
 * {@link rateBasisColumnsSql} for a transaction already loaded as an entity,
 * the custom report engine's shape: the same date and the same own-rate rule.
 */
export function transactionRateBasis(
  tx: {
    currencyCode: string;
    transactionDate: string | Date;
    originalCurrencyCode?: string | null;
    exchangeRate?: number | string | null;
  },
  reportingCurrency: string,
): RawRateBasis {
  if (tx.currencyCode === reportingCurrency) {
    return { currency_code: tx.currencyCode, tx_date: null, own_rate: null };
  }
  const rate = Number(tx.exchangeRate);
  const ownRate =
    tx.originalCurrencyCode === reportingCurrency &&
    tx.originalCurrencyCode !== tx.currencyCode &&
    rate > 0 &&
    rate !== 1
      ? rate
      : null;
  const date =
    tx.transactionDate instanceof Date
      ? tx.transactionDate.toISOString().slice(0, 10)
      : String(tx.transactionDate).slice(0, 10);
  return { currency_code: tx.currencyCode, tx_date: date, own_rate: ownRate };
}

/** A selected `own_rate` as a usable rate: positive and finite, or null. */
export const toOwnRate = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

@Injectable()
export class ReportCurrencyService {
  private readonly logger = new Logger(ReportCurrencyService.name);

  constructor(
    private dataSource: DataSource,
    private exchangeRateService: ExchangeRateService,
  ) {}

  async getDefaultCurrency(userId: string): Promise<string> {
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({
        where: { userId },
      }),
    );
    return preferredCurrency(pref);
  }

  /**
   * The only conversion door a report has: each row at its own rate.
   *
   * A row in the reporting currency is its own amount. A row that settled into
   * the reporting currency at a rate of its own is converted at that rate
   * (INV-FX-002). Anything else takes the market rate on the row's own date,
   * the newest observation on or before it within `FX_MAX_RATE_AGE_DAYS`
   * (INV-FX-001), loaded once for the span the rows cover. A report about a past
   * period used to price every row at today's rate, so a currency's move since
   * then rewrote last year's spending (issue #2106).
   *
   * A missing rate is unknown, never 1:1 and never the unconverted amount under
   * the reporting currency's name: the converter answers `null`, and the caller
   * excludes the row from every figure and records the currency in a
   * {@link ConversionGaps}.
   */
  async buildConverter(
    rows: readonly RawRateBasis[],
    defaultCurrency: string,
  ): Promise<ReportConverter> {
    // Only rows the market rate has to convert need the history.
    const foreign = new Set<string>();
    let start: string | null = null;
    let end: string | null = null;
    for (const row of rows) {
      if (!row.currency_code || row.currency_code === defaultCurrency) continue;
      if (toOwnRate(row.own_rate) !== null || !row.tx_date) continue;
      foreign.add(row.currency_code);
      if (start === null || row.tx_date < start) start = row.tx_date;
      if (end === null || row.tx_date > end) end = row.tx_date;
    }
    const rateIndex =
      start === null || end === null
        ? new Map()
        : await this.exchangeRateService.getRateIndex(
            foreign,
            defaultCurrency,
            start,
            end,
          );

    return (amount, row) => {
      const from = row.currency_code;
      if (!from || !defaultCurrency) return null;
      if (from === defaultCurrency) return amount;
      const ownRate = toOwnRate(row.own_rate);
      if (ownRate !== null) return amount / ownRate;
      if (!row.tx_date) return null;
      return convertAtDate(
        amount,
        from,
        defaultCurrency,
        row.tx_date,
        rateIndex,
        this.logger,
      );
    };
  }
}

/**
 * What a report could not convert, kept apart from the arithmetic so every
 * report answers the same two questions the same way: which currencies had no
 * rate, and how many aggregate rows that cost.
 *
 * An excluded row is not a smaller number: it could have changed which
 * categories, payees or bills appear at all. So a headline total is withheld
 * (`null`) whenever anything was excluded, and the part that did convert goes in
 * a separately named `known*` field.
 */
export class ConversionGaps {
  private currencies: readonly string[] = [];
  private excluded = 0;

  /** Record one aggregate row left out because `currency` has no rate. */
  record(currency: string): void {
    if (!this.currencies.includes(currency)) {
      this.currencies = [...this.currencies, currency];
    }
    this.excluded += 1;
  }

  /** Source currencies with no usable rate, sorted and unique. */
  get missingCurrencies(): string[] {
    return [...this.currencies].sort();
  }

  get excludedCount(): number {
    return this.excluded;
  }

  get isComplete(): boolean {
    return this.excluded === 0;
  }

  /** The headline total, or `null` when any row was excluded. */
  headline(knownTotal: number): number | null {
    return this.isComplete ? knownTotal : null;
  }
}
