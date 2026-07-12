import { Account } from '@/types/account';
import { Transaction, TransactionSplit } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import {
  ScheduleFrequency,
  RateTimelineRow,
  getPeriodicRate,
  getPeriodsPerYear,
  effectiveAnnualRateOn,
} from '@/lib/loan-schedule';

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
 *   3. otherwise the interest is derived analytically from the running balance
 *      at the rate in effect on that date (`balance * periodicRate`, using the
 *      rate timeline when supplied), so a payment recorded without an interest
 *      split -- including loans whose interest is booked separately -- shows a
 *      realistic interest that tracks the bank rather than 100% principal.
 *
 * The balance walk is unchanged -- it always tracks the actual ledger amount,
 * so the projected balance still ends at the account's current balance.
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
   * True only when `interest` came from a real recorded interest split, so
   * `principal + interest` is a genuine full installment. False for
   * overpayments and for analytically-derived interest (e.g. interest booked
   * as a separate transaction), where the sum is not a reliable installment.
   */
  interestRecorded: boolean;
  /**
   * The annual interest rate (percentage) observed for this installment,
   * inferred from the interest actually charged: `interest / balanceBefore x
   * periodsPerYear`. Null for overpayments and rows with no interest or no
   * outstanding balance. This is the real rate that produced the row's
   * interest, so it always matches the lender without any detection step.
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
  // interest). Falls back to the split/analytic paths when none is paired.
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

  // A source-account payment covering multiple loan transfers (e.g. regular +
  // extra principal) carries one interest split; count it once.
  const processedParentIds = new Set<string>();
  // Actual interest expenses paired to each payment date. Each date's interest
  // is consumed once, so two rows on the same date can't double-count it.
  // Expenses with no payment in range (interest-only periods) become their own
  // rows below.
  const { byDate: separateInterestByDate, orphans: orphanInterest } =
    pairSeparateInterestByDate(
      interestTransactions,
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
      const { interest, type, interestRecorded } = classifyPayment(
        transaction,
        runningBalance,
        account,
        loanAccountId,
        processedParentIds,
        rateChanges,
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
        interestRecorded,
      });
    }
  } else {
    // Ledger path: track the true signed running balance so draws and
    // repayments both count. Emit an event per repayment with the debt
    // magnitude at that point.
    let runningSigned = openingSigned;
    for (const transaction of sortedTransactions) {
      const balanceBefore = debtMagnitude(runningSigned);
      runningSigned += Number(transaction.amount);
      if (Number(transaction.amount) <= 0) continue; // draws move the balance, no row
      const principal = Math.abs(Number(transaction.amount));
      const { interest, type, interestRecorded } = classifyPayment(
        transaction,
        balanceBefore,
        account,
        loanAccountId,
        processedParentIds,
        rateChanges,
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
        interestRecorded,
      });
    }
  }

  if (orphanInterest.length === 0) {
    assignObservedRates(events, periodsPerYear);
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
    interestRecorded: true,
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
  assignObservedRates(merged, periodsPerYear);

  return {
    events: merged,
    startingBalance,
    currentBalance,
    cumulativePrincipal: runningPrincipal,
    cumulativeInterest: runningInterest,
  };
}

/**
 * Debt owed for a signed account balance. Debt accounts store the balance
 * negative, so the outstanding amount is `-balance`, floored at zero so an
 * overpaid balance (in credit) reads as paid off rather than as fresh debt.
 */
function debtMagnitude(signedBalance: number): number {
  return Math.max(0, -signedBalance);
}

/**
 * The installment to seed a forward projection with, given the payment history:
 * the most recent regular payment's full amount, `principal + interest`. With
 * interest now taken from the rate timeline (or a recorded split), this is the
 * borrower's real current installment -- and it always covers the period's
 * interest, since the principal portion is positive, so the projection
 * amortizes. Falls back to the stored contractual payment only when there is no
 * usable regular payment yet (e.g. an interest-only grace period). The stored
 * payment is not preferred even when it is lower: for loans whose interest is
 * booked separately it often holds only the principal part and would seed a
 * non-amortizing payment.
 */
export function deriveCurrentInstallment(
  history: LoanHistoryResult,
  contractualPayment: number,
): number {
  const lastRegular = [...history.events]
    .reverse()
    .find((event) => event.type === 'REGULAR');
  if (!lastRegular) return contractualPayment;
  const observed =
    Math.round((lastRegular.principal + lastRegular.interest) * 100) / 100;
  return observed > 0 ? observed : contractualPayment;
}

/**
 * Classify a positive loan-account transaction into its interest portion and
 * row type. Interest is resolved in order: a recorded interest split of the
 * payment; else the actual separate interest expense paired to this date; else
 * an analytic estimate from the running balance and rate. An overpayment
 * (recognized by the loan's overpayment category / memo / payee) is extra
 * principal, but still shows any real interest charged alongside it (paired) --
 * never an analytic estimate.
 */
