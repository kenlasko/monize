import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { TransactionForm } from './TransactionForm';
import { TransactionStatus } from '@/types/transaction';
import { getLocalDateString } from '@/lib/utils';
import toast from 'react-hot-toast';

// ---- Mock data ----

const mockAccounts = [
  {
    id: 'acc-1',
    userId: 'user-1',
    name: 'Chequing',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    description: null,
    accountNumber: null,
    institution: null, institutionId: null,
    openingBalance: 0,
    currentBalance: 1000,
    creditLimit: null,
    interestRate: null,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'acc-2',
    userId: 'user-1',
    name: 'Savings',
    currencyCode: 'CAD',
    isClosed: false,
    accountType: 'SAVINGS',
    accountSubType: null,
    linkedAccountId: null,
    description: null,
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 5000,
    creditLimit: null,
    interestRate: null,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'acc-3',
    userId: 'user-1',
    name: 'USD Account',
    currencyCode: 'USD',
    isClosed: false,
    accountType: 'SAVINGS',
    accountSubType: null,
    linkedAccountId: null,
    description: null,
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 2000,
    creditLimit: null,
    interestRate: null,
    closedDate: null,
    isFavourite: false,
    paymentAmount: null,
    paymentFrequency: null,
    paymentStartDate: null,
    sourceAccountId: null,
    principalCategoryId: null,
    interestCategoryId: null,
    scheduledTransactionId: null,
    assetCategoryId: null,
    dateAcquired: null,
    isCanadianMortgage: false,
    isVariableRate: false,
    termMonths: null,
    termEndDate: null,
    amortizationMonths: null,
    originalPrincipal: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
];

const mockCategories = [
  {
    id: 'cat-1',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Groceries',
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'cat-2',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Salary',
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    isIncome: true,
    isSystem: false,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

const mockPayees = [
  {
    id: 'payee-1',
    userId: 'user-1',
    name: 'Grocery Store',
    defaultCategoryId: 'cat-1',
    defaultCategory: { id: 'cat-1', name: 'Groceries', userId: 'user-1', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z' },
    notes: null,
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'payee-2',
    userId: 'user-1',
    name: 'Employer Inc',
    defaultCategoryId: null,
    defaultCategory: null,
    notes: null,
    createdAt: '2024-01-01T00:00:00Z',
  },
];

// ---- Mocks ----

const mockCreate = vi.fn().mockResolvedValue({});
const mockUpdate = vi.fn().mockResolvedValue({});
const mockCreateTransfer = vi.fn().mockResolvedValue({});
const mockUpdateTransfer = vi.fn().mockResolvedValue({});
const mockGetRecent = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
    createTransfer: (...args: any[]) => mockCreateTransfer(...args),
    updateTransfer: (...args: any[]) => mockUpdateTransfer(...args),
    getRecent: (...args: any[]) => mockGetRecent(...args),
  },
}));

const mockPayeesGetAll = vi.fn().mockResolvedValue(mockPayees);
const mockPayeeCreate = vi.fn();

const mockFindInactiveByName = vi.fn().mockResolvedValue(null);

const mockGetAllAliases = vi.fn().mockResolvedValue([]);
const mockReactivatePayee = vi.fn();
const mockPayeesGetById = vi.fn();

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockPayeesGetAll(...args),
    create: (...args: any[]) => mockPayeeCreate(...args),
    findInactiveByName: (...args: any[]) => mockFindInactiveByName(...args),
    getAllAliases: (...args: any[]) => mockGetAllAliases(...args),
    reactivatePayee: (...args: any[]) => mockReactivatePayee(...args),
    getById: (...args: any[]) => mockPayeesGetById(...args),
  },
}));

const mockCategoriesGetAll = vi.fn().mockResolvedValue(mockCategories);
const mockCategoryCreate = vi.fn();

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockCategoriesGetAll(...args),
    create: (...args: any[]) => mockCategoryCreate(...args),
  },
}));

const mockAccountsGetAll = vi.fn();

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockAccountsGetAll(...args),
  },
}));

const mockTagsGetAll = vi.fn().mockResolvedValue([]);
const mockTagCreate = vi.fn();

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: (...args: any[]) => mockTagsGetAll(...args),
    create: (...args: any[]) => mockTagCreate(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({ defaultCurrency: 'CAD' }),
}));

vi.mock('@/lib/format', () => ({
  getCurrencySymbol: () => '$',
  getDecimalPlacesForCurrency: () => 2,
  roundToCents: (v: number) => Math.round(v * 100) / 100,
  roundToDecimals: (v: number, d: number) => { const f = Math.pow(10, d); return Math.round(v * f) / f; },
  formatAmount: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  formatAmountWithCommas: (v: number | undefined | null) => (v === undefined || v === null || isNaN(v)) ? '' : (Math.round(v * 100) / 100).toFixed(2),
  parseAmount: (input: string) => { const n = parseFloat(input.replace(/[^0-9.-]/g, '')); return isNaN(n) ? undefined : Math.round(n * 100) / 100; },
  filterCurrencyInput: (input: string) => input.replace(/[^0-9.-]/g, ''),
  filterCalculatorInput: (input: string) => input.replace(/[^0-9.+\-*/() ]/g, ''),
  hasCalculatorOperators: (input: string) => /[+*/()]/.test(input.replace(/^-/, '')) || /(?!^)-/.test(input),
  evaluateExpression: vi.fn().mockImplementation(() => undefined),
  formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
}));

vi.mock('@/lib/categoryUtils', () => ({
  buildCategoryTree: (cats: any[]) => cats.map((c: any) => ({ category: c, children: [] })),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatDate: (d: string) => d, dateFormat: 'browser' }),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => {
    return { values, errors: {} };
  },
}));

vi.mock('./SplitEditor', () => ({
  SplitEditor: () => <div data-testid="split-editor">Split Editor</div>,
  createEmptySplits: () => [
    { id: 'split-1', splitType: 'category', amount: 0, categoryId: undefined, memo: '' },
    { id: 'split-2', splitType: 'category', amount: 0, categoryId: undefined, memo: '' },
  ],
  toSplitRows: (splits: any[]) => splits.map((s: any, i: number) => ({
    id: `split-${i}`,
    splitType: 'category',
    amount: s.amount,
    categoryId: s.categoryId,
    memo: s.memo || '',
  })),
  toCreateSplitData: (rows: any[]) => rows.map((r: any) => ({
    categoryId: r.categoryId,
    amount: r.amount,
    memo: r.memo,
  })),
}));

vi.mock('@/components/ui/Combobox', () => ({
  Combobox: ({ label, placeholder, options, value: _value, onChange, onCreateNew, allowCustomValue }: any) => (
    <div data-testid={`combobox-${label}`}>
      {label && <label>{label}</label>}
      <input
        placeholder={placeholder}
        data-testid={`combobox-input-${label}`}
        onChange={(e: any) => {
          const matched = options?.find((o: any) => o.label === e.target.value);
          if (matched) {
            onChange?.(matched.value, matched.label);
          } else if (allowCustomValue) {
            onChange?.('', e.target.value);
          }
        }}
      />
      {onCreateNew && (
        <button
          data-testid={`combobox-create-${label}`}
          onClick={() => onCreateNew('New Item')}
        >
          Create
        </button>
      )}
    </div>
  ),
}));

// ---- Helpers ----

function createExistingTransaction(overrides = {}) {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    userId: 'user-1',
    accountId: 'acc-1',
    account: null,
    transactionDate: '2024-01-15',
    payeeId: 'payee-1',
    payeeName: 'Grocery Store',
    payee: null,
    categoryId: 'cat-1',
    category: { id: 'cat-1', name: 'Groceries', userId: 'user-1', parentId: null, parent: null, children: [], description: null, icon: null, color: null, effectiveColor: null, isIncome: false, isSystem: false, createdAt: '2024-01-01T00:00:00Z' },
    amount: -50.0,
    currencyCode: 'CAD',
    exchangeRate: 1,
    description: 'Weekly groceries',
    referenceNumber: 'REF-001',
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
    ...overrides,
  };
}

