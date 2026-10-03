import { Account } from '@/types/account';
import { Transaction, TransactionSplit } from '@/types/transaction';
import { LoanProjectionAnchor } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import { financialTodayYmd } from '@/lib/financial-today';
import { transactionsApi } from '@/lib/transactions';
import {
  LoanScheduleInput,
  ScheduleFrequency,
  RateTimelineRow,
  advanceDate,
  buildRateTimeline,
  effectiveAnnualRateOn,
  firstPeriodInterest,
  generateLoanSchedule,
  getPeriodicRate,
  getPeriodsPerYear,
  isoDay,
  resolveEffectiveLoanTerms,
} from '@/lib/loan-schedule';
import {
  amortizationMethodFor,
  annualizationFor,
  mortgageTypeOf,
} from '@/lib/mortgage-type';
import {
  methodScheduleTerms,
  nextScheduledPaymentDate,
  type MissingMethodTerm,
} from '@/lib/mortgage-installment';


/**
 * Historical loan-payment derivation shared by the loan reports and the loan
 * detail page.
 *
 * Payments to the loan appear as positive transactions on the loan account.
 * The interest portion of a regular installment is recovered, in order of
 * preference:
 *   1. an overpayment recognized by the loan's overpayment category or its
 *      overpayment memo text is 100% principal, so its interest is 0 and the
 *      row is flagged OVERPAYMENT;
 *   2. otherwise, if the linked source-account transaction carries an interest
 *      split (the shape ScheduledTransactionLoanService builds), that recorded
 *      interest is used -- exact even on variable-rate loans;
 *   3. otherwise the payment recorded no interest, so it is 100% principal and
 *      its interest is a known **zero** -- never an estimate derived from the
 *      balance and the account's rate. Historical rows report the ledger: a
 *      figure the borrower never paid inflates "Interest Paid", every cumulative
 *      total built on it, the CSV/PDF exports, and the installment the forward
 *      projection is seeded with (issue #1255).
 *
 * The balance walk is unchanged -- it always tracks the actual ledger amount,
 * so the projected balance still ends at the account's current balance.
 *
 * Zero here is a *measured* zero, which is why it is a number and not null: the
 * ledger was read and it recorded no interest. A ledger that could not be read
 * is a different state, and `fetchLoanInterestTransactions` rejects rather than
 * returning an empty list so its callers can tell the two apart.
 */

export type LoanPaymentType = 'REGULAR' | 'OVERPAYMENT';

export interface LoanPaymentEvent {
  /** ISO transaction date (yyyy-MM-dd) */
  date: string;
  principal: number;
  interest: number;
  /** Balance remaining after this payment */
  balance: number;
  cumulativePrincipal: number;
  cumulativeInterest: number;
  /** REGULAR installment or a standalone OVERPAYMENT (extra principal) */
  type: LoanPaymentType;
  /**
   * The annual interest rate (percentage) for this installment. When the loan
   * has a recorded rate history it is the exact rate in effect on this row's
   * date (the clean, discrete history); with no rate history it is
   * reconstructed from the interest charged (`interest / balanceBefore x
   * periodsPerYear`), and where the row charged no interest a *fixed*-rate
   * loan still shows its configured rate -- the rate is a known fact about the
   * loan whether or not this payment settled any interest. Null for
   * overpayments, and for a variable-rate loan whose history says nothing.
   * Always populated by `deriveLoanPaymentHistory`; optional only so test
   * fixtures that build events by hand need not supply it.
   */
  annualRate?: number | null;
}

export interface LoanHistoryResult {
  events: LoanPaymentEvent[];
  /** Opening balance, or currentBalance + principal paid when unset */
  startingBalance: number;
  currentBalance: number;
  cumulativePrincipal: number;
  cumulativeInterest: number;
}

export function deriveLoanPaymentHistory(
  account: Account,
  transactions: Transaction[],
  rateChanges: RateTimelineRow[] = [],
  // Interest booked as separate categorized expenses (not a split leg) on the
  // payment's source account. When supplied, each payment's interest is the
  // actual expense paired to its date -- exact, matching the lender -- and
  // overpayments show the interest charged alongside them. Excludes transfers
  // (a principal transfer that happens to share the interest category is not
  // interest). Falls back to a recorded split, then to zero, when none is
  // paired.
  interestTransactions: Transaction[] = [],
): LoanHistoryResult {
  const loanAccountId = account.id;

  const sortedTransactions = [...transactions].sort(
    (a, b) => new Date(a.transactionDate).getTime() - new Date(b.transactionDate).getTime(),
  );

  // On a debt account the balance is stored negative. Repayments post as
  // positive amounts (raising the balance toward zero); draws post as negative
  // amounts (driving it further into debt). Summing only the repayments would
  // count every payoff across the account's life while dropping the offsetting
  // draws -- which is exactly what inflates a revolving line of credit whose
  // real balance cycled near zero.
  const openingSigned = Number(account.openingBalance) || 0;
  const currentBalance = Math.abs(Number(account.currentBalance) || 0);
  const repayments = sortedTransactions.filter((t) => Number(t.amount) > 0);
  const hasDraws = sortedTransactions.some((t) => Number(t.amount) < 0);
  const totalPrincipalPaid = repayments.reduce((sum, t) => sum + Math.abs(Number(t.amount)), 0);

  // Anchor to the real opening balance whenever we have one, or the account is
  // revolving (has draws). Only reconstruct the original principal by summing
  // repayments for an amortizing loan imported without an opening balance and
  // with no draws -- the one case where the true opening is genuinely unknown.
  const useReconstruction = openingSigned === 0 && !hasDraws;
  const startingBalance = useReconstruction
    ? currentBalance + totalPrincipalPaid
    : debtMagnitude(openingSigned);

  let cumulativePrincipal = 0;
  let cumulativeInterest = 0;

  // Separately-booked interest is already scoped to this loan by its configured
  // interest category and source account (see fetchLoanInterestTransactions), so
  // include all of it regardless of date. A loan account legitimately has
  // activity before its configured start date -- an interest-only grace period,
  // or history migrated from another tool -- and those payments must still show
  // and count in the schedule and every figure derived from it, rather than
  // being truncated at a start date that is often set later than the real first
  // payment. The only bound kept is the upper one for a fully paid-off loan, so
  // interest later booked in the same category (e.g. a subsequent loan) is not
  // absorbed after this one is gone; an active loan still accrues to today.
  const lastTransactionDate =
    sortedTransactions.length > 0
      ? sortedTransactions[sortedTransactions.length - 1].transactionDate.split('T')[0]
      : null;
  const loanPaidOff = currentBalance <= 0.01;
  const scopedInterestTransactions = interestTransactions.filter((tx) => {
    if (!loanPaidOff || !lastTransactionDate) return true;
    return tx.transactionDate.split('T')[0] <= lastTransactionDate;
  });

  // A source-account payment covering multiple loan transfers (e.g. regular +
  // extra principal) carries one interest split; count it once.
  const processedParentIds = new Set<string>();
  // Actual interest expenses paired to each payment date. Each date's interest
  // is consumed once, so two rows on the same date can't double-count it.
  // Expenses with no payment in range (interest-only periods) become their own
  // rows below.
  const { byDate: separateInterestByDate, orphans: orphanInterest } =
    pairSeparateInterestByDate(
      scopedInterestTransactions,
      repayments.map((t) => t.transactionDate.split('T')[0]),
    );
  const usedInterestDates = new Set<string>();
  const events: LoanPaymentEvent[] = [];

  // Day count for the very first row's rate, where there is no prior payment to
  // measure the accrual period against; later rows use the actual gap.
  const periodsPerYear = account.paymentFrequency
    ? getPeriodsPerYear(account.paymentFrequency as ScheduleFrequency)
    : 12;

  if (useReconstruction) {
    // Legacy path: monotonic amortizing loan, balance decreasing from the
    // reconstructed principal by each repayment.
    let runningBalance = startingBalance;
    for (const transaction of repayments) {
      const principal = Math.abs(Number(transaction.amount));
      const { interest, type } = classifyPayment(
        transaction,
        account,
        loanAccountId,
        processedParentIds,
        separateInterestByDate,
        usedInterestDates,
      );
      runningBalance = Math.max(0, runningBalance - principal);
      cumulativePrincipal += principal;
      cumulativeInterest += interest;
      events.push({
        date: transaction.transactionDate,
        principal,
        interest,
        balance: runningBalance,
        cumulativePrincipal,
        cumulativeInterest,
        type,
      });
    }
  } else {
    // Ledger path: track the true signed running balance so draws and
    // repayments both count. Emit an event per repayment with the debt
    // magnitude at that point.
    let runningSigned = openingSigned;
    for (const transaction of sortedTransactions) {
      runningSigned += Number(transaction.amount);
      if (Number(transaction.amount) <= 0) continue; // draws move the balance, no row
      const principal = Math.abs(Number(transaction.amount));
      const { interest, type } = classifyPayment(
        transaction,
        account,
        loanAccountId,
        processedParentIds,
        separateInterestByDate,
        usedInterestDates,
      );
      cumulativePrincipal += principal;
      cumulativeInterest += interest;
      events.push({
        date: transaction.transactionDate,
        principal,
        interest,
        balance: debtMagnitude(runningSigned),
        cumulativePrincipal,
        cumulativeInterest,
        type,
      });
    }
  }

  if (orphanInterest.length === 0) {
    assignObservedRates(events, periodsPerYear, rateChanges, account);
    return {
      events,
      startingBalance,
      currentBalance,
      cumulativePrincipal,
      cumulativeInterest,
    };
  }

  // Merge interest-only rows for interest expenses with no matching principal
  // payment (an interest-only grace period before repayment begins). They carry
  // no principal, so they never move the balance; interleave them by date and
  // re-walk the cumulative totals and the balance shown on each row.
  const orphanEvents: LoanPaymentEvent[] = orphanInterest.map((tx) => ({
    date: tx.transactionDate,
    principal: 0,
    interest: Math.round(Math.abs(Number(tx.amount)) * 100) / 100,
    balance: 0,
    cumulativePrincipal: 0,
    cumulativeInterest: 0,
    type: 'REGULAR' as const,
  }));
  const merged = [...events, ...orphanEvents].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );
  let runningPrincipal = 0;
  let runningInterest = 0;
  let lastBalance = startingBalance;
  for (const event of merged) {
    runningPrincipal += event.principal;
    runningInterest += event.interest;
    event.cumulativePrincipal = runningPrincipal;
    event.cumulativeInterest = runningInterest;
    if (event.principal > 0) {
      // A principal payment already carries its post-payment balance.
      lastBalance = event.balance;
    } else {
      // Interest-only row: the debt is whatever it was at that point.
      event.balance = lastBalance;
    }
  }
  assignObservedRates(merged, periodsPerYear, rateChanges, account);

  return {
    events: merged,
    startingBalance,
    currentBalance,
    cumulativePrincipal: runningPrincipal,
    cumulativeInterest: runningInterest,
  };
}

