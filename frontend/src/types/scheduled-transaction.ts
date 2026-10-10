import { Account } from './account';
import { Payee } from './payee';
import { Category } from './category';
import { Tag } from './tag';
import { InvestmentAction, Security } from './investment';
import { SplitKind, InvestmentSplitDetails } from './transaction';

/**
 * Every frequency a scheduled transaction can have, ordered shortest period
 * first -- the order the selector renders them in. Mirrors the backend's
 * `FrequencyType` enum (`create-scheduled-transaction.dto.ts`); the stepping
 * maths lives in `@/lib/frequency`.
 *
 * Declared as a const tuple so `z.enum(FREQUENCY_VALUES)` in the form derives
 * from it instead of repeating the list.
 */
export const FREQUENCY_VALUES = [
  'ONCE',
  'DAILY',
  'WEEKLY',
  'BIWEEKLY',
  'EVERY4WEEKS',
  'SEMIMONTHLY',
  'MONTHLY',
  'EVERY2MONTHS',
  'QUARTERLY',
  'EVERY4MONTHS',
  'SEMIANNUAL',
  'YEARLY',
  'EVERY2YEARS',
] as const;

export type FrequencyType = (typeof FREQUENCY_VALUES)[number];

export interface ScheduledTransactionSplit {
  id: string;
  scheduledTransactionId: string;
  kind?: SplitKind;
  categoryId: string | null;
  category: Category | null;
  transferAccountId: string | null;
  transferAccount: Account | null;
  amount: number;
  memo: string | null;
  tags?: Tag[];
  // Investment-split fields
  investmentAction?: InvestmentAction | null;
  investmentSecurityId?: string | null;
  investmentSecurity?: Security | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentCommission?: number | null;
  investmentExchangeRate?: number | null;
  // Currency pair the stored rate was resolved for (issue #1167), server-derived.
  investmentExchangeRateFromCurrency?: string | null;
  investmentExchangeRateToCurrency?: string | null;
  createdAt: string;
}

