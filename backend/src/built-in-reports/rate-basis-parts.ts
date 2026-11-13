import { EntityManager, ObjectLiteral, SelectQueryBuilder } from "typeorm";
import { MONEY_SCALE, sumMoney } from "../common/round.util";
import {
  RateIndexLogger,
  RateIndexQuery,
} from "../common/time-series/rate-index.util";
import {
  convertDatedRows,
  RawRateBasis,
  transactionRateBasis,
} from "./report-currency.service";
import { TransferLegAliases, transferRateSql } from "./transfer-rate-sql";

/** A raw row of a read split by {@link splitByRateBasis}. */
export type RatePartRow = Record<string, any>;

/**
 * The expressions of the read's own columns {@link splitByRateBasis} keys a
 * part by: property paths for an entity alias (`transaction.currencyCode`) or
 * column names for a raw one (`account.currency_code`).
 */
export interface RateBasisColumns {
  /** The currency the summed amounts are in. */
  currency: string;
  /** The transaction date, a DATE. */
  date: string;
  originalCurrency: string;
  exchangeRate: string;
  /**
   * Where the read's transfer legs sit, when its rows can be one: each such
   * part is also split by the rate its transfer's posted amounts imply
   * (`fx_transfer_rate`, {@link transferRateSql}), which wins over the stored
   * rate.
   */
  transferLegs?: TransferLegAliases;
}

/**
 * Split a grouped read, for every row outside `reporting`, by the day it was
 * struck on and the rate it settled at (`fx_day`, `fx_original_currency`,
 * `fx_exchange_rate`), so the one read yields both the native per-group figures
 * ({@link foldRateParts}) and the parts their reporting-currency conversion
 * needs ({@link convertRateParts}: each part at its own rate, INV-FX-002, or
 * the market rate on its date, INV-FX-001). A reporting-currency row needs no
 * rate and stays one part, so a single-currency read keeps its row count.
 * Before issue #2130 each such conversion re-ran the whole filtered read.
 *
 * `byDay: false` adds only the own-rate columns, for a read that already
 * splits every row by its day.
 */
export function splitByRateBasis<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  columns: Omit<RateBasisColumns, "date"> & { date?: string },
  reporting: string,
  { byDay = true }: { byDay?: boolean } = {},
): void {
  const foreign = `${columns.currency} <> :fxReportingCurrency`;
  qb.setParameter("fxReportingCurrency", reporting);
  if (byDay && columns.date) {
    qb.addSelect(
      `CASE WHEN ${foreign} THEN TO_CHAR(${columns.date}, 'YYYY-MM-DD') END`,
      "fx_day",
    ).addGroupBy("fx_day");
  }
  qb.addSelect(
    `CASE WHEN ${foreign} THEN ${columns.originalCurrency} END`,
    "fx_original_currency",
  )
    .addSelect(
      `CASE WHEN ${foreign} THEN ${columns.exchangeRate} END`,
      "fx_exchange_rate",
    )
    // The output columns' names: lower case, so the unquoted names match.
    .addGroupBy("fx_original_currency")
    .addGroupBy("fx_exchange_rate");
  if (columns.transferLegs) {
    qb.addSelect(
      transferRateSql(":fxReportingCurrency", columns.transferLegs),
      "fx_transfer_rate",
    ).addGroupBy("fx_transfer_rate");
  }
}

/**
 * A part's {@link RawRateBasis} from the columns {@link splitByRateBasis}
 * selected: its currency, its day and the rate it settled at, under the rule
 * the reports apply (`transactionRateBasis`).
 */
export function partRateBasis(
  row: RatePartRow,
  currency: string,
  day: string | null | undefined,
  reporting: string,
): RawRateBasis {
  return transactionRateBasis(
    {
      currencyCode: currency,
      transactionDate: day ?? "",
      originalCurrencyCode: row.fx_original_currency,
      exchangeRate: row.fx_exchange_rate,
      transferRate: row.fx_transfer_rate,
    },
    reporting,
  );
}

/**
 * Order two group keys by Unicode code point, the byte order of their UTF-8
 * that `COLLATE "C"` sorts by. A plain `<` compares UTF-16 code units, which
 * puts a character beyond U+FFFF before one from U+E000 to U+FFFF.
 */
