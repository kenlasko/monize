import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { applyFxConversion } from "../common/fx-entry.util";
import {
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import { investmentExclusionSql } from "../common/investment-filter.util";
import { LEDGER_MOVEMENT_PREDICATE } from "../common/ledger-balance.sql";
import { ensureYMD, type FrequencyType } from "../common/recurrence";
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
import {
  EstimateBalanceFloor,
  TransferFloorPlan,
  applyBalanceFloor,
  floorFor,
  transferBalanceFloors,
  transferFloorPlan,
} from "./transfer-estimate-floor";
import {
  TransferDestination,
  loadTransferDestinations,
  loadTransferHistory,
} from "./transfer-estimate-ledger";

/**
 * Why an estimate has, or has no, amount.
 *
 *  - `estimated`: the history produced one; every month has an amount.
 *  - `no-basis`: the schedule names no payee or no category to match on (a
 *    transfer: no destination account).
 *  - `no-history`: no matching payment in the last `ESTIMATE_HISTORY_MONTHS`.
 *  - `missing-rate`: a matching payment, or a transfer's destination balance,
 *    is in a currency with no current rate into the schedule's, named by
 *    `missingPair`.
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
  /**
   * What a transfer's destination is owed raises these occurrences above the
   * history estimate (issue #2164); empty for any other schedule.
   */
  floors: EstimateBalanceFloor[];
}

/**
 * A scheduled transfer's basis (issue #2164): its history is the transfers
 * from `accountId` into `transferAccountId`, and what that destination is
 * owed raises the next occurrences (`transfer-estimate-floor.ts`).
 */
export interface TransferEstimateBasis {
  accountId: string;
  transferAccountId: string | null;
  frequency: FrequencyType;
  /**
   * The date the next occurrence falls on: the cursor, or where an override
   * moved it. Balance mode raises the occurrence due on it.
   */
  nextOccurrenceDueDate: string;
}

/** What one schedule's estimate is matched and converted on. */
export interface ScheduleEstimateBasis {
  payeeId: string | null;
  categoryId: string | null;
  currencyCode: string;
  /** Set for a transfer, which is matched on its accounts instead. */
  transfer?: TransferEstimateBasis | null;
}

/**
 * The basis of `schedule`'s estimate: the one place a schedule becomes a
 * basis, so the list read, the expansion, the save and the posting match the
 * same history. `nextOccurrenceDueDate` is where an override moved the next
 * occurrence, when one did.
 */
export function estimateBasisOf(
  schedule: {
    payeeId: string | null;
    categoryId: string | null;
    currencyCode: string;
    accountId: string;
    isTransfer?: boolean | null;
    transferAccountId?: string | null;
    frequency: FrequencyType;
    nextDueDate: string | Date;
  },
  nextOccurrenceDueDate?: string | null,
): ScheduleEstimateBasis {
  const basis = {
    payeeId: schedule.payeeId,
    categoryId: schedule.categoryId,
    currencyCode: schedule.currencyCode,
  };
  if (schedule.isTransfer !== true) return basis;
  return {
    ...basis,
    transfer: {
      accountId: schedule.accountId,
      transferAccountId: schedule.transferAccountId ?? null,
      frequency: schedule.frequency,
      nextOccurrenceDueDate: ensureYMD(
        nextOccurrenceDueDate ?? schedule.nextDueDate,
      ),
    },
  };
}

/** Which rule produced one occurrence's estimate, as a client reads it. */
export type EstimatedAmountBasis = EstimateBasis | "balance";

/** One month of an estimate, as a client reads it. */
export interface EstimatedMonthReadModel {
  amount: number;
  /** `balance` when what a transfer's destination owes raised the estimate. */
  basis: EstimatedAmountBasis;
}

/**
 * The occurrences a transfer's balance floor governs, as a client reads them:
 * an occurrence due after `after` (exclusive) and on or before `through`
 * reads its month here instead of from `months`. Each month
 * is the history estimate raised to the floor, so the debt itself is never
 * sent: a figure below the baseline reads as the baseline.
 */
export interface EstimateFloorReadModel {
  after: string;
  through: string;
  months: Record<string, EstimatedMonthReadModel>;
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
  /** The year-over-year growth applied, or null when the history shows no trend. */
  growthRate: number | null;
  historyMonths: number;
  missingPair: { from: string; to: string } | null;
  /** A transfer's balance floors (issue #2164); empty for any other schedule. */
  floors: EstimateFloorReadModel[];
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
  return estimatedOccurrenceFor(estimate, dueDate)?.amount ?? null;
}

/**
 * The estimate of an occurrence falling on `dueDate` and the rule behind it:
 * the history's figure for its month, raised by a transfer's balance floor
 * when that governs the date and asks for more (issue #2164). `null` when the
 * estimate has none.
 */
export function estimatedOccurrenceFor(
  estimate: ScheduleAmountEstimate,
  dueDate: string,
): EstimatedMonthReadModel | null {
  if (estimate.status !== "estimated" || !estimate.profile) return null;
  return raisedMonth(
    estimate.profile,
    monthKeyOf(dueDate),
    floorFor(estimate.floors, dueDate),
  );
}

