import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { applyFxConversion } from "../common/fx-entry.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { investmentExclusionSql } from "../common/investment-filter.util";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  ESTIMATE_HISTORY_MONTHS,
  EstimateBasis,
  EstimatePayment,
  EstimateProfile,
  buildEstimateProfile,
  estimateForMonth,
  historyWindowStart,
  monthKeyOf,
  shiftMonthKey,
} from "./amount-estimate";

/**
 * Why an estimate has, or has no, amount.
 *
 *  - `estimated`: the history produced one; every month has an amount.
 *  - `no-basis`: the schedule names no payee or no category to match on.
 *  - `no-history`: no matching payment in the last `ESTIMATE_HISTORY_MONTHS`.
 *  - `missing-rate`: a matching payment is in a currency with no current rate
 *    into the schedule's, named by `missingPair`.
 *
 * Every status but `estimated` leaves each occurrence's amount unknown; it is
 * never the stored `amount` (docs/specs/scheduled-amount-estimate.md 3).
 */
export type ScheduleAmountEstimateStatus =
  "estimated" | "no-basis" | "no-history" | "missing-rate";

/** One schedule's estimate, from which any occurrence's amount is read. */
export interface ScheduleAmountEstimate {
  status: ScheduleAmountEstimateStatus;
  /** The currency every amount is in: the schedule's. */
  currencyCode: string;
  /** Present exactly when `status === "estimated"`. */
  profile: EstimateProfile | null;
  /** The pair with no current rate, when `status === "missing-rate"`. */
  missingPair: { from: string; to: string } | null;
}

/** What one schedule's estimate is matched and converted on. */
export interface ScheduleEstimateBasis {
  payeeId: string | null;
  categoryId: string | null;
  currencyCode: string;
}

/** One month of an estimate, as a client reads it. */
export interface EstimatedMonthReadModel {
  amount: number;
  basis: EstimateBasis;
}

/**
 * The estimate as the schedule list sends it: the status, the facts a person
 * is told about where the figure came from, and one amount per month over the
 * horizon a client projects (the cash-flow forecast, the override editor).
 */
export interface ScheduleAmountEstimateReadModel {
  status: ScheduleAmountEstimateStatus;
  currencyCode: string;
  /** `YYYY-MM` -> the per-occurrence estimate for occurrences in that month. */
  months: Record<string, EstimatedMonthReadModel>;
  /**
   * How many payments the estimate averages; `null` when withheld (a delegate
   * is not told how often the owner paid).
   */
  paymentCount: number | null;
  /** The newest payment the estimate read, `YYYY-MM-DD`; null when none or withheld. */
  latestPaymentDate: string | null;
  /** The year-over-year growth applied, or null when the history is not seasonal. */
  growthRate: number | null;
  historyMonths: number;
  missingPair: { from: string; to: string } | null;
}

/**
 * How far ahead the read model reaches, in months past today's: beyond the
 * longest forecast period (one year) and the occurrence picker's dates.
 */
export const ESTIMATE_READ_MODEL_MONTHS_AHEAD = 24;

/**
 * How far back the read model reaches at most, in months before today's. It
 * starts at the schedule's next due month, so an overdue occurrence the
 * forecast carries, the Post dialog or the editor opens is priced by the
 * client exactly as by the server; a schedule overdue for longer than this is
 * read from this bound.
 */
export const ESTIMATE_READ_MODEL_MONTHS_BACK = 24;

/**
 * Whether an occurrence governed by `override` (or by none) is priced from the
 * schedule's estimate (docs/specs/scheduled-amount-estimate.md section 6): an
 * override that states an amount, or carries its own split lines, is that
 * occurrence's amount; any other follows the estimate. The one statement of
 * the rule on the server -- the expansion, the list read and the posting all
 * ask here; `occurrenceFollowsEstimate` in
 * frontend/src/lib/scheduled-effective-amount.ts is its client twin.
 */
export function occurrenceFollowsEstimate(
  schedule: { amountIsEstimated?: boolean | null },
  override:
    | { amount?: number | string | null; isSplit?: boolean | null }
    | null
    | undefined,
): boolean {
  if (schedule.amountIsEstimated !== true) return false;
  if (!override) return true;
  return (
    (override.amount === null || override.amount === undefined) &&
    override.isSplit !== true
  );
}

/**
 * The amount of an occurrence falling on `dueDate`, or `null` when the
 * estimate has none (every status but `estimated`).
 */
export function estimatedAmountFor(
  estimate: ScheduleAmountEstimate,
  dueDate: string,
): number | null {
  if (estimate.status !== "estimated" || !estimate.profile) return null;
  return estimateForMonth(estimate.profile, monthKeyOf(dueDate)).amount;
}