export function compareGroupKeys(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/**
 * The parts of a read split by {@link splitByRateBasis}, only those of its
 * `limit` largest groups: `groupKeySql` names a part's group (selected as
 * `group_key`) and a group ranks by the sum of its parts' `magnitude` column,
 * largest first and then by key (byte order, `COLLATE "C"`, which
 * {@link compareGroupKeys} reproduces), as the unsplit read's `ORDER BY ...
 * LIMIT` ranked them. The bound stays in PostgreSQL, so a person with
 * thousands of groups is not read whole to show a hundred.
 */
export async function readTopGroupParts<T extends ObjectLiteral>(
  m: EntityManager,
  qb: SelectQueryBuilder<T>,
  groupKeySql: string,
  magnitude: string,
  limit: number,
): Promise<RatePartRow[]> {
  qb.addSelect(groupKeySql, "group_key");
  const [sql, params] = qb.getQueryAndParameters();
  return m.query(
    `WITH parts AS (${sql})
     SELECT parts.* FROM parts
     WHERE parts.group_key IN (
       SELECT group_key FROM parts
       GROUP BY group_key
       ORDER BY SUM(parts."${magnitude}") DESC, group_key COLLATE "C"
       LIMIT $${params.length + 1}
     )`,
    [...params, limit],
  );
}

/** One group of a read folded back from its {@link splitByRateBasis} parts. */
export interface FoldedParts {
  key: string;
  /** The first part, standing for the group's label columns. */
  first: RatePartRow;
  /** Each summed figure in the group's own currency, at the column scale. */
  sums: Record<string, number>;
  count: number;
  /** The greatest `latestName` value of the parts, when one is named. */
  latest: string | null;
}

/**
 * Fold the parts of a read split by {@link splitByRateBasis} back into one
 * entry per `keyOf`, in first-seen order: each `sumNames` figure summed at the
 * column scale (`sumMoney`, the SQL `SUM` it replaces), `countName` added and
 * the greatest `latestName` (an ISO date) kept. A transaction lies in exactly
 * one part of a group (its day and rate are its own), so the parts' distinct
 * counts add up to the group's.
 */
export function foldRateParts(
  rows: readonly RatePartRow[],
  keyOf: (row: RatePartRow) => string,
  names: {
    sums: readonly string[];
    count: string;
    latest?: string;
  },
): FoldedParts[] {
  const groups = new Map<
    string,
    {
      first: RatePartRow;
      values: Record<string, number[]>;
      count: number;
      latest: string | null;
    }
  >();
  for (const row of rows) {
    const key = keyOf(row);
    const group = groups.get(key) ?? {
      first: row,
      values: Object.fromEntries(names.sums.map((name) => [name, []])),
      count: 0,
      latest: null,
    };
    // The arrays are this fold's own, so appending in place keeps it linear.
    for (const name of names.sums) {
      group.values[name].push(Number(row[name]) || 0);
    }
    group.count += Number(row[names.count]) || 0;
    const latest: string | null = names.latest
      ? (row[names.latest] ?? null)
      : null;
    if (latest !== null && (group.latest === null || latest > group.latest)) {
      group.latest = latest;
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    first: group.first,
    sums: Object.fromEntries(
      names.sums.map((name) => [
        name,
        sumMoney(group.values[name], MONEY_SCALE),
      ]),
    ),
    count: group.count,
    latest: group.latest,
  }));
}

/**
 * The reporting-currency figures of the foreign parts of a read split by
 * {@link splitByRateBasis}, keyed by `keyOf`: each part at the rate it settled
 * at where that reaches the reporting currency (INV-FX-002), else at the
 * market rate on its own date (INV-FX-001). A figure is `null` while any of its
 * parts has no admissible rate. The parts come from the caller's own read; only
 * the rate history is loaded here, through `query`, and only when a part needs
 * it. `currencyName` is the alias the read selects its currency under.
 */
export function convertRateParts(
  query: RateIndexQuery,
  parts: readonly RatePartRow[],
  reporting: string,
  keyOf: (row: RatePartRow) => string,
  names: { sums: readonly string[]; currency: string },
  logger?: RateIndexLogger,
): Promise<Map<string, Record<string, number | null>>> {
  return convertDatedRows(
    query,
    parts
      .filter((row) => row[names.currency] !== reporting)
      .map((row) => ({
        key: keyOf(row),
        currencyCode: row[names.currency],
        txDate: row.fx_day,
        originalCurrencyCode: row.fx_original_currency,
        exchangeRate: row.fx_exchange_rate,
        transferRate: row.fx_transfer_rate,
        amounts: Object.fromEntries(
          names.sums.map((name) => [name, Number(row[name]) || 0]),
        ),
      })),
    reporting,
    logger,
  );
}