/**
 * How many payments the borrower has actually made -- the count every surface
 * that says "Payments Made" reports.
 *
 * It is the length of the derived event list and nothing else. The reports draw
 * their curves from series that have been aggregated by month and then reduced
 * to fit a chart axis, and counting either of those answers a question about
 * pixels: the Debt Payoff Timeline counted retained chart samples, so a loan
 * with three hundred payments reported about sixty (issue #1244). Monthly
 * aggregation is wrong for the same reason one step earlier -- weekly and
 * biweekly loans, extra principal payments, and two payments in one month all
 * collapse into a single bucket.
 *
 * One line, exported, because it is the figure two reports must agree on: the
 * Loan Amortization report lists one row per event and counts those rows, and a
 * user opening both reports on the same loan is comparing two answers to one
 * question.
 */
export function historicalPaymentCount(history: LoanHistoryResult): number {
  return history.events.length;
}

/**
 * Debt owed for a signed account balance. Debt accounts store the balance
 * negative, so the outstanding amount is `-balance`, floored at zero so an
 * overpaid balance (in credit) reads as paid off rather than as fresh debt.
 */
function debtMagnitude(signedBalance: number): number {
  return Math.max(0, -signedBalance);
}

/** The last regular installment actually observed, and whether it is complete. */
export interface ObservedInstallment {
  amount: number;
  /** The date (YYYY-MM-DD) of the regular installment this figure comes from. */
  date: string;
  /**
   * True when the row's interest is KNOWN -- either recorded (a split, or a
   * paired separate expense) or known to be zero because the rate in effect on
   * that date was 0%. False for `principal + 0` at an unknown or non-zero rate,
   * which is an incomplete installment rather than a smaller one -- see
   * `resolveSeedPayment`.
   */
  complete: boolean;
}

/**
 * The most recent REGULAR installment in the history, `principal + interest`,
 * and whether the ledger recorded that interest. Overpayments are skipped: an
 * ad-hoc extra payment is not the installment. Null when there is no usable
 * regular row yet (an interest-only grace period, or no history at all), which
 * is what sends `resolveSeedPayment` to the stored contractual payment.
 *
 * The only derivation of this figure. It replaced an exported
 * `deriveCurrentInstallment`/`resolveCurrentInstallment` pair that had no
 * production caller left but still carried the pre-change semantics -- a live
 * trap, since calling either bypassed the rate-timeline resolution every
 * surface now shares.
 */
export function observedInstallment(
  history: LoanHistoryResult,
): ObservedInstallment | null {
  const lastRegular = [...history.events]
    .reverse()
    .find((event) => event.type === 'REGULAR');
  if (!lastRegular) return null;
  const amount =
    Math.round((lastRegular.principal + lastRegular.interest) * 100) / 100;
  if (amount <= 0) return null;
  // Recorded interest, or a rate of exactly 0% -- at which the interest for the
  // row is known, and known to be zero, so `principal + 0` IS the whole
  // installment. Strict `=== 0`: null/undefined is "the rate on this date is
  // unknown", which is the incomplete case. Without this an interest-free loan
  // with no stored `paymentAmount` had its real, fully-stated installment
  // discarded and its payoff refused, though the ledger states both terms
  // exactly -- "`null` is not the safe answer either", from the other side.
  return {
    amount,
    date: lastRegular.date.split('T')[0],
    complete: lastRegular.interest > 0 || lastRegular.annualRate === 0,
  };
}

/** The loan's rate and payment in effect: one answer for every surface. */
export interface CurrentLoanTerms {
  /** Null only when the account has no rate at all. */
  annualRate: number | null;
  payment: number | null;
  /**
   * The due date `payment` is the installment of, for a LINEAR or
   * INTEREST_ONLY mortgage: those methods have no constant payment, so their
   * installment is a dated answer -- the first projected row, which is the
   * next bill when the server anchors the projection on it -- and a surface
   * that shows it says which date it is for (docs/specs/mortgage-types.md,
   * section 5.6). Null for an annuity, whose payment is the same every period,
   * and whenever `payment` is null.
   */
  paymentDate: string | null;
  /**
   * The final payment of an INTEREST_ONLY mortgage -- the whole debt plus its
   * period's interest, on the term end -- which every surface showing the
   * installment shows beside it, because an interest-only installment without
   * its bullet understates what is owed by the whole principal. Null for
   * every other method, and when the projection does not reach the term end.
   */
  finalPayment: { amount: number; date: string } | null;
}

/**
 * The terms to DISPLAY, which are the terms the projection runs at.
 *
 * Every "current" figure on a loan surface comes from here: the summary card's
 * Interest Rate and Payment, the PDF export's, the transactions sidebar's, and
 * the payoff/remaining-interest projection. They used to be resolved
 * separately, so a loan whose rate had been recorded through the rate-history
 * UI showed "Interest Rate 5%" and "Payment $1,500" beside "Est. Payoff N/A" --
 * the projection correctly refusing at the real 12% and $900 while the cards
 * described terms under which the loan would amortize comfortably. A user
 * troubleshooting the missing payoff was reading numbers that disagreed with the
 * calculation refusing it.
 *
 * The rate is null only for an account with none recorded anywhere; a loan with
 * no rate history simply falls back to the account's own scalar.
 */
export function resolveCurrentLoanTerms(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[] = [],
  anchor?: LoanProjectionAnchor | null,
  // The calendar day every date decision below is made against -- see
  // `buildLoanProjectionInput`.
  todayYmd: string = financialTodayYmd(undefined),
): CurrentLoanTerms {
  if (amortizationMethodFor(mortgageTypeOf(account)) !== 'ANNUITY') {
    return resolveMethodLoanTerms(account, history, rateChanges, anchor, todayYmd);
  }
  const seed = resolveSeedPayment(
    account,
    history,
    rateChanges,
    usableProjectionAnchor(anchor, todayYmd),
    todayYmd,
  );
  return {
    annualRate: seed.annualRate,
    payment: seed.payment != null && seed.payment > 0 ? seed.payment : null,
    paymentDate: null,
    finalPayment: null,
  };
}

