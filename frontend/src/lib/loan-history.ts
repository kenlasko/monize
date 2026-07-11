import { Account } from '@/types/account';
import { Transaction, TransactionSplit } from '@/types/transaction';
import { transactionsApi } from '@/lib/transactions';
import {
  ScheduleFrequency,
  getPeriodicRate,
  getPeriodsPerYear,
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
 *      (`balance * periodicRate`), so a payment entered as a plain transfer no
 *      longer shows interest = 0 / rata = 100% principal.
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
  const events: LoanPaymentEvent[] = [];

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

  return {
    events,
    startingBalance,
    currentBalance,
    cumulativePrincipal,
    cumulativeInterest,
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
 * The installment to seed a forward projection with, given the payment history.
 * Returns the most recent regular installment (principal + interest) when the
 * lender has demonstrably lowered it below the stored contractual payment (PL
 * *obniżenie raty*); otherwise the contractual payment. Only a genuine
 * reduction is trusted -- a figure above the contractual usually reflects
 * analytic interest on a payment recorded without an interest split rather than
 * a real raise, so it is ignored to avoid projecting too high a payment.
 *
 * Crucially, only an installment whose interest was actually *recorded* (a real
 * split) is trusted: without a recorded interest leg, `principal + interest` is
 * principal plus at most an analytic estimate -- often below the period's true
 * interest -- which would seed the projection with a payment that never
 * amortizes (payoff "beyond forecast", 0 months saved). In that case we fall
 * back to the contractual payment, which does amortize.
 */
export function deriveCurrentInstallment(
  history: LoanHistoryResult,
  contractualPayment: number,
): number {
  const lastRegular = [...history.events]
    .reverse()
    .find((event) => event.type === 'REGULAR' && event.interestRecorded);
  if (!lastRegular) return contractualPayment;
  const observed =
    Math.round((lastRegular.principal + lastRegular.interest) * 100) / 100;
  return observed > 0 && observed < contractualPayment
    ? observed
    : contractualPayment;
}

/**
 * Classify a positive loan-account transaction into its interest portion and
 * row type. An overpayment (recognized by the loan's overpayment category or
 * overpayment memo text) is 100% principal; a regular installment prefers its
 * recorded interest split and otherwise derives interest analytically from the
 * running balance.
 */
function classifyPayment(
  transaction: Transaction,
  balanceBefore: number,
  account: Account,
  loanAccountId: string,
  processedParentIds: Set<string>,
): { interest: number; type: LoanPaymentType; interestRecorded: boolean } {
  if (
    isOverpayment(
      transaction,
      account.overpaymentCategoryId,
      account.overpaymentMemo,
      loanAccountId,
    )
  ) {
    return { interest: 0, type: 'OVERPAYMENT', interestRecorded: false };
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
  return {
    interest: analyticInterest(balanceBefore, account, transaction),
    type: 'REGULAR',
    interestRecorded: false,
  };
}

/**
 * Whether a payment is a standalone overpayment. Recognized either by the
 * loan's overpayment category or its overpayment memo text -- each usable on
 * its own or together, so either match is sufficient.
 */
function isOverpayment(
  transaction: Transaction,
  overpaymentCategoryId: string | null | undefined,
  overpaymentMemo: string | null | undefined,
  loanAccountId: string,
): boolean {
  return (
    matchesOverpaymentCategory(transaction, overpaymentCategoryId, loanAccountId) ||
    matchesOverpaymentMemo(transaction, overpaymentMemo, loanAccountId)
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
 * analytic estimate (revolving credit has no fixed installment schedule);
 * capped at the payment amount and floored at zero so it never goes negative
 * or dwarfs the payment.
 */
function analyticInterest(
  balanceBefore: number,
  account: Account,
  transaction: Transaction,
): number {
  if (account.accountType !== 'LOAN' && account.accountType !== 'MORTGAGE') {
    return 0;
  }
  const annualRate = Number(account.interestRate);
  if (!annualRate || annualRate <= 0 || balanceBefore <= 0) return 0;
  const frequency = (account.paymentFrequency as ScheduleFrequency) || 'MONTHLY';
  const periodicRate = getPeriodicRate(
    annualRate,
    getPeriodsPerYear(frequency),
    account.isCanadianMortgage || false,
    account.isVariableRate || false,
  );
  const interest = balanceBefore * periodicRate;
  const capped = Math.min(Math.max(0, interest), Math.abs(Number(transaction.amount)));
  return Math.round(capped * 100) / 100;
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
