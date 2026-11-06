import { createHash } from "node:crypto";
import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { CreateNotificationInput } from "../notification-center/notification.service";
import { STATE_KEYED_DEDUPE_PREFIXES } from "../notification-center/notification-bounds";
import { addDaysYMD } from "../common/date-utils";
import { canonicalJson } from "./canonical-json";
import { BondRedemptionSplit } from "./bond-holdings.service";
import { ExactDecimal } from "./domain/exact-decimal";
import { assertNever } from "./domain/assert-never";
import { BondValuationRefusal, CashFlow } from "./engine/bond-engine-types";
import {
  SecurityLotValuation,
  SecurityValuation,
} from "./bond-valuation.service";

/**
 * The event rules of the bond notifications (`docs/specs/bond-notifications.md`),
 * pure over the engine's valuation: nothing here reads the database, the clock or
 * a provider (INV-BONDNOTIFY-001), and every figure carried is the engine's
 * (INV-BONDNOTIFY-003). An amount the engine cannot work out stays `null`
 * (INV-BONDNOTIFY-004). The producer (`bond-notification.service.ts`) loads the
 * data, calls these and dispatches the result.
 */

/** A series maturing within this many days (today excluded) raises item 1. */
export const BOND_MATURITY_NOTICE_DAYS = 14;
/** A benchmark observation stored within this many days raises item 5. */
export const BOND_BENCHMARK_FRESH_DAYS = 7;
/**
 * Items 2 and 3 look back this many days (today included, the day that many
 * days ago excluded), so a cron day that did not run, or a person's local day
 * that was skipped, does not lose them. Keys are date-scoped: a re-read of a day
 * already raised writes nothing.
 */
export const BOND_LOOKBACK_DAYS = 3;
/** Affected series listed on an item 5 row; the rest are counted. */
export const BOND_BENCHMARK_AFFECTED_LIMIT = 20;

const RESET_RATE_SOURCES: ReadonlySet<string> = new Set([
  "DERIVED",
  "ANNOUNCED",
]);

/** Lots of one series held in one account. */
export interface LotGroup {
  readonly accountId: string | null;
  readonly instrumentId: string;
  readonly seriesCode: string;
  readonly lots: readonly SecurityLotValuation[];
}

/** One security's facts every row of it carries. */
function baseData(
  valuation: SecurityValuation,
  accountId: string | null,
  instrumentId: string | null,
  seriesCode: string | null,
): Record<string, unknown> {
  return {
    securityId: valuation.securityId,
    accountId,
    instrumentId,
    seriesCode,
    currency: valuation.program.currency,
  };
}

/** The lots grouped by (account, series), in first-appearance order. */
export function groupLots(
  lots: readonly SecurityLotValuation[],
  keyOf: (lot: SecurityLotValuation) => string = () => "",
): LotGroup[] {
  const groups = new Map<string, SecurityLotValuation[]>();
  const heads = new Map<string, SecurityLotValuation>();
  for (const lot of lots) {
    if (lot.instrumentId === null) continue;
    const key = `${lot.accountId ?? ""}|${lot.instrumentId}|${keyOf(lot)}`;
    const members = groups.get(key);
    if (members) members.push(lot);
    else {
      groups.set(key, [lot]);
      heads.set(key, lot);
    }
  }
  return [...groups.entries()].map(([key, members]) => {
    const head = heads.get(key) as SecurityLotValuation;
    return {
      accountId: head.accountId ?? null,
      instrumentId: head.instrumentId as string,
      seriesCode: head.valuation.seriesCode,
      lots: members,
    };
  });
}

const quantityOf = (lots: readonly SecurityLotValuation[]): number =>
  lots.reduce((n, lot) => n + lot.quantity, 0);