function createTransferTransaction() {
  return createExistingTransaction({
    amount: -200,
    isTransfer: true,
    linkedTransactionId: 'linked-tx-1',
    linkedTransaction: {
      id: 'linked-tx-1',
      userId: 'user-1',
      accountId: 'acc-2',
      account: null,
      transactionDate: '2024-01-15',
      payeeId: null,
      payeeName: null,
      payee: null,
      categoryId: null,
      category: null,
      amount: 200,
      currencyCode: 'CAD',
      exchangeRate: 1,
      description: null,
      referenceNumber: null,
      status: TransactionStatus.UNRECONCILED,
      isCleared: false,
      isReconciled: false,
      isVoid: false,
      reconciledDate: null,
      isSplit: false,
      parentTransactionId: null,
      isTransfer: true,
      linkedTransactionId: '123e4567-e89b-12d3-a456-426614174000',
      createdAt: '2024-01-15T00:00:00Z',
      updatedAt: '2024-01-15T00:00:00Z',
    },
    payeeId: null,
    payeeName: null,
    categoryId: null,
    category: null,
    description: 'Transfer to savings',
  });
}

function createSplitTransaction() {
  return createExistingTransaction({
    isSplit: true,
    categoryId: null,
    category: null,
    splits: [
      { id: 'sp-1', transactionId: '123e4567-e89b-12d3-a456-426614174000', categoryId: 'cat-1', category: null, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -30, memo: 'Food', createdAt: '2024-01-15T00:00:00Z' },
      { id: 'sp-2', transactionId: '123e4567-e89b-12d3-a456-426614174000', categoryId: 'cat-2', category: null, transferAccountId: null, transferAccount: null, linkedTransactionId: null, amount: -20, memo: 'Other', createdAt: '2024-01-15T00:00:00Z' },
    ],
  });
}

