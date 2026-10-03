import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { tr } from "../i18n/translate";
import { withScopedDb } from "../common/db/scoped-db";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import {
  LoanPaymentDetectorService,
  PaymentRecord,
} from "../accounts/loan-payment-detector.service";
import {
  LoanRateChangesService,
  derivedInstallmentType,
} from "./loan-rate-changes.service";
import { roundMoney } from "../common/round.util";
import {
  annualizationFor,
  mortgageTypeOf,
} from "../accounts/mortgage-type.util";
import {
  DEFAULT_PERIODS_PER_YEAR,
  periodsPerYearForStoredFrequency,
} from "../accounts/payment-frequency.util";

/** Balances below this produce interest amounts too noisy to infer a rate from */
export const MIN_BALANCE_FOR_INFERENCE = 500;
/** Absolute rate deviation (percentage points) that signals a possible step */
export const RATE_TOLERANCE_PP = 0.15;
/** Relative rate deviation that signals a possible step */
export const RATE_TOLERANCE_REL = 0.025;
/** Minimum usable observations (payments with interest + known balance) */
export const MIN_USABLE_PAYMENTS = 3;
/** Payment amounts within this are considered the same payment level */
const PAYMENT_STEP_EPSILON = 0.01;

interface RateObservation {
  /** ISO date (yyyy-MM-dd) of the payment */
  date: string;
  /** Annualized rate implied by interest / balanceBefore, as a percentage */
  annualRate: number;
  /** Total payment amount */
  paymentAmount: number;
}

interface RateSegment {
  observations: RateObservation[];
  medianRate: number;
  /** Mode of payment amounts within the segment */
  paymentAmount: number | null;
}

export interface DetectRateChangesResult {
  created: LoanRateChange[];
  /** Number of previously inferred rows that were replaced */
  replacedCount: number;
  warnings: string[];
}

/**
 * Infers historical interest-rate changes from a loan's payment history.
 *
 * Each payment with an interest split yields a periodic-rate observation
 * (interest / balance before the payment), annualized per the account's
 * compounding convention. Chronological observations are segmented with a
 * step detector (two consecutive deviations beyond tolerance open a new
 * segment; single outliers such as lump-sum periods are skipped). The first
 * segment becomes the account's 'initial' rate row; later segments become
 * 'inferred' rows. Manual rows always win: re-running detection replaces
 * only previously inferred rows and skips candidates whose effective date
 * collides with a manual or initial row.
 */
@Injectable()
export class RateChangeInferenceService {
  private readonly logger = new Logger(RateChangeInferenceService.name);

  constructor(
    private dataSource: DataSource,
    private detector: LoanPaymentDetectorService,
    private rateChangesService: LoanRateChangesService,
  ) {}

