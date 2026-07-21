import { transactionsApi } from './transactions';
import { exportToCsv } from './csv-export';
import { foreignTransactionFee } from './fx-fees';
import type { Transaction } from '@/types/transaction';

// Matches the Transactions page export format, with the foreign-currency
// columns from the fees table appended (paid currency / amount / fee paid).
const FX_CSV_HEADERS = [
  'Date',
  'Account',
  'Payee',
  'Category',
  'Description',
  'Tags',
  'Amount',
  'Currency',
  'Paid Currency',
  'Paid Amount',
  'Fee Paid',
  'Status',
];

/**
 * The account-currency amount to show, matching the list: when a currency
 * filter has reduced which splits are returned, use the visible-splits total
 * rather than the full transaction amount.
 */
function displayAmount(tx: Transaction): number {
  if (tx.isSplit && tx.splits && tx.splits.length > 0) {
    const splitsSumCents = tx.splits.reduce(
      (sum, s) => sum + Math.round(Number(s.amount) * 10000),
      0,
    );
    const txAmountCents = Math.round(Number(tx.amount) * 10000);
    if (splitsSumCents !== txAmountCents) return splitsSumCents / 10000;
  }
  return Number(tx.amount);
}

function toCsvRow(tx: Transaction): (string | number)[] {
  return [
    tx.transactionDate,
    tx.account?.name ?? '',
    tx.payee?.name ?? tx.payeeName ?? '',
    tx.isSplit && tx.splits
      ? tx.splits.map((s) => s.category?.name || 'Uncategorized').join('; ')
      : (tx.category?.name ?? ''),
    tx.description ?? '',
    tx.tags?.map((t) => t.name).join('; ') ?? '',
    displayAmount(tx),
    tx.currencyCode ?? '',
    tx.originalCurrencyCode ?? '',
    tx.originalAmount ?? '',
    foreignTransactionFee(tx),
    tx.status,
  ];
}

function timestampedFilename(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Monize_ForeignCurrencyFees_${datePart}_${timePart}.csv`;
}

/**
 * Fetch every foreign-currency transaction matching the given accounts and paid
 * currencies and download them as a CSV, mirroring the Transactions page export
 * plus the fees table's currency/paid-amount/fee columns. Returns the number of
 * rows exported (0 means there was nothing to export).
 */
export async function exportForeignTransactionsCsv(params: {
  accountIds: string[];
  /** Resolved paid currencies to include (already defaulted to all foreign). */
  currencyCodes: string[];
}): Promise<number> {
  if (params.accountIds.length === 0 || params.currencyCodes.length === 0) {
    return 0;
  }

  const transactions = await transactionsApi.getAllPages({
    accountIds: params.accountIds,
    originalCurrencyCodes: params.currencyCodes,
    pageSize: 200,
  });

  if (transactions.length === 0) return 0;

  const rows = transactions.map(toCsvRow);
  exportToCsv(timestampedFilename(new Date()), FX_CSV_HEADERS, rows);
  return transactions.length;
}