/** Decimal places of an exact decimal string. */
function placesOfText(text: string): number {
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The exact sum of decimal strings, null when any is unknown. */
function sumExact(figures: ReadonlyArray<string | null>): string | null {
  let total = ExactDecimal.ZERO;
  let places = 0;
  for (const figure of figures) {
    if (figure === null) return null;
    places = Math.max(places, placesOfText(figure));
    total = total.add(ExactDecimal.parse(figure));
  }
  return total.toFixed(places);
}

/** A fraction as a percentage for the English fallback ("0.069" -> "6.9"). */
function percentOf(fraction: string): string {
  return ExactDecimal.parse(fraction)
    .mul(ExactDecimal.fromInt(100))
    .toTrimmedString(4, 1);
}

// ---------------------------------------------------------------- dedupe keys

const [UNBOOKED_PREFIX, MISSING_PREFIX] = STATE_KEYED_DEDUPE_PREFIXES;

export const bondDedupeKeys = {
  maturity: (a: string | null, i: string, maturity: string): string =>
    `bond:maturity:${a ?? "-"}:${i}:${maturity}`,
  interest: (a: string | null, i: string, day: string): string =>
    `bond:interest:${a ?? "-"}:${i}:${day}`,
  rate: (a: string | null, i: string, start: string): string =>
    `bond:rate:${a ?? "-"}:${i}:${start}`,
  unbooked: (a: string | null, i: string, maturity: string): string =>
    `${UNBOOKED_PREFIX}${a ?? "-"}:${i}:${maturity}`,
  benchmark: (benchmarkId: string, observation: string): string =>
    `bond:bench:${benchmarkId}:${observation}`,
  missing: (securityId: string, causes: readonly BondMissingCause[]): string =>
    `${MISSING_PREFIX}${securityId}:${createHash("sha256")
      .update(canonicalJson(causes.map(causeIdentity)))
      .digest("hex")
      .slice(0, 16)}`,
};

// ------------------------------------------------- payout (items 1 and 4)

/** What a payout is: the engine's split, or nothing and why. */
export interface BondPayout {
  readonly payout: string | null;
  readonly interest: string | null;
  readonly principalReturned: string | null;
  /** The split's refusal code, or the code of the error that stopped it; null when known. */
  readonly missing: string | null;
}

/** The payout of `BondHoldingsService.redemptionSplit`; a refused split carries null figures. */
export function payoutOf(split: BondRedemptionSplit): BondPayout {
  const refused = split.refusal !== null;
  return {
    payout: refused ? null : split.payout,
    interest: refused ? null : split.interest,
    principalReturned: refused ? null : split.principalReturned,
    missing: split.refusal,
  };
}

/** The payout when the split threw: unknown, with the refusal code carried. */
export function unknownPayout(code: string): BondPayout {
  return {
    payout: null,
    interest: null,
    principalReturned: null,
    missing: code,
  };
}

/** A maturity of a group of lots: the input of `redemptionSplit` and of the row. */
export interface MaturityCandidate {
  readonly accountId: string | null;
  readonly instrumentId: string;
  readonly seriesCode: string;
  readonly maturityDate: string;
  readonly quantity: number;
}

function maturityCandidates(
  valuation: SecurityValuation,
  include: (lot: SecurityLotValuation) => boolean,
): MaturityCandidate[] {
  return groupLots(
    valuation.lots.filter(include),
    (lot) => lot.valuation.maturityDate,
  ).map((group) => ({
    accountId: group.accountId,
    instrumentId: group.instrumentId,
    seriesCode: group.seriesCode,
    maturityDate: group.lots[0].valuation.maturityDate,
    quantity: quantityOf(group.lots),
  }));
}

/** Item 1: OPEN lots maturing after `today` and within the notice window. */
export function maturitySoonCandidates(
  valuation: SecurityValuation,
  today: string,
  noticeDays: number = BOND_MATURITY_NOTICE_DAYS,
): MaturityCandidate[] {
  const last = addDaysYMD(today, noticeDays);
  return maturityCandidates(
    valuation,
    (lot) =>
      lot.valuation.status === "OPEN" &&
      lot.valuation.maturityDate > today &&
      lot.valuation.maturityDate <= last,
  );
}

/** Item 4: lots the fold still holds after maturity (no REDEEM removed them). */
export function unbookedCandidates(
  valuation: SecurityValuation,
): MaturityCandidate[] {
  return maturityCandidates(
    valuation,
    (lot) => lot.valuation.status === "MATURED",
  );
}

function payoutData(payout: BondPayout): Record<string, unknown> {
  return {
    payout: payout.payout,
    interest: payout.interest,
    principalReturned: payout.principalReturned,
    missing: payout.missing,
  };
}

function payoutSentence(payout: BondPayout, currency: string): string {
  return payout.payout === null
    ? `The payout is not known yet (${payout.missing ?? "unknown"}).`
    : `The payout is ${payout.payout} ${currency}.`;
}

export function buildMaturitySoonNotification(
  valuation: SecurityValuation,
  candidate: MaturityCandidate,
  payout: BondPayout,
): CreateNotificationInput {
  const { seriesCode, maturityDate, quantity } = candidate;
  return {
    type: NotificationType.BOND_MATURITY_SOON,
    severity: NotificationSeverity.INFO,
    title: `${seriesCode}: matures on ${maturityDate}`,
    message: `${quantity} x ${seriesCode} mature on ${maturityDate}. ${payoutSentence(payout, valuation.program.currency)}`,
    data: {
      ...baseData(
        valuation,
        candidate.accountId,
        candidate.instrumentId,
        seriesCode,
      ),
      maturityDate,
      quantity,
      ...payoutData(payout),
    },
    target: `/securities/${valuation.securityId}`,
    periodStart: maturityDate,
    dedupeKey: bondDedupeKeys.maturity(
      candidate.accountId,
      candidate.instrumentId,
      maturityDate,
    ),
  };
}

export function buildRedemptionUnbookedNotification(
  valuation: SecurityValuation,
  candidate: MaturityCandidate,
  payout: BondPayout,
): CreateNotificationInput {
  const { seriesCode, maturityDate, quantity } = candidate;
  return {
    type: NotificationType.BOND_REDEMPTION_UNBOOKED,
    severity: NotificationSeverity.WARNING,
    title: `${seriesCode}: matured, redemption not booked`,
    message: `${quantity} x ${seriesCode} matured on ${maturityDate} and no redemption is booked. ${payoutSentence(payout, valuation.program.currency)} Book the redemption on the security page.`,
    data: {
      ...baseData(
        valuation,
        candidate.accountId,
        candidate.instrumentId,
        seriesCode,
      ),
      maturityDate,
      quantity,
      ...payoutData(payout),
    },
    target: `/securities/${valuation.securityId}`,
    periodStart: maturityDate,
    dedupeKey: bondDedupeKeys.unbooked(
      candidate.accountId,
      candidate.instrumentId,
      maturityDate,
    ),
  };
}

// ------------------------------------------------------- item 2, interest

/** The interest a group of lots pays on one day; `amount` is null when any flow is unknown. */
export interface InterestCandidate {
  readonly accountId: string | null;
  readonly instrumentId: string;
  readonly seriesCode: string;
  readonly paymentDate: string;
  readonly quantity: number;
  readonly amount: string | null;
}

/**
 * Item 2, from the valuation as of the day `BOND_LOOKBACK_DAYS` before `today`
 * (the window start): the `INTEREST` flows dated in (window start, `today`] of
 * lots maturing after the flow's date (the maturity payment is items 1 and 4),
 * summed per (account, series, date). One unknown flow makes the sum null. The
 * flows are every one the engine lists after that day, known and not, so a
 * flow of a skipped day is found as well as today's.
 */
export function interestCandidates(
  valuationAtWindowStart: SecurityValuation,
  today: string,
): InterestCandidate[] {
  const candidates: InterestCandidate[] = [];
  const interestOn = (lot: SecurityLotValuation, date: string): CashFlow[] =>
    [
      ...lot.valuation.knownCashflows,
      ...lot.valuation.projectedCashflows,
    ].filter((flow) => flow.type === "INTEREST" && flow.date === date);
  for (let back = BOND_LOOKBACK_DAYS - 1; back >= 0; back -= 1) {
    const date = addDaysYMD(today, -back);
    const paying = valuationAtWindowStart.lots.filter(
      (lot) =>
        lot.valuation.status === "OPEN" &&
        lot.valuation.maturityDate > date &&
        interestOn(lot, date).length > 0,
    );
    for (const group of groupLots(paying)) {
      const flows = group.lots.flatMap((lot) => interestOn(lot, date));
      candidates.push({
        accountId: group.accountId,
        instrumentId: group.instrumentId,
        seriesCode: group.seriesCode,
        paymentDate: date,
        quantity: quantityOf(group.lots),
        amount: sumExact(
          flows.map((flow) => (flow.status === "UNKNOWN" ? null : flow.amount)),
        ),
      });
    }
  }
  return candidates;
}

export function buildInterestNotification(
  valuation: SecurityValuation,
  candidate: InterestCandidate,
): CreateNotificationInput {
  const { seriesCode, paymentDate, quantity, amount } = candidate;
  const currency = valuation.program.currency;
  return {
    type: NotificationType.BOND_INTEREST_PAYMENT,
    severity: NotificationSeverity.INFO,
    title: `${seriesCode}: interest payment on ${paymentDate}`,
    message:
      amount === null
        ? `${quantity} x ${seriesCode} pay interest on ${paymentDate}. The amount is not known yet: a rate it depends on is not published.`
        : `${quantity} x ${seriesCode} pay ${amount} ${currency} of interest on ${paymentDate}. Book it on the security page if it is not in your account yet.`,
    data: {
      ...baseData(
        valuation,
        candidate.accountId,
        candidate.instrumentId,
        seriesCode,
      ),
      paymentDate,
      amount,
      quantity,
    },
    target: `/securities/${valuation.securityId}`,
    periodStart: paymentDate,
    dedupeKey: bondDedupeKeys.interest(
      candidate.accountId,
      candidate.instrumentId,
      paymentDate,
    ),
  };
}

// ------------------------------------------------------------ item 3, reset

/**
 * Item 3: OPEN lots that entered, within the last `BOND_LOOKBACK_DAYS` days (the
 * day that many days ago excluded, `today` included), a period (the second or later) whose
 * rate comes from a benchmark or an announcement. A fixed or terms rate is not
 * news; a period whose rate is unknown is reported by item 6, not here.
 */
export function rateResetNotifications(
  valuation: SecurityValuation,
  today: string,
): CreateNotificationInput[] {
  const windowStart = addDaysYMD(today, -BOND_LOOKBACK_DAYS);
  const entering = valuation.lots.filter((lot) => {
    const period = lot.valuation.currentPeriod;
    return (
      lot.valuation.status === "OPEN" &&
      period !== null &&
      period.start > windowStart &&
      period.start <= today &&
      period.index >= 2 &&
      period.annualRate !== null &&
      period.rateSource !== null &&
      RESET_RATE_SOURCES.has(period.rateSource)
    );
  });
  return groupLots(
    entering,
    (lot) => lot.valuation.currentPeriod?.start ?? "",
  ).map((group) => {
    const head = group.lots[0].valuation;
    const period = head.currentPeriod as NonNullable<typeof head.currentPeriod>;
    const entry = head.rateSchedule.find((e) => e.index === period.index);
    const rate = period.annualRate as string;
    return {
      type: NotificationType.BOND_RATE_RESET,
      severity: NotificationSeverity.INFO,
      title: `${group.seriesCode}: new interest period`,
      message: `${group.seriesCode} entered period ${period.index} on ${period.start}: ${percentOf(rate)} percent a year (${(period.rateSource as string).toLowerCase()}).`,
      data: {
        ...baseData(
          valuation,
          group.accountId,
          group.instrumentId,
          group.seriesCode,
        ),
        periodStart: period.start,
        periodEnd: period.end,
        periodIndex: period.index,
        annualRate: rate,
        rateSource: period.rateSource,
        benchmarkId: entry?.benchmark?.benchmarkId ?? null,
        observation: entry?.benchmark?.observation ?? null,
        benchmarkValue: entry?.benchmark?.value ?? null,
        addend: entry?.addend ?? null,
      },
      target: `/securities/${valuation.securityId}`,
      periodStart: period.start,
      dedupeKey: bondDedupeKeys.rate(
        group.accountId,
        group.instrumentId,
        period.start,
      ),
    };
  });
}

// ---------------------------------------------------------- item 6, missing

/** One reason a held lot's figures cannot be worked out; the identity of a gap. */
export type BondMissingCause =
  | {
      readonly code: "OBSERVATION_MISSING";
      readonly benchmarkId: string;
      readonly observation: string;
      readonly publisher: string | null;
    }
  | {
      readonly code: "TERMS_INCOMPLETE";
      readonly instrumentId: string;
      readonly seriesCode: string;
    }
  | {
      readonly code: "PURCHASE_OUTSIDE_SALE_WINDOW";
      readonly instrumentId: string;
      readonly seriesCode: string;
      readonly purchaseDate: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly code: "PURCHASE_AFTER_MATURITY";
      readonly instrumentId: string;
      readonly seriesCode: string;
      readonly purchaseDate: string;
      readonly maturityDate: string;
    }
  | {
      readonly code: "LOTS_UNDERIVABLE";
      readonly refusalCode: string;
      /** The base action of the row that refused (`SELL`). */
      readonly action: string;
      /** That row's transaction date. */
      readonly date: string;
      /** That row's quantity as stored; null when it has none. Not part of the gap's identity. */
      readonly quantity: string | null;
      /** The id of the row, when the ledger read carried ids. */
      readonly rowId?: string;
    };

/**
 * What identifies a gap: the cause without the figures a person can edit away
 * and without any text, so the same gap hashes the same on every run.
 */
function causeIdentity(cause: BondMissingCause): unknown {
  if (cause.code !== "LOTS_UNDERIVABLE") return cause;
  const { quantity: _quantity, ...identity } = cause;
  return identity;
}

/** The causes of a security's valuation, sorted and without duplicates. */

/** The missing-cause a refused lot reports: one case per refusal code, so a new code cannot fall into another's. */
function refusedCause(
  lot: SecurityLotValuation,
  seriesCode: string,
  refusal: BondValuationRefusal,
): BondMissingCause {
  const instrumentId = lot.instrumentId ?? "";
  switch (refusal.code) {
    case "PURCHASE_OUTSIDE_SALE_WINDOW":
      return {
        code: "PURCHASE_OUTSIDE_SALE_WINDOW",
        instrumentId,
        seriesCode,
        purchaseDate: refusal.params.purchaseDate,
        from: refusal.params.from,
        to: refusal.params.to,
      };
    case "PURCHASE_AFTER_MATURITY":
      return {
        code: "PURCHASE_AFTER_MATURITY",
        instrumentId,
        seriesCode,
        purchaseDate: refusal.params.purchaseDate,
        maturityDate: refusal.params.maturityDate,
      };
    default:
      return assertNever(refusal);
  }
}

export function missingCausesOf(valuation: SecurityValuation): {
  causes: BondMissingCause[];
  lots: SecurityLotValuation[];
} {
  if (valuation.refusal !== null) {
    return {
      causes: [
        {
          code: "LOTS_UNDERIVABLE",
          refusalCode: valuation.refusal.code,
          action: valuation.refusal.params.action,
          date: valuation.refusal.params.date,
          quantity: valuation.refusal.params.quantity,
          ...(valuation.refusal.rowId !== undefined
            ? { rowId: valuation.refusal.rowId }
            : {}),
        },
      ],
      lots: [],
    };
  }
  const found = new Map<string, BondMissingCause>();
  const involved: SecurityLotValuation[] = [];
  const add = (cause: BondMissingCause, lot: SecurityLotValuation): void => {
    found.set(canonicalJson(cause), cause);
    if (!involved.includes(lot)) involved.push(lot);
  };
  for (const lot of valuation.lots) {
    const v = lot.valuation;
    if (v.status === "REFUSED" && v.refusal !== null) {
      add(refusedCause(lot, v.seriesCode, v.refusal), lot);
      continue;
    }
    if (v.status !== "OPEN") continue;
    for (const gap of v.missing) {
      add(
        {
          code: "OBSERVATION_MISSING",
          benchmarkId: gap.benchmarkId,
          observation: gap.observation,
          publisher: gap.publisher,
        },
        lot,
      );
    }
    if (!v.dataCompleteness.termsComplete) {
      add(
        {
          code: "TERMS_INCOMPLETE",
          instrumentId: lot.instrumentId ?? "",
          seriesCode: v.seriesCode,
        },
        lot,
      );
    }
  }
  const causes = [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, cause]) => cause);
  return { causes, lots: involved };
}