/**
 * `resolveCurrentLoanTerms` for a LINEAR or INTEREST_ONLY mortgage. None of
 * the annuity's candidates applies: `account.paymentAmount` is null for these
 * methods (spec decision 11), and a stated or observed installment is a past
 * one, not the next. The current installment is the projection's first row,
 * priced by the method from the same input the payoff is projected from, and
 * it travels with its date; INTEREST_ONLY adds the bullet, the projection's
 * last row. Without a projection there is no installment to show.
 */
function resolveMethodLoanTerms(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[],
  anchor: LoanProjectionAnchor | null | undefined,
  todayYmd: string,
): CurrentLoanTerms {
  // The rate is resolved as it is for an annuity, so a mortgage that cannot
  // be projected (paid off, or a term missing) still shows the rate it has.
  const { annualRate } = resolveSeedPayment(
    account,
    history,
    rateChanges,
    usableProjectionAnchor(anchor, todayYmd),
    todayYmd,
  );
  const { input } = evaluateLoanProjection(
    account,
    history,
    rateChanges,
    anchor,
    todayYmd,
  );
  const schedule = input ? generateLoanSchedule(input) : null;
  const first = schedule?.rows[0] ?? null;
  const last =
    schedule?.paidOff && schedule.rows.length > 0
      ? schedule.rows[schedule.rows.length - 1]
      : null;
  return {
    annualRate,
    payment: first ? first.payment : null,
    paymentDate: first ? first.date : null,
    finalPayment:
      last && amortizationMethodFor(mortgageTypeOf(account)) === 'INTEREST_ONLY'
        ? { amount: last.payment, date: last.date }
        : null,
  };
}

/**
 * A server anchor is usable only when it states both halves: the installment
 * date and the debt through it. A loan with no active scheduled payment gets
 * `{null, null}` from the API, and the projection then keeps its today-anchored
 * fallback -- there is no bill for it to be in parity with.
 */
type UsableProjectionAnchor = { nextDueDate: string; debt: number };

function usableProjectionAnchor(
  anchor: LoanProjectionAnchor | null | undefined,
  todayYmd: string,
): UsableProjectionAnchor | null {
  if (!anchor || anchor.nextDueDate == null || anchor.debt == null) return null;
  // An OVERDUE anchor is refused, and the projection falls back to today.
  //
  // The anchor's debt is measured through the installment's own date. That is
  // exactly right while the date is ahead of us, and wrong the moment it is
  // behind: everything the ledger did *after* that date -- a repayment, a
  // draw, a rate change -- is real, is already on screen in the history, and
  // is invisible to a projection seeded from the older balance. The generated
  // rows would also be dated before history rows they are appended after, so
  // the schedule reads out of order.
  //
  // Reconciling an overdue schedule properly means replaying each missed
  // occurrence against the events that followed it, which is a product
  // decision about what an overdue bill even means -- not something to infer
  // here. Until then the honest answer is the one that predates the anchor:
  // project from where the borrower stands today. The first row then no longer
  // matches the overdue bill, which is a visible imprecision rather than a
  // confidently wrong balance path.
  //
  // "Behind us" is a question about the USER's calendar, so it is asked against
  // `todayYmd` -- the day `financialTodayYmd` resolves in their timezone, which
  // is the day the backend's `todayYMD()` resolves for the same request. Asked
  // against `new Date().toISOString()` it was a third calendar belonging to
  // neither: for the first two hours after midnight in Warsaw (fourteen at
  // UTC+14) UTC still reads yesterday, so an installment the bill considers
  // overdue was accepted and the projection went back to the stale balance path
  // this refusal exists to prevent -- and west of Greenwich the mirror image,
  // an installment due today rejected all evening because UTC had already
  // rolled over.
  if (anchor.nextDueDate < todayYmd) return null;
  return { nextDueDate: anchor.nextDueDate, debt: anchor.debt };
}

/** The resolved projection seed: the terms in effect plus the payment to use. */
interface SeedPayment {
  payment: number | null;
  /** Null when the loan has no rate recorded anywhere -- see resolveCurrentLoanTerms. */
  annualRate: number | null;
  /** The rate row 1 of the schedule will actually run at -- see below. */
  firstRowAnnualRate: number;
  firstPaymentDate: Date;
}

/**
 * Resolve the terms to project at, and the payment to project with.
 *
 * The rate and the payment come from ONE effective state -- the rate history's,
 * via `resolveEffectiveLoanTerms`. Recording a rate change deliberately never
 * writes `account.interestRate` / `account.paymentAmount` (they stay user-owned,
 * settable only from the account edit form), so after any change entered through
 * the rate-history UI the scalars hold the OLD terms. Taking the payment from
 * one source and the rate from the other prices a payoff at a rate nobody pays:
 * at a stale 5% against a real 12%, a payment $100 short of the interest looks
 * comfortably amortizing.
 *
 * The payment comes from the most authoritative source that states one, and only
 * the unranked candidates are tested against the first period's interest:
 *
 *   1. a payment stated by an applicable `manual` or `inferred` rate-change row
 *      -- the recorded answer to "what is being paid now", so one that no longer
 *      covers the interest is a fact about the loan (a rate rise the installment
 *      has not caught up with) and the schedule must be allowed to refuse rather
 *      than be handed a different number. It yields to rank 2 only when a
 *      complete installment was actually paid AFTER the row stating it: that
 *      later payment is the newer statement (see `observedIsNewer` below);
 *   2. otherwise a COMPLETE observed installment -- `principal + interest` of the
 *      last regular payment, where that interest is known -- also unconditionally,
 *      for the same reason: it is a complete statement of what is being paid;
 *   3. otherwise the `initial` row's snapshot payment, then the stored
 *      contractual `paymentAmount`, first one that covers a period's interest.
 *
 * An INCOMPLETE observation is not a candidate at any rank. `principal + 0` for
 * a loan booking interest outside the app is a PART of the installment, not a
 * smaller one, and it clears the amortization guard easily -- a principal-only
 * figure usually does exceed one period's interest (issue #1255's own example:
 * 285 of principal against 91.67 of interest, against a contractual 1,200). So
 * ranking it ahead of the contractual figure made that documented fallback fire
 * only when the principal-only number happened to be the smaller one.
 *
 * An `initial` row's payment is not rank 1: it is a real observed installment
 * when detection wrote it and a verbatim copy of `account.paymentAmount` when
 * the first-rate-change hook did, and nothing on the row distinguishes them.
 * Seeding it unconditionally pinned the projection to a snapshot of the very
 * field the user would edit to fix it; discarding it threw away a real
 * observation. It joins rank 3 instead, ahead of the scalar and tested like it.
 *
 * The contractual figure is last because it is often stale, but it is a real
 * stored fact and it is the only complete payment a loan booking its interest
 * outside the app has left. When nothing complete resolves the payment is null:
 * the payoff and remaining interest read as unknown rather than as a figure
 * built on a fraction of the real installment, which is what the estimate in
 * issue #1255 was quietly supplying.
 */