function classifyPayment(
  transaction: Transaction,
  balanceBefore: number,
  account: Account,
  loanAccountId: string,
  processedParentIds: Set<string>,
  rateChanges: RateTimelineRow[],
  separateInterestByDate: Map<string, number>,
  usedInterestDates: Set<string>,
): { interest: number; type: LoanPaymentType; interestRecorded: boolean } {
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
    return {
      interest: paired ?? 0,
      type: 'OVERPAYMENT',
      interestRecorded: paired != null,
    };
  }
  const recorded = readRecordedInterest(
    transaction,
    loanAccountId,
    processedParentIds,
  );
  if (recorded !== null) {
    // A positive recorded split is a real installment leg; 0 means the source
    // split carried no interest (e.g. an extra-principal sibling), which is not.
    return { interest: recorded, type: 'REGULAR', interestRecorded: recorded > 0 };
  }
  const paired = takeSeparateInterest();
  if (paired != null) {
    return { interest: paired, type: 'REGULAR', interestRecorded: true };
  }
  return {
    interest: analyticInterest(balanceBefore, account, transaction, rateChanges),
    type: 'REGULAR',
    interestRecorded: false,
  };
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
 * The recorded interest of a payment lives on the linked source-account
 * transaction as the split that does not transfer back to the loan. Returns
 * null when there is no recorded interest split (so the caller falls back to
 * the analytic derivation); a single source payment covering several loan
 * transfers is counted only once.
 */
function readRecordedInterest(
  transaction: Transaction,
  loanAccountId: string,
  processedParentIds: Set<string>,
): number | null {
  const linkedTx = transaction.linkedTransaction;
  if (!linkedTx?.splits || linkedTx.splits.length === 0) return null;
  if (processedParentIds.has(linkedTx.id)) return 0;
  processedParentIds.add(linkedTx.id);
  const interestSplit = linkedTx.splits.find((s) => s.transferAccountId !== loanAccountId);
  return interestSplit ? Math.abs(interestSplit.amount) : 0;
}

/**
 * Interest a regular payment accrued over the period, `balance * periodicRate`,
 * for amortizing debt with a positive rate. Only loans and mortgages get an
 * analytic estimate (revolving credit has no fixed installment schedule). The
 * rate is the one in effect on the payment date from the rate timeline (falling
 * back to the account's rate), so a variable-rate loan reprices each month and
 * the figure tracks the bank's amortization. Not capped at the loan-side
 * transaction amount: that amount is principal-only when interest is booked as
 * a separate transaction, and capping there collapses interest to the principal
 * (the artifact this replaces). Floored at zero.
 */
function analyticInterest(
  balanceBefore: number,
  account: Account,
  transaction: Transaction,
  rateChanges: RateTimelineRow[],
): number {
  if (account.accountType !== 'LOAN' && account.accountType !== 'MORTGAGE') {
    return 0;
  }
  const annualRate = effectiveAnnualRateOn(
    rateChanges,
    transaction.transactionDate,
    Number(account.interestRate),
  );
  if (!annualRate || annualRate <= 0 || balanceBefore <= 0) return 0;
  const frequency = (account.paymentFrequency as ScheduleFrequency) || 'MONTHLY';
  const periodicRate = getPeriodicRate(
    annualRate,
    getPeriodsPerYear(frequency),
    account.isCanadianMortgage || false,
    account.isVariableRate || false,
  );
  const interest = balanceBefore * periodicRate;
  return Math.round(Math.max(0, interest) * 100) / 100;
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
    if (!(amount > 0)) continue;
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
 * Fill each event's observed annual rate: the interest charged, annualized over
 * the actual days since interest was last settled (`interest / balanceBefore x
 * 365 / days`). The period runs from the previous *interest-bearing* event, not
 * merely the previous row: a pure-principal overpayment (no interest) does not
 * reset the accrual clock, so the following installment still covers the whole
 * month -- measuring from the overpayment instead would divide a full month's
 * interest by a few days and report an absurd rate. Using the real gap keeps
 * the rate correct across partial first periods, payment holidays, and
 * mid-cycle overpayments that do carry interest. The first interest-bearing row
 * falls back to the nominal period length. Events must be sorted by date;
 * `balanceBefore` is the post-payment balance plus the principal paid, i.e. the
 * debt the interest accrued on.
 */
function assignObservedRates(events: LoanPaymentEvent[], periodsPerYear: number): void {
  const fallbackDays = 365 / periodsPerYear;
  let lastInterestDateKey: string | null = null;
  for (const event of events) {
    const balanceBefore = event.balance + event.principal;
    const dateKey = event.date.split('T')[0];
    const days =
      lastInterestDateKey !== null
        ? daysBetween(lastInterestDateKey, dateKey)
        : fallbackDays;
    event.annualRate =
      event.interest > 0 && balanceBefore > 0 && days > 0
        ? (event.interest / balanceBefore) * (365 / days) * 100
        : null;
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
 * `deriveLoanPaymentHistory` so each row shows the actual interest booked
 * (rather than an analytic estimate) and overpayments show their interest too.
 * Returns [] when the loan has no interest category or source account set.
 */
export async function fetchLoanInterestTransactions(
  account: Account,
): Promise<Transaction[]> {
  if (!account.interestCategoryId || !account.sourceAccountId) return [];
  try {
    return await transactionsApi.getAllPages({
      categoryIds: [account.interestCategoryId],
      accountIds: [account.sourceAccountId],
    });
  } catch {
    return [];
  }
}