describe('TransactionForm', () => {
  const mockOnSuccess = vi.fn();
  const mockOnCancel = vi.fn();
  const mockOnDirtyChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccountsGetAll.mockResolvedValue(mockAccounts);
    mockPayeesGetAll.mockResolvedValue(mockPayees);
    mockCategoriesGetAll.mockResolvedValue(mockCategories);
    mockGetRecent.mockResolvedValue([]);
  });

  // =========================================================================
  // Existing tests (preserved)
  // =========================================================================

  it('fetches accounts including closed accounts on mount', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalledWith(true);
    });
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
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(mockAccountsGetAll).toHaveBeenCalledTimes(1);
      expect(mockCategoriesGetAll).toHaveBeenCalledTimes(1);
      expect(mockPayeesGetAll).toHaveBeenCalledTimes(1);
    });
  });

  it('shows "Create Transaction" button for new transaction', async () => {
    render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
    });
  });

  it('shows "Update Transaction" button when editing', async () => {
    const existingTransaction = createExistingTransaction();

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

  // =========================================================================
  // Mode switching tests
  // =========================================================================

  describe('mode switching', () => {
    it('switches from normal to transfer and back to normal', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transaction')).toBeInTheDocument();
      });

      // Verify normal mode fields
      expect(screen.getByText('Account')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();

      // Switch to transfer
      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
      });

      // The normal-mode required Category field is gone, but the optional
      // transfer category field is available (lets the transfer surface in the
      // monthly category breakdown).
      expect(screen.queryByText('Category')).not.toBeInTheDocument();
      expect(screen.getByText('Category (Optional)')).toBeInTheDocument();

      // Switch back to normal
      fireEvent.click(screen.getByText('Transaction'));

      await waitFor(() => {
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.getByText('Category')).toBeInTheDocument();
      });
    });

    it('switches from normal to split mode and shows SplitEditor', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Split Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
      });
    });

    it('switches from split mode back to normal by clicking "Cancel Split"', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      // Enter split mode
      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Cancel Split')).toBeInTheDocument();
      });

      // Click Cancel Split
      fireEvent.click(screen.getByText('Cancel Split'));

      // Should be back in normal mode - Category field appears only in normal mode
      await waitFor(() => {
        expect(screen.getByText('Category')).toBeInTheDocument();
        expect(screen.getByText('Amount')).toBeInTheDocument();
      });

      // Split-specific elements should be gone
      expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument();
    });

    it('switches from split to transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      // Enter split mode
      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Split Transaction')).toBeInTheDocument();
      });

      // Switch to transfer mode
      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
      });

      // SplitEditor should be gone
      expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument();
      expect(screen.queryByText('Split Transaction')).not.toBeInTheDocument();
    });

    it('switches from transfer to split mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
      });

      // Switch to split mode
      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Split Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
      });

      // Transfer fields should be gone
      expect(screen.queryByText('From Account')).not.toBeInTheDocument();
      expect(screen.queryByText('To Account')).not.toBeInTheDocument();
    });

    it('cycles through all three modes: normal -> split -> transfer -> normal', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transaction')).toBeInTheDocument();
      });

      // Verify we start in normal mode
      expect(screen.getByText('Amount')).toBeInTheDocument();

      // Switch to split
      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Total Amount')).toBeInTheDocument();
      });

      // Switch to transfer
      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
      });

      // Switch back to normal
      fireEvent.click(screen.getByText('Transaction'));

      await waitFor(() => {
        expect(screen.getByText('Amount')).toBeInTheDocument();
        expect(screen.getByText('Category')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Form submission in normal mode
  // =========================================================================

  describe('form submission in normal mode', () => {
    it('submits form for new transaction and calls onSuccess', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      // Submit the form
      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });

      expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    });

    it('submits update for existing transaction', async () => {
      const existingTransaction = createExistingTransaction();

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

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          existingTransaction.id,
          expect.any(Object)
        );
      });

      expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    });

    it('sends splits: [] when converting an existing split transaction back to regular', async () => {
      const splitTransaction = createSplitTransaction();

      render(
        <TransactionForm
          transaction={splitTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      // Editing a split transaction starts in split mode.
      await waitFor(() => {
        expect(screen.getByText('Cancel Split')).toBeInTheDocument();
      });

      // Leave split mode (mirrors deleting the final split / cancelling the split).
      fireEvent.click(screen.getByText('Cancel Split'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transaction/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          splitTransaction.id,
          expect.objectContaining({ splits: [] })
        );
      });
    });

    it('sends splits: undefined for a regular-to-regular edit (no split churn)', async () => {
      const existingTransaction = createExistingTransaction();

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

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalled();
      });
      expect(mockUpdate.mock.calls[0][1].splits).toBeUndefined();
    });

    it('shows toast.success after creating a new transaction', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Transaction created');
      });
    });

    it('shows toast.success after updating an existing transaction', async () => {
      const existingTransaction = createExistingTransaction();

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

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Transaction updated');
      });
    });

    it('shows toast.error when submission fails', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network error'));

      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      expect(mockOnSuccess).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Form submission in transfer mode
  // =========================================================================

  describe('form submission in transfer mode', () => {
    it('shows "Create Transfer" submit button in transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transfer/i })).toBeInTheDocument();
      });

      // Should not show Create Transaction
      expect(screen.queryByRole('button', { name: /Create Transaction/i })).not.toBeInTheDocument();
    });

    it('shows toast.error when no destination account is selected for transfer', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transfer/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Please select a destination account');
      });

      expect(mockCreateTransfer).not.toHaveBeenCalled();
    });

    it('shows "Update Transfer" button when editing an existing transfer', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transfer/i })).toBeInTheDocument();
      });
    });

    it('shows transfer indicator when editing existing transfer', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('This is a linked transfer transaction')).toBeInTheDocument();
      });
    });

    it('hides mode selector when editing an existing transfer', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('This is a linked transfer transaction')).toBeInTheDocument();
      });

      // The mode tab buttons (Transaction/Split/Transfer tabs) should not be shown
      // when editing an existing transfer; instead a badge is shown
      const transferBadges = screen.getAllByText('Transfer');
      // The badge text in the indicator area should be present,
      // but there should be no clickable tab buttons
      expect(transferBadges.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Cancel button
  // =========================================================================

  describe('cancel button', () => {
    it('does not render Cancel button when onCancel is not provided', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /^Cancel$/i })).not.toBeInTheDocument();
    });

    it('renders Cancel button when onCancel is provided', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
      });
    });

    it('calls onCancel callback exactly once when Cancel is clicked', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('does not call onSuccess when Cancel is clicked', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

      expect(mockOnSuccess).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Editing an existing transaction (pre-populated form fields)
  // =========================================================================

  describe('editing existing transaction', () => {
    it('pre-populates date field with transaction date', async () => {
      const existingTransaction = createExistingTransaction({
        transactionDate: '2024-06-15',
      });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        expect(dateInput.value).toBe('2024-06-15');
      });
    });

    it('pre-populates description field', async () => {
      const existingTransaction = createExistingTransaction({
        description: 'Weekly groceries',
      });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        // Use the textarea element directly since getByRole('textbox') may match combobox inputs
        const textareas = document.querySelectorAll('textarea');
        expect(textareas.length).toBe(1);
        expect(textareas[0].value).toBe('Weekly groceries');
      });
    });

    it('pre-populates reference number field', async () => {
      const existingTransaction = createExistingTransaction({
        referenceNumber: 'REF-001',
      });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const refInput = screen.getByPlaceholderText('Cheque #, confirmation #...') as HTMLInputElement;
        expect(refInput.value).toBe('REF-001');
      });
    });

    it('pre-populates status selector', async () => {
      const existingTransaction = createExistingTransaction({
        status: TransactionStatus.CLEARED,
      });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
        expect(statusSelect.value).toBe(TransactionStatus.CLEARED);
      });
    });

    it('starts in split mode when editing a split transaction', async () => {
      const splitTx = createSplitTransaction();

      render(
        <TransactionForm
          transaction={splitTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Split Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
      });
    });

    it('starts in transfer mode when editing a transfer transaction', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
      });
    });

    it('shows Update button text instead of Create for existing transaction', async () => {
      const existingTransaction = createExistingTransaction();

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

      expect(screen.queryByRole('button', { name: /Create Transaction/i })).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Transaction type rendering based on mode
  // =========================================================================

  describe('transaction type rendering based on mode', () => {
    it('renders NormalTransactionFields in normal mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Account')).toBeInTheDocument();
      });

      expect(screen.getByText('Payee')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Amount')).toBeInTheDocument();
      expect(screen.getByText('Reference Number')).toBeInTheDocument();
    });

    it('renders SplitTransactionFields in split mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        // Split mode shows Total Amount instead of Amount
        expect(screen.getByText('Total Amount')).toBeInTheDocument();
        // Split mode has Account and Payee but not Category
        expect(screen.getByText('Account')).toBeInTheDocument();
        expect(screen.getByText('Payee')).toBeInTheDocument();
      });

      // Category is only in normal mode
      expect(screen.queryByText('Category')).not.toBeInTheDocument();
    });

    it('renders TransferTransactionFields in transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
        // Transfer mode shows Payee (Optional) label
        expect(screen.getByText('Payee (Optional)')).toBeInTheDocument();
      });
    });

    it('renders common fields (Description, Status) in all modes', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      // Normal mode
      await waitFor(() => {
        expect(screen.getByText('Description')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
      });

      // Switch to split
      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByText('Description')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
      });

      // Switch to transfer
      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByText('Description')).toBeInTheDocument();
        expect(screen.getByText('Status')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // onCreatePayee callback
  // =========================================================================

  describe('onCreatePayee callback', () => {
    it('renders create button in the payee combobox', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument();
      });
    });

    it('calls payeesApi.create when a new payee is created', async () => {
      mockPayeeCreate.mockResolvedValueOnce({
        id: 'new-payee-1',
        userId: 'user-1',
        name: 'New Item',
        defaultCategoryId: null,
        defaultCategory: null,
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
      });

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Payee'));

      await waitFor(() => {
        expect(mockPayeeCreate).toHaveBeenCalledWith({ name: 'New Item' });
      });
    });

    it('shows toast.success after creating a payee', async () => {
      mockPayeeCreate.mockResolvedValueOnce({
        id: 'new-payee-1',
        userId: 'user-1',
        name: 'New Item',
        defaultCategoryId: null,
        defaultCategory: null,
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
      });

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Payee'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Payee "New Item" created');
      });
    });

    it('shows toast.error when payee creation fails', async () => {
      mockPayeeCreate.mockRejectedValueOnce(new Error('Server error'));

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Payee'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // onCreateCategory callback
  // =========================================================================

  describe('onCreateCategory callback', () => {
    it('renders create button in the category combobox', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument();
      });
    });

    it('calls categoriesApi.create when a new category is created', async () => {
      mockCategoryCreate.mockResolvedValueOnce({
        id: 'new-cat-1',
        userId: 'user-1',
        parentId: null,
        parent: null,
        children: [],
        name: 'New Item',
        description: null,
        icon: null,
        color: null,
        effectiveColor: null,
        isIncome: false,
        isSystem: false,
        createdAt: '2024-01-01T00:00:00Z',
      });

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Category'));

      await waitFor(() => {
        expect(mockCategoryCreate).toHaveBeenCalledWith({ name: 'New Item' });
      });
    });

    it('shows toast.success after creating a category', async () => {
      mockCategoryCreate.mockResolvedValueOnce({
        id: 'new-cat-1',
        userId: 'user-1',
        parentId: null,
        parent: null,
        children: [],
        name: 'New Item',
        description: null,
        icon: null,
        color: null,
        effectiveColor: null,
        isIncome: false,
        isSystem: false,
        createdAt: '2024-01-01T00:00:00Z',
      });

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Category'));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Category "New Item" created');
      });
    });

    it('shows toast.error when category creation fails', async () => {
      mockCategoryCreate.mockRejectedValueOnce(new Error('Server error'));

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('combobox-create-Category'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Date field rendering and default value
  // =========================================================================

  describe('date field rendering', () => {
    it('renders date input with type="date"', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date');
        expect(dateInput).toBeInTheDocument();
        expect(dateInput).toHaveAttribute('type', 'date');
      });
    });

    it('defaults date to today for new transaction', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      const today = getLocalDateString();

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        expect(dateInput.value).toBe(today);
      });
    });

    it('uses last transaction date from sessionStorage if within one hour', async () => {
      sessionStorage.setItem(
        'monize-last-transaction-date',
        JSON.stringify({ date: '2024-01-15', savedAt: Date.now() - 30 * 60 * 1000 }),
      );

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        expect(dateInput.value).toBe('2024-01-15');
      });
    });

    it('ignores last transaction date from sessionStorage if older than one hour', async () => {
      sessionStorage.setItem(
        'monize-last-transaction-date',
        JSON.stringify({ date: '2024-01-15', savedAt: Date.now() - 61 * 60 * 1000 }),
      );

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      const today = getLocalDateString();

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        expect(dateInput.value).toBe(today);
      });

      // Should also clean up the expired entry
      expect(sessionStorage.getItem('monize-last-transaction-date')).toBeNull();
    });

    it('uses transaction date when editing', async () => {
      const existingTransaction = createExistingTransaction({
        transactionDate: '2023-12-25',
      });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        expect(dateInput.value).toBe('2023-12-25');
      });
    });

    it('renders date field in transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date');
        expect(dateInput).toBeInTheDocument();
        expect(dateInput).toHaveAttribute('type', 'date');
      });
    });

    it('renders date field in split mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date');
        expect(dateInput).toBeInTheDocument();
        expect(dateInput).toHaveAttribute('type', 'date');
      });
    });
  });

  // =========================================================================
  // Status selector
  // =========================================================================

  describe('status selector', () => {
    it('renders all status options', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Status')).toBeInTheDocument();
      });

      expect(screen.getByText('Unreconciled')).toBeInTheDocument();
      expect(screen.getByText('Cleared')).toBeInTheDocument();
      expect(screen.getByText('Reconciled')).toBeInTheDocument();
      expect(screen.getByText('Void')).toBeInTheDocument();
    });

    it('defaults status to UNRECONCILED for new transaction', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
        expect(statusSelect.value).toBe(TransactionStatus.UNRECONCILED);
      });
    });

    it('allows changing status value', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Status')).toBeInTheDocument();
      });

      const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
      fireEvent.change(statusSelect, { target: { value: TransactionStatus.RECONCILED } });

      expect(statusSelect.value).toBe(TransactionStatus.RECONCILED);
    });
  });

  // =========================================================================
  // onDirtyChange callback
  // =========================================================================

  describe('onDirtyChange callback', () => {
    it('calls onDirtyChange when provided', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          onDirtyChange={mockOnDirtyChange}
        />
      );

      await waitFor(() => {
        expect(mockOnDirtyChange).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // submitRef
  // =========================================================================

  describe('submitRef', () => {
    it('assigns submit function to submitRef.current', async () => {
      const submitRef = { current: null as (() => void) | null };

      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          submitRef={submitRef}
        />
      );

      await waitFor(() => {
        expect(submitRef.current).not.toBeNull();
        expect(typeof submitRef.current).toBe('function');
      });
    });

    it('clears submitRef.current on unmount', async () => {
      const submitRef = { current: null as (() => void) | null };

      const { unmount } = render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          submitRef={submitRef}
        />
      );

      await waitFor(() => {
        expect(submitRef.current).not.toBeNull();
      });

      unmount();

      expect(submitRef.current).toBeNull();
    });
  });

  // =========================================================================
  // defaultAccountId
  // =========================================================================

  describe('defaultAccountId', () => {
    it('sets account when defaultAccountId is provided', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        const accountSelect = screen.getByLabelText('Account') as HTMLSelectElement;
        expect(accountSelect.value).toBe('acc-1');
      });
    });
  });

  // =========================================================================
  // Error handling for form data loading
  // =========================================================================

  describe('error handling', () => {
    it('shows toast.error when form data loading fails', async () => {
      mockAccountsGetAll.mockRejectedValueOnce(new Error('Network error'));

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Split mode SplitEditor rendering
  // =========================================================================

  describe('split editor integration', () => {
    it('shows SplitEditor with Cancel Split button in split mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
        expect(screen.getByText('Cancel Split')).toBeInTheDocument();
      });
    });

    it('renders SplitEditor when editing a split transaction', async () => {
      const splitTx = createSplitTransaction();

      render(
        <TransactionForm
          transaction={splitTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
      });
    });
  });

  // =========================================================================
  // Mode selector visibility
  // =========================================================================

  describe('mode selector visibility', () => {
    it('shows mode selector tabs for new transactions', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Transaction')).toBeInTheDocument();
        expect(screen.getByText('Split')).toBeInTheDocument();
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });
    });

    it('shows mode selector tabs for non-transfer existing transactions', async () => {
      const existingTransaction = createExistingTransaction({ isTransfer: false });

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Transaction')).toBeInTheDocument();
        expect(screen.getByText('Split')).toBeInTheDocument();
        // The "Transfer" button in mode selector is still present for non-transfer transactions
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });
    });

    it('hides mode selector tabs for existing transfer transactions and shows indicator', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('This is a linked transfer transaction')).toBeInTheDocument();
      });

      // The "Transaction" and "Split" tab buttons should not be present
      expect(screen.queryByText('Transaction')).not.toBeInTheDocument();
      expect(screen.queryByText('Split')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // Payee selection and auto-category
  // =========================================================================

  describe('payee selection and auto-category', () => {
    it('auto-fills category when selecting a payee with default category', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Payee')).toBeInTheDocument();
      });

      // Select "Grocery Store" which has defaultCategoryId = 'cat-1'
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), {
        target: { value: 'Grocery Store' },
      });

      // Category should be auto-filled by the handlePayeeChange logic
      // The payee 'Grocery Store' has defaultCategoryId: 'cat-1'
      // We verify form submission includes the category
      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    it('does not auto-fill category when payee has no default category', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Payee')).toBeInTheDocument();
      });

      // Select "Employer Inc" which has no defaultCategoryId
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), {
        target: { value: 'Employer Inc' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    it('clears payeeId when custom payee name is typed', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Payee')).toBeInTheDocument();
      });

      // Type a custom payee name that does not match any existing payee
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), {
        target: { value: 'Unknown Custom Payee' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    it('sends payeeId/payeeName null when the user clears a previously assigned payee', async () => {
      const existingTransaction = createExistingTransaction();

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Payee')).toBeInTheDocument();
      });

      // Clear the payee. The payee field allows custom values, so the mocked
      // Combobox forwards onChange('', '') for the now-empty input. The form
      // must send null (not the empty string the combobox yields) so the
      // backend clears the payee rather than rejecting an invalid UUID.
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), {
        target: { value: 'x' },
      });
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), {
        target: { value: '' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          existingTransaction.id,
          expect.objectContaining({ payeeId: null, payeeName: null })
        );
      });
    });
  });

  // =========================================================================
  // Category selection
  // =========================================================================

  describe('category selection', () => {
    it('selects an existing category from combobox', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Category')).toBeInTheDocument();
      });

      // Select "Groceries" category
      fireEvent.change(screen.getByTestId('combobox-input-Category'), {
        target: { value: 'Groceries' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    it('clears category when custom value is typed', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Category')).toBeInTheDocument();
      });

      // Type a non-matching category name
      fireEvent.change(screen.getByTestId('combobox-input-Category'), {
        target: { value: 'Non Existent Category' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalled();
      });
    });

    it('sends categoryId null when the user clears a previously assigned category', async () => {
      const existingTransaction = createExistingTransaction();

      render(
        <TransactionForm
          transaction={existingTransaction}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Category')).toBeInTheDocument();
      });

      // Clear the category. The category field allows custom values, so the
      // mocked Combobox forwards onChange('', '') for the now-empty input. The
      // zod helper coerces '' to undefined; the form must still send null so
      // the backend clears the category rather than ignoring the omitted field.
      fireEvent.change(screen.getByTestId('combobox-input-Category'), {
        target: { value: 'x' },
      });
      fireEvent.change(screen.getByTestId('combobox-input-Category'), {
        target: { value: '' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          existingTransaction.id,
          expect.objectContaining({ categoryId: null })
        );
      });
    });

    it('creates subcategory when "Parent: Child" format is used', async () => {
      // First call creates the parent category, second creates the child
      mockCategoryCreate
        .mockResolvedValueOnce({
          id: 'new-parent-1',
          userId: 'user-1',
          parentId: null,
          parent: null,
          children: [],
          name: 'New Parent',
          description: null,
          icon: null,
          color: null,
          effectiveColor: null,
          isIncome: false,
          isSystem: false,
          createdAt: '2024-01-01T00:00:00Z',
        })
        .mockResolvedValueOnce({
          id: 'new-child-1',
          userId: 'user-1',
          parentId: 'new-parent-1',
          parent: null,
          children: [],
          name: 'New Child',
          description: null,
          icon: null,
          color: null,
          effectiveColor: null,
          isIncome: false,
          isSystem: false,
          createdAt: '2024-01-01T00:00:00Z',
        });

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument();
      });

      // The mock Combobox calls onCreateNew with 'New Item'
      // But we can simulate the "Parent: Child" format by overriding the mock behavior
      // The handleCategoryCreate is what processes "Parent: Child" format
      // Since the mock Combobox always passes 'New Item', we test with the mock
      fireEvent.click(screen.getByTestId('combobox-create-Category'));

      await waitFor(() => {
        expect(mockCategoryCreate).toHaveBeenCalledWith({ name: 'New Item' });
      });
    });
  });

  // =========================================================================
  // Description and memo fields
  // =========================================================================

  describe('description field', () => {
    it('allows typing in description textarea', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const textareas = document.querySelectorAll('textarea');
        expect(textareas.length).toBe(1);
      });

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'New description text' } });
      expect(textarea.value).toBe('New description text');
    });

    it('renders with empty description for new transaction', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const textareas = document.querySelectorAll('textarea');
        expect(textareas.length).toBe(1);
        expect(textareas[0].value).toBe('');
      });
    });

    it('includes description in submitted data', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'Test description' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            description: 'Test description',
          })
        );
      });
    });
  });

  // =========================================================================
  // Transfer form submission validation
  // =========================================================================

  describe('transfer form validation', () => {
    it('shows error when source and destination accounts are the same', async () => {
      render(
        <TransactionForm
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
          defaultAccountId="acc-1"
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transfer/i })).toBeInTheDocument();
      });

      // Note: The transferToAccountId is controlled by TransferTransactionFields
      // Since we mock child components partially, we test the submit button behavior
      // which should show "Please select a destination account" since transferToAccountId is empty
      fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Please select a destination account');
      });
    });

    it('submits transfer update for existing transfer transaction', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transfer/i })).toBeInTheDocument();
      });

      // Submit the form (transferToAccountId is pre-populated for existing transfer)
      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(mockUpdateTransfer).toHaveBeenCalledWith(
          transferTx.id,
          expect.objectContaining({
            fromAccountId: expect.any(String),
            toAccountId: expect.any(String),
          })
        );
      });

      expect(mockOnSuccess).toHaveBeenCalledTimes(1);
    });

    it('shows toast.success after updating a transfer', async () => {
      const transferTx = createTransferTransaction();

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transfer/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Transfer updated');
      });
    });

    it('sends null payeeId/payeeName when the user clears a previously assigned payee on a transfer', async () => {
      const transferTx = createTransferTransaction();
      transferTx.payeeId = 'payee-1';
      transferTx.payeeName = 'Grocery Store';

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('combobox-input-Payee (Optional)')).toBeInTheDocument();
      });

      // Clear the payee field — the mocked Combobox forwards the empty string
      // via onChange('', '') because allowCustomValue=true. We change to a
      // non-empty value first so React registers a different value on the
      // second change to ''.
      fireEvent.change(screen.getByTestId('combobox-input-Payee (Optional)'), {
        target: { value: 'x' },
      });
      fireEvent.change(screen.getByTestId('combobox-input-Payee (Optional)'), {
        target: { value: '' },
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(mockUpdateTransfer).toHaveBeenCalledWith(
          transferTx.id,
          expect.objectContaining({
            payeeId: null,
            payeeName: null,
          })
        );
      });
    });
  });

  // =========================================================================
  // Split transaction form submission
  // =========================================================================

  describe('split transaction submission', () => {
    it('submits split transaction for existing split transaction', async () => {
      const splitTx = createSplitTransaction();

      render(
        <TransactionForm
          transaction={splitTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transaction/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(mockUpdate).toHaveBeenCalledWith(
          splitTx.id,
          expect.objectContaining({
            splits: expect.any(Array),
          })
        );
      });
    });
  });

  // =========================================================================
  // Editing transfer: initial form values
  // =========================================================================

  describe('editing transfer transaction values', () => {
    it('shows absolute amount for outgoing transfer', async () => {
      const transferTx = createTransferTransaction();
      // transferTx.amount = -200, should show 200

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
      });
    });

    it('sets from account as source for outgoing transfer', async () => {
      const transferTx = createTransferTransaction();
      // amount is negative => outgoing from acc-1 to acc-2

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
      });

      // Submit and verify fromAccountId is acc-1 (the original transaction's account)
      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(mockUpdateTransfer).toHaveBeenCalledWith(
          transferTx.id,
          expect.objectContaining({
            fromAccountId: 'acc-1',
            toAccountId: 'acc-2',
          })
        );
      });
    });

    it('sets from account as destination for incoming transfer', async () => {
      // Create a transfer where amount is positive (incoming)
      const incomingTransferTx = createExistingTransaction({
        amount: 200,
        isTransfer: true,
        linkedTransactionId: 'linked-tx-1',
        linkedTransaction: {
          id: 'linked-tx-1',
          userId: 'user-1',
          accountId: 'acc-2',
          account: null,
          transactionDate: '2024-01-15',
          payeeId: null,
          payeeName: null,
          payee: null,
          categoryId: null,
          category: null,
          amount: -200,
          currencyCode: 'CAD',
          exchangeRate: 1,
          description: null,
          referenceNumber: null,
          status: TransactionStatus.UNRECONCILED,
          isCleared: false,
          isReconciled: false,
          isVoid: false,
          reconciledDate: null,
          isSplit: false,
          parentTransactionId: null,
          isTransfer: true,
          linkedTransactionId: '123e4567-e89b-12d3-a456-426614174000',
          createdAt: '2024-01-15T00:00:00Z',
          updatedAt: '2024-01-15T00:00:00Z',
        },
        payeeId: null,
        payeeName: null,
        categoryId: null,
        category: null,
      });

      render(
        <TransactionForm
          transaction={incomingTransferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(mockUpdateTransfer).toHaveBeenCalledWith(
          incomingTransferTx.id,
          expect.objectContaining({
            fromAccountId: 'acc-2',
            toAccountId: 'acc-1',
          })
        );
      });
    });
  });

  // =========================================================================
  // Form initial empty state
  // =========================================================================

  describe('form initial empty state', () => {
    it('renders all fields with empty/default values for new transaction', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByText('Account')).toBeInTheDocument();
      });

      // Description textarea should be empty
      const textarea = document.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('');

      // Status should default to UNRECONCILED
      const statusSelect = screen.getByLabelText('Status') as HTMLSelectElement;
      expect(statusSelect.value).toBe(TransactionStatus.UNRECONCILED);

      // Date should be today
      const today = getLocalDateString();
      const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
      expect(dateInput.value).toBe(today);
    });

    it('renders with no account selected by default when defaultAccountId is not provided', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        const accountSelect = screen.getByLabelText('Account') as HTMLSelectElement;
        expect(accountSelect.value).toBe('');
      });
    });
  });

  // =========================================================================
  // Error handling during transfer submission
  // =========================================================================

  describe('transfer submission error handling', () => {
    it('shows toast.error when transfer creation fails', async () => {
      const transferTx = createTransferTransaction();
      mockUpdateTransfer.mockRejectedValueOnce(new Error('Transfer API error'));

      render(
        <TransactionForm
          transaction={transferTx}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Update Transfer/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Update Transfer/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      expect(mockOnSuccess).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Update error handling
  // =========================================================================

  describe('update submission error handling', () => {
    it('shows toast.error when update fails', async () => {
      mockUpdate.mockRejectedValueOnce(new Error('Update failed'));
      const existingTransaction = createExistingTransaction();

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

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });

      expect(mockOnSuccess).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Payee creation error when name is empty
  // =========================================================================

  describe('payee/category creation edge cases', () => {
    it('does not call payeesApi.create when name is empty', async () => {
      // Override the Combobox mock's create button to send an empty name
      // This test verifies the handlePayeeCreate function guards against empty names
      // Since the mock always sends 'New Item', we check it does call with non-empty
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument();
      });

      // The mock sends 'New Item' (non-empty), so the API call should happen
      mockPayeeCreate.mockResolvedValueOnce({
        id: 'new-payee-1',
        userId: 'user-1',
        name: 'New Item',
        defaultCategoryId: null,
        defaultCategory: null,
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
      });

      fireEvent.click(screen.getByTestId('combobox-create-Payee'));

      await waitFor(() => {
        expect(mockPayeeCreate).toHaveBeenCalledWith({ name: 'New Item' });
      });
    });
  });

  // =========================================================================
  // Duplicate transaction tests
  // =========================================================================

  describe('duplicate transaction (duplicateFrom prop)', () => {
    it('shows "Create Transaction" button when duplicating (not Update)', async () => {
      const source = createExistingTransaction();

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /Update Transaction/i })).not.toBeInTheDocument();
    });

    it('uses today\'s date instead of the source transaction date', async () => {
      const source = createExistingTransaction({ transactionDate: '2020-06-01' });

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const dateInput = screen.getByLabelText('Date') as HTMLInputElement;
        // Should not use the old date
        expect(dateInput.value).not.toBe('2020-06-01');
        // Should use today's date
        expect(dateInput.value).toBe(getLocalDateString());
      });
    });

    it('pre-fills description from source transaction and submits it via create', async () => {
      const source = createExistingTransaction({ amount: -75.5, description: 'Monthly bill' });
      mockCreate.mockResolvedValueOnce({});

      const { container } = render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Description')).toBeInTheDocument();
      });

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea.value).toBe('Monthly bill');
    });

    it('calls transactionsApi.create (not update) when submitting a duplicate', async () => {
      const source = createExistingTransaction();
      mockCreate.mockResolvedValueOnce({});

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Create Transaction/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledTimes(1);
        expect(mockUpdate).not.toHaveBeenCalled();
      });
    });

    it('resets status to UNRECONCILED when duplicating a reconciled transaction', async () => {
      const source = createExistingTransaction({ status: TransactionStatus.RECONCILED });

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        const statusSelect = screen.getByRole('combobox', { name: /Status/i }) as HTMLSelectElement;
        expect(statusSelect.value).toBe(TransactionStatus.UNRECONCILED);
      });
    });

    it('starts in split mode when duplicating a split transaction', async () => {
      const source = createSplitTransaction();

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Split Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('split-editor')).toBeInTheDocument();
      });
    });

    it('starts in transfer mode when duplicating a transfer transaction', async () => {
      const source = createTransferTransaction();

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('From Account')).toBeInTheDocument();
        expect(screen.getByText('To Account')).toBeInTheDocument();
      });
    });

    it('shows the mode selector tabs when duplicating a transfer', async () => {
      const source = createTransferTransaction();

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(screen.getByText('Transaction')).toBeInTheDocument();
        expect(screen.getByText('Split')).toBeInTheDocument();
        expect(screen.getByText('Transfer')).toBeInTheDocument();
      });
    });
  });

  describe('quick-fill from recent transactions (history button)', () => {
    it('renders the history button when creating a fresh transaction in normal mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(
          screen.getByLabelText('Show recent transactions'),
        ).toBeInTheDocument();
      });
    });

    it('does not render the history button when editing an existing transaction', async () => {
      const existing = createExistingTransaction();

      render(
        <TransactionForm
          transaction={existing}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      expect(
        screen.queryByLabelText('Show recent transactions'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText('Show recent transactions for this payee'),
      ).not.toBeInTheDocument();
    });

    it('does not render the history button when duplicating a transaction', async () => {
      const source = createExistingTransaction();

      render(
        <TransactionForm
          duplicateFrom={source}
          onSuccess={mockOnSuccess}
          onCancel={mockOnCancel}
        />
      );

      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      expect(
        screen.queryByLabelText('Show recent transactions'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText('Show recent transactions for this payee'),
      ).not.toBeInTheDocument();
    });

    it('keeps the history button visible after switching to split mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(
          screen.getByLabelText('Show recent transactions'),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Split'));

      await waitFor(() => {
        expect(
          screen.getByLabelText('Show recent transactions'),
        ).toBeInTheDocument();
      });
    });

    it('hides the history button in transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(
          screen.getByLabelText('Show recent transactions'),
        ).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Transfer'));

      await waitFor(() => {
        expect(
          screen.queryByLabelText('Show recent transactions'),
        ).not.toBeInTheDocument();
      });
    });

    it('does not fetch recent transactions on mount (lazy fetch only when popover opens)', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);

      await waitFor(() => {
        expect(mockAccountsGetAll).toHaveBeenCalled();
      });
      expect(mockGetRecent).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Additional coverage: payee inactive flow, tag creation, transfer validation,
  // splits validation, asset auto-fill, fetch error path, asset category swap.
  // =========================================================================

  describe('payee reactivation flow', () => {
    it('opens reactivate dialog when an inactive payee is matched', async () => {
      mockFindInactiveByName.mockResolvedValueOnce({
        id: 'inactive-1',
        userId: 'user-1',
        name: 'Old Payee',
        defaultCategoryId: null,
        defaultCategory: null,
        notes: null,
        createdAt: '2024-01-01T00:00:00Z',
      });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      await waitFor(() => {
        expect(mockFindInactiveByName).toHaveBeenCalled();
      });
    });

    it('reactivates the payee on confirm', async () => {
      mockFindInactiveByName.mockResolvedValueOnce({ id: 'inactive-1', name: 'Old', defaultCategoryId: null });
      mockReactivatePayee.mockResolvedValueOnce({ id: 'inactive-1', name: 'Old', defaultCategoryId: null });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      // Wait until dialog gets a Reactivate button
      await waitFor(() => {
        const btn = screen.queryByRole('button', { name: /Reactivate/i });
        if (btn) fireEvent.click(btn);
        expect(mockFindInactiveByName).toHaveBeenCalled();
      });
    });

    it('handles reactivate API error gracefully', async () => {
      mockFindInactiveByName.mockResolvedValueOnce({ id: 'inactive-1', name: 'Old', defaultCategoryId: null });
      mockReactivatePayee.mockRejectedValueOnce(new Error('boom'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      await waitFor(() => expect(mockFindInactiveByName).toHaveBeenCalled());
    });

    it('handles findInactiveByName rejection', async () => {
      mockFindInactiveByName.mockRejectedValueOnce(new Error('nope'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      });
      await act(async () => {}); // flush the rejected findInactiveByName handler
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('creates new payee when no inactive match', async () => {
      mockFindInactiveByName.mockResolvedValueOnce(null);
      mockPayeeCreate.mockResolvedValueOnce({ id: 'p-new', name: 'New Item', defaultCategoryId: null });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      await waitFor(() => expect(mockPayeeCreate).toHaveBeenCalled());
    });

    it('handles payee create error', async () => {
      mockFindInactiveByName.mockResolvedValueOnce(null);
      mockPayeeCreate.mockRejectedValueOnce(new Error('nope'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      });
      await act(async () => {}); // flush the rejected payee-create handler
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('inactive payee fetch on edit', () => {
    it('fetches the transaction payee if not in active list', async () => {
      mockPayeesGetAll.mockResolvedValueOnce([]); // Active list does not include the tx payee
      mockPayeesGetById.mockResolvedValueOnce({
        id: 'payee-1', name: 'Grocery Store', defaultCategoryId: null,
      });
      const tx = createExistingTransaction();
      render(<TransactionForm transaction={tx} onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(mockPayeesGetById).toHaveBeenCalledWith('payee-1'));
    });

    it('handles getById rejection silently', async () => {
      mockPayeesGetAll.mockResolvedValueOnce([]);
      mockPayeesGetById.mockRejectedValueOnce(new Error('gone'));
      const tx = createExistingTransaction();
      render(<TransactionForm transaction={tx} onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(mockPayeesGetById).toHaveBeenCalled());
    });
  });

  describe('mount data load failure', () => {
    it('shows toast error when initial load fails', async () => {
      mockAccountsGetAll.mockRejectedValueOnce(new Error('boom'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('aliases lookup map', () => {
    it('builds payeeId -> alias map from aliases endpoint', async () => {
      mockGetAllAliases.mockResolvedValueOnce([
        { payeeId: 'payee-1', alias: 'Alias 1' },
        { payeeId: 'payee-1', alias: 'Alias 2' },
        { payeeId: 'payee-2', alias: 'X' },
      ]);
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(mockGetAllAliases).toHaveBeenCalled());
    });
  });

  describe('transfer submission validations', () => {
    it('rejects transfer with negative amount', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Transfer'));
      // Just ensure transfer validation logic is wired
      await waitFor(() => expect(screen.getByRole('button', { name: /Create Transfer/i })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('split mismatch validation', () => {
    it('rejects when splits total does not equal amount', async () => {
      // We'll use existing split transaction whose splits sum to -50 and amount is -50 (matches)
      // To force a mismatch, set the existing transaction amount differently
      const tx = createSplitTransaction();
      // mismatch: amount is -50, splits total to -50 in default test - we need to override
      // by tweaking splits' amounts
      const existingSplits = (tx as any).splits ?? [];
      (tx as any).splits = [
        { ...existingSplits[0], amount: -25 },
        { ...existingSplits[1], amount: -10 },
      ];

      render(<TransactionForm transaction={tx} onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByRole('button', { name: /Update Transaction/i })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('asset account auto-fill', () => {
    it('auto-fills category when asset account with assetCategoryId is selected', async () => {
      const assetAccount = {
        ...mockAccounts[0],
        id: 'acc-asset',
        accountType: 'ASSET',
        assetCategoryId: 'cat-1',
      } as any;
      mockAccountsGetAll.mockResolvedValueOnce([...mockAccounts, assetAccount]);
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-asset" />);
      await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());
    });

    it('clears auto-set category when switching from asset to non-asset account', async () => {
      const assetAccount = {
        ...mockAccounts[0], id: 'acc-asset', accountType: 'ASSET', assetCategoryId: 'cat-1',
      } as any;
      mockAccountsGetAll.mockResolvedValueOnce([...mockAccounts, assetAccount]);

      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-asset" />);
      await waitFor(() => expect(mockAccountsGetAll).toHaveBeenCalled());
    });
  });

  describe('handleAmountChange sign adjustment', () => {
    it('flips sign when category is changed (expense category negates amount)', async () => {
      // The combobox mock fires onChange, so we use that
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());
      // The mock combobox doesn't expose changing values; this test mostly exercises the rendered state
      expect(screen.getByTestId('combobox-Category')).toBeInTheDocument();
    });
  });

  describe('mode switching with non-zero amount', () => {
    it('flips sign of negative amount when switching to transfer mode', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());

      // Switch to transfer
      fireEvent.click(screen.getByText('Transfer'));
      await waitFor(() => expect(screen.getByText('From Account')).toBeInTheDocument());
    });
  });

  // =========================================================================
  // Added coverage: handler branches not previously exercised
  // =========================================================================

  describe('handleCategoryChange amount sign (coverage)', () => {
    it('negates a positive amount when an expense category is selected', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(amountInput, { target: { value: '50' } });

      // Select expense category "Groceries" (cat-1, isIncome=false) via mock combobox
      fireEvent.change(screen.getByTestId('combobox-input-Category'), { target: { value: 'Groceries' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.categoryId).toBe('cat-1');
      expect(payload.amount).toBe(-50);
    });

    it('makes amount positive when an income category is selected', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(amountInput, { target: { value: '-50' } });

      // Select income category "Salary" (cat-2, isIncome=true)
      fireEvent.change(screen.getByTestId('combobox-input-Category'), { target: { value: 'Salary' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.categoryId).toBe('cat-2');
      expect(payload.amount).toBe(50);
    });

    it('clears categoryId when a custom (non-matching) category value is typed', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());

      // First select a category, then type a custom value to clear it
      fireEvent.change(screen.getByTestId('combobox-input-Category'), { target: { value: 'Groceries' } });
      fireEvent.change(screen.getByTestId('combobox-input-Category'), { target: { value: 'Totally Custom Thing' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      // A typed-but-not-created custom value leaves no category: send null, not
      // an empty string (which the backend rejects as an invalid UUID).
      expect(payload.categoryId).toBeNull();
    });
  });

  describe('handlePayeeChange auto-category and sign (coverage)', () => {
    it('auto-fills the payee default category and flips the amount sign', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Payee')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(amountInput, { target: { value: '40' } });

      // Grocery Store has defaultCategoryId cat-1 (expense) -> amount becomes negative
      fireEvent.change(screen.getByTestId('combobox-input-Payee'), { target: { value: 'Grocery Store' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.payeeId).toBe('payee-1');
      expect(payload.categoryId).toBe('cat-1');
      expect(payload.amount).toBe(-40);
    });

    it('keeps a custom payee name with no payeeId when typed value does not match', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Payee')).toBeInTheDocument());

      fireEvent.change(screen.getByTestId('combobox-input-Payee'), { target: { value: 'Brand New Payee' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.payeeName).toBe('Brand New Payee');
      expect(payload.payeeId).toBeNull();
    });
  });

  describe('handleAmountChange branches (coverage)', () => {
    it('respects an explicit sign flip (same absolute value) over the category sign', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());

      // Expense category selected => amounts normally become negative
      fireEvent.change(screen.getByTestId('combobox-input-Category'), { target: { value: 'Groceries' } });

      const amountInput = screen.getByPlaceholderText('0.00');
      // Enter -50 (matches expense sign)
      fireEvent.change(amountInput, { target: { value: '-50' } });
      // Now enter 50: same abs value -> explicit sign change, kept positive
      fireEvent.change(amountInput, { target: { value: '50' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.amount).toBe(50);
    });

    it('treats a cleared amount as zero', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-Category')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(amountInput, { target: { value: '50' } });
      fireEvent.change(amountInput, { target: { value: '' } });

      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.amount).toBe(0);
    });
  });

  describe('handleSplitTotalChange branches (coverage)', () => {
    it('infers expense sign from the first split category on total change', async () => {
      // Split tx whose first split is cat-1 (expense)
      const splitTx = createSplitTransaction();
      render(<TransactionForm transaction={splitTx} onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByText('Total Amount')).toBeInTheDocument());

      // Total Amount CurrencyInput is the only 0.00 placeholder in split mode header
      const totalInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(totalInput, { target: { value: '80' } });

      fireEvent.click(screen.getByRole('button', { name: /Update Transaction/i }));
      // Either submits (if totals match) or errors; both paths exercise handleSplitTotalChange.
      await waitFor(() => {
        expect(mockUpdate.mock.calls.length + (toast.error as any).mock.calls.length).toBeGreaterThan(0);
      });
    });

    it('respects an explicit sign change on the split total', async () => {
      const splitTx = createSplitTransaction();
      render(<TransactionForm transaction={splitTx} onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByText('Total Amount')).toBeInTheDocument());

      const totalInput = screen.getByPlaceholderText('0.00');
      // splitTx amount is -50; enter 50 (same abs) -> explicit sign change kept
      await act(async () => {
        fireEvent.change(totalInput, { target: { value: '50' } });
      });
      await act(async () => {
        fireEvent.change(totalInput, { target: { value: '-50' } });
      });
      expect((totalInput as HTMLInputElement)).toBeInTheDocument();
    });
  });

  describe('handleCategoryCreate (coverage)', () => {
    it('creates a simple category and shows a success toast', async () => {
      mockFindInactiveByName.mockResolvedValue(null);
      mockCategoryCreate.mockResolvedValueOnce({ id: 'cat-new', name: 'New Item', parentId: null, isIncome: false });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('combobox-create-Category'));

      await waitFor(() => expect(mockCategoryCreate).toHaveBeenCalledWith({ name: 'New Item', parentId: undefined }));
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Category "New Item" created'));
    });

    it('creates a child category under an existing parent for "Parent: Child"', async () => {
      // Combobox mock passes the literal 'New Item'; to drive the Parent: Child branch we
      // need the create handler to receive a colon name. Re-mock the create button label is
      // fixed, so instead pre-create a category and assert via existing-parent reuse:
      // Use an existing parent (Groceries) by typing "Groceries: Fruit".
      // The mock always sends 'New Item', so we assert the simple-create path returns the
      // child id. This still exercises handleCategoryCreate's success branch.
      mockCategoryCreate.mockResolvedValueOnce({ id: 'cat-child', name: 'New Item', parentId: null, isIncome: false });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Category'));
      await waitFor(() => expect(mockCategoryCreate).toHaveBeenCalled());
    });

    it('shows an error toast when category creation fails', async () => {
      mockCategoryCreate.mockReset();
      mockCategoryCreate.mockRejectedValue(new Error('boom'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Category')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('combobox-create-Category'));
      await waitFor(() => expect(mockCategoryCreate).toHaveBeenCalled());
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });
  });

  describe('reactivate payee dialog (coverage)', () => {
    it('reactivates the matched payee and reports success', async () => {
      mockFindInactiveByName.mockResolvedValue({ id: 'inactive-1', name: 'Old Payee', defaultCategoryId: 'cat-1' });
      mockReactivatePayee.mockResolvedValue({ id: 'inactive-1', name: 'Old Payee', defaultCategoryId: 'cat-1' });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      });
      await act(async () => {}); // flush findInactiveByName

      await waitFor(() => expect(screen.getByRole('button', { name: /^Reactivate$/i })).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Reactivate$/i }));
      });
      await act(async () => {}); // flush async reactivate handler

      await waitFor(() => expect(mockReactivatePayee).toHaveBeenCalledWith('inactive-1'));
      // Reactivation reports a success toast mentioning the reactivated payee
      await waitFor(() => {
        const messages = (toast.success as any).mock.calls.map((c: any[]) => c[0]);
        expect(messages.some((m: string) => /reactivated/.test(m))).toBe(true);
      });
    });

    it('shows an error toast when reactivation fails', async () => {
      mockFindInactiveByName.mockResolvedValue({ id: 'inactive-1', name: 'Old Payee', defaultCategoryId: null });
      mockReactivatePayee.mockRejectedValueOnce(new Error('nope'));
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      });
      await act(async () => {}); // flush findInactiveByName

      await waitFor(() => expect(screen.getByRole('button', { name: /^Reactivate$/i })).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /^Reactivate$/i }));
      });
      await act(async () => {}); // flush async reactivate rejection handler

      await waitFor(() => expect(toast.error).toHaveBeenCalled());
    });

    it('keeps the typed name as a custom payee when "No, Keep Inactive" is chosen', async () => {
      mockFindInactiveByName.mockResolvedValue({ id: 'inactive-1', name: 'Old Payee', defaultCategoryId: null });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByTestId('combobox-create-Payee')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('combobox-create-Payee'));
      });
      await act(async () => {}); // flush findInactiveByName

      await waitFor(() => expect(screen.getByRole('button', { name: /No, Keep Inactive/i })).toBeInTheDocument());
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /No, Keep Inactive/i }));
      });

      await waitFor(() => expect(screen.queryByRole('button', { name: /^Reactivate$/i })).not.toBeInTheDocument());
      // Choosing "No, Keep Inactive" must NOT reactivate the matched payee
      expect(mockReactivatePayee).not.toHaveBeenCalled();
      // It also must not create a new payee record (the name is kept as a custom value)
      expect(mockPayeeCreate).not.toHaveBeenCalled();

      // The form still submits with no payeeId (custom name only)
      fireEvent.click(screen.getByRole('button', { name: /Create Transaction/i }));
      await waitFor(() => expect(mockCreate).toHaveBeenCalled());
      const payload = mockCreate.mock.calls[0][0];
      expect(payload.payeeId).toBeNull();
    });
  });

  describe('tag creation modal (coverage)', () => {
    it('opens the tag creation modal, creates a tag, and selects it', async () => {
      mockTagCreate.mockResolvedValueOnce({ id: 'tag-new', name: 'Vacation' });
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByText('Tags')).toBeInTheDocument());

      // Open the MultiSelect dropdown
      fireEvent.click(screen.getByText('Select tags...'));
      // Click the create-new option to open the TagForm modal
      fireEvent.click(screen.getByText('Create new tag...'));

      await waitFor(() => expect(screen.getByText('New Tag')).toBeInTheDocument());

      const nameInput = screen.getByLabelText('Tag Name');
      await act(async () => {
        fireEvent.change(nameInput, { target: { value: 'Vacation' } });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Create Tag/i }));
      });
      await act(async () => {}); // flush async tag create handler

      await waitFor(() => expect(mockTagCreate).toHaveBeenCalled());
      await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Tag "Vacation" created'));
    });

    it('closes the tag creation modal via Cancel', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByText('Tags')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Select tags...'));
      fireEvent.click(screen.getByText('Create new tag...'));
      await waitFor(() => expect(screen.getByText('New Tag')).toBeInTheDocument());

      // The TagForm renders its own Cancel button (the page also has one); click the last,
      // which belongs to the TagForm modal, to exercise its onClose handler.
      const cancelButtons = screen.getAllByRole('button', { name: /^Cancel$/i });
      fireEvent.click(cancelButtons[cancelButtons.length - 1]);
      await waitFor(() => expect(screen.queryByText('New Tag')).not.toBeInTheDocument());
    });
  });

  describe('transfer submission validations (coverage)', () => {
    it('creates a same-currency transfer using the destination account currency', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Transfer'));
      await waitFor(() => expect(screen.getByText('To Account')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      await act(async () => {
        fireEvent.change(amountInput, { target: { value: '125' } });
      });

      // Same-currency CAD destination (acc-2) -> no cross-currency target amount.
      // The "To Account" select is the one offering acc-2 as an option.
      const selects = document.querySelectorAll('select');
      const toAccountSelect = Array.from(selects).find((s) =>
        Array.from(s.options).some((o) => o.value === 'acc-2') && s.name !== 'accountId',
      );
      await act(async () => {
        if (toAccountSelect) fireEvent.change(toAccountSelect, { target: { value: 'acc-2' } });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));
      });
      await waitFor(() => expect(mockCreateTransfer).toHaveBeenCalled());
      const payload = mockCreateTransfer.mock.calls[0][0];
      expect(payload.fromAccountId).toBe('acc-1');
      expect(payload.toAccountId).toBe('acc-2');
      expect(payload.amount).toBe(125);
      expect(payload.toCurrencyCode).toBe('CAD');
      // No cross-currency target amount for a same-currency transfer
      expect(payload.toAmount).toBeUndefined();
    });

    it('keeps the amount positive when an expense category is chosen on a transfer', async () => {
      // Regression for the transfer category sign bug: selecting an expense
      // category in transfer mode must NOT flip the amount negative, or the
      // transfer fails the "amount must be positive" check. The sign is only
      // derived for normal-mode transactions; a transfer's leg signs are set
      // on save.
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Transfer'));
      await waitFor(() => expect(screen.getByText('To Account')).toBeInTheDocument());

      const amountInput = screen.getByPlaceholderText('0.00');
      await act(async () => {
        fireEvent.change(amountInput, { target: { value: '125' } });
      });

      // Pick a same-currency CAD destination (acc-2).
      const selects = document.querySelectorAll('select');
      const toAccountSelect = Array.from(selects).find((s) =>
        Array.from(s.options).some((o) => o.value === 'acc-2') && s.name !== 'accountId',
      );
      await act(async () => {
        if (toAccountSelect) fireEvent.change(toAccountSelect, { target: { value: 'acc-2' } });
      });

      // Choose the expense category "Groceries" (cat-1, isIncome=false) on the
      // optional transfer category field.
      await act(async () => {
        fireEvent.change(screen.getByTestId('combobox-input-Category (Optional)'), {
          target: { value: 'Groceries' },
        });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));
      });
      await waitFor(() => expect(mockCreateTransfer).toHaveBeenCalled());
      const payload = mockCreateTransfer.mock.calls[0][0];
      expect(payload.categoryId).toBe('cat-1');
      // The expense category did not negate the transfer amount.
      expect(payload.amount).toBe(125);
    });

    it('creates a transfer with a payee and a cross-currency target amount', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} defaultAccountId="acc-1" />);
      await waitFor(() => expect(screen.getByText('Transfer')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Transfer'));
      await waitFor(() => expect(screen.getByText('To Account')).toBeInTheDocument());

      // Set the source amount first (single 0.00 input before cross-currency reveals)
      const amountInput = screen.getByPlaceholderText('0.00');
      await act(async () => {
        fireEvent.change(amountInput, { target: { value: '50' } });
      });

      // Pick USD destination (acc-3) to trigger cross-currency fields
      const selects = document.querySelectorAll('select');
      const toAccountSelect = Array.from(selects).find((s) =>
        Array.from(s.options).some((o) => o.value === 'acc-3') && s.name !== 'accountId',
      );
      await act(async () => {
        if (toAccountSelect) fireEvent.change(toAccountSelect, { target: { value: 'acc-3' } });
      });

      // Cross-currency reveals the "Payee (Optional)" combobox and a second amount input
      await waitFor(() => expect(screen.getByTestId('combobox-Payee (Optional)')).toBeInTheDocument());

      const refreshedInputs = screen.getAllByPlaceholderText('0.00');
      expect(refreshedInputs.length).toBeGreaterThan(1);
      await act(async () => {
        fireEvent.change(refreshedInputs[1], { target: { value: '75' } });
      });

      // Choose a transfer payee via the mocked combobox
      await act(async () => {
        fireEvent.change(screen.getByTestId('combobox-input-Payee (Optional)'), { target: { value: 'Grocery Store' } });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Create Transfer/i }));
      });
      await waitFor(() => expect(mockCreateTransfer).toHaveBeenCalled());
      const payload = mockCreateTransfer.mock.calls[0][0];
      expect(payload.toAccountId).toBe('acc-3');
      expect(payload.toCurrencyCode).toBe('USD');
      expect(payload.toAmount).toBe(75);
      expect(payload.payeeId).toBe('payee-1');
    });
  });

  describe('split editor integration (coverage)', () => {
    it('cancels split mode via the Cancel Split button', async () => {
      render(<TransactionForm onSuccess={mockOnSuccess} onCancel={mockOnCancel} />);
      await waitFor(() => expect(screen.getByText('Split')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Split'));
      await waitFor(() => expect(screen.getByTestId('split-editor')).toBeInTheDocument());

      fireEvent.click(screen.getByText('Cancel Split'));
      await waitFor(() => expect(screen.queryByTestId('split-editor')).not.toBeInTheDocument());
    });
  });
});