function resolveSeedPayment(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[],
  // Already normalized by the caller: "which balance does the projection
  // price" is one decision, and spelling it here as well as in
  // buildLoanProjectionInput is how the seed and the figure on screen drift
  // apart (issue #1255's shape).
  usableAnchor: UsableProjectionAnchor | null,
  // The user's calendar day, resolved once by the caller for the same reason
  // the anchor is: two spellings of "today" in one resolution is how the rate
  // in effect and the row it prices come apart.
  today: string,
): SeedPayment {
  const frequency = (account.paymentFrequency as ScheduleFrequency) || 'MONTHLY';
  const mortgageType = mortgageTypeOf(account);
  // `Number(null)` is 0, and 0 is a rate. Pass the absence through so a loan
  // with no rate anywhere reads as "Not set" rather than as a measured 0%.
  const effective = resolveEffectiveLoanTerms(
    rateChanges,
    today,
    account.interestRate != null ? Number(account.interestRate) : null,
  );

  // The amortization guard has to test the rate the schedule will actually use
  // for its first row, which is not always today's: `firstPaymentDate` is one
  // full period ahead, and `generateLoanSchedule` applies every step dated on or
  // before a row's date to that row. A step recorded for next week therefore
  // lands on row 1. Testing today's rate instead passes a candidate the very
  // next line then refuses -- the "a preview computes what the commit will do,
  // through the same code" rule, applied to the guard.
  // The `?? 0` covers two different states on purpose, and neither is the
  // "0% when unknown" conflation this module bans elsewhere. A genuine 0% loan
  // has no period interest, so 0 is the right figure. An UNKNOWN rate also
  // yields 0, which reduces the guard to "is the candidate positive" -- and that
  // is the honest degenerate case: with no rate there is nothing to test a
  // payment against, and `buildLoanProjectionInput` refuses the projection
  // outright a few lines later on `seed.annualRate == null`. The rate itself
  // stays `number | null` (`effective.annualRate`); only this guard's input is
  // flattened.
  // With a server anchor the first projected row IS the next scheduled bill:
  // its date is the schedule's due date, and its interest accrues on the debt
  // the ledger holds through that date -- the same balance boundary the bill's
  // own recalculation uses, so the report's first row and the bill cannot
  // disagree (issue #1253). Without one (no active scheduled payment), the
  // projection keeps its today-anchored fallback.
  // One spelling of row 1's date. `parseLocalDate` is the module family's
  // helper for a YYYY-MM-DD (a bare `new Date(ymd)` reads as UTC and shifts
  // the day west of it), and the YMD is derived once so the rate lookup and
  // the Date cannot disagree.
  // Unanchored, row 1 is one period past the user's own today -- `today` rather
  // than `new Date()` so the day the fallback steps from is the same day the
  // anchor was judged against, and `isoDay` rather than `toISOString` to read it
  // back, because `generateLoanSchedule` dates every row it produces with
  // `isoDay` (LOCAL components). Formatting this one Date with UTC components
  // named a different day than the schedule then used it for, so west of
  // Greenwich the rate looked up for row 1 was the rate of the day before the
  // row.
  const firstPaymentDate = usableAnchor
    ? parseLocalDate(usableAnchor.nextDueDate)
    : advanceDate(parseLocalDate(today), frequency);
  const firstRowYMD = usableAnchor?.nextDueDate ?? isoDay(firstPaymentDate);
  const firstRowAnnualRate =
    resolveEffectiveLoanTerms(rateChanges, firstRowYMD, effective.annualRate)
      .annualRate ?? 0;

  const observed = observedInstallment(history);
  const contractual = account.paymentAmount ?? 0;
  const periodInterest = firstPeriodInterest(
    usableAnchor ? usableAnchor.debt : history.currentBalance,
    firstRowAnnualRate,
    frequency,
    mortgageType,
  );
  const amortizes = (payment: number) => payment > 0 && payment > periodInterest;

  // Whether the observed installment is COMPLETE decides whether the contractual
  // figure may stand in for it, and the two cases look identical from the number
  // alone.
  //
  // A row whose interest the ledger recorded is a complete statement of what was
  // paid, so it is the payment -- even when it no longer covers the interest.
  // That is a real financial state (a rate rise the installment has not caught up
  // with), and the schedule refusing it is the honest answer; substituting the
  // contractual figure would report a payoff from a payment nobody makes, which
  // is the defect the previous round fixed at rank 1.
  //
  // A row whose interest was never recorded contributes `principal + 0` -- $450
  // of a $950 installment for a loan booking interest outside the app. That is
  // not a lower payment, it is an incomplete one, and the contractual figure is
  // the only complete payment fact such a loan has. This is the only case the
  // fallback is for.
  // A payment stated in a rate-change row is authoritative -- UNLESS a complete
  // installment was actually paid AFTER the row that stated it. A stated payment
  // is a snapshot of the contractual installment on that day; a real payment
  // made later is a newer statement of what is owed. This matters most for a
  // loan whose lender re-amortizes after each overpayment (a lower installment):
  // one stated 1,200.99 in 2022 kept reading as "the installment" on every
  // surface while the bank had long since dropped it to ~860 -- and the projection,
  // seeded from the stale figure, described payments nobody was making. The
  // reverse ordering is still protected: a row recorded AFTER the last payment
  // (a rate rise with a new contractual installment not yet paid) keeps
  // precedence over the older observation. Strict `>` -- on a tie the recorded
  // statement wins.
  const observedIsNewer =
    observed?.complete === true &&
    effective.paymentEffectiveDate != null &&
    observed.date > effective.paymentEffectiveDate;
  let payment: number | null;
  if (effective.paymentAmount != null && !observedIsNewer) {
    payment = effective.paymentAmount;
  } else if (observed?.complete) {
    payment = observed.amount;
  } else {
    // The incomplete observation is deliberately NOT a candidate. It is a PART
    // of the installment -- `principal + 0` for a loan booking interest outside
    // the app -- so using it as the whole payment understates the installment and
    // overstates the payoff, and it slips through the amortization guard easily
    // because a principal-only figure usually does exceed one period's interest
    // (issue #1255's own example: 285 of principal against 91.67 of interest,
    // seeded as 285 when the contractual installment is 1,200). Listing it first
    // made the documented contractual fallback fire only for the narrow case
    // where the principal-only number happened to be smaller than the interest.
    //
    // The `initial` row's payment does belong here: detection writes a real
    // observed installment under that source and the first-rate-change hook
    // writes a stale copy of `account.paymentAmount`, with nothing on the row to
    // tell them apart. Tested like the contractual figure, both readings come out
    // right -- an observation that amortizes is used, a stale copy that no longer
    // covers the interest falls through to the corrected scalar.
    const candidates = [effective.snapshotPaymentAmount, contractual].filter(
      (value): value is number => value != null && value > 0,
    );
    // No complete figure anywhere: the installment is unknown, so there is no
    // projection and no Current Payment. Better than a payoff computed from a
    // fraction of the real payment.
    payment = candidates.find(amortizes) ?? candidates[0] ?? null;
  }

  return {
    payment,
    annualRate: effective.annualRate,
    firstRowAnnualRate,
    firstPaymentDate,
  };
}

/**
 * The forward-projection input shared by the loan detail view and the loan
 * reports: a schedule that continues from today's balance at the loan's terms in
 * effect. Returns null when the account cannot be projected (no remaining
 * balance, rate, payment, or frequency), or when nothing usable resolves as the
 * payment.
 *
 * Both the rate and the payment come from `resolveSeedPayment`, which is also
 * what "Current Payment" displays -- see its doc for the authority ordering and
 * why the two must not be resolved twice. Future-dated rate steps bend the
 * projection ahead; passing no `rateChanges` simply omits them.
 */
export function buildLoanProjectionInput(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[] = [],
  // Server anchor for a loan with a scheduled payment (issue #1253): the next
  // installment's due date and the ledger debt through it. Anchored, the first
  // projected row prices the same balance the next bill's interest is
  // calculated from -- today's `history.currentBalance` excludes future-dated
  // principal the bill's own recalculation includes, so the two disagreed for
  // exactly the payments posted ahead of their date.
  anchor?: LoanProjectionAnchor | null,
  // The calendar day this projection is made on, in the USER's timezone --
  // `useFinancialToday()` on a React surface, or `financialTodayYmd(pref)`
  // outside one. Every date decision here reads it and nothing reads the clock
  // twice: whether the anchor is overdue, which rate is in effect, and where an
  // unanchored row 1 falls are one day's worth of answers.
  //
  // The default is the browser's zone, which is what the backend falls back to
  // as well (the axios interceptor sends it as `X-Client-Timezone`), so an
  // omitted argument is correct for every user who has not overridden the
  // preference and never UTC for anyone. It is still an argument a surface is
  // expected to pass -- `loan-projection-today.guard.test.ts` fails a call site
  // that does not.
  todayYmd: string = financialTodayYmd(undefined),
): LoanScheduleInput | null {
  return evaluateLoanProjection(account, history, rateChanges, anchor, todayYmd)
    .input;
}

/**
 * Why the forward projection cannot be built, or `null` when it can. Each value
 * is a SEPARATE, separately-fixable cause, so the surface can tell the user
 * which one applies instead of hiding the panel with no explanation:
 *
 * - `paid-off` -- nothing outstanding to amortize (balance <= 0.01).
 * - `no-frequency` -- the account has no payment frequency set.
 * - `no-rate` -- no rate recorded anywhere (neither `account.interestRate` nor
 *   an applicable rate-change row). A per-row rate reconstructed from the
 *   interest charged still shows in the schedule table, so the table can carry
 *   a rate while the projection cannot -- see `assignObservedRates`.
 * - `no-payment` -- no complete installment resolves: there is no complete
 *   observed regular payment (a loan whose regular installments are booked as
 *   categorized expenses on the source account, never as transfers to the loan
 *   account, has no regular row here at all) AND no stored contractual payment.
 */
export type LoanProjectionUnavailableReason =
  | 'paid-off'
  | 'no-frequency'
  | 'no-rate'
  | 'no-payment'
  | 'no-amortization'
  | 'no-payment-start'
  | 'no-principal';