/** What to do about a refused ledger row, per refusal code (English fallback). */
function lotsRemedy(refusalCode: string): string {
  switch (refusalCode) {
    case "SERIES_NOT_DETERMINED":
    case "SERIES_REQUIRED":
      return "choose the series on that transaction";
    case "REMOVAL_EXCEEDS_SERIES":
      return "the removal exceeds what the account holds of that series; correct the transaction";
    default:
      return "correct the transaction";
  }
}

function soleOf<T>(values: readonly (T | null)[]): T | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

/** Item 6: one row per security whose figures wait for data; none when nothing is missing. */
export function missingDataNotification(
  valuation: SecurityValuation,
): CreateNotificationInput | null {
  const { causes, lots } = missingCausesOf(valuation);
  if (causes.length === 0) return null;
  const observed = new Set(
    causes.flatMap((c) =>
      c.code === "OBSERVATION_MISSING" ? [c.benchmarkId] : [],
    ),
  );
  const coverage = valuation.benchmarkCoverage.filter((c) =>
    observed.has(c.benchmarkId),
  );
  const series = soleOf(lots.map((lot) => lot.valuation.seriesCode));
  const text = causes
    .map((cause) => {
      switch (cause.code) {
        case "OBSERVATION_MISSING":
          return `the ${cause.observation} observation of ${cause.benchmarkId}${cause.publisher ? ` (${cause.publisher})` : ""} is not stored: either it is not published yet or the feed has not been fetched since; refresh on the bond page`;
        case "TERMS_INCOMPLETE":
          return `the terms of ${cause.seriesCode} are incomplete; refresh the series on the bond page`;
        case "PURCHASE_OUTSIDE_SALE_WINDOW":
          return `a purchase of ${cause.seriesCode} on ${cause.purchaseDate} is outside its sale window ${cause.from} to ${cause.to}; correct the purchase date`;
        case "PURCHASE_AFTER_MATURITY":
          return `a purchase of ${cause.seriesCode} on ${cause.purchaseDate} is on or after its maturity ${cause.maturityDate}; correct the purchase date`;
        case "LOTS_UNDERIVABLE":
          return `the ${cause.action} of ${cause.date} makes the lots impossible to derive (${cause.refusalCode}); ${lotsRemedy(cause.refusalCode)}`;
      }
    })
    .join("; ");
  return {
    type: NotificationType.BOND_DATA_MISSING,
    severity: NotificationSeverity.WARNING,
    title: "Bond figures are not known yet",
    message: `Some bond figures cannot be worked out: ${text}.`,
    data: {
      ...baseData(
        valuation,
        soleOf(lots.map((lot) => lot.accountId ?? null)),
        soleOf(lots.map((lot) => lot.instrumentId)),
        series,
      ),
      causes,
      coverage,
    },
    target: `/securities/${valuation.securityId}`,
    dedupeKey: bondDedupeKeys.missing(valuation.securityId, causes),
  };
}