  async detectAndPersist(
    userId: string,
    accountId: string,
  ): Promise<DetectRateChangesResult> {
    const account = await this.rateChangesService.verifyLoanAccount(
      userId,
      accountId,
    );

    const transactions = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Transaction).find({
        where: { accountId, userId },
        order: { transactionDate: "ASC" },
      }),
    );

    // The payments read through the pairing mortgage-type detection shares.
    // When interest is a separate expense, the payment amounts are principal
    // only (not the full installment), so they must not be recorded as the
    // rate rows' payment.
    const { payments, balanceMap, interestBookedSeparately } =
      await this.detector.buildInstallmentHistory(
        userId,
        account,
        transactions,
      );

    const warnings: string[] = [];
    const periodsPerYear = this.resolvePeriodsPerYear(
      account,
      payments,
      warnings,
    );
    const observations = this.buildObservations(
      account,
      payments,
      balanceMap,
      periodsPerYear,
    );

    if (observations.length < MIN_USABLE_PAYMENTS) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.insufficientData",
          "Not enough payments with interest details to detect rate changes",
        ),
      );
    }

    const segments = this.segmentObservations(observations);
    if (segments.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.loanRateChanges.insufficientData",
          "Not enough payments with interest details to detect rate changes",
        ),
      );
    }

    return this.persistSegments(
      userId,
      account,
      segments,
      warnings,
      interestBookedSeparately,
    );
  }

  /**
   * Convert each payment with an interest split and a known, large-enough
   * pre-payment balance into an annualized rate observation.
   */
  private buildObservations(
    account: Account,
    payments: PaymentRecord[],
    balanceMap: Map<string, number>,
    periodsPerYear: number,
  ): RateObservation[] {
    const observations: RateObservation[] = [];
    // Day-count annualization (non-Canadian) measures each accrual over the
    // actual gap since the last interest-bearing payment; the first falls back
    // to the nominal period.
    const periodDays = 365 / periodsPerYear;
    let lastDate: string | null = null;
    for (const payment of payments) {
      if (payment.interestAmount == null || payment.interestAmount <= 0) {
        continue;
      }
      const dateKey = payment.date.split("T")[0];
      const balanceBefore = balanceMap.get(dateKey);
      if (!balanceBefore || balanceBefore < MIN_BALANCE_FOR_INFERENCE) {
        continue;
      }

      // A gap much longer than one interval (a payment holiday) still covers a
      // single billing period, so cap it; a non-positive gap (same-day) falls
      // back to the nominal period.
      const gap =
        lastDate !== null ? this.daysBetween(lastDate, dateKey) : periodDays;
      const days = gap <= 0 || gap > periodDays * 1.5 ? periodDays : gap;
      lastDate = dateKey;

      const periodicRate = payment.interestAmount / balanceBefore;
      const annualRate = this.annualizeRate(
        account,
        periodicRate,
        periodsPerYear,
        days,
      );
      if (annualRate <= 0 || annualRate >= 100) continue;

      observations.push({
        date: dateKey,
        annualRate,
        paymentAmount: payment.amount,
      });
    }
    return observations;
  }

  /** Whole days from `aKey` to `bKey` (both yyyy-MM-dd), timezone-safe. */
  private daysBetween(aKey: string, bKey: string): number {
    const a = new Date(`${aKey}T00:00:00Z`).getTime();
    const b = new Date(`${bKey}T00:00:00Z`).getTime();
    return Math.round((b - a) / (1000 * 60 * 60 * 24));
  }

  /**
   * Annualize an observed periodic rate by the type's annualization trait
   * (`annualizationFor`, docs/specs/mortgage-types.md table 4.1). This mirrors
   * the frontend's reconstruction (`assignObservedRates`) so a detected rate
   * matches what the schedule shows:
   *  - `SEMI_ANNUAL` (Canadian fixed-rate): invert the semi-annual
   *    compounding over the nominal periods per year (the lender's
   *    convention);
   *  - `DAY_COUNT` (every other type): annualize over the actual accrual
   *    window (`x 365 / days`), which self-corrects for month-length and
   *    payment-gap variation rather than overshooting a fixed
   *    `x periodsPerYear`. A Canadian variable-rate account is `ANNUITY` and
   *    annualizes here too (table 4.2, last row); it used `x periodsPerYear`
   *    before the type existed.
   *
   * A mortgage's type is read through `mortgageTypeOf`; any other account
   * annualizes as `ANNUITY`, the engine a plain loan uses, whatever its column
   * holds.
   */
  private annualizeRate(
    account: Account,
    periodicRate: number,
    periodsPerYear: number,
    days: number,
  ): number {
    const type =
      account.accountType === AccountType.MORTGAGE
        ? mortgageTypeOf(account)
        : "ANNUITY";
    if (annualizationFor(type) === "SEMI_ANNUAL") {
      return (Math.pow(1 + periodicRate, periodsPerYear / 2) - 1) * 2 * 100;
    }
    return periodicRate * (365 / days) * 100;
  }

  /**
   * Payments per year from the account's configured frequency, falling back
   * to the median interval between payments when unset. Adds a warning when
   * the observed cadence disagrees with the configured frequency.
   */
  private resolvePeriodsPerYear(
    account: Account,
    payments: PaymentRecord[],
    warnings: string[],
  ): number {
    const observedPeriods = this.periodsPerYearFromIntervals(payments);

    if (account.paymentFrequency) {
      // One lookup for both spellings; the account type never decided the count.
      const configured =
        periodsPerYearForStoredFrequency(account.paymentFrequency) ??
        DEFAULT_PERIODS_PER_YEAR;
      if (
        observedPeriods !== null &&
        Math.abs(observedPeriods - configured) / configured > 0.5
      ) {
        warnings.push(
          tr(
            "errors.loanRateChanges.frequencyMismatch",
            "Payment dates do not match the account's payment frequency; inferred rates may be less accurate",
          ),
        );
      }
      return configured;
    }

    return observedPeriods ?? 12;
  }

  /** Snap the median payment interval to a standard payments-per-year count */
  private periodsPerYearFromIntervals(
    payments: PaymentRecord[],
  ): number | null {
    if (payments.length < 3) return null;
    const intervals: number[] = [];
    for (let i = 1; i < payments.length; i++) {
      const prev = new Date(payments[i - 1].date);
      const curr = new Date(payments[i].date);
      intervals.push(
        Math.round((curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24)),
      );
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    if (median <= 0) return null;
    const raw = 365.25 / median;
    const standard = [52, 26, 24, 12, 4, 1];
    return standard.reduce((best, candidate) =>
      Math.abs(candidate - raw) < Math.abs(best - raw) ? candidate : best,
    );
  }

  /**
   * Step detection: maintain a running segment; a new segment opens when two
   * consecutive observations deviate from the segment median beyond
   * tolerance and agree with each other. A single deviating observation is
   * treated as an outlier (e.g. a lump-sum period) and skipped. Segments
   * with fewer than two observations are dropped.
   */
  private segmentObservations(observations: RateObservation[]): RateSegment[] {
    const rawSegments: RateObservation[][] = [];
    let current: RateObservation[] = [observations[0]];

    let i = 1;
    while (i < observations.length) {
      const median = this.median(current.map((o) => o.annualRate));
      const tolerance = Math.max(
        RATE_TOLERANCE_PP,
        median * RATE_TOLERANCE_REL,
      );
      const obs = observations[i];

      if (Math.abs(obs.annualRate - median) <= tolerance) {
        current.push(obs);
        i++;
        continue;
      }

      const next = observations[i + 1];
      const stepTolerance = Math.max(
        RATE_TOLERANCE_PP,
        obs.annualRate * RATE_TOLERANCE_REL,
      );
      const confirmed =
        next !== undefined &&
        Math.abs(next.annualRate - median) > tolerance &&
        Math.abs(next.annualRate - obs.annualRate) <= stepTolerance;

      if (confirmed) {
        rawSegments.push(current);
        current = [obs];
      }
      // Unconfirmed deviation: single outlier, skip it
      i++;
    }
    rawSegments.push(current);

    return rawSegments
      .filter((segment) => segment.length >= 2)
      .map((segment) => ({
        observations: segment,
        medianRate:
          Math.round(this.median(segment.map((o) => o.annualRate)) * 100) / 100,
        paymentAmount: this.modePaymentAmount(segment),
      }));
  }

  /** Most common payment amount in a segment (1-cent grouping) */
  private modePaymentAmount(segment: RateObservation[]): number | null {
    const counts = new Map<number, number>();
    for (const obs of segment) {
      const rounded = Math.round(obs.paymentAmount * 100) / 100;
      counts.set(rounded, (counts.get(rounded) || 0) + 1);
    }
    let best: number | null = null;
    let bestCount = 0;
    for (const [amount, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = amount;
      }
    }
    return best;
  }

  private median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  /**
   * Replace previously inferred rows with the detected segments in one
   * transaction. Manual and initial rows are preserved; candidates whose
   * effective date collides with one are skipped.
   */
  private async persistSegments(
    userId: string,
    account: Account,
    segments: RateSegment[],
    warnings: string[],
    // When interest is booked separately, the observed payment amount is
    // principal-only (not the full installment), so it must not be recorded as
    // the row's payment -- doing so would seed the forward projection with a
    // non-amortizing payment.
    interestBookedSeparately: boolean,
  ): Promise<DetectRateChangesResult> {
    const created: LoanRateChange[] = [];
    let replacedCount = 0;
    // A LINEAR or INTEREST_ONLY mortgage records no payment on a rate row: its
    // method prices every installment, so an observed payment would be a
    // second, conflicting answer (spec section 5.3). Segments are still cut on
    // the rate alone.
    const recordsPayment =
      !interestBookedSeparately && derivedInstallmentType(account) === null;
    await withScopedDb(this.dataSource, async (m) => {
      const deleted = await m.delete(LoanRateChange, {
        accountId: account.id,
        source: "inferred",
      });
      replacedCount = deleted.affected || 0;

      const kept = await m.find(LoanRateChange, {
        where: { accountId: account.id },
      });
      const keptDates = new Set(kept.map((row) => row.effectiveDate));
      const hasInitial = kept.some((row) => row.source === "initial");

      for (const [index, segment] of segments.entries()) {
        const isFirst = index === 0;
        // The first segment describes the origination rate: it becomes the
        // 'initial' row when none exists, and is otherwise already covered.
        if (isFirst && hasInitial) continue;

        const effectiveDate = segment.observations[0].date;
        if (keptDates.has(effectiveDate)) continue;

        const previous = index > 0 ? segments[index - 1] : null;
        const paymentStepped =
          previous?.paymentAmount != null &&
          segment.paymentAmount != null &&
          Math.abs(segment.paymentAmount - previous.paymentAmount) >
            PAYMENT_STEP_EPSILON;

        const row = m.create(LoanRateChange, {
          userId,
          accountId: account.id,
          effectiveDate,
          annualRate: segment.medianRate,
          newPaymentAmount: !recordsPayment
            ? null
            : isFirst
              ? segment.paymentAmount != null
                ? roundMoney(segment.paymentAmount)
                : null
              : paymentStepped
                ? roundMoney(segment.paymentAmount!)
                : null,
          source: isFirst ? ("initial" as const) : ("inferred" as const),
          note: null,
        });
        created.push(await m.save(row));
      }
    });

    // Detection is historical inference: it only writes timeline rows and must
    // never overwrite the account's user-owned rate/payment or resync the
    // linked scheduled bill (that would clobber manually-set values).

    this.logger.log(
      `Detected ${created.length} rate segment(s) for account ${account.id} (replaced ${replacedCount} inferred rows)`,
    );
    return { created, replacedCount, warnings };
  }
}