/**
 * The reason a LINEAR or INTEREST_ONLY mortgage cannot be projected, for each
 * term its method needs (docs/specs/mortgage-types.md, section 8): there is no
 * `N` without the amortization period, no calendar (so no term end and no
 * bullet) without the first payment date, and no constant principal without
 * the amount borrowed. An unknown cadence is the `no-frequency` every loan
 * already reports.
 *
 * - `no-amortization` -- the mortgage has no amortization period.
 * - `no-payment-start` -- the mortgage has no first payment date.
 * - `no-principal` -- a LINEAR mortgage that shortens its term has neither an
 *   original principal nor an opening balance to divide.
 */
const MISSING_TERM_REASON: Record<MissingMethodTerm, LoanProjectionUnavailableReason> = {
  amortizationMonths: 'no-amortization',
  paymentStartDate: 'no-payment-start',
  paymentFrequency: 'no-frequency',
  originalPrincipal: 'no-principal',
};

/**
 * The reason `buildLoanProjectionInput` cannot produce a schedule, or `null`
 * when it can. Shares ONE evaluation with `buildLoanProjectionInput`
 * (`evaluateLoanProjection`), so the two can never disagree about whether a
 * projection exists -- a surface renders the simulator when this is `null` and
 * this explanation when it is not, rather than silently drawing nothing.
 */
export function diagnoseLoanProjection(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[] = [],
  anchor?: LoanProjectionAnchor | null,
  todayYmd: string = financialTodayYmd(undefined),
): LoanProjectionUnavailableReason | null {
  return evaluateLoanProjection(account, history, rateChanges, anchor, todayYmd)
    .reason;
}

interface LoanProjectionEvaluation {
  input: LoanScheduleInput | null;
  reason: LoanProjectionUnavailableReason | null;
}

/**
 * The projection gate, evaluated once: either the schedule input, or the reason
 * it cannot be built. `input` and `reason` are mutually exclusive -- exactly one
 * is non-null -- so the "can we project" decision lives in a single place and
 * `buildLoanProjectionInput` / `diagnoseLoanProjection` cannot drift apart.
 */
function evaluateLoanProjection(
  account: Account,
  history: LoanHistoryResult,
  rateChanges: RateTimelineRow[],
  anchor: LoanProjectionAnchor | null | undefined,
  todayYmd: string,
): LoanProjectionEvaluation {
  const usableAnchor = usableProjectionAnchor(anchor, todayYmd);
  // Gated on the RESOLVED terms, not on the account's scalars. Gating on the
  // scalars asked the wrong question: this function goes on to resolve both the
  // rate and the payment from the rate history precisely because the scalars can
  // be stale or absent relative to it -- so a loan configured only through the
  // rate-history UI (`interestRate` null, or a payment that lives only in a
  // rate-change row) was refused outright while the summary cards, now reading
  // the same resolution, displayed its real 6% and $1,200 beside "Est. Payoff
  // N/A". That is the disagreement this work exists to remove, with the halves
  // swapped.
  const startingDebt = usableAnchor ? usableAnchor.debt : history.currentBalance;
  // BOTH must show debt. The anchor is measured through the schedule's next
  // due date, and nothing floors that date at today -- an overdue schedule
  // (auto-post off, never posted) anchors on a past date, so a loan the user
  // has since cleared with a lump sum would project a full amortization from
  // the pre-payoff balance and print an Est. Payoff years away. Today's
  // balance is what says the loan is finished, and it kept saying so before
  // the anchor existed.
  if (startingDebt <= 0.01 || history.currentBalance <= 0.01) {
    return { input: null, reason: 'paid-off' };
  }
  if (!account.paymentFrequency) {
    return { input: null, reason: 'no-frequency' };
  }

  const seed = resolveSeedPayment(
    account,
    history,
    rateChanges,
    usableAnchor,
    todayYmd,
  );
  // A missing rate and a missing payment are different causes with different
  // fixes, so they are reported apart rather than folded into one `null`. The
  // combined null condition is unchanged from the single guard this replaced.
  if (seed.annualRate == null) {
    return { input: null, reason: 'no-rate' };
  }

  // Only the future-dated steps are taken from here; the current terms are the
  // seed's. `buildRateTimeline`'s own "starting" fields are deliberately unused
  // -- see resolveEffectiveLoanTerms.
  const futureTimeline = buildRateTimeline(rateChanges, todayYmd, seed.annualRate);
  const mortgageType = mortgageTypeOf(account);
  const frequency = account.paymentFrequency as ScheduleFrequency;

  // A LINEAR or INTEREST_ONLY mortgage has no constant payment to seed: every
  // row derives its own installment from the method's terms (spec section
  // 5.4), which come from the account's amortization and first payment date,
  // so the payments left to the term end are counted from row 1's own date.
  // A missing term withholds the projection, naming it (section 8).
  //
  // Unanchored, row 1 is the mortgage's next due date on its own calendar
  // rather than one period past today, so the rows -- and the bullet -- fall
  // on the dates it is paid on; past the term end there is no next one and
  // the fallback stands (the whole debt is then due).
  const methodFirstPaymentDate =
    amortizationMethodFor(mortgageType) !== 'ANNUITY' && !usableAnchor
      ? nextScheduledPaymentDate(account, todayYmd)
      : null;
  const firstPaymentDate = methodFirstPaymentDate
    ? parseLocalDate(methodFirstPaymentDate)
    : seed.firstPaymentDate;
  const method = methodScheduleTerms(mortgageType, account, isoDay(firstPaymentDate));
  if (method) {
    if (!method.terms) {
      return {
        input: null,
        reason: MISSING_TERM_REASON[method.missing[0]],
      };
    }
    const input: LoanScheduleInput = {
      startingBalance: startingDebt,
      annualRate: seed.annualRate,
      paymentAmount: 0,
      frequency,
      mortgageType,
      methodTerms: method.terms,
      firstPaymentDate,
      rateChanges: futureTimeline.rateChanges,
    };
    // `paymentAmount` is the first projected installment for these methods
    // (`LoanScheduleInput`), which the engine never reads: it is what the
    // simulator's budget floor and the goal-seek's bound compare against.
    const firstRow = generateLoanSchedule({ ...input, maxPayments: 1 }).rows[0];
    return {
      input: { ...input, paymentAmount: firstRow?.payment ?? 0 },
      reason: null,
    };
  }

  if (seed.payment == null || seed.payment <= 0) {
    return { input: null, reason: 'no-payment' };
  }

  return {
    input: {
      startingBalance: startingDebt,
      annualRate: seed.annualRate,
      paymentAmount: seed.payment,
      frequency,
      mortgageType,
      firstPaymentDate: seed.firstPaymentDate,
      rateChanges: futureTimeline.rateChanges,
    },
    reason: null,
  };
}

/**
 * Classify a positive loan-account transaction into its interest portion and
 * row type. Interest is resolved in order: a recorded interest split of the
 * payment; else the actual separate interest expense paired to this date; else
 * zero -- the payment recorded no interest, so it was all principal. An
 * overpayment (recognized by the loan's overpayment category / memo / payee) is
 * extra principal, but still shows any real interest charged alongside it
 * (paired).
 *
 * Nothing here consults the balance or the rate: a historical row states what
 * the ledger holds. `account` is read for the overpayment markers and for
 * `interestCategoryId`, which is how the recorded interest line is identified --
 * see `readRecordedInterest`.
 */
function classifyPayment(
  transaction: Transaction,
  account: Account,
  loanAccountId: string,
  processedParentIds: Set<string>,
  separateInterestByDate: Map<string, number>,
  usedInterestDates: Set<string>,
): { interest: number; type: LoanPaymentType } {
  const dateKey = transaction.transactionDate.split('T')[0];
  // The actual interest expense paired to this date, consumed once.
  const takeSeparateInterest = (): number | null => {
    if (usedInterestDates.has(dateKey)) return null;
    const amount = separateInterestByDate.get(dateKey);
    if (amount == null || amount <= 0) return null;
    usedInterestDates.add(dateKey);
    return Math.round(amount * 100) / 100;
  };

  if (
    isOverpayment(
      transaction,
      account.overpaymentCategoryId,
      account.overpaymentMemo,
      account.overpaymentPayeeId,
      loanAccountId,
    )
  ) {
    const paired = takeSeparateInterest();
    return { interest: paired ?? 0, type: 'OVERPAYMENT' };
  }
  const recorded = readRecordedInterest(
    transaction,
    loanAccountId,
    account.interestCategoryId,
    processedParentIds,
  );
  // The configured category names the interest line, so nothing outranks it.
  if (recorded.kind === 'exact') {
    return { interest: recorded.amount, type: 'REGULAR' };
  }
  // Otherwise a separate expense booked against this date is the stronger
  // signal: a loan that books interest outside the split records it there, and
  // the split's single line might be escrow.
  const paired = takeSeparateInterest();
  if (paired != null) {
    return { interest: paired, type: 'REGULAR' };
  }
  // No paired expense, so the split's one unambiguous line is the best evidence
  // there is -- and the reason it is used even when it does not carry the
  // configured category: splits recorded before that setting existed, or filed
  // under a since-changed category, still hold the real interest.
  if (recorded.kind === 'fallback') {
    return { interest: recorded.amount, type: 'REGULAR' };
  }
  // Nothing anywhere: the ledger records no interest against this payment, so it
  // moved principal only. That is a measured zero, not an unknown -- the
  // alternative, estimating it from the balance and the account's rate, reported
  // interest the borrower never paid (issue #1255).
  return { interest: 0, type: 'REGULAR' };
}

