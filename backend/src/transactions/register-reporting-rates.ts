import { EntityManager } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { preferredCurrency } from "../common/default-currency.util";
import {
  buildRateIndex,
  RateIndex,
} from "../common/time-series/rate-index.util";
import {
  convertRateBasis,
  toOwnRate,
  transactionRateBasis,
} from "../built-in-reports/report-currency.service";
import {
  ownTransferLegs,
  transferRateSql,
} from "../built-in-reports/transfer-rate-sql";

/**
 * The factor that takes a register row's amount (in its own `currencyCode`)
 * into the reader's reporting currency: its own settled rate where it carries
 * one (INV-FX-002), a transfer leg's two posted amounts where the other side
 * moved in the reporting currency, else the market rate on the row's own date
 * (INV-FX-001). `null` is a row no admissible rate reaches. A register page
 * that holds several currencies sums `amount * reportingRate`, never the face
 * values (issue #2308); the client never converts at today's rate (#2106).
 */
export interface RegisterRowReportingRate {
  reportingCurrencyCode: string;
  reportingRate: number | null;
}

/** What a register row carries that its rate is worked out from. */
export interface RegisterRowRateSource {
  id: string;
  transactionDate: string;
  currencyCode: string;
  originalCurrencyCode?: string | null;
  exchangeRate?: number | string | null;
  isTransfer?: boolean;
}

/**
 * Stamp {@link RegisterRowReportingRate} onto every row of a page. Mutates in
 * place: these are the rows the controller serialises. The transfer legs'
 * counterparts are read in one query and the rate history once for the page's
 * span, both inside `m`.
 */
export async function attachRegisterReportingRates<
  T extends RegisterRowRateSource & Partial<RegisterRowReportingRate>,
>(m: EntityManager, userId: string, rows: readonly T[]): Promise<void> {
  if (rows.length === 0) return;
  const reporting = preferredCurrency(
    await m.getRepository(UserPreference).findOne({ where: { userId } }),
  );

  // A transfer leg's other side is read only on the reader's own ledger
  // (`transferRateSql`); anywhere else the leg keeps the market rate.
  const transferIds = rows
    .filter((row) => row.isTransfer && row.currencyCode !== reporting)
    .map((row) => row.id);
  const legs = ownTransferLegs(userId, "$3");
  const transferRates = new Map<string, unknown>();
  if (legs && transferIds.length > 0) {
    const found: { id: string; transfer_rate: unknown }[] = await m.query(
      `SELECT t.id, ${transferRateSql("$2::text", "t", legs)} AS transfer_rate
         FROM transactions t
        WHERE t.id = ANY($1::uuid[])`,
      [transferIds, reporting, userId],
    );
    for (const row of found) transferRates.set(row.id, row.transfer_rate);
  }

  const bases = rows.map((row) =>
    transactionRateBasis(
      {
        currencyCode: row.currencyCode,
        transactionDate: row.transactionDate,
        originalCurrencyCode: row.originalCurrencyCode,
        exchangeRate: row.exchangeRate,
        transferRate: transferRates.get(row.id) as
          number | string | null | undefined,
      },
      reporting,
    ),
  );

  // Only the rows the market rate has to convert need the history.
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
      : await buildRateIndex(
          (sql, params) => m.query(sql, params),
          foreign,
          reporting,
          first,
          last,
        );

  rows.forEach((row, i) => {
    Object.assign(row, {
      reportingCurrencyCode: reporting,
      reportingRate: convertRateBasis(1, bases[i], reporting, rateIndex),
    });
  });
}