// ------------------------------------------------------ item 5, benchmark

/** The newest stored observation of a benchmark. */
export interface BenchmarkObservation {
  readonly benchmarkId: string;
  readonly publisher: string;
  /** `YYYY-MM` for a monthly series, the day for a step series. */
  readonly observation: string;
  readonly value: string;
  /** The series' unit (`benchmark_series.unit`), so a reader formats `value` as the series says. */
  readonly unit: string;
  readonly publishedOn: string | null;
}

export interface AffectedSeries {
  readonly instrumentId: string;
  readonly seriesCode: string;
  readonly periodStart: string;
  readonly annualRate: string | null;
  readonly rateSource: string | null;
}

/** An affected series and the security (and its currency) that holds it. */
export interface AffectedHolding {
  readonly securityId: string;
  readonly currency: string;
  readonly entry: AffectedSeries;
}

/**
 * True when a new observation of the benchmark decides a LATER period's rate
 * (item 5 says that period's rate is not known yet). A floating rate that reads
 * the benchmark every day (`DAILY_INDEX_PLUS_SPREAD`) changes the accrual of the
 * current period instead, with every weekly auction, so it has no such period.
 */
export function readsBenchmarkForLaterPeriod(
  rule: SecurityValuation["lots"][number]["valuation"]["rateRule"],
): boolean {
  return rule.benchmarkId !== null && rule.type !== "DAILY_INDEX_PLUS_SPREAD";
}