/**
 * Whether a payment is a standalone overpayment. Recognized by the loan's
 * overpayment category, its overpayment memo text, or its overpayment payee --
 * each usable on its own or together, so any single match is sufficient.
 */
function isOverpayment(
  transaction: Transaction,
  overpaymentCategoryId: string | null | undefined,
  overpaymentMemo: string | null | undefined,
  overpaymentPayeeId: string | null | undefined,
  loanAccountId: string,
): boolean {
  return (
    matchesOverpaymentCategory(transaction, overpaymentCategoryId, loanAccountId) ||
    matchesOverpaymentMemo(transaction, overpaymentMemo, loanAccountId) ||
    matchesOverpaymentPayee(transaction, overpaymentPayeeId)
  );
}

/**
 * Whether the overpayment payee is the payee of the transaction itself or of
 * its linked source-account transaction (the payment is usually recorded with
 * the payee on the source side).
 */
function matchesOverpaymentPayee(
  transaction: Transaction,
  overpaymentPayeeId: string | null | undefined,
): boolean {
  if (!overpaymentPayeeId) return false;
  return (
    transaction.payeeId === overpaymentPayeeId ||
    transaction.linkedTransaction?.payeeId === overpaymentPayeeId
  );
}

/**
 * The parent-transaction split that produced this loan-side transfer. A split
 * source payment posts one loan transfer per transfer-split (e.g. a regular
 * principal transfer alongside an extra-principal one), and every such loan
 * transaction shares the same parent -- so only the single split that links
 * back to *this* transaction actually describes it. Correlated by the split's
 * linkedTransactionId, or, when that is unavailable (older data or imports),
 * by its transfer target and amount. Null when the parent is not a split (a
 * plain transfer) or no split corresponds.
 */
function correspondingParentSplit(
  transaction: Transaction,
  loanAccountId: string,
): TransactionSplit | null {
  const splits = transaction.linkedTransaction?.splits;
  if (!splits || splits.length === 0) return null;
  const byLink = splits.find(
    (s) => s.linkedTransactionId != null && s.linkedTransactionId === transaction.id,
  );
  if (byLink) return byLink;
  const txAmount = Math.abs(Number(transaction.amount));
  return (
    splits.find(
      (s) =>
        s.transferAccountId === loanAccountId &&
        Math.abs(Number(s.amount)) === txAmount,
    ) ?? null
  );
}

/**
 * Whether the overpayment category tags the transaction itself, its linked
 * source-account transaction, or the specific split of that linked transaction
 * that produced this transfer. When several transfers share one split parent,
 * scanning every split would wrongly flag a regular-principal sibling as an
 * overpayment, so only the correlated split is considered; scanning all splits
 * is kept solely as a fallback for data where the split cannot be correlated.
 */
function matchesOverpaymentCategory(
  transaction: Transaction,
  overpaymentCategoryId: string | null | undefined,
  loanAccountId: string,
): boolean {
  if (!overpaymentCategoryId) return false;
  if (transaction.categoryId === overpaymentCategoryId) return true;
  const linkedTx = transaction.linkedTransaction;
  if (!linkedTx) return false;
  if (linkedTx.categoryId === overpaymentCategoryId) return true;
  const own = correspondingParentSplit(transaction, loanAccountId);
  if (own) return own.categoryId === overpaymentCategoryId;
  return Boolean(
    linkedTx.splits?.some((s) => s.categoryId === overpaymentCategoryId),
  );
}

/**
 * Whether the overpayment memo text appears (case-insensitive substring) in the
 * transaction's memo, its linked source-account transaction's memo, or the
 * split that produced this transfer. As with the category match, only the
 * correlated split is inspected so a regular-principal sibling of an
 * overpayment split is not misflagged; all split memos are considered only when
 * the split cannot be correlated. The transaction-level memo is stored as
 * `description`.
 */
function matchesOverpaymentMemo(
  transaction: Transaction,
  overpaymentMemo: string | null | undefined,
  loanAccountId: string,
): boolean {
  const needle = overpaymentMemo?.trim().toLowerCase();
  if (!needle) return false;
  const linkedTx = transaction.linkedTransaction;
  const own = correspondingParentSplit(transaction, loanAccountId);
  const splitMemos = own
    ? [own.memo]
    : (linkedTx?.splits?.map((s) => s.memo) ?? []);
  const haystacks: (string | null | undefined)[] = [
    transaction.description,
    linkedTx?.description,
    ...splitMemos,
  ];
  return haystacks.some(
    (text) => !!text && text.toLowerCase().includes(needle),
  );
}

/**
 * What a parent's splits say about interest. Three answers, because "the
 * configured category names this amount" and "this is the only line it could be"
 * are different strengths of evidence and a separate interest expense sits
 * between them:
 *
 *   - `exact`    -- the loan's configured interest category names this amount;
 *                   nothing outranks it. Also the `0` for a sibling loan
 *                   transfer of a parent already counted, so a source payment
 *                   covering several loan transfers is counted once.
 *   - `fallback` -- the single unambiguous line, offered when no configured
 *                   category matched. A separate interest expense paired to the
 *                   date is a stronger signal and wins over it.
 *   - `none`     -- nothing here identifies interest, so the caller falls
 *                   through to a paired separate expense and then to a measured
 *                   zero. Returned for a parent with no splits, for an ambiguous
 *                   one (two or more categorized lines, none of them the
 *                   configured category -- guessing one is what this function
 *                   used to do), and for a parent whose every line is a transfer.
 */
type RecordedInterest =
  | { kind: 'exact'; amount: number }
  | { kind: 'fallback'; amount: number }
  | { kind: 'none' };

/**
 * The recorded interest of a payment, from the splits of the linked
 * source-account transaction. A single source payment covering several loan
 * transfers is counted only once.
 *
 * Interest is identified by **provenance, not by absence**. "The split that is
 * not the principal transfer" says what a line is *not*, and a real mortgage
 * payment has more than two lines: principal to the loan, escrow or property
 * tax, insurance, a fee, and the interest. Under that predicate whichever
 * non-principal line came first became "Interest Paid", so the figure depended
 * on split order -- $500 of escrow reported as interest on a payment whose
 * interest was $300, and into every cumulative total, export and projection
 * seed downstream. The loan already names its interest category, so use it.
 *
 * `RecordedInterest` above states the three answers. Every amount is rounded to
 * cents like every other interest path in this module.
 *
 * A configured category with no matching line is deliberately **not** the end of
 * the search: it returns the single unambiguous line as a `fallback` instead. An
 * earlier revision answered "none" there, which zeroed a loan's entire Interest
 * Paid the moment its interest category was set or changed -- splits recorded
 * before the setting existed, or filed under a since-renamed category, still hold
 * the real interest.
 *
 * "A categorized line" means the same thing here as in the backend's
 * `ScheduledTransactionLoanService`, which recalculates the templates this reads
 * back: `categoryId && !transferAccountId`. The two differed by that one clause,
 * so a payment of [principal transfer, categorized interest, uncategorized fee]
 * was one candidate line to the writer and two to this reader -- ambiguous, and
 * reported as no interest at all. A parent with no categorized line still falls
 * back to a single uncategorized non-transfer line, which is how legacy splits
 * recorded interest before categories were required.
 */
