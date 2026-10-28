import { reportingResultCurrency } from "./reporting-basis";
import { ServiceUnavailableException } from "@nestjs/common";
import type { EntityManager, SelectQueryBuilder } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  type RateIndex,
} from "../common/time-series/rate-index.util";
import { resolveFxRate } from "../common/time-series/fx-rate-resolver";
import { sumMoney } from "../common/round.util";
import { applyFxConversion } from "../common/fx-entry.util";
import { reportingRawMany } from "./reporting-query";

export interface ReportingMoneySource {
  currencyCode: string;
  transactionDate: string;
  originalCurrencyCode?: string | null;
  exchangeRate?: number | string | null;
}
export async function reportingCurrency(
  manager: EntityManager,
  userId: string,
): Promise<string> {
  return preferredCurrency(
    await manager.getRepository(UserPreference).findOne({ where: { userId } }),
  );
}
/** A bounded, stored-only historical read: summaries/tools never fetch providers inline. */
export async function reportingRates(
  manager: EntityManager,
  sources: ReportingMoneySource[],
  currency: string,
): Promise<RateIndex> {
  const dates = sources.map((source) => source.transactionDate).sort();
  if (!dates.length) return new Map();
  const currencies = new Set(
    sources
      .map((source) => source.currencyCode)
      .filter((code) => code !== currency),
  );
  return buildRateIndex(
    (sql, params) => manager.query(sql, params),
    currencies,
    currency,
    dates[0],
    dates[dates.length - 1],
  );
}
export function reportingConversion(
  amount: number | string,
  source: ReportingMoneySource,
  currency: string,
  rates: RateIndex,
) {
  const value = Number(amount);
  if (!Number.isFinite(value))
    throw new ServiceUnavailableException({
      code: "REPORTING_VALUE_INCOMPLETE",
      date: source.transactionDate,
    });
  if (value === 0)
    return { amount: 0, rate: null, source: "zero" as const, observedOn: null };
  const entered = Number(source.exchangeRate);
  const resolution = resolveFxRate(
    source.currencyCode,
    currency,
    source.transactionDate,
    (from, to) => rates.get(`${from}->${to}`),
  );
  const rate =
    source.currencyCode !== currency &&
    source.originalCurrencyCode === currency &&
    Number.isFinite(entered) &&
    entered > 0
      ? 1 / entered
      : resolution.rate;
  if (rate === null)
    throw new ServiceUnavailableException({
      code: "REPORTING_FX_INCOMPLETE",
      fxComplete: false,
      missingRatePairs: [
        {
          from: source.currencyCode,
          to: currency,
          date: source.transactionDate,
          reason: resolution.reason,
        },
      ],
      repair: "currency_rate_history",
      fetchAttempted: false,
    });
  return {
    amount: applyFxConversion(value, rate).amount,
    rate,
    source:
      source.currencyCode === currency
        ? ("identity" as const)
        : source.originalCurrencyCode === currency &&
            entered > 0 &&
            Number.isFinite(entered)
          ? ("source" as const)
          : ("history" as const),
    observedOn:
      source.originalCurrencyCode === currency &&
      entered > 0 &&
      Number.isFinite(entered)
        ? null
        : resolution.observedOn,
  };
}

export function reportingAmount(
  amount: number | string,
  source: ReportingMoneySource,
  currency: string,
  rates: RateIndex,
): number {
  return reportingConversion(amount, source, currency, rates).amount;
}

/** Explicit SUM(total) adapter. Callers select signed sums and request absolute
 * only when their original contract applies ABS to the final net bucket.
 * Date/currency/entered-rate grouping is retained until conversion, then folded.
 */
export async function reportingMoneyMany<T = any>(
  manager: EntityManager,
  userId: string,
  query: SelectQueryBuilder<any>,
  currency: string,
  absolute = false,
): Promise<T[]> {
  reportingResultCurrency(userId, currency);
  const keys = query.expressionMap.selects
    .filter(
      (select) => select.aliasName !== "total" && select.aliasName !== "count",
    )
    .map((select) => select.aliasName!)
    .filter(Boolean);
  const transactionAlias = query.alias === "s" ? "t" : query.alias;
  const qb = query
    .clone()
    .addSelect(
      `TO_CHAR(${transactionAlias}.transaction_date,'YYYY-MM-DD')`,
      "__moneyDate",
    )
    .addSelect(`${transactionAlias}.currency_code`, "__moneyCurrency")
    .addSelect(`${transactionAlias}.original_currency_code`, "__moneyOriginal")
    .addSelect(`${transactionAlias}.exchange_rate`, "__moneyRate")
    .addGroupBy(`${transactionAlias}.id`)
    .addGroupBy(`${transactionAlias}.transaction_date`)
    .addGroupBy(`${transactionAlias}.currency_code`)
    .addGroupBy(`${transactionAlias}.original_currency_code`)
    .addGroupBy(`${transactionAlias}.exchange_rate`);
  for (const join of query.expressionMap.joinAttributes)
    if (
      join.alias.hasMetadata &&
      join.alias.metadata.tableName === "transaction_splits"
    )
      qb.addGroupBy(`${join.alias.name}.id`);
  if (query.alias === "s") qb.addGroupBy("s.id");
  const rows = await reportingRawMany(manager, userId, qb);
  const sources: ReportingMoneySource[] = rows.map((row) => ({
    transactionDate: row.__moneyDate,
    currencyCode: row.__moneyCurrency,
    originalCurrencyCode: row.__moneyOriginal,
    exchangeRate: row.__moneyRate,
  }));
  const rates = await reportingRates(manager, sources, currency);
  const buckets = new Map<
    string,
    { row: Record<string, unknown>; values: number[]; count: number }
  >();
  for (const [index, row] of rows.entries()) {
    const key = JSON.stringify(keys.map((name) => row[name]));
    const bucket: {
      row: Record<string, unknown>;
      values: number[];
      count: number;
    } = buckets.get(key) ?? {
      row: Object.fromEntries(keys.map((name) => [name, row[name]])),
      values: [],
      count: 0,
    };
    bucket.values.push(
      reportingAmount(row.total, sources[index], currency, rates),
    );
    bucket.count += Number(row.count ?? 0);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map(
    (bucket) =>
      ({
        ...bucket.row,
        ...(query.expressionMap.selects.some(
          (select) => select.aliasName === "count",
        )
          ? { count: String(bucket.count) }
          : {}),
        total: String(
          absolute
            ? Math.abs(sumMoney(bucket.values))
            : sumMoney(bucket.values),
        ),
      }) as T,
  );
}
export async function reportingMoneyOne<T = any>(
  manager: EntityManager,
  userId: string,
  query: SelectQueryBuilder<any>,
  currency: string,
  absolute = false,
): Promise<T> {
  const rows = await reportingMoneyMany<T>(
    manager,
    userId,
    query,
    currency,
    absolute,
  );
  return rows[0] ?? ({ total: "0" } as T);
}