export interface ScheduledTransaction {
  id: string;
  userId: string;
  accountId: string;
  account: Account | null;
  name: string;
  payeeId: string | null;
  payee: Payee | null;
  payeeName: string | null;
  categoryId: string | null;
  category: Category | null;
  amount: number;
  currencyCode: string;
  // Foreign-currency entry. When originalCurrencyCode is set, originalAmount is
  // the fixed amount the biller charges in that currency and `amount` is the
  // account-currency estimate derived from it at exchangeRate -- refreshed
  // daily from the latest rate, and re-derived for the posting date on posting.
  originalAmount: number | null;
  originalCurrencyCode: string | null;
  exchangeRate: number;
  description: string | null;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate: string;
  endDate: string | null;
  occurrencesRemaining: number | null;
  totalOccurrences: number | null;
  isActive: boolean;
  autoPost: boolean;
  reminderDaysBefore: number;
  lastPostedDate: string | null;
  isSplit: boolean;
  isTransfer: boolean;
  transferAccountId: string | null;
  transferAccount: Account | null;
  isInvestment: boolean;
  investmentAction: InvestmentAction | null;
  investmentSecurityId: string | null;
  investmentSecurity: Security | null;
  investmentFundingAccountId: string | null;
  investmentFundingAccount: Account | null;
  investmentQuantity: number | null;
  investmentPrice: number | null;
  investmentCommission: number | null;
  investmentTotalAmount: number | null;
  investmentExchangeRate: number | null;
  // Currency pair the stored rate was resolved for (issue #1167), server-derived.
  investmentExchangeRateFromCurrency?: string | null;
  investmentExchangeRateToCurrency?: string | null;
  // Read-only, server-resolved FX rate the cash-flow forecast must use for this
  // investment schedule (issue #1167) -- resolved through the same settlement
  // pair + FX path as posting, never the stale persisted `investmentExchangeRate`.
  // `1` for same-currency, a number for a resolvable cross-currency pair, `null`
  // when the current rate is unknown (forecast then shows the projection as
  // unavailable rather than inventing a rate). Absent/`null` for non-investment.
  investmentForecastExchangeRate?: number | null;
  // Read-only, server-resolved effective *total* the cash-flow forecast must use
  // for a split-investment schedule (issue #1167) -- the base splits re-summed
  // with each investment split's current FX rate, so the forecast matches what
  // posting would book rather than the stale stored `amount`. A number when every
  // investment split's current rate is known, `null` when any is unknown (forecast
  // then shows the projection as unavailable). Absent/`null` for schedules that
  // carry no investment splits.
  investmentForecastAmount?: number | null;
  // Read-only, server-resolved: the cash amount this schedule's un-overridden
  // occurrences would post TODAY, in `effectiveCurrencyCode` (issue #1247).
  //
  // This is the one figure every surface presenting or aggregating a scheduled
  // occurrence's money must read. `amount` is a snapshot taken at whatever FX
  // rate was current when it was written, so for an FX-sensitive schedule (a
  // top-level investment, or a split parent carrying an investment line) it can
  // be stale by the drift since -- which is how one schedule came to read
  // 1,500 CAD on five screens and 1,350 CAD on the forecast that predicts its
  // posting.
  //
  // `null` (with `effectiveAmountComplete` false) means the current amount
  // cannot be determined -- render it as unavailable, or withhold the total it
  // belongs to. It NEVER means "fall back to `amount`". Read the flag as
  // `=== false` and the amount as `== null`: absent is an older backend that did
  // not compute it, which is "no information", not "known good".
  //
  // For a top-level investment schedule `effectiveCurrencyCode` is the
  // *settlement* account's currency (the cash lands there), which may differ
  // from `currencyCode` (the brokerage account's).
  effectiveAmount?: number | null;
  effectiveAmountComplete?: boolean;
  effectiveCurrencyCode?: string;
  // The signed amount that decides DIRECTION, or `null` when the direction is not
  // derivable (an unpriceable mixed-sign split posts either way). Absent means an
  // older backend, which is no information -- `occurrenceKind` then falls back as
  // it always did.
  effectiveDirectionAmount?: number | null;
  // Read-only, server-resolved: the account whose balance `effectiveAmount`
  // actually moves. For an investment schedule that is the SETTLEMENT account
  // (the named funding account, or the brokerage's linked cash account), not
  // `accountId`, which is the brokerage. Absent means an older backend, and the
  // client derives the same answer from the funding/linked account it already
  // holds (`occurrenceSettlementAccountId`); it is never a licence to project
  // onto `accountId`, which charged the brokerage for cash it never moved
  // (issue #1247).
  settlementAccountId?: string;
  tagIds?: string[];
  splits?: ScheduledTransactionSplit[];
  overrideCount?: number;
  nextOverride?: ScheduledTransactionOverride | null;
  futureOverrides?: ScheduledTransactionOverride[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionSplitData {
  splitKind?: SplitKind;
  categoryId?: string;
  transferAccountId?: string;
  investment?: InvestmentSplitDetails;
  amount: number;
  memo?: string;
  tagIds?: string[];
}

export interface CreateScheduledTransactionData {
  accountId: string;
  name: string;
  payeeId?: string;
  payeeName?: string;
  categoryId?: string;
  amount: number;
  currencyCode: string;
  originalAmount?: number | null;
  originalCurrencyCode?: string | null;
  exchangeRate?: number;
  description?: string;
  frequency: FrequencyType;
  nextDueDate: string;
  startDate?: string;
  endDate?: string;
  occurrencesRemaining?: number;
  isActive?: boolean;
  autoPost?: boolean;
  reminderDaysBefore?: number;
  isTransfer?: boolean;
  transferAccountId?: string;
  isInvestment?: boolean;
  investmentAction?: InvestmentAction;
  // Nullable so an action whose UI has no security field (INTEREST) can send an
  // explicit null to clear a security hidden by an earlier edit (issue #1154).
  investmentSecurityId?: string | null;
  // Nullable so an edit away from BUY/SELL can send an explicit null that clears
  // the stored funding account, rather than omitting the key and leaving the
  // stale value in place (issue #1154).
  investmentFundingAccountId?: string | null;
  investmentQuantity?: number;
  investmentPrice?: number;
  investmentCommission?: number;
  investmentTotalAmount?: number;
  investmentExchangeRate?: number;
  splits?: CreateScheduledTransactionSplitData[];
  tagIds?: string[];
}

export interface UpdateScheduledTransactionData
  extends Partial<CreateScheduledTransactionData> {
  // Update-only marker (issue #1167 R11-F1): set true when the user actually
  // re-enters the parent investment FX rate, so the server stamps the current
  // settlement pair even when the value equals the stored one. The form resends
  // the whole object, so numeric equality alone cannot distinguish an explicit
  // re-entry from a passive round-trip. No shipping form emits the parent
  // `investmentExchangeRate` yet, so nothing sends this today; it exists so a
  // future caller can express the intent rather than silently re-blessing a
  // stale rate.
  investmentExchangeRateExplicit?: boolean;
}

// ==================== Override Types ====================

export interface OverrideSplit {
  // Stable id of this override split, server-generated (issue #1167 F4). Returned
  // in the read model and echoed back as `sourceSplitId` on edit/post so the
  // server correlates FX-rate provenance by identity, not by matching values.
  id?: string;
  splitKind?: SplitKind;
  categoryId: string | null;
  transferAccountId?: string | null;
  investment?: InvestmentSplitDetails;
  amount: number;
  memo?: string | null;
  // Set by the client on write to name the source split this row continues.
  sourceSplitId?: string;
  // Set for a newly added investment line (no `sourceSplitId`) so the server
  // stamps the current settlement pair for its rate instead of re-resolving it
  // as an unidentified legacy row (issue #1167 R8-F2).
  rateExplicit?: boolean;
}

export interface ScheduledTransactionOverride {
  id: string;
  scheduledTransactionId: string;
  originalDate: string; // The original calculated occurrence date this override replaces
  overrideDate: string; // The actual date for this occurrence (may differ if date was changed)
  amount: number | null;
  categoryId: string | null;
  category?: Category | null;
  description: string | null;
  isSplit: boolean | null;
  splits: OverrideSplit[] | null;
  investmentQuantity: number | null;
  investmentPrice: number | null;
  investmentTotalAmount: number | null;
  // Read-only, server-resolved effective total this override would post today
  // when it carries investment splits (issue #1167 F5-2) -- its base splits
  // re-summed at current FX, so the forecast projects what posting would book
  // rather than the stale stored `amount`. `null` when the override has no
  // investment split (forecast uses `amount`) or when any line's current rate is
  // unknown (forecast withholds this occurrence).
  investmentForecastAmount?: number | null;
  // The cash amount THIS occurrence would post today (issue #1247), resolved
  // server-side with the same override-then-base precedence the posting applies.
  // `null` with `effectiveAmountComplete` false means unknown -- never a licence
  // to read `amount`. Its currency is the parent's `effectiveCurrencyCode`.
  effectiveAmount?: number | null;
  effectiveAmountComplete?: boolean;
  /** As on the schedule: `null` is "direction not derivable", absent is "not said". */
  effectiveDirectionAmount?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateScheduledTransactionOverrideData {
  originalDate: string; // The original calculated occurrence date being overridden
  overrideDate: string; // The actual date for this occurrence
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  isSplit?: boolean | null;
  splits?: OverrideSplit[] | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentTotalAmount?: number | null;
}

export interface UpdateScheduledTransactionOverrideData {
  // Moving the occurrence's date updates the existing override in place, so its
  // split identities and FX provenance survive (issue #1167 R10-F3).
  overrideDate?: string;
  amount?: number | null;
  categoryId?: string | null;
  description?: string | null;
  isSplit?: boolean | null;
  splits?: OverrideSplit[] | null;
  investmentQuantity?: number | null;
  investmentPrice?: number | null;
  investmentTotalAmount?: number | null;
}

export interface OverrideCheckResult {
  hasOverrides: boolean;
  count: number;
}

/**
 * The next-installment projection anchor for a loan account (issue #1253):
 * the next scheduled installment's due date and the debt measured from the
 * server's ledger through that date -- the same balance boundary the
 * scheduled bill's interest is calculated from. Both fields are null when
 * the loan has no active scheduled payment.
 */
export interface LoanProjectionAnchor {
  nextDueDate: string | null;
  debt: number | null;
}

/**
 * Why a projected loan occurrence's figures are unknown, and so where the
 * reader repairs it (`docs/specs/scheduled-loan-installment-pricing.md` 8.4).
 */
export type LoanOccurrenceMissing =
  /** No rate is recorded at `date`: the loan's rate history. */
  | { kind: 'rate'; date: string }
  /** A payment frequency the pricing cannot count: the loan's frequency. */
  | { kind: 'cadence'; frequency: string }
  /** The override's lines are not principal, interest and extra principal. */
  | { kind: 'override-lines'; overrideId: string }
  /** The override states an amount for a date by which the debt is settled. */
  | { kind: 'override-on-settled-debt'; overrideId: string }
  /** An earlier occurrence's figures are unknown, so this one's debt is. */
  | { kind: 'earlier-occurrence'; originalDate: string };

/**
 * One occurrence of a loan bill, priced at its own due date by the server
 * (spec 8.1). Money is unsigned and booked in the minor unit; `null` is
 * unknown, never zero, and `missing` says why.
 */
export interface LoanOccurrence {
  /** The recurrence slot: the occurrence's identity. */
  originalDate: string;
  /** The date it falls on: an override's date when one moved it. */
  dueDate: string;
  overrideId: string | null;
  amount: number | null;
  principal: number | null;
  interest: number | null;
  extraPrincipal: number | null;
  annualRate: number | null;
  debtBefore: number | null;
  complete: boolean;
  missing: LoanOccurrenceMissing | null;
}

/**
 * `GET /scheduled-transactions/:id/loan-occurrences`. `occurrences` is empty
 * unless `status` is `priced`; for the other two the bill is not one the loan
 * pricing re-prices, and its stored figures are what the posting moves.
 */
export interface LoanOccurrencesProjection {
  scheduledTransactionId: string;
  loanAccountId: string | null;
  status: 'priced' | 'not-a-loan' | 'declined';
  currencyCode: string;
  occurrences: LoanOccurrence[];
}

/** One projected loan occurrence with the loan its lines pay, as the editor opens it. */
export interface SelectedLoanOccurrence {
  loanAccountId: string | null;
  occurrence: LoanOccurrence;
}

export interface PostScheduledTransactionData {
  transactionDate?: string;
  amount?: number | null;
  // Foreign-currency schedules only: the amount in the entry currency for this
  // posting, and the rate to convert it at (defaults to the rate stored for the
  // posting date).
  originalAmount?: number | null;
  exchangeRate?: number | null;
  categoryId?: string | null;
  description?: string | null;
  referenceNumber?: string;
  isSplit?: boolean;
  splits?: OverrideSplit[];
  investmentQuantity?: number;
  investmentPrice?: number;
  investmentTotalAmount?: number;
}

/**
 * One occurrence of one schedule, as the server sends it
 * (`GET /scheduled-transactions/occurrences`, issue #1247).
 *
 * `amount` is already the effective amount for THIS occurrence -- the override's
 * when one governs it, the schedule's otherwise -- so there is no base-versus-
 * override choice left to make on the client, and no persisted snapshot in the
 * payload to reach for. `null` (with `amountComplete` false) means the current
 * amount cannot be determined: render `UnknownAmount` and withhold any total
 * containing it.
 *
 * `originalDate` is the recurrence slot (the occurrence's identity, and what an
 * override edit addresses); `dueDate` is when it actually falls.
 */
export interface ScheduledOccurrence {
  scheduledTransactionId: string;
  originalDate: string;
  dueDate: string;
  amount: number | null;
  amountComplete: boolean;
  /**
   * The signed amount that decides this occurrence's direction, or `null` when it
   * cannot be derived (an unpriceable mixed-sign split posts on either side of
   * zero). Read it through `occurrenceKind` -- never substitute the schedule's
   * stored amount for a `null`.
   */
  directionAmount: number | null;
  currencyCode: string;
  overrideId: string | null;
  /** True when an override moved this occurrence off its recurrence slot. */
  moved: boolean;
  accountId: string;
  transferAccountId: string | null;
  isTransfer: boolean;
}
