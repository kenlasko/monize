import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";

export interface DetectedLoanPayment {
  /** Detected regular payment amount (positive) */
  paymentAmount: number;
  /** Detected payment frequency */
  paymentFrequency: string;
  /** Confidence score 0-1 for the detection */
  confidence: number;
  /** Source account ID (where payments come from) */
  sourceAccountId: string | null;
  /** Source account name */
  sourceAccountName: string | null;
  /** Detected interest category ID (if splits found) */
  interestCategoryId: string | null;
  /** Detected interest category name */
  interestCategoryName: string | null;
  /** Detected principal category ID (if splits found) */
  principalCategoryId: string | null;
  /** Estimated interest rate (annual percentage, null if cannot determine) */
  estimatedInterestRate: number | null;
  /** Suggested next due date based on last payment */
  suggestedNextDueDate: string;
  /** Date of the first detected payment */
  firstPaymentDate: string;
  /** Date of the last detected payment */
  lastPaymentDate: string;
  /** Number of payments analyzed */
  paymentCount: number;
  /** Current loan balance (absolute value) */
  currentBalance: number;
  /** Whether the account is a mortgage */
  isMortgage: boolean;
  /** Average extra principal payment per period (0 if none detected) */
  averageExtraPrincipal: number;
  /** Number of extra principal payments detected */
  extraPrincipalCount: number;
  /** Principal portion from the most recent split payment (null if no splits) */
  lastPrincipalAmount: number | null;
  /** Interest portion from the most recent split payment (null if no splits) */
  lastInterestAmount: number | null;
}

interface PaymentRecord {
  date: string;
  amount: number;
  sourceAccountId: string | null;
  sourceAccountName: string | null;
  interestAmount: number | null;
  principalAmount: number | null;
  /** Extra principal detected from splits (memo cues or multiple principal splits) */
  extraPrincipalAmount: number | null;
  /** Individual principal split amounts when multiple transfers to the loan exist */
  principalSplitAmounts: number[];
  interestCategoryId: string | null;
  interestCategoryName: string | null;
}

@Injectable()
export class LoanPaymentDetectorService {
  private readonly logger = new Logger(LoanPaymentDetectorService.name);