function readRecordedInterest(
  transaction: Transaction,
  loanAccountId: string,
  interestCategoryId: string | null | undefined,
  processedParentIds: Set<string>,
): RecordedInterest {
  const linkedTx = transaction.linkedTransaction;
  if (!linkedTx?.splits || linkedTx.splits.length === 0) return { kind: 'none' };
  // A sibling loan transfer of a parent already counted: its interest has been
  // attributed once, so this row adds none.
  if (processedParentIds.has(linkedTx.id)) return { kind: 'exact', amount: 0 };
  processedParentIds.add(linkedTx.id);

  const cents = (value: number) => Math.round(Math.abs(value) * 100) / 100;
  const sumCents = (lines: TransactionSplit[]) =>
    cents(lines.reduce((total, s) => total + Math.abs(Number(s.amount)), 0));

  // Never a transfer: interest is paid to the lender, so it is an expense. A
  // transfer leg moves money between the user's own accounts -- the principal
  // leg is one, and a leg to some third account is not interest either, though
  // the old `!== loanAccountId` predicate accepted it.
  const nonTransfer = linkedTx.splits.filter((s) => !s.transferAccountId);
  const categoryLines = nonTransfer.filter((s) => s.categoryId);

  if (interestCategoryId) {
    // The explicit statement of which line is interest. Summed rather than
    // picked so a payment splitting interest across two lines is not truncated,
    // and order-independent by construction.
    const matching = categoryLines.filter(
      (s) => s.categoryId === interestCategoryId,
    );
    if (matching.length > 0) return { kind: 'exact', amount: sumCents(matching) };
  }

  // Nothing carries the configured category -- or none is configured. A single
  // categorized line is still unambiguous: it is the canonical shape
  // ScheduledTransactionLoanService writes, and it is what every loan without a
  // configured interest category has always relied on.
  //
  // Crucially this applies whether or not a category is configured. Returning
  // "no interest" for a single line that simply does not match zeroed the loan's
  // whole Interest Paid the moment a user SET or CHANGED its interest category:
  // splits recorded before the setting, or filed under a since-renamed category,
  // still hold the real interest. It is offered as a `fallback` so a separate
  // interest expense paired to the date -- a stronger signal about a loan that
  // books interest outside the split -- still wins if one exists.
  if (categoryLines.length === 1) {
    return { kind: 'fallback', amount: cents(Number(categoryLines[0].amount)) };
  }
  // Several categorized lines and none matching: escrow, insurance, interest --
  // indistinguishable, and picking by position is the defect this replaced.
  if (categoryLines.length > 1) return { kind: 'none' };
  // No categorized line at all: a single uncategorized expense line is still
  // unambiguous (legacy splits), and a transfer-only parent records nothing here
  // -- its interest, if any, is the separate expense the caller looks for next.
  if (nonTransfer.length === 1) {
    return { kind: 'fallback', amount: cents(Number(nonTransfer[0].amount)) };
  }
  return { kind: 'none' };
}

/**
 * Pair separate interest expenses to payment dates: each expense (never a
 * transfer -- a principal transfer that happens to share the interest category
 * is not interest) is attributed to the nearest payment date within half a
 * payment interval, and amounts landing on the same date are summed. Expenses
 * with no payment in range are returned as `orphans` -- these are interest-only
 * periods (e.g. an interest-only grace period before principal repayment
 * begins) that get their own rows.
 */
function pairSeparateInterestByDate(
  interestTransactions: Transaction[],
  paymentDateKeys: string[],
): { byDate: Map<string, number>; orphans: Transaction[] } {
  const byDate = new Map<string, number>();
  const orphans: Transaction[] = [];
  if (interestTransactions.length === 0) return { byDate, orphans };
  const sortedDates = [...new Set(paymentDateKeys)].sort();
  const tolerance = paymentIntervalToleranceDays(sortedDates);
  for (const tx of interestTransactions) {
    if (tx.isTransfer) continue; // interest is never a transfer to the loan
    const amount = Math.abs(Number(tx.amount));
    // Skip only a non-numeric amount, never an exact zero. A zero-value row is
    // a REAL recorded event -- a payment holiday ("rata zawieszona") posts a
    // 0 against the interest category -- and a measured zero is not absence
    // (the same rule this module holds for interest and rates). Dropping
    // exactly 0 while keeping -0.01 made a suspended installment vanish from
    // the schedule while a one-groszy rounding of the very same row appeared.
    // A zero pairs into a date's interest as 0 (no effect) and, when it pairs
    // to no payment, becomes its own interest-only row -- which is what shows
    // the holiday.
    if (!Number.isFinite(amount)) continue;
    const nearest =
      sortedDates.length > 0
        ? nearestDateKey(tx.transactionDate.split('T')[0], sortedDates, tolerance)
        : null;
    if (nearest) {
      byDate.set(nearest, (byDate.get(nearest) ?? 0) + amount);
    } else {
      orphans.push(tx);
    }
  }
  return { byDate, orphans };
}

/** Half the median gap between payment dates (min 15 days) -- the window within
 *  which a separate interest expense counts toward a payment. */
function paymentIntervalToleranceDays(sortedDateKeys: string[]): number {
  if (sortedDateKeys.length < 2) return 20;
  const gaps: number[] = [];
  for (let i = 1; i < sortedDateKeys.length; i++) {
    gaps.push(daysBetween(sortedDateKeys[i - 1], sortedDateKeys[i]));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  return median > 0 ? Math.max(15, Math.round(median / 2)) : 20;
}

/** The payment date nearest a given date, or null when the closest one is
 *  further away than the tolerance. */
function nearestDateKey(
  dateKey: string,
  sortedDateKeys: string[],
  toleranceDays: number,
): string | null {
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const key of sortedDateKeys) {
    const diff = Math.abs(daysBetween(key, dateKey));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = key;
    }
  }
  return best != null && bestDiff <= toleranceDays ? best : null;
}

/**
 * The share of a full period's expected interest a regular installment must
 * carry for its observed rate to be trusted. Below this, the booked interest is
 * only a stub (an overpayment settled most of the period's interest with
 * itself, or a payment holiday left an odd partial charge), so annualizing it
 * yields an absurdly low rate; such rows show the contractual timeline rate
 * instead. The two populations are far apart in practice -- a full installment
 * lands near 1.0, a split stub near 0.0-0.2 -- so the exact threshold is not
 * sensitive.
 */
const FULL_PERIOD_INTEREST_RATIO = 0.5;

/**
 * Fill each event's annual rate. When the loan has a recorded rate history
 * (`rateChanges`), each regular row shows the exact rate in effect on its date
 * from that history and overpayments show none -- this is the primary path.
 *
 * Only when no rate history is recorded does the reconstruction below run: the
 * interest charged, annualized over the actual days since interest was last
 * settled (`interest / balanceBefore x 365 / days`). The period runs from the previous *interest-bearing* event, not
 * merely the previous row: a pure-principal overpayment (no interest) does not
 * reset the accrual clock, so the following installment still covers the whole
 * month -- measuring from the overpayment instead would divide a full month's
 * interest by a few days and report an absurd rate. Using the real gap keeps
 * the rate correct across partial first periods, payment holidays, and
 * mid-cycle overpayments that do carry interest. The first interest-bearing row
 * falls back to the nominal period length. Events must be sorted by date;
 * `balanceBefore` is the post-payment balance plus the principal paid, i.e. the
 * debt the interest accrued on.
 *
 * When a period's interest was booked irregularly -- most of it charged
 * alongside an overpayment, or a payment holiday leaving only a partial stub on
 * the regular installment -- the true accrual span is unrecoverable and the
 * annualized observed rate is misleadingly low. Such a row (booked interest
 * below `FULL_PERIOD_INTEREST_RATIO` of a full period's expected accrual at the
 * contractual rate) shows the timeline rate in effect on its date instead. A
 * full-period installment keeps its observed rate, which tracks the real
 * variable rate month to month. Falls back to the plain observed rate when no
 * timeline rate is available to compare against.
 *
 * A regular row that charged no interest has nothing to reconstruct from, and
 * for a **fixed**-rate loan that is not the same as an unknown rate: the
 * configured `interestRate` was in effect on that date regardless of what the
 * payment settled, so the row keeps showing it. A variable-rate loan with no
 * recorded history genuinely does not know its rate on that date, and stays
 * null. Historical *interest* is the ledger's to state (issue #1255); the
 * historical *rate* is the loan's, and one must not be dropped with the other.
 */
