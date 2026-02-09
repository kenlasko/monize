import { ScheduledTransaction, FrequencyType } from '@/types/scheduled-transaction';
import { Account } from '@/types/account';
import { parseLocalDate } from '@/lib/utils';

export type ForecastPeriod = 'week' | 'month' | '90days' | '6months' | 'year';

export interface ForecastTransaction {
  name: string;
  amount: number;
  scheduledTransactionId: string;
}

export interface ForecastDataPoint {
  date: string;
  balance: number;
  label: string;
  transactions: ForecastTransaction[];
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

function formatDateLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Add interval to a date based on frequency, returning a new Date object.
 */
function addFrequencyInterval(date: Date, frequency: FrequencyType): Date {
  const newDate = new Date(date.getTime());
  switch (frequency) {
    case 'DAILY':
      newDate.setDate(newDate.getDate() + 1);
      break;
    case 'WEEKLY':
      newDate.setDate(newDate.getDate() + 7);
      break;
    case 'BIWEEKLY':
      newDate.setDate(newDate.getDate() + 14);
      break;
    case 'SEMIMONTHLY':
      // Twice a month: 15th and last day of month
      if (newDate.getDate() <= 15) {
        // Go to end of current month
        newDate.setMonth(newDate.getMonth() + 1, 0); // Day 0 of next month = last day of current month
      } else {
        // Go to 15th of next month
        newDate.setMonth(newDate.getMonth() + 1, 15);
      }
      break;
    case 'MONTHLY':
      newDate.setMonth(newDate.getMonth() + 1);
      break;
    case 'QUARTERLY':
      newDate.setMonth(newDate.getMonth() + 3);
      break;
    case 'YEARLY':
      newDate.setFullYear(newDate.getFullYear() + 1);
      break;
  }
  return newDate;
}

/**
 * Generate all occurrence dates for a scheduled transaction within a date range.
 * Uses override amount for the next due date if an override exists.
 */
function generateOccurrences(
  transaction: ScheduledTransaction,
  startDate: Date,
  endDate: Date
): Array<{ date: string; amount: number }> {
  const occurrences: Array<{ date: string; amount: number }> = [];

  if (!transaction.isActive) return occurrences;

  const startTime = startDate.getTime();
  const endTime = endDate.getTime();
  const txEndDate = transaction.endDate ? parseLocalDate(transaction.endDate) : null;
  const txEndTime = txEndDate ? txEndDate.getTime() : null;

  let currentDate = parseLocalDate(transaction.nextDueDate);
  let remainingOccurrences = transaction.occurrencesRemaining;

  // Get the next due date key to check for override
  const nextDueDateKey = formatDateKey(parseLocalDate(transaction.nextDueDate));

  // Determine the amount to use for the next due date (with override if exists)
  const baseAmount = Number(transaction.amount);
  const overrideAmount = transaction.nextOverride?.amount;
  const nextDueAmount = overrideAmount !== null && overrideAmount !== undefined
    ? Number(overrideAmount)
    : baseAmount;

  // For ONCE frequency, just check if it's in range
  if (transaction.frequency === 'ONCE') {
    const currentTime = currentDate.getTime();
    if (currentTime >= startTime && currentTime <= endTime) {
      if (!txEndTime || currentTime <= txEndTime) {
        occurrences.push({
          date: formatDateKey(currentDate),
          amount: nextDueAmount,
        });
      }
    }
    return occurrences;
  }

  // Generate occurrences until we pass the end date or run out of occurrences
  // Limit iterations to prevent infinite loops
  let iterations = 0;
  const maxIterations = 1000;

  while (iterations < maxIterations) {
    iterations++;
    const currentTime = currentDate.getTime();
    const currentDateKey = formatDateKey(currentDate);

    // Check if we've passed the forecast end date
    if (currentTime > endTime) break;

    // Check if we've exceeded the transaction's end date
    if (txEndTime && currentTime > txEndTime) break;

    // Check if we've used all occurrences
    if (remainingOccurrences !== null && remainingOccurrences <= 0) break;

    // Only include if within our forecast range (on or after start date)
    if (currentTime >= startTime) {
      // Use override amount for the next due date, base amount for all others
      const amount = currentDateKey === nextDueDateKey ? nextDueAmount : baseAmount;

      occurrences.push({
        date: currentDateKey,
        amount,
      });

      // Only decrement for occurrences we actually count
      if (remainingOccurrences !== null) {
        remainingOccurrences--;
      }
    }

    // Calculate next date based on frequency
    currentDate = addFrequencyInterval(currentDate, transaction.frequency);
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
 * Build forecast data points for the cash flow chart.
 */
export function buildForecast(
  accounts: Account[],
  transactions: ScheduledTransaction[],
  period: ForecastPeriod,
  accountId: string | 'all'
): ForecastDataPoint[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = FORECAST_PERIOD_DAYS[period];
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + days);

  const granularity = getGranularity(period);

  // Filter accounts
  const targetAccounts = accountId === 'all'
    ? accounts.filter(a => !a.isClosed)
    : accounts.filter(a => a.id === accountId);

  if (targetAccounts.length === 0) {
    return [];
  }

  // Calculate starting balance
  const startingBalance = targetAccounts.reduce(
    (sum, acc) => sum + Number(acc.currentBalance),
    0
  );

  // Filter transactions by account
  const relevantTransactions = accountId === 'all'
    ? transactions.filter(t => t.isActive && !isTransfer(t))
    : transactions.filter(t => t.isActive && t.accountId === accountId);

  // Generate all occurrences and group by date
  const transactionsByDate = new Map<string, ForecastTransaction[]>();

  for (const tx of relevantTransactions) {
    const occurrences = generateOccurrences(tx, today, endDate);
    for (const occ of occurrences) {
      const existing = transactionsByDate.get(occ.date) || [];
      existing.push({
        name: tx.name,
        amount: occ.amount,
        scheduledTransactionId: tx.id,
      });
      transactionsByDate.set(occ.date, existing);
    }
  }

  // Build data points
  const dataPoints: ForecastDataPoint[] = [];
  let currentBalance = startingBalance;
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
      currentBalance += tx.amount;
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
        balance: Math.round(currentBalance * 100) / 100,
        label: formatDateLabel(currentDate),
        transactions: dayTransactions,
      });
      lastAddedTime = currentTime;
    }
  }

  return dataPoints;
}

/**
 * Get summary statistics from forecast data
 */
export function getForecastSummary(dataPoints: ForecastDataPoint[]) {
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
  const startingBalance = balances[0];
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
