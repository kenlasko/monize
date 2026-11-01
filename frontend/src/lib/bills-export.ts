import type { CsvValue } from '@/lib/csv-export';
import {
  nextOccurrenceDueDate,
  nextOccurrenceEffectiveAmount,
} from '@/lib/scheduled-effective-amount';
import { transferCsvLabel } from '@/lib/transfer-label';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

/**
 * A schedule's `transferAccount` is its DESTINATION, so the direction is fixed
 * rather than read off the amount's sign -- the same decision the list's
 * transfer chip makes (`SCHEDULED_TRANSFER_DIRECTION` in
 * `ScheduledTransactionList`). Any negative amount asks `transferCsvLabel` for
 * "To".
 */
const OUTGOING = -1;

/**
 * The headers of the Bills & Deposits export. English literals, as the
 * register's export is (see `transferCsvLabel`): one cell translated under an
 * English header reads worse than either choice made consistently.
 */
export const BILLS_CSV_HEADERS = [
  'Name',
  'Payee',
  'Account',
  'Category',
  'Amount',
  'Currency',
  'Frequency',
  'Next Due Date',
  'Auto-Post',
  'Active',
];

function categoryCell(st: ScheduledTransaction): string {
  if (st.isInvestment) {
    const action = st.investmentAction ?? 'Investment';
    const symbol = st.investmentSecurity?.symbol;
    return symbol ? `${action}: ${symbol}` : action;
  }
  if (st.isSplit && st.splits && st.splits.length > 0) {
    return st.splits
      .map((s) =>
        s.transferAccount
          ? transferCsvLabel(s.transferAccount.name, s.amount)
          : (s.category?.name ?? 'Uncategorized'),
      )
      .join('; ');
  }
  if (st.isTransfer) {
    const transfer = st.transferAccount
      ? transferCsvLabel(st.transferAccount.name, OUTGOING)
      : 'Transfer';
    return [st.category?.name, transfer].filter(Boolean).join('; ');
  }
  return st.category?.name ?? '';
}

/**
 * One row per schedule, carrying the figures the list shows: the NEXT
 * occurrence's effective amount, currency and date (an override included), not
 * the stored template. An amount the server could not price is an empty cell,
 * never a zero.
 */
export function buildBillsCsvRows(
  transactions: readonly ScheduledTransaction[],
): CsvValue[][] {
  return transactions.map((st) => {
    const next = nextOccurrenceEffectiveAmount(st);
    return [
      st.name,
      st.payeeName || st.payee?.name || '',
      st.account?.name ?? '',
      categoryCell(st),
      next.amount === null ? null : Number(next.amount),
      next.currencyCode,
      st.frequency,
      st.nextDueDate ? nextOccurrenceDueDate(st) : '',
      st.autoPost ? 'Yes' : 'No',
      st.isActive ? 'Yes' : 'No',
    ];
  });
}