function assignObservedRates(
  events: LoanPaymentEvent[],
  periodsPerYear: number,
  rateChanges: RateTimelineRow[],
  account: Account,
): void {
  // When the loan has recorded rate-change rows, show the actual rate in effect
  // on each date -- the clean, discrete rate history -- rather than a
  // per-installment figure reconstructed from the interest charged. The
  // reconstruction jitters with day-count and partial periods and reads as the
  // rate being "averaged by month"; the recorded timeline is exact. An
  // overpayment is an ad-hoc extra payment, not a scheduled installment, so it
  // still shows no rate. The reconstruction below is kept only for loans with
  // no rate history recorded (e.g. a variable-rate loan whose changes were
  // never detected), where it is the sole signal of how the rate moved.
  if (rateChanges.length > 0) {
    for (const event of events) {
      event.annualRate =
        event.type === 'REGULAR'
          ? effectiveAnnualRateOn(rateChanges, event.date, Number(account.interestRate))
          : null;
    }
    return;
  }

  const periodDays = 365 / periodsPerYear;
  const mortgageType = mortgageTypeOf(account);
  // No rate history here (this branch only runs when rateChanges is empty), so
  // the account's scalar rate is the only reference available -- both to
  // sanity-check a reconstructed figure against and, for a fixed-rate loan, as
  // the rate of a row that charged no interest to reconstruct from.
  //
  // `number | null`, not `Number(account.interestRate)`: that is 0 for an
  // unconfigured rate, and 0 is a rate. A fixed 0% loan (interest-free
  // financing, a family loan) has a known rate on every row and books no
  // interest on any of them, so a `> 0` test hides exactly the loan whose rate
  // is most certain -- the same conflation this module fixed one level up for
  // zero-*interest* rows.
  const configuredRate =
    account.interestRate != null ? Number(account.interestRate) : null;
  let lastInterestDateKey: string | null = null;
  for (const event of events) {
    const balanceBefore = event.balance + event.principal;
    const dateKey = event.date.split('T')[0];
    const gap =
      lastInterestDateKey !== null ? daysBetween(lastInterestDateKey, dateKey) : periodDays;
    // A gap much longer than one payment interval means payments were skipped
    // (e.g. a payment holiday): the interest still covers a single billing
    // period, so cap the accrual span at one interval rather than dividing one
    // month of interest across the whole gap. A non-positive gap means a prior
    // interest event fell on this very date -- an overpayment that settled
    // interest the same day as the installment -- so there is no span to
    // measure; fall back to the nominal period rather than dropping the rate.
    // Shorter gaps (an overpayment that settled interest mid-cycle) keep their
    // actual span.
    const days = gap <= 0 || gap > periodDays * 1.5 ? periodDays : gap;
    // Only a scheduled installment carries a meaningful rate. An overpayment is
    // an ad-hoc extra payment whose attached interest spans an odd partial
    // period, so it shows no rate -- but its interest still settles the accrual
    // clock for the following installment.
    if (event.type === 'REGULAR' && event.interest > 0 && balanceBefore > 0 && days > 0) {
      const periodicRate = event.interest / balanceBefore;
      // By the type's annualization trait, mirroring the backend's
      // `annualizeRate` (docs/specs/mortgage-types.md table 4.1): `SEMI_ANNUAL`
      // (Canadian fixed-rate) inverts the semi-annual compounding over the
      // nominal periods per year -- the convention the lender quotes.
      // `DAY_COUNT` annualizes over the actual accrual window (days since
      // interest was last settled), which self-corrects for overpayments and
      // payment gaps.
      const observed =
        annualizationFor(mortgageType) === 'SEMI_ANNUAL'
          ? (Math.pow(1 + periodicRate, periodsPerYear / 2) - 1) * 2 * 100
          : periodicRate * (365 / days) * 100;
      // A 0% loan expects no interest, so it has nothing to check the
      // observation against -- same as an unconfigured rate, and reached here
      // only by a row whose interest contradicts the loan's own rate.
      const expectedFullPeriodInterest =
        configuredRate != null && configuredRate > 0
          ? balanceBefore * getPeriodicRate(configuredRate, periodsPerYear, mortgageType)
          : 0;
      // A partial period falls back to the configured rate, which this branch
      // can only reach when there is one: `expectedFullPeriodInterest > 0`
      // implies a configured rate above zero.
      const isFullPeriod =
        expectedFullPeriodInterest <= 0 ||
        event.interest >= expectedFullPeriodInterest * FULL_PERIOD_INTEREST_RATIO;
      event.annualRate = isFullPeriod ? observed : (configuredRate ?? observed);
    } else if (event.type === 'REGULAR' && configuredRate != null) {
      // Nothing to reconstruct from (a principal-only payment, or a row against
      // no balance), but with no rate history the configured rate is the only
      // rate on record for this date -- so the Rate column keeps it rather than
      // dropping to "--" alongside the interest. A rate that changed is
      // recorded as rate history, which takes the branch above this function.
      event.annualRate = configuredRate;
    } else {
      event.annualRate = null;
    }
    if (event.interest > 0) lastInterestDateKey = dateKey;
  }
}

/** Whole days from `aKey` to `bKey` (both yyyy-MM-dd), timezone-safe. */
function daysBetween(aKey: string, bKey: string): number {
  const a = new Date(`${aKey}T00:00:00Z`).getTime();
  const b = new Date(`${bKey}T00:00:00Z`).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

/**
 * Fetch every transaction for an account, paginating through the API's
 * 200-per-page limit.
 */
export async function fetchAllAccountTransactions(accountId: string): Promise<Transaction[]> {
  let allTransactions: Transaction[] = [];
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const result = await transactionsApi.getAll({
      accountId,
      limit: 200,
      page,
    });
    allTransactions = allTransactions.concat(result.data);
    hasMore = result.pagination.hasMore;
    page++;
  }
  return allTransactions;
}

/**
 * Fetch the loan's separate interest expenses: transactions in the loan's
 * interest category on its payment source account. Pass the result to
 * `deriveLoanPaymentHistory` so each row shows the actual interest booked and
 * overpayments show their interest too. Returns [] when the loan has no
 * interest category or source account set.
 *
 * **Rejects on a failed lookup rather than returning [].** An empty list is a
 * claim about the ledger -- `deriveLoanPaymentHistory` reads it as "no interest
 * was booked against these payments, so their interest is zero" -- and a
 * timeout, a 500 or a proxy error is not that claim. Swallowing the failure
 * here rendered a plausible, wrong Interest Paid of 0.00 with no way for the
 * user to tell it from a real one. Every caller routes the rejection into its
 * own error-and-retry state.
 *
 * Only genuinely standalone interest expenses are returned. The category filter
 * also matches interest booked as a *split leg* of a payment (the backend
 * matches `splits.categoryId`), but that interest is already attributed to its
 * payment through the recorded interest split (path 2 of
 * `deriveLoanPaymentHistory`); returning it here as well would double-count it.
 * A standalone expense carries the interest category at the top level (split
 * parents have a null top-level category) and is not a transfer, so filtering
 * on that keeps only the interest this separate-expense path is meant to handle.
 *
 * Scoping to this loan is by the configured interest category + source account:
 * `deriveLoanPaymentHistory` no longer date-bounds the result, so all of it
 * counts (an interest-only grace period or migrated history included). Pointing
 * two loans at one interest category would therefore merge them -- give each
 * loan its own interest category to keep them apart.
 *
 * **A failed lookup REJECTS; it is not an empty result.** `[]` means one of two
 * things and only those two: the loan is not configured for separate-interest
 * booking, or the query ran and this loan genuinely has no standalone interest
 * expenses. A `catch { return [] }` here made a transient 500 or timeout
 * indistinguishable from the second -- and every one of this function's callers
 * already has the error state it should have reached. `useLoanProjection`
 * reports the projection as unknown, the account detail page has an outer error
 * boundary, and both the Debt Payoff Timeline and the Overpayment Simulator run
 * on `useReportData`'s error-and-retry. The helper was swallowing the failure
 * before any of them could see it, so the history was recomputed from a
 * fabricated empty interest list.
 *
 * What that produced changed with this work, and both readings are worth
 * keeping. Against the analytic estimate this module used to carry, every row
 * of a loan that books interest separately fell back to an INVENTED figure, so
 * the outage rendered a full history of plausible interest. With the estimate
 * deleted (issue #1255) the same outage renders a measured **zero** instead --
 * quieter, and no less wrong, because "the ledger recorded no interest" is a
 * claim this function is not entitled to make on a failed read. The rule in
 * `docs/frontend/api-and-cache.md` covers both: a failed lookup is not an empty dataset,
 * and rendering the failure as emptiness turns an outage into an answer.
 */
export async function fetchLoanInterestTransactions(
  account: Account,
): Promise<Transaction[]> {
  if (!account.interestCategoryId || !account.sourceAccountId) return [];
  const results = await transactionsApi.getAllPages({
    categoryIds: [account.interestCategoryId],
    accountIds: [account.sourceAccountId],
  });
  return results.filter(
    (tx) => tx.categoryId === account.interestCategoryId && !tx.isTransfer,
  );
}