/**
 * The read model of `estimate`: one month per entry from the earlier of the
 * month before today's and `nextDueDate`'s month (an overdue occurrence, at
 * most `ESTIMATE_READ_MODEL_MONTHS_BACK` back) through
 * `ESTIMATE_READ_MODEL_MONTHS_AHEAD` past today's.
 */
export function estimateReadModel(
  estimate: ScheduleAmountEstimate,
  today: string = todayYMD(),
  nextDueDate?: string,
): ScheduleAmountEstimateReadModel {
  const months: Record<string, EstimatedMonthReadModel> = {};
  const profile = estimate.profile;
  if (estimate.status === "estimated" && profile) {
    const todayMonth = monthKeyOf(today);
    const floor = shiftMonthKey(todayMonth, -ESTIMATE_READ_MODEL_MONTHS_BACK);
    const dueMonth = nextDueDate ? monthKeyOf(nextDueDate) : todayMonth;
    const monthBefore = shiftMonthKey(todayMonth, -1);
    let month = dueMonth < monthBefore ? dueMonth : monthBefore;
    if (month < floor) month = floor;
    const last = shiftMonthKey(todayMonth, ESTIMATE_READ_MODEL_MONTHS_AHEAD);
    while (month <= last) {
      months[month] = estimateForMonth(profile, month);
      month = shiftMonthKey(month, 1);
    }
  }
  return {
    status: estimate.status,
    currencyCode: estimate.currencyCode,
    months,
    paymentCount: profile?.payments.length ?? 0,
    latestPaymentDate:
      profile && profile.payments.length > 0
        ? profile.payments[profile.payments.length - 1].date
        : null,
    growthRate: profile?.seasonal ? profile.growthRate : null,
    historyMonths: ESTIMATE_HISTORY_MONTHS,
    missingPair: estimate.missingPair,
  };
}

interface RawHistoryRow {
  payee_id: string;
  category_id: string;
  tx_date: string;
  currency_code: string;
  amount: string;
}

const basisKey = (payeeId: string, categoryId: string): string =>
  `${payeeId}:${categoryId}`;

/**
 * The estimated amount of a scheduled transaction, from the payee and
 * category's payment history (issue #2096, docs/specs/scheduled-amount-estimate.md).
 *
 * Read on every surface through `ScheduledOccurrenceService.expand` and the
 * schedule list, never persisted per occurrence: a new payment moves the next
 * read's estimate, and an override that states an amount is never touched.
 */
@Injectable()
export class ScheduledAmountEstimateService {
  constructor(
    private readonly dataSource: DataSource,
    // forwardRef: CurrenciesModule sits on a require cycle back to the
    // scheduled-transactions module, as for ScheduledTransactionsService.
    @Inject(forwardRef(() => ExchangeRateService))
    private readonly exchangeRates: ExchangeRateService,
  ) {}

  /** One estimate per keyed basis. */
  async estimateMany(
    userId: string,
    bases: ReadonlyMap<string, ScheduleEstimateBasis>,
    today: string = todayYMD(),
  ): Promise<Map<string, ScheduleAmountEstimate>> {
    const result = new Map<string, ScheduleAmountEstimate>();
    if (bases.size === 0) return result;

    const pairs = new Map<string, { payeeId: string; categoryId: string }>();
    for (const basis of bases.values()) {
      if (basis.payeeId && basis.categoryId) {
        pairs.set(basisKey(basis.payeeId, basis.categoryId), {
          payeeId: basis.payeeId,
          categoryId: basis.categoryId,
        });
      }
    }

    const { rows, places } = await this.loadHistory(
      userId,
      [...pairs.values()],
      [...bases.values()].map((b) => b.currencyCode),
      today,
    );
    const byPair = new Map<string, RawHistoryRow[]>();
    for (const row of rows) {
      const key = basisKey(row.payee_id, row.category_id);
      byPair.set(key, [...(byPair.get(key) ?? []), row]);
    }

    // Converted at the current rate, the newest on or before today: one lookup
    // per pair for the whole call, after the history read's transaction has
    // closed.
    const rates = new Map<string, number | null>();
    const rateFor = async (from: string, to: string) => {
      const key = `${from}->${to}`;
      if (!rates.has(key)) {
        // `fetchMissing: false`: this runs on every list read, occurrence
        // expansion and reminder pass, and the daily rate refresh stores the
        // currencies accounts are held in, so a stored rate or none.
        const rate =
          from === to
            ? 1
            : await this.exchangeRates.getRateForDate(from, to, today, {
                fetchMissing: false,
              });
        rates.set(key, rate !== null && rate > 0 ? rate : null);
      }
      return rates.get(key) ?? null;
    };

    for (const [id, basis] of bases) {
      const unknown = (
        status: ScheduleAmountEstimateStatus,
        missingPair: { from: string; to: string } | null = null,
      ): ScheduleAmountEstimate => ({
        status,
        currencyCode: basis.currencyCode,
        profile: null,
        missingPair,
      });
      if (!basis.payeeId || !basis.categoryId) {
        result.set(id, unknown("no-basis"));
        continue;
      }
      const history = byPair.get(basisKey(basis.payeeId, basis.categoryId));
      if (!history || history.length === 0) {
        result.set(id, unknown("no-history"));
        continue;
      }

      const moneyDecimals = moneyDecimalsForCode(places, basis.currencyCode);
      const payments: EstimatePayment[] = [];
      let missingPair: { from: string; to: string } | null = null;
      for (const row of history) {
        const amount = Number(row.amount);
        const from = row.currency_code.toUpperCase();
        const to = basis.currencyCode.toUpperCase();
        const rate = await rateFor(from, to);
        if (rate === null) {
          missingPair = { from, to };
          break;
        }
        payments.push({
          date: row.tx_date,
          amount:
            from === to
              ? amount
              : applyFxConversion(amount, rate, null, {
                  toDecimals: moneyDecimals,
                }).amount,
        });
      }
      // A payment that cannot be converted is not dropped: the average of the
      // rest is a different bill's average, so the estimate is unknown and
      // names the pair that would make it known.
      if (missingPair) {
        result.set(id, unknown("missing-rate", missingPair));
        continue;
      }

      const entryDecimals =
        places.get(basis.currencyCode.toUpperCase()) ?? moneyDecimals;
      const profile = buildEstimateProfile(payments, today, entryDecimals);
      result.set(
        id,
        profile
          ? {
              status: "estimated",
              currencyCode: basis.currencyCode,
              profile,
              missingPair: null,
            }
          : unknown("no-history"),
      );
    }
    return result;
  }