  constructor(
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Transaction)
    private transactionRepository: Repository<Transaction>,
  ) {}

  /**
   * Analyze transactions on a loan/mortgage account to detect payment patterns.
   * Looks at incoming transfers (payments) to determine amount, frequency,
   * source account, and interest/principal splits.
   */
  async detectPaymentPattern(
    userId: string,
    accountId: string,
  ): Promise<DetectedLoanPayment | null> {
    const account = await this.accountsRepository.findOne({
      where: { id: accountId, userId },
    });

    if (!account) {
      throw new NotFoundException("Account not found");
    }

    if (
      account.accountType !== AccountType.LOAN &&
      account.accountType !== AccountType.MORTGAGE &&
      account.accountType !== AccountType.LINE_OF_CREDIT
    ) {
      return null;
    }

    // Find all transactions on this loan account that look like payments
    // Payments to a loan are positive amounts (reducing the negative balance)
    const transactions = await this.transactionRepository.find({
      where: { accountId, userId },
      relations: ["account"],
      order: { transactionDate: "ASC" },
    });

    if (transactions.length === 0) {
      return null;
    }

    // Build payment records from transactions
    const payments = await this.buildPaymentRecords(
      userId,
      accountId,
      transactions,
    );

    if (payments.length < 2) {
      // Need at least 2 payments to detect a pattern
      return payments.length === 1
        ? this.buildSinglePaymentResult(account, payments[0])
        : null;
    }

    // Detect the regular payment amount (most common amount)
    const regularAmount = this.detectRegularAmount(payments);
    if (!regularAmount) {
      return null;
    }

    // Filter to only regular payments (within 5% of detected amount)
    const regularPayments = payments.filter(
      (p) => Math.abs(p.amount - regularAmount) / regularAmount < 0.05,
    );

    if (regularPayments.length < 2) {
      return null;
    }

    // Detect frequency from payment intervals
    const frequency = this.detectFrequency(regularPayments);
    const confidence = this.calculateConfidence(
      regularPayments,
      payments,
      regularAmount,
      frequency,
    );

    // Determine source account (most common)
    const sourceAccount = this.detectSourceAccount(regularPayments);

    // Detect interest/principal split info
    const splitInfo = this.detectSplitInfo(regularPayments);

    // Build running balance map from all transactions for accurate rate estimation
    const balanceMap = this.buildRunningBalanceMap(account, transactions);

    // Estimate interest rate if we have split data
    const estimatedRate = this.estimateInterestRate(
      payments,
      balanceMap,
      frequency,
    );

    // Detect extra principal payments
    const extraPrincipal = this.detectExtraPrincipal(
      payments,
      regularAmount,
      regularPayments.length,
    );

    // The regularAmount is the total from the source account (includes extra principal).
    // Subtract extra principal to get the base payment (principal + interest only).
    const basePaymentAmount =
      extraPrincipal.averageExtraPrincipal > 0
        ? Math.round(
            (regularAmount - extraPrincipal.averageExtraPrincipal) * 100,
          ) / 100
        : regularAmount;

    // Analyze the recent P/I split trend from several payments.
    // In amortization, principal increases and interest decreases each period.
    // Use the trend to project the next expected split values.
    // Pass extra principal so it can be subtracted from principalAmount
    // when the combined total was stored without memo-based separation.
    const splitAnalysis = this.analyzeSplitTrend(
      payments,
      extraPrincipal.averageExtraPrincipal,
    );

    // Calculate next due date
    const lastPayment = regularPayments[regularPayments.length - 1];
    const suggestedNextDueDate = this.calculateNextDueDate(
      lastPayment.date,
      frequency,
    );

    return {
      paymentAmount: basePaymentAmount,
      paymentFrequency: frequency,
      confidence,
      sourceAccountId: sourceAccount.id,
      sourceAccountName: sourceAccount.name,
      interestCategoryId: splitInfo.interestCategoryId,
      interestCategoryName: splitInfo.interestCategoryName,
      principalCategoryId: splitInfo.principalCategoryId,
      estimatedInterestRate: estimatedRate,
      suggestedNextDueDate,
      firstPaymentDate: regularPayments[0].date,
      lastPaymentDate: lastPayment.date,
      paymentCount: regularPayments.length,
      currentBalance: Math.abs(Number(account.currentBalance)),
      isMortgage: account.accountType === AccountType.MORTGAGE,
      averageExtraPrincipal: extraPrincipal.averageExtraPrincipal,
      extraPrincipalCount: extraPrincipal.extraPrincipalCount,
      lastPrincipalAmount: splitAnalysis.projectedPrincipal,
      lastInterestAmount: splitAnalysis.projectedInterest,
    };
  }

  /**
   * Build payment records by examining transactions and their linked source transfers/splits.
   * The source account transaction represents the true total payment (principal + interest +
   * extra principal). Its splits break down the components clearly:
   *   - Transfer split to the loan account = principal
   *   - Categorized split = interest expense
   *   - Memo cues ("Extra"/"Additional") distinguish extra principal from regular principal
   *
   * When no linked source transaction is found (simple transfer without splits),
   * the loan account transaction amount is used as the payment amount.
   */
  private async buildPaymentRecords(
    userId: string,
    accountId: string,
    transactions: Transaction[],
  ): Promise<PaymentRecord[]> {
    const payments: PaymentRecord[] = [];

    for (const tx of transactions) {
      const loanSideAmount = Number(tx.amount);

      // Payments to a loan account are positive (reducing the negative liability)
      if (loanSideAmount <= 0) continue;

      let sourceAccountId: string | null = null;
      let sourceAccountName: string | null = null;
      let interestAmount: number | null = null;
      let principalAmount: number | null = null;
      let extraPrincipalAmount: number | null = null;
      let principalSplitAmounts: number[] = [];
      let interestCategoryId: string | null = null;
      let interestCategoryName: string | null = null;
      // Default to loan-side amount; override with source amount when available
      let totalPaymentAmount = loanSideAmount;

      // Check if this is a transfer - find the linked source transaction
      if (tx.isTransfer && tx.linkedTransactionId) {
        const linkedTx = await this.transactionRepository.findOne({
          where: { id: tx.linkedTransactionId, userId },
          relations: ["account"],
        });
        if (linkedTx) {
          sourceAccountId = linkedTx.accountId;
          sourceAccountName = linkedTx.account?.name || null;

          // The source transaction amount is the total payment (negative outflow).
          // Use its absolute value as the total payment amount.
          const sourceAmount = Math.abs(Number(linkedTx.amount));
          if (sourceAmount > 0) {
            totalPaymentAmount = sourceAmount;
          }

          // Check if the source transaction has splits (principal + interest)
          if (linkedTx.isSplit) {
            const splits = await this.transactionRepository.manager.find(
              TransactionSplit,
              {
                where: { transactionId: linkedTx.id },
                relations: ["category"],
              },
            );

            // Collect all principal splits (transfers to the loan account)
            const principalSplits: Array<{
              amount: number;
              memo: string | null;
            }> = [];

            for (const split of splits) {
              const splitAmount = Math.abs(Number(split.amount));
              if (split.transferAccountId === accountId) {
                principalSplits.push({
                  amount: splitAmount,
                  memo: split.memo,
                });
              } else if (split.categoryId) {
                // Categorized split = interest expense
                interestAmount = splitAmount;
                interestCategoryId = split.categoryId;
                interestCategoryName = split.category?.name || null;
              }
            }

            // Separate regular principal from extra principal using memo cues.
            // Regular principal varies with amortization; extra is typically static.
            if (principalSplits.length === 1) {
              // Single principal split -- check memo for "extra"/"additional"
              const memo = (principalSplits[0].memo || "").toLowerCase();
              if (
                memo.includes("extra") ||
                memo.includes("additional")
              ) {
                extraPrincipalAmount = principalSplits[0].amount;
              } else {
                principalAmount = principalSplits[0].amount;
              }
            } else if (principalSplits.length > 1) {
              // Multiple principal splits -- use memo cues to separate
              let regular = 0;
              let extra = 0;
              let hasMemoCues = false;

              for (const ps of principalSplits) {
                const memo = (ps.memo || "").toLowerCase();
                if (
                  memo.includes("extra") ||
                  memo.includes("additional")
                ) {
                  extra += ps.amount;
                  hasMemoCues = true;
                } else {
                  regular += ps.amount;
                }
              }

              if (hasMemoCues) {
                principalAmount = regular > 0 ? regular : null;
                extraPrincipalAmount = extra > 0 ? extra : null;
              } else {
                // No memo cues -- keep individual split amounts for cross-payment
                // analysis. The largest split is likely regular principal (varies),
                // smaller splits may be extra principal (static).
                // Sum all into principalAmount for now; detectExtraPrincipal will
                // use principalSplitAmounts to separate them.
                principalSplitAmounts = principalSplits.map((ps) => ps.amount);
                principalAmount = principalSplitAmounts.reduce(
                  (s, a) => s + a,
                  0,
                );
              }
            }
          }
        }
      }

      payments.push({
        date: tx.transactionDate,
        amount: totalPaymentAmount,
        sourceAccountId,
        sourceAccountName,
        interestAmount,
        principalAmount,
        extraPrincipalAmount,
        principalSplitAmounts,
        interestCategoryId,
        interestCategoryName,
      });
    }

    return payments;
  }

  /**
   * Detect the most common payment amount (the regular payment).
   * Groups amounts within 1 cent tolerance and returns the mode.
   */
  private detectRegularAmount(payments: PaymentRecord[]): number | null {
    // Round amounts to 2 decimal places and count occurrences
    const amountCounts = new Map<number, number>();
    for (const p of payments) {
      const rounded = Math.round(p.amount * 100) / 100;
      amountCounts.set(rounded, (amountCounts.get(rounded) || 0) + 1);
    }

    // Find the most frequent amount
    let maxCount = 0;
    let regularAmount: number | null = null;
    for (const [amount, count] of amountCounts) {
      if (count > maxCount) {
        maxCount = count;
        regularAmount = amount;
      }
    }

    // Require at least 2 occurrences of the same amount
    if (maxCount < 2) {
      // Try grouping within 5% tolerance
      return this.detectRegularAmountFuzzy(payments);
    }

    return regularAmount;
  }

  /**
   * Fuzzy amount detection - groups amounts within 5% of median.
   */
  private detectRegularAmountFuzzy(payments: PaymentRecord[]): number | null {
    const amounts = [...payments.map((p) => p.amount)].sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];

    const nearMedian = amounts.filter(
      (a) => Math.abs(a - median) / median < 0.05,
    );

    if (nearMedian.length >= 2) {
      // Return the average of the near-median amounts
      const sum = nearMedian.reduce((s, a) => s + a, 0);
      return Math.round((sum / nearMedian.length) * 100) / 100;
    }

    return null;
  }

  /**
   * Detect payment frequency from intervals between payment dates.
   */
  private detectFrequency(payments: PaymentRecord[]): string {
    const intervals: number[] = [];
    for (let i = 1; i < payments.length; i++) {
      const prev = new Date(payments[i - 1].date);
      const curr = new Date(payments[i].date);
      const diffDays = Math.round(
        (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24),
      );
      intervals.push(diffDays);
    }

    // Calculate median interval
    const sorted = [...intervals].sort((a, b) => a - b);
    const medianInterval = sorted[Math.floor(sorted.length / 2)];

    // Map interval to frequency
    if (medianInterval <= 10) return "WEEKLY";
    if (medianInterval <= 18) return "BIWEEKLY";
    if (medianInterval <= 21) return "SEMIMONTHLY";
    if (medianInterval <= 45) return "MONTHLY";
    if (medianInterval <= 100) return "QUARTERLY";
    return "YEARLY";
  }

  /**
   * Calculate confidence score based on how consistent the payments are.
   */
  private calculateConfidence(
    regularPayments: PaymentRecord[],
    allPayments: PaymentRecord[],
    regularAmount: number,
    frequency: string,
  ): number {
    let score = 0;

    // 1. What percentage of all payments match the regular amount? (0-0.4)
    const matchRatio = regularPayments.length / allPayments.length;
    score += matchRatio * 0.4;

    // 2. How consistent are the intervals? (0-0.3)
    const expectedDays = this.getExpectedIntervalDays(frequency);
    const intervals: number[] = [];
    for (let i = 1; i < regularPayments.length; i++) {
      const prev = new Date(regularPayments[i - 1].date);
      const curr = new Date(regularPayments[i].date);
      const diffDays =
        (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
      intervals.push(diffDays);
    }

    if (intervals.length > 0) {
      const avgDeviation =
        intervals.reduce((sum, d) => sum + Math.abs(d - expectedDays), 0) /
        intervals.length;
      // Allow up to 5 days deviation for full score
      const intervalScore = Math.max(0, 1 - avgDeviation / 10);
      score += intervalScore * 0.3;
    }

    // 3. Number of payments (more = more confident) (0-0.2)
    const countScore = Math.min(1, regularPayments.length / 12);
    score += countScore * 0.2;

    // 4. Exact amount match bonus (0-0.1)
    const exactMatches = regularPayments.filter(
      (p) => Math.round(p.amount * 100) === Math.round(regularAmount * 100),
    ).length;
    const exactRatio = exactMatches / regularPayments.length;
    score += exactRatio * 0.1;

    return Math.round(score * 100) / 100;
  }

  private getExpectedIntervalDays(frequency: string): number {
    switch (frequency) {
      case "WEEKLY":
        return 7;
      case "BIWEEKLY":
        return 14;
      case "SEMIMONTHLY":
        return 15;
      case "MONTHLY":
        return 30;
      case "QUARTERLY":
        return 91;
      case "YEARLY":
        return 365;
      default:
        return 30;
    }
  }

  /**
   * Determine the most common source account for payments.
   */
  private detectSourceAccount(payments: PaymentRecord[]): {
    id: string | null;
    name: string | null;
  } {
    const counts = new Map<string, { count: number; name: string | null }>();
    for (const p of payments) {
      if (p.sourceAccountId) {
        const existing = counts.get(p.sourceAccountId);
        if (existing) {
          existing.count++;
        } else {
          counts.set(p.sourceAccountId, {
            count: 1,
            name: p.sourceAccountName,
          });
        }
      }
    }

    let bestId: string | null = null;
    let bestName: string | null = null;
    let bestCount = 0;
    for (const [id, { count, name }] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestId = id;
        bestName = name;
      }
    }

    return { id: bestId, name: bestName };
  }

  /**
   * Detect principal/interest split information from payment records.
   */
  private detectSplitInfo(payments: PaymentRecord[]): {
    interestCategoryId: string | null;
    interestCategoryName: string | null;
    principalCategoryId: string | null;
  } {
    // Find the most common interest category
    const categoryCounts = new Map<
      string,
      { count: number; name: string | null }
    >();
    for (const p of payments) {
      if (p.interestCategoryId) {
        const existing = categoryCounts.get(p.interestCategoryId);
        if (existing) {
          existing.count++;
        } else {
          categoryCounts.set(p.interestCategoryId, {
            count: 1,
            name: p.interestCategoryName,
          });
        }
      }
    }

    let interestCategoryId: string | null = null;
    let interestCategoryName: string | null = null;
    let bestCount = 0;
    for (const [id, { count, name }] of categoryCounts) {
      if (count > bestCount) {
        bestCount = count;
        interestCategoryId = id;
        interestCategoryName = name;
      }
    }

    return {
      interestCategoryId,
      interestCategoryName,
      // Principal category is not used in the current schema
      // (principal goes as a transfer to the loan account)
      principalCategoryId: null,
    };
  }

  /**
   * Build a map of running balance before each transaction date.
   * Uses all transactions on the loan account to track the actual balance
   * at each point in time, giving accurate data for interest rate estimation.
   */
  private buildRunningBalanceMap(
    account: Account,
    transactions: Transaction[],
  ): Map<string, number> {
    const balanceMap = new Map<string, number>();
    // Start from the absolute opening balance (loan balances are negative liabilities)
    let absBalance = Math.abs(Number(account.openingBalance));

    // Transactions are already sorted by date ASC from the query
    for (const tx of transactions) {
      const dateStr =
        typeof tx.transactionDate === "string"
          ? tx.transactionDate.split("T")[0]
          : String(tx.transactionDate);

      // Record balance before the first transaction on this date
      if (!balanceMap.has(dateStr)) {
        balanceMap.set(dateStr, absBalance);
      }

      // Payments (positive) reduce the absolute balance;
      // charges/fees (negative) increase it
      absBalance -= Number(tx.amount);
    }

    return balanceMap;
  }

  /**
   * Estimate the annual interest rate from payment data.
   * Uses the actual running balance at each payment date for accuracy,
   * and takes the median rate to be robust against outliers.
   */
  private estimateInterestRate(
    payments: PaymentRecord[],
    balanceMap: Map<string, number>,
    frequency: string,
  ): number | null {
    const paymentsWithSplits = payments.filter(
      (p) => p.interestAmount !== null && p.principalAmount !== null,
    );

    if (paymentsWithSplits.length < 1) {
      return null;
    }

    const periodsPerYear = this.getPeriodsPerYear(frequency);
    const rates: number[] = [];

    for (const p of paymentsWithSplits) {
      const dateStr = p.date.split("T")[0];
      const balance = balanceMap.get(dateStr);
      if (!balance || balance <= 0 || !p.interestAmount) continue;

      const periodicRate = p.interestAmount / balance;
      const annualRate = periodicRate * periodsPerYear * 100;
      if (annualRate > 0 && annualRate < 50) {
        rates.push(annualRate);
      }
    }

    if (rates.length === 0) {
      return null;
    }

    // Use median for robustness against outliers
    rates.sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    const medianRate =
      rates.length % 2 === 0
        ? (rates[mid - 1] + rates[mid]) / 2
        : rates[mid];

    return Math.round(medianRate * 100) / 100;
  }

  /**
   * Detect extra principal payments from split-level data.
   *
   * The source account transaction for a loan payment has splits:
   *   - Transfer to loan account = principal (varies, increases over time)
   *   - Categorized expense = interest (varies, decreases over time)
   *   - (Optional) Second transfer to loan account = extra principal (static)
   *
   * Strategies (in priority order):
   * 1. Memo-based: Use "Extra"/"Additional" keywords from split memos.
   * 2. Multiple splits: When a payment has 2+ transfers to the loan account,
   *    find the split amount that is constant/static across payments. The
   *    varying one is regular principal; the static one is extra principal.
   * 3. Fall back to zero.
   */
  private detectExtraPrincipal(
    allPayments: PaymentRecord[],
    _regularAmount: number,
    _regularPaymentCount: number,
  ): { averageExtraPrincipal: number; extraPrincipalCount: number } {
    // Strategy 1: Use memo-detected extra principal from splits.
    const memoBasedExtras = allPayments.filter(
      (p) => p.extraPrincipalAmount !== null && p.extraPrincipalAmount > 0,
    );

    if (memoBasedExtras.length >= 3 && memoBasedExtras.length / allPayments.length >= 0.5) {
      const totalExtra = memoBasedExtras.reduce(
        (sum, p) => sum + p.extraPrincipalAmount!,
        0,
      );
      const avg = Math.round((totalExtra / memoBasedExtras.length) * 100) / 100;
      return {
        averageExtraPrincipal: avg,
        extraPrincipalCount: memoBasedExtras.length,
      };
    }

    // Strategy 2: Look for payments with multiple principal splits (2+ transfers
    // to the loan account). The extra principal appears as a second transfer
    // with a static/constant amount across payments.
    const paymentsWithMultipleSplits = allPayments.filter(
      (p) => p.principalSplitAmounts.length >= 2,
    );

    if (paymentsWithMultipleSplits.length >= 3) {
      // For each payment, find the smaller split amount(s).
      // In amortization, the regular principal is the larger, varying portion.
      // The extra principal is the smaller, static portion.
      const candidateExtras: number[] = [];

      for (const p of paymentsWithMultipleSplits) {
        // Sort splits ascending -- the smaller ones are candidate extras
        const sorted = [...p.principalSplitAmounts].sort((a, b) => a - b);
        // Take all but the largest (which is likely the regular principal)
        for (let i = 0; i < sorted.length - 1; i++) {
          candidateExtras.push(sorted[i]);
        }
      }

      if (candidateExtras.length >= 3) {
        // Check if these candidate extras are roughly the same value (static)
        const avg =
          candidateExtras.reduce((s, e) => s + e, 0) / candidateExtras.length;
        const maxDev = Math.max(
          ...candidateExtras.map((e) => Math.abs(e - avg)),
        );
        const isStatic = avg > 0.01 && (maxDev < 0.02 || maxDev / avg < 0.05);

        if (isStatic) {
          const extraAmount = Math.round(avg * 100) / 100;
          return {
            averageExtraPrincipal: extraAmount,
            extraPrincipalCount: paymentsWithMultipleSplits.length,
          };
        }
      }
    }

    return { averageExtraPrincipal: 0, extraPrincipalCount: 0 };
  }

  /**
   * Analyze the principal/interest split trend across recent payments.
   * In amortization: principal increases each period, interest decreases.
   * Uses the last several payments to project what the next split should be.
   *
   * @param extraPrincipalAmount - If detected, this is subtracted from
   *   principalAmount to get the regular principal before trend analysis.
   *
   * Returns projected REGULAR principal and interest values for the next payment.
   */
  private analyzeSplitTrend(
    allPayments: PaymentRecord[],
    extraPrincipalAmount: number = 0,
  ): { projectedPrincipal: number | null; projectedInterest: number | null } {
    // Get payments with split data, in chronological order
    const withSplits = allPayments.filter(
      (p) => p.principalAmount !== null && p.interestAmount !== null,
    );

    if (withSplits.length === 0) {
      return { projectedPrincipal: null, projectedInterest: null };
    }

    // Subtract extra principal from principalAmount to get regular principal
    const getRegularPrincipal = (p: PaymentRecord): number => {
      const total = p.principalAmount!;
      // If this payment had memo-based extra, it's already excluded from principalAmount.
      // Only subtract when extraPrincipalAmount was detected from multi-split analysis
      // and this payment's principalAmount includes the extra (no memo-based separation).
      if (
        extraPrincipalAmount > 0 &&
        p.extraPrincipalAmount === null &&
        p.principalSplitAmounts.length >= 2
      ) {
        return Math.max(0, total - extraPrincipalAmount);
      }
      return total;
    };

    if (withSplits.length === 1) {
      return {
        projectedPrincipal: getRegularPrincipal(withSplits[0]),
        projectedInterest: withSplits[0].interestAmount,
      };
    }

    // Use up to the last 6 payments for trend analysis
    const recent = withSplits.slice(-6);
    const principals = recent.map(getRegularPrincipal);
    const interests = recent.map((p) => p.interestAmount!);

    // Verify the amortization pattern:
    // principal should be increasing, interest should be decreasing
    let principalIncreasing = 0;
    let interestDecreasing = 0;
    for (let i = 1; i < recent.length; i++) {
      if (principals[i] >= principals[i - 1]) principalIncreasing++;
      if (interests[i] <= interests[i - 1]) interestDecreasing++;
    }

    const steps = recent.length - 1;
    const hasAmortizationPattern =
      principalIncreasing / steps >= 0.6 && interestDecreasing / steps >= 0.6;

    if (hasAmortizationPattern && recent.length >= 3) {
      // Project the next values by continuing the trend.
      const principalSteps: number[] = [];
      const interestSteps: number[] = [];
      for (let i = 1; i < recent.length; i++) {
        principalSteps.push(principals[i] - principals[i - 1]);
        interestSteps.push(interests[i] - interests[i - 1]);
      }

      const avgPrincipalStep =
        principalSteps.reduce((s, v) => s + v, 0) / principalSteps.length;
      const avgInterestStep =
        interestSteps.reduce((s, v) => s + v, 0) / interestSteps.length;

      const lastPrincipal = principals[principals.length - 1];
      const lastInterest = interests[interests.length - 1];

      const projectedPrincipal = Math.round(
        (lastPrincipal + avgPrincipalStep) * 100,
      ) / 100;
      const projectedInterest = Math.max(
        0,
        Math.round((lastInterest + avgInterestStep) * 100) / 100,
      );

      return { projectedPrincipal, projectedInterest };
    }

    // No clear trend -- return the most recent split values
    const lastRegularPrincipal = getRegularPrincipal(
      withSplits[withSplits.length - 1],
    );
    return {
      projectedPrincipal: lastRegularPrincipal,
      projectedInterest: withSplits[withSplits.length - 1].interestAmount,
    };
  }

  private getPeriodsPerYear(frequency: string): number {
    switch (frequency) {
      case "WEEKLY":
        return 52;
      case "BIWEEKLY":
        return 26;
      case "SEMIMONTHLY":
        return 24;
      case "MONTHLY":
        return 12;
      case "QUARTERLY":
        return 4;
      case "YEARLY":
        return 1;
      default:
        return 12;
    }
  }

  /**
   * Calculate the next due date by advancing one period from the last payment date.
   */
  private calculateNextDueDate(lastDate: string, frequency: string): string {
    const date = new Date(lastDate);

    switch (frequency) {
      case "WEEKLY":
        date.setDate(date.getDate() + 7);
        break;
      case "BIWEEKLY":
        date.setDate(date.getDate() + 14);
        break;
      case "SEMIMONTHLY":
        if (date.getDate() <= 15) {
          // Move to end of month
          date.setMonth(date.getMonth() + 1, 0);
        } else {
          // Move to 15th of next month
          date.setMonth(date.getMonth() + 1, 15);
        }
        break;
      case "MONTHLY":
        date.setMonth(date.getMonth() + 1);
        break;
      case "QUARTERLY":
        date.setMonth(date.getMonth() + 3);
        break;
      case "YEARLY":
        date.setFullYear(date.getFullYear() + 1);
        break;
    }

    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Build a result from a single payment when only one exists.
   */
  private buildSinglePaymentResult(
    account: Account,
    payment: PaymentRecord,
  ): DetectedLoanPayment {
    const extraAmount = payment.extraPrincipalAmount ?? 0;
    const baseAmount =
      extraAmount > 0
        ? Math.round((payment.amount - extraAmount) * 100) / 100
        : payment.amount;
    return {
      paymentAmount: baseAmount,
      paymentFrequency: "MONTHLY", // Default assumption
      confidence: 0.2,
      sourceAccountId: payment.sourceAccountId,
      sourceAccountName: payment.sourceAccountName,
      interestCategoryId: payment.interestCategoryId,
      interestCategoryName: payment.interestCategoryName,
      principalCategoryId: null,
      estimatedInterestRate: null,
      suggestedNextDueDate: this.calculateNextDueDate(payment.date, "MONTHLY"),
      firstPaymentDate: payment.date,
      lastPaymentDate: payment.date,
      paymentCount: 1,
      currentBalance: Math.abs(Number(account.currentBalance)),
      isMortgage: account.accountType === AccountType.MORTGAGE,
      averageExtraPrincipal: payment.extraPrincipalAmount ?? 0,
      extraPrincipalCount: payment.extraPrincipalAmount ? 1 : 0,
      lastPrincipalAmount: payment.principalAmount,
      lastInterestAmount: payment.interestAmount,
    };
  }
}