/** `month`'s history estimate, raised to `floor` when that is more. */
function raisedMonth(
  profile: EstimateProfile,
  month: string,
  floor: EstimateBalanceFloor | null,
): EstimatedMonthReadModel {
  const base = estimateForMonth(profile, month);
  const raised = applyBalanceFloor(base.amount, floor, profile.decimals);
  return raised.raised
    ? { amount: raised.amount, basis: "balance" }
    : { amount: base.amount, basis: base.basis };
}

/**
 * The read model of `estimate`: one month per entry from the earlier of the
 * month before today's and `nextDueDate`'s month (an overdue occurrence, at
 * most `ESTIMATE_READ_MODEL_MONTHS_BACK` back) through
 * `ESTIMATE_READ_MODEL_MONTHS_AHEAD` past today's, and each balance floor's
 * months over the same span.
 */
export function estimateReadModel(
  estimate: ScheduleAmountEstimate,
  today: string = todayYMD(),
  nextDueDate?: string,
): ScheduleAmountEstimateReadModel {
  const months: Record<string, EstimatedMonthReadModel> = {};
  const floors: EstimateFloorReadModel[] = [];
  const profile = estimate.profile;
  if (estimate.status === "estimated" && profile) {
    const todayMonth = monthKeyOf(today);
    const floor = shiftMonthKey(todayMonth, -ESTIMATE_READ_MODEL_MONTHS_BACK);
    const dueMonth = nextDueDate ? monthKeyOf(nextDueDate) : todayMonth;
    const monthBefore = shiftMonthKey(todayMonth, -1);
    let first = dueMonth < monthBefore ? dueMonth : monthBefore;
    if (first < floor) first = floor;
    const last = shiftMonthKey(todayMonth, ESTIMATE_READ_MODEL_MONTHS_AHEAD);
    for (let month = first; month <= last; month = shiftMonthKey(month, 1)) {
      months[month] = estimateForMonth(profile, month);
    }
    for (const balanceFloor of estimate.floors) {
      const floorMonths: Record<string, EstimatedMonthReadModel> = {};
      const afterMonth = monthKeyOf(balanceFloor.after);
      const from = afterMonth > first ? afterMonth : first;
      const through = monthKeyOf(balanceFloor.through);
      for (
        let month = from;
        month <= through && month <= last;
        month = shiftMonthKey(month, 1)
      ) {
        floorMonths[month] = raisedMonth(profile, month, balanceFloor);
      }
      floors.push({
        after: balanceFloor.after,
        through: balanceFloor.through,
        months: floorMonths,
      });
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
    growthRate: profile && profile.growthRate !== 0 ? profile.growthRate : null,
    historyMonths: ESTIMATE_HISTORY_MONTHS,
    missingPair: estimate.missingPair,
    floors,
  };
}

interface RawHistoryRow {
  payee_id: string;
  category_id: string;
  tx_date: string;
  currency_code: string;
  amount: string;
}

/** The key a basis's history is grouped on, or `null` when it names none. */
function historyKeyOf(basis: ScheduleEstimateBasis): string | null {
  if (basis.transfer) {
    return basis.transfer.transferAccountId
      ? transferKey(basis.transfer.accountId, basis.transfer.transferAccountId)
      : null;
  }
  return basis.payeeId && basis.categoryId
    ? payeeKey(basis.payeeId, basis.categoryId)
    : null;
}

const payeeKey = (payeeId: string, categoryId: string): string =>
  `payee:${payeeId}:${categoryId}`;

const transferKey = (accountId: string, transferAccountId: string): string =>
  `transfer:${accountId}:${transferAccountId}`;

/**
 * The estimated amount of a scheduled transaction, from the payee and
 * category's payment history (issue #2096, docs/specs/scheduled-amount-estimate.md),
 * or for a transfer from the transfers between its two accounts, raised by
 * what the destination is owed (issue #2164).
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
    const transfers = new Map<
      string,
      { accountId: string; transferAccountId: string }
    >();
    for (const basis of bases.values()) {
      const key = historyKeyOf(basis);
      if (!key) continue;
      if (basis.transfer) {
        transfers.set(key, {
          accountId: basis.transfer.accountId,
          transferAccountId: basis.transfer.transferAccountId!,
        });
      } else {
        pairs.set(key, {
          payeeId: basis.payeeId!,
          categoryId: basis.categoryId!,
        });
      }
    }

    const { history, destinations, places } = await this.loadHistory(
      userId,
      [...pairs.values()],
      [...transfers.values()],
      [...bases.values()].map((b) => b.currencyCode),
      today,
    );

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
        floors: [],
      });
      const key = historyKeyOf(basis);
      if (!key) {
        result.set(id, unknown("no-basis"));
        continue;
      }
      const rows = history.get(key);
      if (!rows || rows.length === 0) {
        result.set(id, unknown("no-history"));
        continue;
      }

      const to = basis.currencyCode.toUpperCase();
      const moneyDecimals = moneyDecimalsForCode(places, to);
      const convert = async (
        amount: number,
        currencyCode: string,
      ): Promise<number | { from: string; to: string }> => {
        const from = currencyCode.toUpperCase();
        if (from === to) return amount;
        const rate = await rateFor(from, to);
        if (rate === null) return { from, to };
        return applyFxConversion(amount, rate, null, {
          toDecimals: moneyDecimals,
        }).amount;
      };

      const payments: EstimatePayment[] = [];
      let missingPair: { from: string; to: string } | null = null;
      for (const row of rows) {
        const amount = await convert(Number(row.amount), row.currency_code);
        if (typeof amount !== "number") {
          missingPair = amount;
          break;
        }
        payments.push({ date: row.tx_date, amount });
      }
      // A payment that cannot be converted is not dropped: the average of the
      // rest is a different bill's average, so the estimate is unknown and
      // names the pair that would make it known.
      if (missingPair) {
        result.set(id, unknown("missing-rate", missingPair));
        continue;
      }

      // A transfer's floors, in the schedule's currency. A destination debt
      // that cannot be converted leaves the estimate unknown, as a payment
      // does: whether it raises the next occurrence cannot be told.
      const floors: EstimateBalanceFloor[] = [];
      if (basis.transfer) {
        const destination = destinations.get(basis.transfer.transferAccountId!);
        if (destination) {
          const plan: TransferFloorPlan = transferFloorPlan(
            destination.facts,
            basis.transfer.frequency,
            today,
          );
          const owedIn = moneyDecimalsForCode(places, destination.currencyCode);
          for (const raw of transferBalanceFloors(
            plan,
            destination.ledger,
            basis.transfer.nextOccurrenceDueDate,
            owedIn,
          )) {
            const owed =
              raw.owed === 0
                ? 0
                : await convert(raw.owed, destination.currencyCode);
            if (typeof owed !== "number") {
              missingPair = owed;
              break;
            }
            floors.push({ ...raw, owed });
          }
        }
        if (missingPair) {
          result.set(id, unknown("missing-rate", missingPair));
          continue;
        }
      }

      const entryDecimals = places.get(to) ?? moneyDecimals;
      const profile = buildEstimateProfile(payments, today, entryDecimals);
      result.set(
        id,
        profile
          ? {
              status: "estimated",
              currencyCode: basis.currencyCode,
              profile,
              missingPair: null,
              floors,
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
   * In one read transaction: every non-void payment to each payee in each
   * category inside the window (plain rows on the category, and the
   * category's lines of a split; transfers, transfer lines and investment
   * cash are not a bill's payments), every transfer between each transfer
   * pair, and each transfer destination's ledger. Grouped by history key.
   */
  private async loadHistory(
    userId: string,
    pairs: { payeeId: string; categoryId: string }[],
    transfers: { accountId: string; transferAccountId: string }[],
    currencyCodes: string[],
    today: string,
  ): Promise<{
    history: Map<
      string,
      { tx_date: string; currency_code: string; amount: string }[]
    >;
    destinations: Map<string, TransferDestination>;
    places: ReadonlyMap<string, number>;
  }> {
    return withScopedDb(this.dataSource, async (m) => {
      const destinations = await loadTransferDestinations(
        m,
        userId,
        transfers.map((t) => t.transferAccountId),
        today,
      );
      const places = await loadCurrencyPlacesForRead(m, [
        ...currencyCodes,
        ...[...destinations.values()].map((d) => d.currencyCode),
      ]);
      const history = new Map<
        string,
        { tx_date: string; currency_code: string; amount: string }[]
      >();
      const add = (
        key: string,
        row: { tx_date: string; currency_code: string; amount: string },
      ) => {
        const list = history.get(key);
        if (list) list.push(row);
        else history.set(key, [row]);
      };
      for (const row of await this.loadPaymentHistory(
        m,
        userId,
        pairs,
        today,
      )) {
        add(payeeKey(row.payee_id, row.category_id), row);
      }
      for (const row of await loadTransferHistory(
        m,
        userId,
        transfers,
        historyWindowStart(today),
        today,
      )) {
        add(transferKey(row.account_id, row.transfer_account_id), row);
      }
      return { history, destinations, places };
    });
  }

  private async loadPaymentHistory(
    m: EntityManager,
    userId: string,
    pairs: { payeeId: string; categoryId: string }[],
    today: string,
  ): Promise<RawHistoryRow[]> {
    if (pairs.length === 0) return [];
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
         AND ${LEDGER_MOVEMENT_PREDICATE}
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
         AND ${LEDGER_MOVEMENT_PREDICATE}
         AND t.transaction_date > $4
         AND t.transaction_date <= $5
         AND ${investmentExclusionSql({ accountAlias: "a", transactionAlias: "t", splitAlias: "ts" })}
      `,
      params,
    );
    return rows;
  }
}
