import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  buildRateIndex,
  convertAtDate,
  RateIndex,
  RateIndexLogger,
  RateIndexQuery,
} from "../common/time-series/rate-index.util";
import { FIAT_MONEY_DECIMALS, sumMoney } from "../common/round.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { preferredCurrency } from "../common/default-currency.util";
import { TransferLegs, transferRateSql } from "./transfer-rate-sql";

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
 * `convert`, but leaving a whole group out when any day-part of it has no
 * rate.
 *
 * A report splits a foreign aggregate by day so each part converts at its own
 * rate (issue #2106); keeping the parts that converted would report a group
 * whose debit is in and whose refund, struck on a day with no rate, is out. So
 * the group is unknown as a whole, as it was before it was split. `keyOf` names
 * the aggregate a row belongs to (the report's gap key) and `amountsOf` the
 * figures the report converts from it.
 */
export function wholeGroups<T extends RawRateBasis>(
  rows: readonly T[],
  convert: ReportConverter,
  keyOf: (row: T) => string,
  amountsOf: (row: T) => number[],
): ReportConverter {
  const failed = new Set<string>();
  for (const row of rows) {
    if (amountsOf(row).some((amount) => convert(amount, row) === null)) {
      failed.add(keyOf(row));
    }
  }
  if (failed.size === 0) return convert;
  return (amount, row) =>
    failed.has(keyOf(row as T)) ? null : convert(amount, row);
}

/**
 * The row's own rate into the reporting currency, when it carries one that
 * reaches it (INV-FX-002): a foreign entry whose original currency IS the
 * reporting currency settled at `exchange_rate` account-currency units per
 * reporting unit. A stored 1 between two different codes is the column's
 * default, not a rate, and falls back to the market rate like an absent one.
 *
 * A read whose rows can be transfer legs passes `transferLegs`
 * (`ownTransferLegs`): a leg of the reader's own whose other side posted in
 * the reporting currency converts at the two amounts the transfer moved
 * ({@link transferRateSql}), ahead of any stored rate.
 */
export function ownRateSql(
  currencyParam: string,
  alias = "t",
  transferLegs?: TransferLegs,
): string {
  const stored = `CASE
          WHEN ${alias}.original_currency_code = ${currencyParam}::text
           AND ${alias}.original_currency_code <> ${alias}.currency_code
           AND ${alias}.exchange_rate > 0
           AND ${alias}.exchange_rate <> 1
          THEN ${alias}.exchange_rate
        END`;
  if (!transferLegs) return stored;
  const transfer = transferRateSql(
    `${currencyParam}::text`,
    alias,
    transferLegs,
  );
  return `COALESCE(${transfer}, ${stored})`;
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
  transferLegs?: TransferLegs,
): string {
  return `CASE
          WHEN ${alias}.currency_code = ${currencyParam}::text THEN NULL
          ELSE TO_CHAR(${alias}.transaction_date, 'YYYY-MM-DD')
        END AS tx_date,
        ${ownRateSql(currencyParam, alias, transferLegs)} AS own_rate`;
}

/** The `GROUP BY` entries matching {@link rateBasisColumnsSql}'s columns. */
export const RATE_BASIS_GROUP_BY = "tx_date, own_rate";

/**
 * {@link rateBasisColumnsSql} for a transaction already loaded as an entity,
 * the custom report engine's shape: the same date and the same own-rate rule.
 * `transferRate` is what {@link transferRateSql} selected for the row, which
 * wins over the stored rate.
 */
export function transactionRateBasis(
  tx: {
    currencyCode: string;
    transactionDate: string | Date;
    originalCurrencyCode?: string | null;
    exchangeRate?: number | string | null;
    transferRate?: number | string | null;
  },
  reportingCurrency: string,
): RawRateBasis {
  if (tx.currencyCode === reportingCurrency) {
    return { currency_code: tx.currencyCode, tx_date: null, own_rate: null };
  }
  const rate = Number(tx.exchangeRate);
  const ownRate =
    toOwnRate(tx.transferRate) ??
    (tx.originalCurrencyCode === reportingCurrency &&
    tx.originalCurrencyCode !== tx.currencyCode &&
    rate > 0 &&
    rate !== 1
      ? rate
      : null);
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

    return (amount, row) =>
      convertRateBasis(amount, row, defaultCurrency, rateIndex, this.logger);
  }
}

/**
 * One amount of `row` in `reportingCurrency`: its own amount in that currency,
 * its own settled rate where it has one (INV-FX-002), else the market rate on
 * its date from `rateIndex` (INV-FX-001); `null` when none applies. The rule
 * {@link ReportCurrencyService.buildConverter} applies, for a caller that loads
 * its own index.
 */
export function convertRateBasis(
  amount: number,
  row: RawRateBasis,
  reportingCurrency: string,
  rateIndex: RateIndex,
  logger?: RateIndexLogger,
): number | null {
  const from = row.currency_code;
  if (!from || !reportingCurrency) return null;
  if (from === reportingCurrency) return amount;
  const ownRate = toOwnRate(row.own_rate);
  if (ownRate !== null) return amount / ownRate;
  if (!row.tx_date) return null;
  return convertAtDate(
    amount,
    from,
    reportingCurrency,
    row.tx_date,
    rateIndex,
    logger,
  );
}

/** One dated, per-key aggregate in its own currency, for {@link convertDatedRows}. */
export interface DatedAmountRow {
  key: string;
  currencyCode: string;
  /** `YYYY-MM-DD` of the rows the aggregate sums. */
  txDate: string;
  originalCurrencyCode?: string | null;
  exchangeRate?: number | string | null;
  /** The rate its transfer's posted amounts imply (`transferRateSql`). */
  transferRate?: number | string | null;
  /** The sums the aggregate carries, by name. */
  amounts: Record<string, number>;
}

/**
 * Fold dated per-key aggregates into one reporting-currency figure per key and
 * sum name, each part at its own settled rate (INV-FX-002) or the market rate
 * on its own date (INV-FX-001), never at today's (issue #2106). A figure is
 * `null` while any part has no admissible rate. The history is loaded once,
 * through `query`, for the days the market-rate parts cover.
 */
export async function convertDatedRows(
  query: RateIndexQuery,
  rows: readonly DatedAmountRow[],
  reportingCurrency: string,
  logger?: RateIndexLogger,
): Promise<Map<string, Record<string, number | null>>> {
  const totals = new Map<string, Record<string, number | null>>();
  if (rows.length === 0) return totals;
  const bases = rows.map((row) =>
    transactionRateBasis(
      {
        currencyCode: row.currencyCode,
        transactionDate: row.txDate,
        originalCurrencyCode: row.originalCurrencyCode,
        exchangeRate: row.exchangeRate,
        transferRate: row.transferRate,
      },
      reportingCurrency,
    ),
  );
  const foreign = new Set<string>();
  let first: string | null = null;
  let last: string | null = null;
  for (const basis of bases) {
    if (!basis.tx_date || toOwnRate(basis.own_rate) !== null) continue;
    foreign.add(basis.currency_code);
    if (first === null || basis.tx_date < first) first = basis.tx_date;
    if (last === null || basis.tx_date > last) last = basis.tx_date;
  }
  const rateIndex: RateIndex =
    first === null || last === null
      ? new Map()
      : await buildRateIndex(query, foreign, reportingCurrency, first, last);

  // The parts of each figure, summed once at the end in integer units
  // (`sumMoney`); `null` once a part has no rate.
  const parts = new Map<string, Record<string, number[] | null>>();
  rows.forEach((row, i) => {
    const acc = parts.get(row.key) ?? {};
    for (const [name, amount] of Object.entries(row.amounts)) {
      const converted =
        amount === 0
          ? 0
          : convertRateBasis(
              amount,
              bases[i],
              reportingCurrency,
              rateIndex,
              logger,
            );
      const held = name in acc ? acc[name] : [];
      acc[name] =
        held === null || converted === null ? null : [...held, converted];
    }
    parts.set(row.key, acc);
  });
  for (const [key, acc] of parts) {
    totals.set(
      key,
      Object.fromEntries(
        Object.entries(acc).map(([name, values]) => [
          name,
          values === null ? null : sumMoney(values, FIAT_MONEY_DECIMALS),
        ]),
      ),
    );
  }
  return totals;
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
  private groups: readonly string[] = [];

  /**
   * Record one aggregate row left out because `currency` has no rate.
   *
   * `group` names the aggregate the row is a part of when a report splits a
   * foreign aggregate by day to convert each part at its own rate (issue
   * #2106): the parts of one group count once, so "amounts left out" still
   * counts what the report shows, not the days it was paid on.
   */
  record(currency: string, group?: string): void {
    if (!this.currencies.includes(currency)) {
      this.currencies = [...this.currencies, currency];
    }
    if (group !== undefined) {
      if (this.groups.includes(group)) return;
      this.groups = [...this.groups, group];
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