/** The held series reading `benchmarkId`, each with its first period starting on or after `today`. */
export function affectedSeriesOf(
  valuations: readonly SecurityValuation[],
  benchmarkId: string,
  today: string,
): AffectedHolding[] {
  const bySeries = new Map<string, AffectedHolding>();
  for (const valuation of valuations) {
    for (const lot of valuation.lots) {
      const v = lot.valuation;
      if (
        v.status !== "OPEN" ||
        lot.instrumentId === null ||
        !readsBenchmarkForLaterPeriod(v.rateRule) ||
        v.rateRule.benchmarkId !== benchmarkId
      )
        continue;
      const next = v.rateSchedule.find((e) => e.start >= today);
      if (!next) continue;
      const known = bySeries.get(lot.instrumentId);
      if (known && known.entry.periodStart <= next.start) continue;
      bySeries.set(lot.instrumentId, {
        securityId: valuation.securityId,
        currency: valuation.program.currency,
        entry: {
          instrumentId: lot.instrumentId,
          seriesCode: v.seriesCode,
          periodStart: next.start,
          annualRate: next.annualRate,
          rateSource: next.rateSource,
        },
      });
    }
  }
  return [...bySeries.values()].sort((a, b) =>
    a.entry.seriesCode < b.entry.seriesCode
      ? -1
      : a.entry.seriesCode > b.entry.seriesCode
        ? 1
        : 0,
  );
}

