import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exportForeignTransactionsCsv } from './fx-fees-csv';
import type { Transaction } from '@/types/transaction';

const mockGetAllPages = vi.fn();
vi.mock('./transactions', () => ({
  transactionsApi: {
    getAllPages: (...args: unknown[]) => mockGetAllPages(...args),
  },
}));

const mockExportToCsv = vi.fn();
vi.mock('./csv-export', () => ({
  exportToCsv: (...args: unknown[]) => mockExportToCsv(...args),
}));

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    userId: 'u',
    accountId: 'acc-1',
    account: { id: 'acc-1', name: 'Travel Card' } as Transaction['account'],
    transactionDate: '2026-07-21',
    payeeId: null,
    payeeName: '39 Carden Street',
    payee: null,
    categoryId: null,
    category: { id: 'c', name: 'Dining Out' } as Transaction['category'],
    amount: -164.21,
    currencyCode: 'CAD',
    exchangeRate: 1.602,
    originalAmount: -100,
    originalCurrencyCode: 'EUR',
    description: 'Dinner',
    referenceNumber: null,
    status: 'UNRECONCILED' as Transaction['status'],
    isCleared: false,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    tags: [],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('exportForeignTransactionsCsv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 and skips the download when there are no accounts or currencies', async () => {
    expect(await exportForeignTransactionsCsv({ accountIds: [], currencyCodes: ['EUR'] })).toBe(0);
    expect(await exportForeignTransactionsCsv({ accountIds: ['a'], currencyCodes: [] })).toBe(0);
    expect(mockGetAllPages).not.toHaveBeenCalled();
    expect(mockExportToCsv).not.toHaveBeenCalled();
  });

  it('returns 0 when the query matches nothing', async () => {
    mockGetAllPages.mockResolvedValue([]);
    expect(
      await exportForeignTransactionsCsv({ accountIds: ['acc-1'], currencyCodes: ['EUR'] }),
    ).toBe(0);
    expect(mockExportToCsv).not.toHaveBeenCalled();
  });

  it('fetches the matching transactions and writes the FX columns to CSV', async () => {
    mockGetAllPages.mockResolvedValue([tx()]);

    const count = await exportForeignTransactionsCsv({
      accountIds: ['acc-1'],
      currencyCodes: ['EUR'],
    });

    expect(count).toBe(1);
    expect(mockGetAllPages).toHaveBeenCalledWith({
      accountIds: ['acc-1'],
      originalCurrencyCodes: ['EUR'],
      pageSize: 200,
    });

    const [filename, headers, rows] = mockExportToCsv.mock.calls[0];
    expect(filename).toMatch(/^Monize_ForeignCurrencyFees_.*\.csv$/);
    expect(headers).toEqual([
      'Date', 'Account', 'Payee', 'Category', 'Description', 'Tags',
      'Amount', 'Currency', 'Paid Currency', 'Paid Amount', 'Fee Paid', 'Status',
    ]);
    const row = rows[0];
    // Amount (account currency), paid currency, paid amount, fee (base 160.20 - 164.21 = 4.01).
    expect(row[6]).toBe(-164.21);
    expect(row[7]).toBe('CAD');
    expect(row[8]).toBe('EUR');
    expect(row[9]).toBe(-100);
    expect(row[10]).toBeCloseTo(4.01, 4);
  });
});
