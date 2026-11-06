import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';
import { advanceByFrequency, anchorDayOf } from '@/lib/frequency';
import { occurrenceSettlementAccountId } from '@/lib/scheduled-effective-amount';
import {
  FIAT_MONEY_DECIMALS,
  fromMoneyUnits,
  moneyDecimalsForCurrency,
  roundMoney,
  roundToEntryPlaces,
  sumMoney,
  toMoneyUnits,
} from '@/lib/format';

/**
 * A running balance is accumulated in integer units of `10^-decimals`, the
 * money precision of the currency it is in (four for fiat and for a balance
 * converted into the reporting currency, a coin's own eight), held in `BigInt`
 * so a long series of 0.1-sized amounts cannot drift and eight places stay
 * exact above 2^53 units. It is rounded once, half away from zero, for
 * display: at the places of the currency the balance is in (a coin wallet's
 * 0.00002500 BTC read 0.00 at cents), two for fiat and for a currency the
 * caller does not name. An unreadable amount contributes nothing.
 */
const toUnits = (amount: number, decimals: number): bigint => {
  const value = Number(amount);
  return Number.isFinite(value) ? toMoneyUnits(value, decimals) : BigInt(0);
};
const unitsToPlaces = (units: bigint, decimals: number, currencyCode?: string): number =>
  roundToEntryPlaces(fromMoneyUnits(units, decimals), currencyCode);

/**
 * The precision of a figure converted into the reporting currency: a coin is
 * never the reporting currency (`docs/specs/money-precision.md` decision 3).
 */
const REPORTING_MONEY_DECIMALS = FIAT_MONEY_DECIMALS;

/**
 * The money precision a set of unconverted balances accumulates at: the widest
 * of their currencies', so no account's amounts are rounded below their own.
 */
function widestMoneyDecimals(accounts: readonly Account[]): number {
  return accounts.reduce(
    (widest, account) => Math.max(widest, moneyDecimalsForCurrency(account.currencyCode)),
    FIAT_MONEY_DECIMALS,
  );
}

/**
 * The one currency a set of balances is drawn in without conversion, or
 * `undefined` when they are converted (into the reader's fiat default) or do
 * not share one.
 */
function unconvertedCurrency(
  accounts: readonly Account[],
  converted: boolean,
): string | undefined {
  if (converted) return undefined;
  const codes = new Set(accounts.map(a => a.currencyCode));
  return codes.size === 1 ? [...codes][0] : undefined;
}

export interface FutureTransaction {
  id: string;
  accountId: string;
  name: string;
  amount: number;
  date: string; // YYYY-MM-DD
}

export type ForecastPeriod = 'week' | 'month' | '90days' | '6months' | 'year';

export interface ForecastTransaction {
  name: string;
  amount: number;
  scheduledTransactionId: string;
  /**
   * The account the amount moved. Only the multi-account forecast populates it,
   * because only there can one point carry transactions from more than one
   * account and the tooltip has to say which.
   */
  accountId?: string;
  /**
   * Set on a scheduled occurrence that fell due before the forecast's first day
   * and was neither posted nor skipped, so it is applied on that day instead
   * (discussion #1784): the recurrence slot it came from, which is the
   * occurrence's identity. Absent on everything dated inside the window.
   */
  overdueOriginalDate?: string;
}

export interface ForecastDataPoint {
  date: string;
  balance: number;
  transactions: ForecastTransaction[];
}

/** One account's line in a multi-account forecast. */
export interface ForecastAccountSeries {
  accountId: string;
  name: string;
}

/**
 * A forecast point covering several accounts at once.
 *
 * `balance` is the "Total of Accounts" figure and is the sum of `balances` --
 * summed from the same rounded per-account values the lines are drawn from, so
 * the total on screen is exactly the total of the lines on screen rather than a
 * separately rounded figure that can sit a cent away from them.
 */
export interface MultiAccountForecastPoint extends ForecastDataPoint {
  balances: Record<string, number>;
}

export interface MultiAccountForecastResult {
  points: MultiAccountForecastPoint[];
  series: ForecastAccountSeries[];
  missingCurrencies: string[];
}

/**
 * A forecast, plus the currencies that stopped it from being one.
 *
 * `points` is empty when `missingCurrencies` is not: a projected balance is
 * cumulative, so a single missing rate invalidates every day after it, and a
 * short series is not a partial answer here -- it is a wrong one.
 */
export interface ForecastResult {
  points: ForecastDataPoint[];
  missingCurrencies: string[];
}

export const FORECAST_PERIOD_DAYS: Record<ForecastPeriod, number> = {
  week: 7,
  month: 30,
  '90days': 90,
  '6months': 180,
  year: 365,
};

export const FORECAST_PERIOD_LABELS: Record<ForecastPeriod, string> = {
  week: '7D',
  month: '30D',
  '90days': '90D',
  '6months': '6M',
  year: '1Y',
};

