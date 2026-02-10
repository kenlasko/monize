import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { TransactionForm } from './TransactionForm';
import { TransactionStatus } from '@/types/transaction';

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    create: vi.fn(),
    update: vi.fn(),
    createTransfer: vi.fn(),
    updateTransfer: vi.fn(),
  },
}));

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: (input: string) => { try { const r = new Function(`"use strict"; return (${input})`)(); return typeof r === 'number' && isFinite(r) ? Math.round(r * 100) / 100 : undefined; } catch { return undefined; } },
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('TransactionForm', () => {
  const mockOnSuccess = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form with mode selector buttons', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });
    expect(screen.getByText('Split')).toBeInTheDocument();
    expect(screen.getByText('Transfer')).toBeInTheDocument();
  });

  it('shows Transaction mode by default', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Transaction')).toBeInTheDocument();
    });

    // In normal mode, the Account select and Payee combobox are shown
    expect(screen.getByText('Account')).toBeInTheDocument();
    expect(screen.getByText('Payee')).toBeInTheDocument();
    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
  });

  it('can switch to Split mode', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Split')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Split'));

    await waitFor(() => {
      expect(screen.getByText('Split Transaction')).toBeInTheDocument();
    });

    // Split mode shows Total Amount instead of Amount
    expect(screen.getByText('Total Amount')).toBeInTheDocument();
  });

  it('can switch to Transfer mode', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transfer'));

    await waitFor(() => {
      expect(screen.getByText('From Account')).toBeInTheDocument();
    });

    expect(screen.getByText('To Account')).toBeInTheDocument();
  });

  it('loads form data (accounts, categories, payees) on mount', async () => {
    const { accountsApi } = await import('@/lib/accounts');
    const { categoriesApi } = await import('@/lib/categories');
    const { payeesApi } = await import('@/lib/payees');

    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(accountsApi.getAll).toHaveBeenCalledTimes(1);
      expect(categoriesApi.getAll).toHaveBeenCalledTimes(1);
      expect(payeesApi.getAll).toHaveBeenCalledTimes(1);
    });
  });

  it('shows "Create Transaction" button for new transaction', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
    });
  });

  it('shows "Update Transaction" button when editing', async () => {
    const existingTransaction = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      userId: 'user-1',
      accountId: '123e4567-e89b-12d3-a456-426614174001',
      account: null,
      transactionDate: '2024-01-15',
      payeeId: null,
      payeeName: 'Test Payee',
      payee: null,
      categoryId: null,
      category: null,
      amount: -50.0,
      currencyCode: 'CAD',
      exchangeRate: 1,
      description: 'Test',
      referenceNumber: null,
      status: TransactionStatus.UNRECONCILED,
      isCleared: false,
      isReconciled: false,
      isVoid: false,
      reconciledDate: null,
      isSplit: false,
      parentTransactionId: null,
      isTransfer: false,
      linkedTransactionId: null,
      createdAt: '2024-01-15T00:00:00Z',
      updatedAt: '2024-01-15T00:00:00Z',
    };

    render(
      <TransactionForm
        transaction={existingTransaction}
        onSuccess={mockOnSuccess}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Update Transaction/i })).toBeInTheDocument();
    });
  });

  it('calls onCancel when Cancel button is clicked', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
    expect(mockOnCancel).toHaveBeenCalledTimes(1);
  });

  it('renders description textarea', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Description')).toBeInTheDocument();
    });
  });

  it('renders status selector with all options', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Status')).toBeInTheDocument();
    });
  });

  it('shows "Create Transfer" button when in transfer mode', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByText('Transfer')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Transfer'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Transfer/i })).toBeInTheDocument();
    });
  });
});