  /** The estimate for one basis: the schedule form's preview and the save path. */
  async estimateFor(
    userId: string,
    basis: ScheduleEstimateBasis,
    today: string = todayYMD(),
  ): Promise<ScheduleAmountEstimate> {
    const result = await this.estimateMany(
      userId,
      new Map([["basis", basis]]),
      today,
    );
    return result.get("basis")!;
  }

  /**
   * Every non-void payment to each payee in each category inside the window:
   * plain rows on the category, and the category's lines of a split. Transfers,
   * transfer lines and investment cash are not a bill's payments.
   */
  private async loadHistory(
    userId: string,
    pairs: { payeeId: string; categoryId: string }[],
    currencyCodes: string[],
    today: string,
  ): Promise<{ rows: RawHistoryRow[]; places: ReadonlyMap<string, number> }> {
    return withScopedDb(this.dataSource, async (m) => {
      const places = await loadCurrencyPlacesForRead(m, currencyCodes);
      if (pairs.length === 0) return { rows: [], places };
      const params = [
        userId,
        pairs.map((p) => p.payeeId),
        pairs.map((p) => p.categoryId),
        historyWindowStart(today),
        today,
      ];
      const rows: RawHistoryRow[] = await m.query(
        `
        SELECT t.payee_id, t.category_id,
               TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
               t.currency_code, t.amount
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = $1
           AND (t.payee_id, t.category_id) IN (
             SELECT k.payee_id, k.category_id
               FROM unnest($2::uuid[], $3::uuid[]) AS k(payee_id, category_id)
           )
           AND COALESCE(t.is_split, false) = false
           AND COALESCE(t.is_transfer, false) = false
           AND t.parent_transaction_id IS NULL
           AND (t.status IS NULL OR t.status <> 'VOID')
           AND t.transaction_date > $4
           AND t.transaction_date <= $5
           AND ${investmentExclusionSql({ accountAlias: "a", transactionAlias: "t" })}
        UNION ALL
        SELECT t.payee_id, ts.category_id,
               TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS tx_date,
               t.currency_code, ts.amount
          FROM transactions t
          JOIN transaction_splits ts ON ts.transaction_id = t.id
          LEFT JOIN accounts a ON a.id = t.account_id
         WHERE t.user_id = $1
           AND (t.payee_id, ts.category_id) IN (
             SELECT k.payee_id, k.category_id
               FROM unnest($2::uuid[], $3::uuid[]) AS k(payee_id, category_id)
           )
           AND t.is_split = true
           AND ts.transfer_account_id IS NULL
           AND COALESCE(t.is_transfer, false) = false
           AND t.parent_transaction_id IS NULL
           AND (t.status IS NULL OR t.status <> 'VOID')
           AND t.transaction_date > $4
           AND t.transaction_date <= $5
           AND ${investmentExclusionSql({ accountAlias: "a", transactionAlias: "t", splitAlias: "ts" })}
        `,
        params,
      );
      return { rows, places };
    });
  }
}