/** Item 5: null when no held series reads the benchmark. */
export function benchmarkPublishedNotification(
  observation: BenchmarkObservation,
  affected: readonly AffectedHolding[],
): CreateNotificationInput | null {
  if (affected.length === 0) return null;
  const listed = affected.slice(0, BOND_BENCHMARK_AFFECTED_LIMIT);
  const names = listed.map((a) => a.entry.seriesCode).join(", ");
  return {
    type: NotificationType.BOND_BENCHMARK_PUBLISHED,
    severity: NotificationSeverity.INFO,
    title: `${observation.benchmarkId}: new observation ${observation.observation}`,
    message: `${observation.publisher} published ${observation.benchmarkId} for ${observation.observation}: ${observation.value}. It is read by ${names}${affected.length > listed.length ? ` and ${affected.length - listed.length} more` : ""}.`,
    data: {
      securityId: null,
      accountId: null,
      instrumentId: null,
      seriesCode: null,
      currency: listed[0].currency,
      benchmarkId: observation.benchmarkId,
      publisher: observation.publisher,
      observation: observation.observation,
      value: observation.value,
      unit: observation.unit,
      publishedOn: observation.publishedOn,
      affected: listed.map((a) => a.entry),
      affectedMore: affected.length - listed.length,
    },
    target: `/securities/${listed[0].securityId}`,
    dedupeKey: bondDedupeKeys.benchmark(
      observation.benchmarkId,
      observation.observation,
    ),
  };
}