// Get granularity in days for each period to limit data points
function getGranularity(period: ForecastPeriod): number {
  switch (period) {
    case 'week':
    case 'month':
      return 1; // Daily
    case '90days':
      return 3; // Every 3 days
    case '6months':
    case 'year':
      return 7; // Weekly
  }
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** One occurrence produced for the forecast. */
interface Occurrence {
  date: string;
  amount: number;
  /**
   * The occurrence's FX-dependent cash amount could not be resolved (issue
   * #1167): a base or override investment line whose current settlement rate is
   * unknown. A cumulative forecast withholds the whole series when any occurrence
   * is unknown, so the flag travels per-occurrence rather than per-schedule -- an
   * override can be unknown while the base schedule is not, and vice versa.
   */
  unknown: boolean;
  /** See `ForecastTransaction.overdueOriginalDate`. */
  overdueOriginalDate?: string;
  /**
   * The day the occurrence falls on before any overdue carry: the day its
   * deductions are spent against the room (`spendPayrollDeductions`).
   */
  spendDate?: string;
  /** An override states the amount: it spends room but takes no add-back. */
  stated?: boolean;
  /** What each ruled category deducts on this occurrence, once the room is spent. */
  deductions?: { categoryId: string; deducted: number }[];
}

/**
 * How many steps one schedule's recurrence is walked. The backend's expander
 * stops at the same count (`OCCURRENCE_WALK_GUARD` in
 * `backend/src/common/scheduled-occurrences.ts`), so a schedule overdue for
 * years is cut at the same occurrence on the Bills chart and the account card.
 */
const MAX_OCCURRENCE_STEPS = 2000;

/**
 * How many days before the forecast's first day an occurrence that was neither
 * posted nor skipped is still carried as owed (discussion #1784). Older ones are
 * read as forgotten and left out, so a stale schedule moves the forecast by at
 * most this window's occurrences. The backend uses the same window
 * (`OVERDUE_CARRY_DAYS` in `backend/src/common/scheduled-occurrences.ts`).
 */
export const OVERDUE_CARRY_DAYS = 31;

/**
 * Does this override carry an embedded investment split? Such an override is
 * FX-sensitive (issue #1167 F5-2) and projects its server-resolved
 * `investmentForecastAmount`, not its stale stored `amount`.
 */
function overrideHasInvestmentSplits(
  override: { splits?: { splitKind?: string; investment?: unknown }[] | null },
): boolean {
  return (
    override.splits?.some(
      s => s.investment != null || s.splitKind === 'investment',
    ) ?? false
  );
}

interface OverrideLookup {
  overrideDate: string;
  amount: number | null;
  hasInvestmentSplits: boolean;
  investmentForecastAmount?: number | null;
}

/** `ymd` one year on, the day clamped to the month (a leap day becomes the 28th). */
function advanceOneYear(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const lastDay = new Date(y + 1, m, 0).getDate();
  return `${y + 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

interface DeductionPool {
  maximum: number;
  remaining: number;
  nextResetOn: string;
  /** The current period's first day: an occurrence before it belongs to a closed period. */
  periodStart: string;
  /** The anchor the resets are anniversaries of; absent on an older read model. */
  resetDate?: string;
}

/**
 * The anniversary of `resetDate`'s month and day in the year after `after`,
 * the day clamped to the month, so a leap-day anchor returns to the 29th in
 * a leap year as the server's `anniversaryInYear` does. Without the anchor
 * the previous reset is stepped one year, which keeps a clamped day clamped.
 */
function nextAnniversary(resetDate: string | undefined, after: string): string {
  if (!resetDate) return advanceOneYear(after);
  const [, m, d] = resetDate.split('-').map(Number);
  const year = Number(after.slice(0, 4)) + 1;
  const lastDay = new Date(year, m, 0).getDate();
  return `${year}-${String(m).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** A bill's rules the projection can spend: those with a positive expected figure. */
function spendableRules(transaction: ScheduledTransaction) {
  return (transaction.payrollDeductions ?? [])
    .filter(r => r.expectedPerPaycheque != null && Number(r.expectedPerPaycheque) > 0)
    .map(r => ({
      key: `${r.categoryId}|${r.currencyCode}`,
      // The rule's money precision: its currency's (a payroll bill is fiat,
      // so four, as it has always been).
      decimals: moneyDecimalsForCurrency(r.currencyCode),
      categoryId: r.categoryId,
      expected: Number(r.expectedPerPaycheque),
      // What the template already deducts for the category: its own line, or
      // nothing when the figure was entered because the line is absent or zero.
      lineAmount: r.expectedSource === 'line' ? Number(r.expectedPerPaycheque) : 0,
      maximum: Number(r.yearlyMaximum),
      remaining: Number(r.remaining),
      nextResetOn: r.nextResetOn,
      periodStart: r.periodStart,
      resetDate: r.resetDate,
    }));
}

/**
 * The room under each yearly maximum, pooled per category and currency across
 * every bill that names it (docs/specs/payroll-deductions.md decision 7). Two
 * paycheques (a mid-month and a month-end) deducting to the same category draw
 * down one maximum, as the ledger's category-wide paid figure does on the
 * server. Where their rules differ, the lower ceiling and the earlier reset
 * bind: the projection errs towards collecting, as the posting cap does.
 */
function buildDeductionPools(transactions: ScheduledTransaction[]): Map<string, DeductionPool> {
  const pools = new Map<string, DeductionPool>();
  for (const tx of transactions) {
    if (!tx.isActive) continue;
    for (const rule of spendableRules(tx)) {
      const pool = pools.get(rule.key);
      if (!pool) {
        pools.set(rule.key, {
          maximum: rule.maximum,
          remaining: rule.remaining,
          nextResetOn: rule.nextResetOn,
          periodStart: rule.periodStart,
          resetDate: rule.resetDate,
        });
      } else {
        pool.maximum = Math.min(pool.maximum, rule.maximum);
        pool.remaining = Math.min(pool.remaining, rule.remaining);
        if (rule.periodStart < pool.periodStart) pool.periodStart = rule.periodStart;
        if (rule.nextResetOn < pool.nextResetOn) {
          pool.nextResetOn = rule.nextResetOn;
          pool.resetDate = rule.resetDate;
        }
      }
    }
  }
  return pools;
}

/**
 * Spend the payroll deductions of every bill against the pooled room, in date
 * order across bills (INV-PAYROLL-003).
 *
 * Each pool starts from the server's `remaining` -- the room left under the
 * yearly maximum as of today, read from the ledger -- and every occurrence
 * walked spends the bill's own expected deduction against it. The occurrence
 * is then projected at the template's amount, less what the template already
 * deducts for the category (its line, or nothing when the figure was entered
 * because the line is absent or zero), plus what will be deducted: so a bill
 * whose line was zeroed at this year's maximum stays where it is until the
 * reset and drops by the deduction from the first paycheque after it, and a
 * bill whose line still deducts rises by what the room cannot cover. An
 * override that states its amount is projected as stated and still spends.
 * An occurrence on or after the reset date refills the pool to the maximum
 * first; one dated inside a closed period (an overdue paycheque from before
 * the current period) neither spends the pool nor changes. A rule with no
 * expected figure projects nothing, and a bill without rules walks
 * unchanged. Mutates the occurrences in place.
 */
function spendPayrollDeductions(
  transactions: ScheduledTransaction[],
  occurrencesById: Map<string, Occurrence[]>,
): void {
  const pools = buildDeductionPools(transactions);
  if (pools.size === 0) return;
  const walk: {
    occurrence: Occurrence;
    rules: ReturnType<typeof spendableRules>;
    decimals: number;
  }[] = [];
  const seen = new Set<string>();
  for (const tx of transactions) {
    if (seen.has(tx.id)) continue;
    seen.add(tx.id);
    const rules = spendableRules(tx);
    if (rules.length === 0) continue;
    for (const occurrence of occurrencesById.get(tx.id) ?? []) {
      if (occurrence.spendDate !== undefined) {
        walk.push({ occurrence, rules, decimals: moneyDecimalsForCurrency(tx.currencyCode) });
      }
    }
  }
  // Stable: two bills on one day spend in the order they were given.
  walk.sort((a, b) => (a.occurrence.spendDate as string).localeCompare(b.occurrence.spendDate as string));
  for (const { occurrence, rules, decimals } of walk) {
    const dateKey = occurrence.spendDate as string;
    let delta = 0;
    const deductions: { categoryId: string; deducted: number }[] = [];
    for (const rule of rules) {
      const pool = pools.get(rule.key) as DeductionPool;
      if (dateKey < pool.periodStart) {
        deductions.push({ categoryId: rule.categoryId, deducted: rule.lineAmount });
        continue;
      }
      while (dateKey >= pool.nextResetOn) {
        pool.remaining = pool.maximum;
        pool.nextResetOn = nextAnniversary(pool.resetDate, pool.nextResetOn);
      }
      const applied = Math.min(rule.expected, Math.max(0, pool.remaining));
      pool.remaining = roundMoney(pool.remaining - applied, rule.decimals);
      deductions.push({ categoryId: rule.categoryId, deducted: roundMoney(applied, rule.decimals) });
      if (!occurrence.stated) delta += rule.lineAmount - applied;
    }
    occurrence.deductions = deductions;
    occurrence.amount = roundMoney(occurrence.amount + roundMoney(delta, decimals), decimals);
  }
}

/**
 * What each ruled category deducts on one occurrence of `billId` falling on
 * `dateKey`, as a map of category id to magnitude, with every bill's earlier
 * occurrences spent first; `null` when the bill has no spendable rule or no
 * occurrence on that day. The occurrence editor opens on these lines, so what
 * it shows is what the forecast projects and the posting will cap to.
 */
export function projectPayrollOccurrence(
  transactions: ScheduledTransaction[],
  billId: string,
  dateKey: string,
): Record<string, number> | null {
  const bill = transactions.find(t => t.id === billId);
  if (!bill || spendableRules(bill).length === 0) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = parseLocalDate(dateKey);
  endDate.setHours(0, 0, 0, 0);
  const occurrences = generateAllOccurrences(transactions, today, endDate, { carryOverdue: true });
  const occurrence = (occurrences.get(billId) ?? []).find(o => o.spendDate === dateKey);
  if (!occurrence?.deductions) return null;
  return Object.fromEntries(occurrence.deductions.map(d => [d.categoryId, d.deducted]));
}

/**
 * The occurrences of every schedule in the window, keyed by schedule id, with
 * the payroll deductions spent across all of them. Every surface generates
 * through this so two bills sharing a deduction category see one room, even
 * when the surface then reads only one account's bills.
 */
function generateAllOccurrences(
  transactions: ScheduledTransaction[],
  startDate: Date,
  endDate: Date,
  options: { carryOverdue?: boolean } = {},
): Map<string, Occurrence[]> {
  const byId = new Map<string, Occurrence[]>();
  for (const tx of transactions) {
    if (!byId.has(tx.id)) byId.set(tx.id, generateOccurrences(tx, startDate, endDate, options));
  }
  spendPayrollDeductions(transactions, byId);
  return byId;
}

/**
 * Generate all occurrence dates for a scheduled transaction within a date range.
 * Uses override data (amount, date) from futureOverrides for each occurrence.
 *
 * With `carryOverdue`, an occurrence whose date (after any override) is before
 * `startDate`, by at most `OVERDUE_CARRY_DAYS`, is not dropped but placed ON
 * `startDate` and marked with its slot (discussion #1784). Posting or skipping
 * an occurrence advances `nextDueDate`, so every slot walked from there is one
 * nobody has posted or skipped: the bill is still owed, and a forecast that left
 * it out showed money that will not be there. The cash-flow forecasts carry;
 * `getProjectedBalanceAtDate` does not.
 */
function generateOccurrences(
  transaction: ScheduledTransaction,
  startDate: Date,
  endDate: Date,
  { carryOverdue = false }: { carryOverdue?: boolean } = {},
): Occurrence[] {
  const occurrences: Occurrence[] = [];

  if (!transaction.isActive) return occurrences;

  const startTime = startDate.getTime();
  const endTime = endDate.getTime();
  const startKey = formatDateKey(startDate);
  const carryFrom = new Date(startDate);
  carryFrom.setDate(carryFrom.getDate() - OVERDUE_CARRY_DAYS);
  const carryFromTime = carryFrom.getTime();

  // Where an occurrence falling on `effectiveTime` lands in this window, or
  // `null` when it is outside it. Before the window it is overdue: carried onto
  // the first day when asked to, only while the window has a first day, and
  // only from the last `OVERDUE_CARRY_DAYS`.
  const place = (
    effectiveTime: number,
    effectiveKey: string,
    slotKey: string,
  ): { date: string; overdueOriginalDate?: string } | null => {
    if (effectiveTime > endTime) return null;
    if (effectiveTime >= startTime) return { date: effectiveKey };
    if (!carryOverdue || startTime > endTime) return null;
    if (effectiveTime < carryFromTime) return null;
    return { date: startKey, overdueOriginalDate: slotKey };
  };
  const txEndDate = transaction.endDate ? parseLocalDate(transaction.endDate) : null;
  const txEndTime = txEndDate ? txEndDate.getTime() : null;

  let currentDate = parseLocalDate(transaction.nextDueDate);
  let remainingOccurrences = transaction.occurrencesRemaining;
  const baseAmount = Number(transaction.amount);
  // Base-schedule FX unknown (parent-investment rate, or embedded-split effective
  // total). Every base occurrence inherits it; so does an override that falls
  // through to the base amount.
  const baseUnknown = hasUnknownForecastRate(transaction);

  // Build override lookup map: originalDate -> override
  const overrideMap = new Map<string, OverrideLookup>();
  const toLookup = (o: {
    overrideDate?: string;
    amount: number | null;
    splits?: { splitKind?: string; investment?: unknown }[] | null;
    investmentForecastAmount?: number | null;
  }): OverrideLookup => ({
    // `overrideDate` may be absent on a fallback nextOverride fixture; downstream
    // treats an absent date as "same date" (uses the occurrence's own date).
    overrideDate: o.overrideDate ? o.overrideDate.split('T')[0] : '',
    amount: o.amount,
    hasInvestmentSplits: overrideHasInvestmentSplits(o),
    investmentForecastAmount: o.investmentForecastAmount,
  });
  if (transaction.futureOverrides) {
    for (const o of transaction.futureOverrides) {
      const origKey = o.originalDate.split('T')[0];
      overrideMap.set(origKey, toLookup(o));
    }
  }
  // Also include nextOverride as fallback (in case futureOverrides is not populated)
  if (transaction.nextOverride && !overrideMap.has(transaction.nextDueDate)) {
    overrideMap.set(transaction.nextDueDate, toLookup(transaction.nextOverride));
  }

  // Resolve the effective amount and unknown flag for one occurrence, given the
  // override that applies to it (if any). An investment override -- one carrying
  // investment splits (#1167 F5-2), OR any override of a top-level investment
  // schedule whose quantity/price/total posting honours (#1167 R6 F3) -- projects
  // its server-resolved effective total; a non-investment override uses its stored
  // scalar; a base occurrence uses the base amount.
  const baseIsInvestment = transaction.isInvestment === true;
  const resolveOccurrence = (
    override: OverrideLookup | undefined,
  ): { amount: number; unknown: boolean; stated: boolean } => {
    if (override && (baseIsInvestment || override.hasInvestmentSplits)) {
      if (override.investmentForecastAmount == null) {
        return { amount: 0, unknown: true, stated: true };
      }
      return { amount: override.investmentForecastAmount, unknown: false, stated: true };
    }
    if (override && override.amount != null) {
      return { amount: Number(override.amount), unknown: false, stated: true };
    }
    // No override, or an override that reuses the base amount.
    return { amount: baseAmount, unknown: baseUnknown, stated: false };
  };

  // Deductions are spent later, across every bill (`spendPayrollDeductions`):
  // the occurrence records the day it falls on and whether an override stated
  // its amount, which is projected as stated and still spends.
  const withDeductions = (
    resolved: { amount: number; unknown: boolean; stated: boolean },
    dateKey: string,
  ): Pick<Occurrence, 'amount' | 'unknown' | 'spendDate' | 'stated'> => ({
    amount: resolved.amount,
    unknown: resolved.unknown,
    spendDate: dateKey,
    stated: resolved.stated,
  });

  // For ONCE frequency, just check if it's in range
  if (transaction.frequency === 'ONCE') {
    const slotKey = formatDateKey(currentDate);
    const override = overrideMap.get(slotKey);
    const effectiveDate = override?.overrideDate ? parseLocalDate(override.overrideDate) : currentDate;
    const effectiveTime = effectiveDate.getTime();
    const effectiveKey = formatDateKey(effectiveDate);
    const placed = place(effectiveTime, effectiveKey, slotKey);
    if (placed && (!txEndTime || effectiveTime <= txEndTime)) {
      occurrences.push({ ...placed, ...withDeductions(resolveOccurrence(override), effectiveKey) });
    }
    return occurrences;
  }

  // Generate occurrences until we pass the end date or run out of occurrences
  let iterations = 0;

  while (iterations < MAX_OCCURRENCE_STEPS) {
    iterations++;
    const currentDateKey = formatDateKey(currentDate);

    // Check if we've passed the forecast end date
    if (currentDate.getTime() > endTime) break;

    // Check if we've exceeded the transaction's end date
    if (txEndTime && currentDate.getTime() > txEndTime) break;

    // Check if we've used all occurrences
    if (remainingOccurrences !== null && remainingOccurrences <= 0) break;

    // Check for override on this occurrence
    const override = overrideMap.get(currentDateKey);
    const effectiveDate = override?.overrideDate && override.overrideDate !== currentDateKey
      ? parseLocalDate(override.overrideDate)
      : currentDate;
    const effectiveTime = effectiveDate.getTime();
    const effectiveDateKey = override?.overrideDate && override.overrideDate !== currentDateKey
      ? formatDateKey(effectiveDate)
      : currentDateKey;
    // Only include if effective date is within our forecast range (or, when
    // carrying, before it)
    const placed = place(effectiveTime, effectiveDateKey, currentDateKey);
    if (placed) {
      occurrences.push({ ...placed, ...withDeductions(resolveOccurrence(override), effectiveDateKey) });
    }

    // Every slot walked is one occurrence of the count, wherever it falls --
    // the backend's expander counts the same way. Counting only the ones inside
    // the window let an overdue slot leave the count untouched, so a schedule
    // with one occurrence left projected one more after it.
    if (remainingOccurrences !== null) {
      remainingOccurrences--;
    }

    // Calculate next date based on frequency
    currentDate = advanceByFrequency(currentDate, transaction.frequency, anchorDayOf(transaction.startDate, currentDate));
  }

  return occurrences;
}

/**
 * Check if a scheduled transaction is a transfer (affects two accounts, net zero for "all accounts" view)
 */
function isTransfer(transaction: ScheduledTransaction): boolean {
  // Check direct transfer field first
  if (transaction.isTransfer && transaction.transferAccountId) {
    return true;
  }
  // Fallback: check for split-based transfers (legacy)
  return transaction.isSplit &&
    (transaction.splits?.some(split => split.transferAccountId != null) ?? false);
}

/**
 * Scheduled investment transactions store `accountId` as the brokerage account
 * but the cash side flows through `investmentFundingAccountId` (typically an
 * INVESTMENT_CASH account). When the funding account is left blank, the cash
 * side falls back to the brokerage's linked cash account. Reshape the
 * scheduled transaction so the forecast treats the cash account as the
 * affected account, with the amount converted into that account's currency
 * via the recorded exchange rate.
 */
/**
 * A split-investment schedule: an ordinary split parent (`isSplit`) carrying at
 * least one embedded investment split line. Its cash impact is FX-sensitive the
 * same way a parent investment schedule is (issue #1167), but it has no single
 * settlement rate -- each investment line settles its own security's currency --
 * so the server sends one recomputed effective total (`investmentForecastAmount`)
 * rather than a rate.
 */
/**
 * Why this file still combines rate x amount itself, when the server sends one
 * effective amount (issue #1247).
 *
 * `effectiveAmount` is *defined* as what this projection computes: the backend's
 * `baseEffectiveAmount` applies the same `investmentForecastExchangeRate` to the
 * same stored scalar, and the split case reads the same
 * `investmentForecastAmount`. What the server cannot express in that one field is
 * the rest of what a cash-flow projection needs -- remapping the schedule onto
 * the settlement cash account, converting each future override, and withholding a
 * cumulative series whole when any occurrence is unknown -- so the projection
 * keeps its own pass over those fields and every *other* consumer reads
 * `effectiveAmount` instead of re-deriving them (see
 * `lib/scheduled-effective-amount.ts`). If you change how either side folds a
 * rate into an amount, change both: the two answering differently is the defect.
 */
function hasEmbeddedInvestmentSplits(transaction: ScheduledTransaction): boolean {
  return (
    transaction.isSplit === true &&
    (transaction.splits?.some(
      s => s.investmentAction != null || s.kind === 'investment',
    ) ?? false)
  );
}

/**
 * The FX rate the forecast should convert a top-level investment schedule at,
 * as `number | null` where `null` means "unknown -- withhold" (issue #1167).
 *
 * A PRESENT `investmentForecastExchangeRate` is authoritative: `1` for a proven
 * same-currency pair, a number for a resolved cross-currency pair, `null` when
 * the current backend could not resolve it.
 *
 * An ABSENT field means a backend that predates the field (a rolling deploy).
 * It is NOT evidence of a 1:1 pair, and a persisted `investmentExchangeRate` is
 * NOT evidence of the current pair -- it is a rate for whatever pair it was
 * resolved against, which the referenced security's or settlement account's
 * currency may since have changed out from under (issue #1167). So the client
 * derives the current settlement pair from data it already holds and reuses the
 * persisted scalar ONLY when its recorded provenance proves it belongs to that
 * pair:
 *   - either currency unknown -> `null` (cannot prove the pair; withhold);
 *   - same-currency pair -> `1` (a same-currency pair is always 1, no scalar);
 *   - cross-currency pair -> the persisted scalar only if it is positive AND its
 *     `investmentExchangeRate{From,To}Currency` provenance matches the derived
 *     pair; otherwise `null` (unprovenanced or stale-pair scalar is unknown,
 *     never `1` and never trusted, so the projection is withheld not fabricated).
 * The derived pair mirrors the backend's `resolveSettlementCurrencyPair`:
 * `from` is the security's currency (falling back to the brokerage's), `to` is
 * the funding-or-linked cash account's currency.
 */
function effectiveForecastRate(
  transaction: ScheduledTransaction,
  accountsById: Map<string, Account>,
  cashAccountId: string,
): number | null {
  const forecastRate = transaction.investmentForecastExchangeRate;
  if (forecastRate !== undefined) return forecastRate;

  const brokerage = accountsById.get(transaction.accountId);
  const fromCurrency =
    transaction.investmentSecurity?.currencyCode ?? brokerage?.currencyCode;
  const cash =
    accountsById.get(cashAccountId) ??
    (transaction.investmentFundingAccountId === cashAccountId
      ? transaction.investmentFundingAccount ?? undefined
      : undefined);
  const toCurrency = cash?.currencyCode;
  if (!fromCurrency || !toCurrency) return null;
  if (fromCurrency === toCurrency) return 1;

  const persisted = transaction.investmentExchangeRate;
  const provenanceMatches =
    transaction.investmentExchangeRateFromCurrency === fromCurrency &&
    transaction.investmentExchangeRateToCurrency === toCurrency;
  return persisted != null &&
    Number.isFinite(Number(persisted)) &&
    Number(persisted) > 0 &&
    provenanceMatches
    ? Number(persisted)
    : null;
}

function normalizeInvestmentForForecast(
  transaction: ScheduledTransaction,
  accountsById: Map<string, Account>,
): ScheduledTransaction {
  if (!transaction.isInvestment) {
    // Issue #1167: a split-investment schedule projects the server's effective
    // total (its base splits re-summed at current FX), never the stale stored
    // `amount`. When any investment line's current rate is unknown the server
    // sends `null`, and an older backend sends the field absent; in either case
    // the amount is left as-is because the builders detect the unknown case
    // (`hasUnknownForecastRate`, which treats null AND absent as unknown) and
    // withhold the whole series rather than projecting a stale figure.
    if (
      hasEmbeddedInvestmentSplits(transaction) &&
      transaction.investmentForecastAmount != null
    ) {
      return { ...transaction, amount: transaction.investmentForecastAmount };
    }
    return transaction;
  }
  // Which account settles is one decision, made by the server for the posting
  // and read here through the shared helper -- the projection and the dashboard
  // widget cannot charge different accounts for the same occurrence (#1247).
  const cashAccountId = occurrenceSettlementAccountId(transaction, accountsById);
  if (!cashAccountId) {
    return transaction;
  }
  // Issue #1167: the forecast converts the security-currency amount into the
  // cash account's currency with the server-resolved *forecast* rate, never the
  // persisted `investmentExchangeRate` (which may be stale for the current
  // settlement pair). The backend sends `1` for a same-currency pair, a resolved
  // rate for a cross-currency one, and `null` when the current rate is unknown;
  // when the field is absent (an older backend, mid rolling deploy) the effective
  // rate is derived and provenance-checked client-side. The effective rate is
  // stamped back onto `investmentForecastExchangeRate` so the downstream builders
  // (`hasUnknownForecastRate`) read one explicit value -- `null` means withhold,
  // a number means project -- rather than having to re-derive it.
  const rate = effectiveForecastRate(transaction, accountsById, cashAccountId);
  const remapped =
    transaction.accountId === cashAccountId
      ? transaction
      : { ...transaction, accountId: cashAccountId };
  if (rate === null) {
    // Unknown current FX: remap onto the cash account but do not convert, and
    // stamp explicit null so the builders withhold the projection for this
    // investment schedule rather than inventing or trusting a rate.
    return { ...remapped, investmentForecastExchangeRate: null };
  }
  if (!Number.isFinite(rate) || rate === 1) {
    // Same-currency (or a degenerate rate): no conversion, but the rate is
    // KNOWN, so stamp it so the projection is not withheld.
    return { ...remapped, investmentForecastExchangeRate: rate };
  }
  // Converted into the cash account's currency, at that currency's precision.
  const cashDecimals = moneyDecimalsForCurrency(
    accountsById.get(cashAccountId)?.currencyCode ??
      (transaction.investmentFundingAccountId === cashAccountId
        ? transaction.investmentFundingAccount?.currencyCode
        : undefined),
  );
  const convertOverride = <T extends { amount: number | null }>(o: T): T => ({
    ...o,
    amount: o.amount != null ? roundMoney(Number(o.amount) * rate, cashDecimals) : o.amount,
  });
  return {
    ...transaction,
    accountId: cashAccountId,
    amount: roundMoney(Number(transaction.amount) * rate, cashDecimals),
    investmentForecastExchangeRate: rate,
    futureOverrides: transaction.futureOverrides?.map(convertOverride),
    nextOverride: transaction.nextOverride
      ? convertOverride(transaction.nextOverride)
      : transaction.nextOverride,
  };
}

/**
 * An investment schedule whose current settlement FX rate could not be resolved
 * server-side (issue #1167). Its projected cash impact is unknown, so -- like a
 * missing display-currency rate -- it withholds the whole cumulative projection
 * rather than contributing a stale or 1:1 figure. The security's currency (the
 * `from` side of the unresolved pair) names it in `missingCurrencies`, falling
 * back to the settlement account's currency.
 */
function hasUnknownForecastRate(transaction: ScheduledTransaction): boolean {
  // This runs on the NORMALIZED transaction (every `generateOccurrences` caller
  // normalizes first), so an investment schedule always carries an explicit
  // `investmentForecastExchangeRate` that `normalizeInvestmentForForecast`
  // stamped: `null` when the current settlement rate is unknown -- an explicit
  // null from the backend, or an absent field whose derived pair could not be
  // proven client-side -- and a number when it is known. Read `=== null`.
  if (transaction.isInvestment) {
    return transaction.investmentForecastExchangeRate === null;
  }
  // A split-investment schedule whose effective total could not be resolved (any
  // investment line's current rate unknown) is withheld the same way (#1167).
  // Read `== null`: an absent `investmentForecastAmount` is an older backend that
  // did not compute it, and the client cannot re-derive a split's current-FX
  // total from data it holds, so an absent value is unknown -- withhold rather
  // than project the stale stored `amount`, which may be off by the FX drift
  // since it was last written (issue #1167 review).
  if (hasEmbeddedInvestmentSplits(transaction)) {
    return transaction.investmentForecastAmount == null;
  }
  return false;
}

/**
 * The active scheduled transactions that move `accountId`, each flagged with
 * whether this account is the *destination* of a transfer -- the stored amount
 * is the source's (negative), so the destination receives its negation.
 *
 * The single-account forecast and every line of the multi-account forecast go
 * through this, so one account's projection cannot mean two different things
 * depending on which chart drew it.
 */
function scheduledFlowsForAccount(
  transactions: ScheduledTransaction[],
  accountId: string,
): Array<{ transaction: ScheduledTransaction; isInbound: boolean }> {
  return transactions
    .filter(
      t =>
        t.isActive &&
        (t.accountId === accountId || (isTransfer(t) && t.transferAccountId === accountId)),
    )
    .map(transaction => ({
      transaction,
      isInbound:
        isTransfer(transaction) &&
        transaction.transferAccountId === accountId &&
        transaction.accountId !== accountId,
    }));
}

/**
 * Build forecast data points for the cash flow chart.
 *
 * futureTransactions: already-posted transactions with a date after today.
 * These are NOT included in account.currentBalance (the backend excludes
 * future-dated transactions from currentBalance).  We start from
 * currentBalance and add future transactions at their correct dates.
 *
 * A scheduled occurrence due before today that was neither posted nor skipped
 * is applied on today, the forecast's first day, and carries
 * `overdueOriginalDate` (discussion #1784). The account balance forecast
 * (`BalanceForecastService`) applies the same rule on its own first day.
 */
export function buildForecast(
  accounts: Account[],
  transactions: ScheduledTransaction[],
  period: ForecastPeriod,
  accountId: string | 'all',
  futureTransactions: FutureTransaction[] = [],
  /**
   * Cross-currency conversion into the display currency. Returns `null` when no
   * rate for the pair is known -- a forecast built by treating that as the
   * unconverted amount would project a balance in a currency it was never in.
   */
  convertAmount?: (amount: number, currencyCode: string) => number | null,
): ForecastResult {
  // Remap scheduled investment transactions onto their funding cash account so
  // BUY/SELL/etc. show up in the cash flow forecast for INVESTMENT_CASH accounts.
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  transactions = transactions.map(t => normalizeInvestmentForForecast(t, accountsById));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const days = FORECAST_PERIOD_DAYS[period];
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + days);

  const granularity = getGranularity(period);

  // Filter accounts
  const targetAccounts = accountId === 'all'
    ? accounts.filter(a => !a.isClosed)
    : accounts.filter(a => a.id === accountId);

  if (targetAccounts.length === 0) {
    return { points: [], missingCurrencies: [] };
  }

  // currentBalance excludes future-dated transactions (backend filters them
  // out).  We use it directly as the starting balance, then layer future
  // transactions onto their correct dates below.
  const targetAccountIds = new Set(targetAccounts.map(a => a.id));
  const relevantFuture = futureTransactions.filter(ft =>
    targetAccountIds.has(ft.accountId) && ft.date > todayKey
  );

  // Build account currency lookup for converting transaction amounts
  const accountCurrencyMap = new Map(targetAccounts.map(a => [a.id, a.currencyCode]));
  const lineCurrency = unconvertedCurrency(targetAccounts, !!convertAmount);
  // Converted into the reporting currency at four; unconverted, at the
  // account currency's own precision (a coin wallet's eight).
  const unitDecimals = convertAmount ? REPORTING_MONEY_DECIMALS : widestMoneyDecimals(targetAccounts);
  // A forecast is a running balance: one unconvertible amount makes every
  // subsequent day wrong, so an unknown conversion is recorded once and the whole
  // series is reported as unavailable rather than silently drifting. `conv`
  // therefore contributes nothing and sets the flag.
  const missingRateCurrencies = new Set<string>();
  const conv = (amount: number, acctId: string): number => {
    if (!convertAmount) return amount;
    const currency = accountCurrencyMap.get(acctId);
    // The account is a target account (transactions are filtered to those), so
    // its currency is always known. Defensive only: never add a raw foreign
    // amount to the running balance under the display currency.
    if (!currency) return 0;
    const converted = convertAmount(amount, currency);
    if (converted === null) {
      missingRateCurrencies.add(currency);
      return 0;
    }
    return roundMoney(converted, REPORTING_MONEY_DECIMALS);
  };

  const startingUnits = targetAccounts.reduce((sum, acc) => {
    if (!convertAmount) return sum + toUnits(Number(acc.currentBalance), unitDecimals);
    const converted = convertAmount(Number(acc.currentBalance), acc.currencyCode);
    if (converted === null) {
      missingRateCurrencies.add(acc.currencyCode);
      return sum;
    }
    return sum + toUnits(converted, unitDecimals);
  }, BigInt(0));

  // Filter scheduled transactions by account
  // For a specific account, include transfers where this account is the destination
  // (transferAccountId) since those represent money coming IN to this account.
  // Inbound transfers (this account is the destination) carry the source's
  // negative amount, so they are negated below.
  const relevantFlows = accountId === 'all'
    ? // Only target (non-closed) accounts: a schedule on a closed account is not
      // part of this forecast, and its currency is not in the map, so including
      // it would add an unconverted foreign amount to the running balance.
      transactions
        .filter(t => t.isActive && !isTransfer(t) && targetAccountIds.has(t.accountId))
        .map(transaction => ({ transaction, isInbound: false }))
    : scheduledFlowsForAccount(transactions, accountId);

  // Every active schedule, not only the relevant ones: a paycheque on another
  // account draws down the same deduction room.
  const occurrencesById = generateAllOccurrences(transactions, today, endDate, { carryOverdue: true });

  // Generate all occurrences and group by date
  const transactionsByDate = new Map<string, ForecastTransaction[]>();

  // Add future-dated regular transactions at their correct dates
  for (const ft of relevantFuture) {
    const existing = transactionsByDate.get(ft.date) || [];
    existing.push({
      name: ft.name,
      amount: conv(ft.amount, ft.accountId),
      scheduledTransactionId: ft.id,
    });
    transactionsByDate.set(ft.date, existing);
  }

  for (const { transaction: tx, isInbound } of relevantFlows) {
    // An unposted occurrence due before today lands on today: the bill is
    // still owed (discussion #1784).
    const occurrences = occurrencesById.get(tx.id) ?? [];
    const txAccountId = isInbound ? (tx.transferAccountId ?? tx.accountId) : tx.accountId;
    for (const occ of occurrences) {
      const existing = transactionsByDate.get(occ.date) || [];
      // An investment occurrence with an unresolved current FX rate makes the
      // running balance unknown from here on (issue #1167): record the missing
      // currency and contribute nothing, which withholds the whole series below.
      // The flag is per-occurrence (F5-2): a base occurrence and an override on
      // the same schedule can differ.
      if (occ.unknown) {
        missingRateCurrencies.add(
          tx.investmentSecurity?.currencyCode ??
            accountCurrencyMap.get(txAccountId) ??
            tx.currencyCode,
        );
      }
      existing.push({
        name: tx.name,
        amount: occ.unknown
          ? 0
          : conv(isInbound ? -occ.amount : occ.amount, txAccountId),
        scheduledTransactionId: tx.id,
        ...(occ.overdueOriginalDate !== undefined && {
          overdueOriginalDate: occ.overdueOriginalDate,
        }),
      });
      transactionsByDate.set(occ.date, existing);
    }
  }

  // Build data points
  const dataPoints: ForecastDataPoint[] = [];
  let currentUnits = startingUnits;
  let lastAddedTime: number | null = null;

  // Iterate through each day in the forecast period
  for (let dayOffset = 0; dayOffset <= days; dayOffset++) {
    const currentDate = new Date(today.getTime());
    currentDate.setDate(today.getDate() + dayOffset);
    const currentTime = currentDate.getTime();

    const dateKey = formatDateKey(currentDate);
    const dayTransactions = transactionsByDate.get(dateKey) || [];

    // Apply transactions for this day
    for (const tx of dayTransactions) {
      currentUnits += toUnits(tx.amount, unitDecimals);
    }

    // Check if we should add a data point (based on granularity)
    const daysSinceLastPoint = lastAddedTime === null
      ? granularity
      : Math.floor((currentTime - lastAddedTime) / (1000 * 60 * 60 * 24));
    const shouldAddPoint = daysSinceLastPoint >= granularity;

    // Always add a point if there are transactions on this day, or if it's the last day
    const isLastDay = dayOffset === days;

    if (shouldAddPoint || dayTransactions.length > 0 || isLastDay) {
      dataPoints.push({
        date: dateKey,
        balance: unitsToPlaces(currentUnits, unitDecimals, lineCurrency),
        transactions: dayTransactions,
      });
      lastAddedTime = currentTime;
    }
  }

  // A running balance cannot be partially right: report the whole series as
  // unavailable when any leg of it needed a rate we do not have.
  if (missingRateCurrencies.size > 0) {
    return { points: [], missingCurrencies: [...missingRateCurrencies] };
  }
  return { points: dataPoints, missingCurrencies: [] };
}

/**
 * Build one forecast line per selected account, plus the "Total of Accounts"
 * line that is their sum.
 *
 * Each line uses the same rules as the single-account forecast
 * (`scheduledFlowsForAccount`): the account's own schedules, plus transfers
 * where it is the destination. So a transfer between two selected accounts
 * moves both lines and nets to zero in the total -- which is what a total of
 * those accounts means -- while a transfer out to an account that is not
 * selected leaves the total, as it should.
 *
 * Every line shares one y-axis, so every line is in one currency: each
 * account's balances and amounts are converted into the display currency
 * through `convertAmount`. As in `buildForecast`, a projected balance is
 * cumulative, so one missing rate withholds the whole result rather than
 * drawing a plausible line.
 *
 * `accountIds` order is preserved: it is the order the legend reads and the
 * order colours are assigned in, and the caller -- not this function -- knows
 * how its account picker sorts.
 */
export function buildMultiAccountForecast(
  accounts: Account[],
  transactions: ScheduledTransaction[],
  period: ForecastPeriod,
  accountIds: string[],
  futureTransactions: FutureTransaction[] = [],
  convertAmount?: (amount: number, currencyCode: string) => number | null,
): MultiAccountForecastResult {
  const accountsById = new Map(accounts.map(a => [a.id, a]));
  const normalized = transactions.map(t => normalizeInvestmentForForecast(t, accountsById));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const days = FORECAST_PERIOD_DAYS[period];
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + days);
  const granularity = getGranularity(period);

  const targetAccounts = [...new Set(accountIds)]
    .map(id => accountsById.get(id))
    .filter((a): a is Account => a !== undefined);

  if (targetAccounts.length === 0) {
    return { points: [], series: [], missingCurrencies: [] };
  }

  // An unknown rate contributes nothing and sets the flag; the whole result is
  // withheld below rather than reported as a shorter, wrong series.
  const missingRateCurrencies = new Set<string>();
  const conv = (amount: number, currencyCode: string): number => {
    if (!convertAmount) return amount;
    const converted = convertAmount(amount, currencyCode);
    if (converted === null) {
      missingRateCurrencies.add(currencyCode);
      return 0;
    }
    return roundMoney(converted, REPORTING_MONEY_DECIMALS);
  };
  // Each line's precision: the reporting currency's four when converted, else
  // its account currency's own (a coin wallet's eight).
  const lineDecimals = (account: Account): number =>
    convertAmount ? REPORTING_MONEY_DECIMALS : moneyDecimalsForCurrency(account.currencyCode);
  const totalDecimals = convertAmount ? REPORTING_MONEY_DECIMALS : widestMoneyDecimals(targetAccounts);

  // Integer units of each line's precision, like the running balance below.
  const startingBalances = new Map<string, bigint>();
  const flowsByAccount = new Map<string, Map<string, ForecastTransaction[]>>();

  // Across every schedule, so bills on different accounts share one room.
  const occurrencesById = generateAllOccurrences(normalized, today, endDate, { carryOverdue: true });

  for (const account of targetAccounts) {
    startingBalances.set(
      account.id,
      toUnits(conv(Number(account.currentBalance), account.currencyCode), lineDecimals(account)),
    );

    const byDate = new Map<string, ForecastTransaction[]>();
    const add = (date: string, entry: ForecastTransaction) => {
      byDate.set(date, [...(byDate.get(date) ?? []), entry]);
    };

    // currentBalance excludes future-dated posted transactions, so they are
    // layered onto their own dates -- same as the single-account forecast.
    for (const ft of futureTransactions) {
      if (ft.accountId !== account.id || ft.date <= todayKey) continue;
      add(ft.date, {
        name: ft.name,
        amount: conv(ft.amount, account.currencyCode),
        scheduledTransactionId: ft.id,
        accountId: account.id,
      });
    }

    for (const { transaction, isInbound } of scheduledFlowsForAccount(normalized, account.id)) {
      for (const occ of occurrencesById.get(transaction.id) ?? []) {
        // Unresolved current FX for an investment occurrence withholds the whole
        // result (issue #1167), the same as a missing display-currency rate. The
        // flag is per-occurrence (F5-2).
        if (occ.unknown) {
          missingRateCurrencies.add(
            transaction.investmentSecurity?.currencyCode ?? account.currencyCode,
          );
        }
        add(occ.date, {
          name: transaction.name,
          amount: occ.unknown
            ? 0
            : conv(isInbound ? -occ.amount : occ.amount, account.currencyCode),
          scheduledTransactionId: transaction.id,
          accountId: account.id,
          ...(occ.overdueOriginalDate !== undefined && {
            overdueOriginalDate: occ.overdueOriginalDate,
          }),
        });
      }
    }

    flowsByAccount.set(account.id, byDate);
  }

  const running = new Map<string, bigint>(startingBalances);
  const points: MultiAccountForecastPoint[] = [];
  let lastAddedTime: number | null = null;

  for (let dayOffset = 0; dayOffset <= days; dayOffset++) {
    const currentDate = new Date(today.getTime());
    currentDate.setDate(today.getDate() + dayOffset);
    const currentTime = currentDate.getTime();
    const dateKey = formatDateKey(currentDate);

    const dayTransactions: ForecastTransaction[] = [];
    for (const account of targetAccounts) {
      const dayFlows = flowsByAccount.get(account.id)?.get(dateKey);
      if (!dayFlows) continue;
      const decimals = lineDecimals(account);
      running.set(
        account.id,
        dayFlows.reduce(
          (sum, tx) => sum + toUnits(tx.amount, decimals),
          running.get(account.id) ?? BigInt(0),
        ),
      );
      dayTransactions.push(...dayFlows);
    }

    const daysSinceLastPoint = lastAddedTime === null
      ? granularity
      : Math.floor((currentTime - lastAddedTime) / (1000 * 60 * 60 * 24));
    const shouldAddPoint = daysSinceLastPoint >= granularity;
    const isLastDay = dayOffset === days;

    if (shouldAddPoint || dayTransactions.length > 0 || isLastDay) {
      // Integer units: the total is summed from the same rounded per-account
      // figures the lines are drawn from, so the total on screen is exactly the
      // total of the lines on screen.
      const balances: Record<string, number> = {};
      for (const account of targetAccounts) {
        balances[account.id] = unitsToPlaces(
          running.get(account.id) ?? BigInt(0),
          lineDecimals(account),
          convertAmount ? undefined : account.currencyCode,
        );
      }
      points.push({
        date: dateKey,
        balance: sumMoney(Object.values(balances), totalDecimals),
        balances,
        transactions: dayTransactions,
      });
      lastAddedTime = currentTime;
    }
  }

  if (missingRateCurrencies.size > 0) {
    return { points: [], series: [], missingCurrencies: [...missingRateCurrencies] };
  }

  return {
    points,
    series: targetAccounts.map(a => ({ accountId: a.id, name: a.name })),
    missingCurrencies: [],
  };
}

/**
 * Compute the projected balance for a single account at a specific date.
 *
 * Starts from account.currentBalance (which excludes future-dated posted
 * transactions), then layers on future transactions and scheduled transaction
 * occurrences up to and including targetDate.
 *
 * @param excludeScheduledId - Omit this scheduled transaction (e.g. the one
 *   being posted) so the caller can add the user-edited amount separately.
 *
 * Occurrences already overdue are not carried onto today here, unlike the
 * cash-flow forecasts: discussion #1784 agreed the rule for those two surfaces,
 * and this figure is the posting dialog's "balance before".
 */
export function getProjectedBalanceAtDate(
  account: Account,
  targetDate: string,
  scheduledTransactions: ScheduledTransaction[],
  futureTransactions: FutureTransaction[] = [],
  excludeScheduledId?: string,
  allAccounts?: Account[],
): number | null {
  const accountsById = new Map<string, Account>();
  accountsById.set(account.id, account);
  if (allAccounts) {
    for (const a of allAccounts) accountsById.set(a.id, a);
  }
  scheduledTransactions = scheduledTransactions.map(t =>
    normalizeInvestmentForForecast(t, accountsById),
  );

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = formatDateKey(today);

  const endDate = parseLocalDate(targetDate);
  endDate.setHours(0, 0, 0, 0);

  const decimals = moneyDecimalsForCurrency(account.currencyCode);
  let units = toUnits(Number(account.currentBalance), decimals);

  // Add future-dated posted transactions for this account up to targetDate
  for (const ft of futureTransactions) {
    if (ft.accountId === account.id && ft.date > todayKey && ft.date <= targetDate) {
      units += toUnits(ft.amount, decimals);
    }
  }

  // Include scheduled transactions for this account + inbound transfers
  const relevant = scheduledTransactions.filter(t => {
    if (!t.isActive) return false;
    if (excludeScheduledId && t.id === excludeScheduledId) return false;
    if (t.accountId === account.id) return true;
    // Inbound transfer: this account is the destination
    if (isTransfer(t) && t.transferAccountId === account.id && t.accountId !== account.id) return true;
    return false;
  });

  const inboundTransferIds = new Set(
    relevant.filter(t => isTransfer(t) && t.transferAccountId === account.id && t.accountId !== account.id).map(t => t.id)
  );

  // The excluded schedule is the one being posted: it neither counts here nor
  // spends room the others would have had.
  const occurrencesById = generateAllOccurrences(
    scheduledTransactions.filter(t => !excludeScheduledId || t.id !== excludeScheduledId),
    today,
    endDate,
  );
  for (const tx of relevant) {
    const occurrences = occurrencesById.get(tx.id) ?? [];
    const isInbound = inboundTransferIds.has(tx.id);
    for (const occ of occurrences) {
      // An investment occurrence whose current FX rate is unknown (issue #1167)
      // makes the balance at/after its date unknowable, exactly as it withholds
      // the whole series in `buildForecast`. Return null rather than folding a
      // stale/raw security-currency amount (or 0) into a projected balance the
      // user approves a posting against.
      if (occ.unknown) return null;
      units += toUnits(isInbound ? -occ.amount : occ.amount, decimals);
    }
  }

  return unitsToPlaces(units, decimals, account.currencyCode);
}

/**
 * How many overdue occurrences a forecast point carries (discussion #1784), so
 * the tooltip can say why the first day drops. Counted per occurrence -- a
 * schedule three months behind is three payments -- and once per occurrence: a
 * transfer between two charted accounts puts one entry on each line, and it is
 * still one bill.
 */
export function countOverdueOccurrences(transactions: ForecastTransaction[]): number {
  const keys = new Set<string>();
  for (const tx of transactions) {
    if (tx.overdueOriginalDate !== undefined) {
      keys.add(`${tx.scheduledTransactionId}|${tx.overdueOriginalDate}`);
    }
  }
  return keys.size;
}

/** The net of the overdue occurrences a forecast point carries, in `10^-decimals` units. */
function overdueNetUnits(transactions: ForecastTransaction[], decimals: number): bigint {
  return transactions.reduce(
    (sum, tx) => (tx.overdueOriginalDate !== undefined ? sum + toUnits(tx.amount, decimals) : sum),
    BigInt(0),
  );
}

/**
 * Get summary statistics from forecast data
 */
export function getForecastSummary(dataPoints: ForecastDataPoint[], currencyCode?: string) {
  if (dataPoints.length === 0) {
    return {
      startingBalance: 0,
      endingBalance: 0,
      minBalance: 0,
      maxBalance: 0,
      goesNegative: false,
    };
  }

  const balances = dataPoints.map(d => d.balance);
  // "Starting" is where the forecast starts from, before the overdue occurrences
  // it applies on its first day (discussion #1784): those are a projection, and
  // the figure has to match the balance the account shows.
  const decimals = moneyDecimalsForCurrency(currencyCode);
  const startingBalance = unitsToPlaces(
    toUnits(balances[0], decimals) - overdueNetUnits(dataPoints[0].transactions, decimals),
    decimals,
    currencyCode,
  );
  const endingBalance = balances[balances.length - 1];
  const minBalance = Math.min(...balances);
  const maxBalance = Math.max(...balances);

  return {
    startingBalance,
    endingBalance,
    minBalance,
    maxBalance,
    goesNegative: minBalance < 0,
  };
}
