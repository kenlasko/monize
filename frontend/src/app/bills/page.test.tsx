import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import BillsPage from './page';
import { ScheduledTransaction } from '@/types/scheduled-transaction';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock next/dynamic
vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="dynamic-component">DynamicComponent</div>,
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock errors lib
vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: unknown, fallback: string) => fallback,
}));

// Mock react-hot-toast
vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

// Mock preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

// Mock API libs
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockHasOverrides = vi.fn().mockResolvedValue({ hasOverrides: false, count: 0 });
const mockGetOverrides = vi.fn().mockResolvedValue([]);
const mockDeleteAllOverrides = vi.fn().mockResolvedValue(0);

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    hasOverrides: (...args: any[]) => mockHasOverrides(...args),
    getOverrides: (...args: any[]) => mockGetOverrides(...args),
    getOverrideByDate: vi.fn().mockResolvedValue(null),
    deleteAllOverrides: (...args: any[]) => mockDeleteAllOverrides(...args),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
    skip: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

// Mock child components
vi.mock('@/components/scheduled-transactions/ScheduledTransactionForm', () => ({
  ScheduledTransactionForm: ({ onSuccess, onCancel }: any) => (
    <div data-testid="scheduled-transaction-form">
      <button data-testid="form-save" onClick={onSuccess}>Save</button>
      <button data-testid="form-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('@/components/scheduled-transactions/ScheduledTransactionList', () => ({
  ScheduledTransactionList: ({ transactions, onEdit, onEditOccurrence, onPost }: any) => (
    <div data-testid="scheduled-transaction-list">
      {transactions.length === 0 && <span data-testid="empty-list">No scheduled transactions</span>}
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`transaction-${t.id}`}>
          <span>{t.name}</span>
          <button data-testid={`edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
          <button data-testid={`edit-occurrence-${t.id}`} onClick={() => onEditOccurrence(t)}>Edit Occurrence</button>
          <button data-testid={`post-${t.id}`} onClick={() => onPost(t)}>Post</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/scheduled-transactions/OverrideEditorDialog', () => ({
  OverrideEditorDialog: ({ isOpen }: any) =>
    isOpen ? <div data-testid="override-editor-dialog">OverrideEditorDialog</div> : null,
}));

vi.mock('@/components/scheduled-transactions/OccurrenceDatePicker', () => ({
  OccurrenceDatePicker: ({ isOpen, onSelect, onClose }: any) =>
    isOpen ? (
      <div data-testid="occurrence-date-picker">
        <button data-testid="pick-date" onClick={() => onSelect('2026-02-15')}>Pick Date</button>
        <button data-testid="close-picker" onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

vi.mock('@/components/scheduled-transactions/PostTransactionDialog', () => ({
  PostTransactionDialog: ({ isOpen, onClose }: any) =>
    isOpen ? (
      <div data-testid="post-transaction-dialog">
        <button data-testid="close-post-dialog" onClick={onClose}>Close</button>
      </div>
    ) : null,
}));

vi.mock('@/components/bills/CashFlowForecastChart', () => ({
  CashFlowForecastChart: () => <div data-testid="cash-flow-chart">CashFlowForecastChart</div>,
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value, valueColor }: any) => (
    <div data-testid={`summary-${label}`} data-value={value} data-color={valueColor}>
      {value}
    </div>
  ),
  SummaryIcons: { clipboard: null, plus: null, money: null, clock: null },
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button onClick={onClick} {...rest}>{children}</button>
  ),
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: ({ isOpen }: any) =>
    isOpen ? <div data-testid="unsaved-changes-dialog">UnsavedChangesDialog</div> : null,
}));

vi.mock('@/components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <div data-testid="error-boundary">{children}</div>,
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <div data-testid="protected-route">{children}</div>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions && <div data-testid="page-header-actions">{actions}</div>}
    </div>
  ),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (val: number) => val,
    defaultCurrency: 'USD',
  }),
}));

// ---------- Test Helpers ----------

function makeScheduledTransaction(overrides: Partial<ScheduledTransaction> = {}): ScheduledTransaction {
  return {
    id: 'st-1',
    userId: 'test-user-id',
    accountId: 'acc-1',
    account: null,
    name: 'Test Bill',
    payeeId: null,
    payee: null,
    payeeName: null,
    categoryId: null,
    category: null,
    amount: -100,
    currencyCode: 'USD',
    description: null,
    frequency: 'MONTHLY',
    nextDueDate: '2026-02-15',
    startDate: '2026-01-01',
    endDate: null,
    occurrencesRemaining: null,
    totalOccurrences: null,
    isActive: true,
    autoPost: false,
    reminderDaysBefore: 3,
    lastPostedDate: null,
    isSplit: false,
    isTransfer: false,
    transferAccountId: null,
    transferAccount: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeSampleTransactions(): ScheduledTransaction[] {
  return [
    makeScheduledTransaction({
      id: 'bill-1',
      name: 'Rent',
      amount: -1500,
      frequency: 'MONTHLY',
      isActive: true,
      isTransfer: false,
      nextDueDate: '2026-02-01',
    }),
    makeScheduledTransaction({
      id: 'bill-2',
      name: 'Internet',
      amount: -80,
      frequency: 'MONTHLY',
      isActive: true,
      isTransfer: false,
      nextDueDate: '2026-02-10',
    }),
    makeScheduledTransaction({
      id: 'deposit-1',
      name: 'Salary',
      amount: 5000,
      frequency: 'MONTHLY',
      isActive: true,
      isTransfer: false,
      nextDueDate: '2026-02-28',
    }),
    makeScheduledTransaction({
      id: 'transfer-1',
      name: 'Savings Transfer',
      amount: -500,
      frequency: 'MONTHLY',
      isActive: true,
      isTransfer: true,
      nextDueDate: '2026-02-15',
    }),
    makeScheduledTransaction({
      id: 'inactive-1',
      name: 'Old Subscription',
      amount: -20,
      frequency: 'MONTHLY',
      isActive: false,
      isTransfer: false,
      nextDueDate: '2026-02-20',
    }),
  ];
}

// ---------- Tests ----------

describe('BillsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
  });

  // --- Rendering ---

  it('renders the page header with title "Bills & Deposits"', async () => {
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByText('Bills & Deposits')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Manage your recurring transactions and scheduled payments/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout and protected route', async () => {
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('protected-route')).toBeInTheDocument();
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders the cash flow forecast chart', async () => {
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('cash-flow-chart')).toBeInTheDocument();
    });
  });

  // --- Loading State ---

  it('shows loading spinner while data is loading', async () => {
    // Never resolve to keep loading state
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
      expect(screen.getByText('Loading scheduled transactions...')).toBeInTheDocument();
    });
  });

  // --- Empty State ---

  it('shows empty list when no scheduled transactions exist', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      expect(screen.getByTestId('empty-list')).toBeInTheDocument();
    });
  });

  // --- Summary Cards ---

  it('renders all four summary cards', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Active Bills')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Active Deposits')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Monthly Net')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Due Now')).toBeInTheDocument();
    });
  });

  it('shows correct counts for active bills and deposits (excludes transfers and inactive)', async () => {
    mockGetAll.mockResolvedValue(makeSampleTransactions());
    render(<BillsPage />);
    await waitFor(() => {
      // Active bills: Rent(-1500) + Internet(-80) = 2 (transfer and inactive excluded)
      const billsCard = screen.getByTestId('summary-Active Bills');
      expect(billsCard).toHaveAttribute('data-value', '2');

      // Active deposits: Salary(+5000) = 1
      const depositsCard = screen.getByTestId('summary-Active Deposits');
      expect(depositsCard).toHaveAttribute('data-value', '1');
    });
  });

  it('calculates monthly net correctly for MONTHLY frequency', async () => {
    mockGetAll.mockResolvedValue(makeSampleTransactions());
    render(<BillsPage />);
    await waitFor(() => {
      // Monthly bills: 1500 + 80 = 1580 (transfer excluded, inactive excluded)
      // Monthly deposits: 5000
      // Net = 5000 - 1580 = 3420
      const netCard = screen.getByTestId('summary-Monthly Net');
      expect(netCard).toHaveAttribute('data-value', '$3420.00');
    });
  });

  it('calculates monthly net with positive color when deposits exceed bills', async () => {
    mockGetAll.mockResolvedValue(makeSampleTransactions());
    render(<BillsPage />);
    await waitFor(() => {
      const netCard = screen.getByTestId('summary-Monthly Net');
      expect(netCard).toHaveAttribute('data-color', 'green');
    });
  });

  it('calculates monthly net with red color when bills exceed deposits', async () => {
    const transactions = [
      makeScheduledTransaction({ id: 'big-bill', name: 'Big Bill', amount: -10000, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
      makeScheduledTransaction({ id: 'small-deposit', name: 'Small Pay', amount: 100, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
    ];
    mockGetAll.mockResolvedValue(transactions);
    render(<BillsPage />);
    await waitFor(() => {
      const netCard = screen.getByTestId('summary-Monthly Net');
      // net = 100 - 10000 = -9900
      expect(netCard).toHaveAttribute('data-value', '$-9900.00');
      expect(netCard).toHaveAttribute('data-color', 'red');
    });
  });

  // --- Monthly Amount Frequency Normalization ---

  describe('monthly amount frequency normalization', () => {
    it('normalizes DAILY frequency: amount * 30', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'daily', name: 'Daily Bill', amount: -10, frequency: 'DAILY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 10 * 30 = 300 monthly bills, deposits = 0, net = 0 - 300 = -300
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-300.00');
      });
    });

    it('normalizes WEEKLY frequency: amount * 4.33', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'weekly', name: 'Weekly Bill', amount: -100, frequency: 'WEEKLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 100 * 4.33 = 433 monthly bills, net = 0 - 433 = -433
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-433.00');
      });
    });

    it('normalizes BIWEEKLY frequency: amount * 2.17', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'biweekly', name: 'Biweekly Bill', amount: -200, frequency: 'BIWEEKLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 200 * 2.17 = 434 monthly bills, net = -434
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-434.00');
      });
    });

    it('normalizes MONTHLY frequency: amount * 1', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'monthly', name: 'Monthly Bill', amount: -500, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-500.00');
      });
    });

    it('normalizes QUARTERLY frequency: amount / 3', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'quarterly', name: 'Quarterly Bill', amount: -300, frequency: 'QUARTERLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 300 / 3 = 100 monthly bills, net = -100
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-100.00');
      });
    });

    it('normalizes YEARLY frequency: amount / 12', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'yearly', name: 'Yearly Bill', amount: -1200, frequency: 'YEARLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 1200 / 12 = 100 monthly bills, net = -100
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-100.00');
      });
    });

    it('normalizes deposits with WEEKLY frequency correctly', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'weekly-dep', name: 'Weekly Pay', amount: 1000, frequency: 'WEEKLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // 1000 * 4.33 = 4330 monthly deposits, net = 4330
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$4330.00');
      });
    });

    it('combines multiple frequencies in a single calculation', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'daily-bill', name: 'Daily', amount: -10, frequency: 'DAILY', isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'monthly-bill', name: 'Monthly', amount: -100, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'yearly-dep', name: 'Yearly Dep', amount: 12000, frequency: 'YEARLY', isActive: true, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // Bills: daily=10*30=300, monthly=100*1=100 => total=400
        // Deposits: yearly=12000/12=1000
        // Net = 1000 - 400 = 600
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$600.00');
      });
    });
  });

  // --- Due Count ---

  describe('due count calculation', () => {
    it('shows 0 due when no transactions are past due', async () => {
      const futureDate = '2099-12-31';
      const transactions = [
        makeScheduledTransaction({ id: 'future', name: 'Future Bill', amount: -100, isActive: true, nextDueDate: futureDate }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const dueCard = screen.getByTestId('summary-Due Now');
        expect(dueCard).toHaveAttribute('data-value', '0');
        expect(dueCard).toHaveAttribute('data-color', 'default');
      });
    });

    it('counts transactions with nextDueDate on or before today', async () => {
      const pastDate = '2020-01-01';
      const todayStr = new Date().toISOString().split('T')[0];
      const transactions = [
        makeScheduledTransaction({ id: 'past', name: 'Past Due', amount: -100, isActive: true, nextDueDate: pastDate }),
        makeScheduledTransaction({ id: 'today', name: 'Due Today', amount: -50, isActive: true, nextDueDate: todayStr }),
        makeScheduledTransaction({ id: 'future', name: 'Future', amount: -30, isActive: true, nextDueDate: '2099-12-31' }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const dueCard = screen.getByTestId('summary-Due Now');
        expect(dueCard).toHaveAttribute('data-value', '2');
        expect(dueCard).toHaveAttribute('data-color', 'red');
      });
    });

    it('excludes inactive transactions from due count', async () => {
      const pastDate = '2020-01-01';
      const transactions = [
        makeScheduledTransaction({ id: 'inactive-due', name: 'Inactive Due', amount: -100, isActive: false, nextDueDate: pastDate }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const dueCard = screen.getByTestId('summary-Due Now');
        expect(dueCard).toHaveAttribute('data-value', '0');
      });
    });
  });

  // --- Filter Tabs ---

  describe('filter tabs', () => {
    it('shows All, Bills, and Deposits filter buttons in list view', async () => {
      const transactions = makeSampleTransactions();
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // All should include all 5 transactions
        expect(screen.getByText(`All (${transactions.length})`)).toBeInTheDocument();
        // Bills: amount < 0 => Rent, Internet, Savings Transfer, Old Subscription = 4
        expect(screen.getByText(`Bills (${transactions.filter(t => t.amount < 0).length})`)).toBeInTheDocument();
        // Deposits: amount > 0 => Salary = 1
        expect(screen.getByText(`Deposits (${transactions.filter(t => t.amount > 0).length})`)).toBeInTheDocument();
      });
    });

    it('filters to only bills when Bills tab is clicked', async () => {
      const transactions = makeSampleTransactions();
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });

      const billsButton = screen.getByText(/^Bills \(/);
      fireEvent.click(billsButton);

      await waitFor(() => {
        // Bills filter: amount < 0 => Rent, Internet, Savings Transfer, Old Subscription
        const list = screen.getByTestId('scheduled-transaction-list');
        expect(list).toBeInTheDocument();
        // Negative amounts: bill-1, bill-2, transfer-1, inactive-1
        expect(screen.getByTestId('transaction-bill-1')).toBeInTheDocument();
        expect(screen.getByTestId('transaction-bill-2')).toBeInTheDocument();
        expect(screen.getByTestId('transaction-transfer-1')).toBeInTheDocument();
        expect(screen.getByTestId('transaction-inactive-1')).toBeInTheDocument();
        // Positive amount excluded
        expect(screen.queryByTestId('transaction-deposit-1')).not.toBeInTheDocument();
      });
    });

    it('filters to only deposits when Deposits tab is clicked', async () => {
      const transactions = makeSampleTransactions();
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });

      const depositsButton = screen.getByText(/^Deposits \(/);
      fireEvent.click(depositsButton);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-deposit-1')).toBeInTheDocument();
        expect(screen.queryByTestId('transaction-bill-1')).not.toBeInTheDocument();
        expect(screen.queryByTestId('transaction-bill-2')).not.toBeInTheDocument();
      });
    });

    it('shows all transactions when All tab is clicked after filtering', async () => {
      const transactions = makeSampleTransactions();
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });

      // Filter to bills first
      fireEvent.click(screen.getByText(/^Bills \(/));
      await waitFor(() => {
        expect(screen.queryByTestId('transaction-deposit-1')).not.toBeInTheDocument();
      });

      // Switch back to all
      fireEvent.click(screen.getByText(/^All \(/));
      await waitFor(() => {
        expect(screen.getByTestId('transaction-deposit-1')).toBeInTheDocument();
        expect(screen.getByTestId('transaction-bill-1')).toBeInTheDocument();
      });
    });

    it('hides filter tabs in calendar view', async () => {
      mockGetAll.mockResolvedValue(makeSampleTransactions());
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByText(/^All \(/)).toBeInTheDocument();
      });

      // Switch to calendar view
      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => {
        expect(screen.queryByText(/^All \(/)).not.toBeInTheDocument();
        expect(screen.queryByText(/^Bills \(/)).not.toBeInTheDocument();
        expect(screen.queryByText(/^Deposits \(/)).not.toBeInTheDocument();
      });
    });
  });

  // --- View Toggle ---

  describe('view toggle between list and calendar', () => {
    it('renders List and Calendar toggle buttons', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('List')).toBeInTheDocument();
        expect(screen.getByText('Calendar')).toBeInTheDocument();
      });
    });

    it('shows list view by default', async () => {
      mockGetAll.mockResolvedValue(makeSampleTransactions());
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });
    });

    it('switches to calendar view when Calendar button is clicked', async () => {
      mockGetAll.mockResolvedValue(makeSampleTransactions());
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => {
        expect(screen.queryByTestId('scheduled-transaction-list')).not.toBeInTheDocument();
        // Calendar view shows day-of-week headers
        expect(screen.getByText('Sun')).toBeInTheDocument();
        expect(screen.getByText('Mon')).toBeInTheDocument();
        expect(screen.getByText('Tue')).toBeInTheDocument();
        expect(screen.getByText('Wed')).toBeInTheDocument();
        expect(screen.getByText('Thu')).toBeInTheDocument();
        expect(screen.getByText('Fri')).toBeInTheDocument();
        expect(screen.getByText('Sat')).toBeInTheDocument();
      });
    });

    it('switches back to list view when List button is clicked', async () => {
      mockGetAll.mockResolvedValue(makeSampleTransactions());
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Calendar'));
      await waitFor(() => {
        expect(screen.queryByTestId('scheduled-transaction-list')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('List'));
      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });
    });
  });

  // --- Calendar View ---

  describe('calendar view', () => {
    it('displays current month name and year', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      fireEvent.click(screen.getByText('Calendar'));

      const now = new Date();
      const expectedMonthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

      await waitFor(() => {
        expect(screen.getByText(expectedMonthYear)).toBeInTheDocument();
      });
    });

    it('shows Today button in calendar view', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => {
        expect(screen.getByText('Today')).toBeInTheDocument();
      });
    });

    it('shows all day-of-week headers', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      fireEvent.click(screen.getByText('Calendar'));

      await waitFor(() => {
        for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
          expect(screen.getByText(day)).toBeInTheDocument();
        }
      });
    });
  });

  // --- Creating a New Bill ---

  describe('creating a new bill', () => {
    it('renders "+ New Schedule" button', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Schedule')).toBeInTheDocument();
      });
    });

    it('opens the form modal when "+ New Schedule" is clicked', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByText('+ New Schedule')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ New Schedule'));

      await waitFor(() => {
        expect(screen.getByTestId('modal')).toBeInTheDocument();
        expect(screen.getByText('New Scheduled Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('scheduled-transaction-form')).toBeInTheDocument();
      });
    });

    it('shows "Edit Scheduled Transaction" title when editing existing transaction', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'edit-me', name: 'Edit This', amount: -50 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockHasOverrides.mockResolvedValue({ hasOverrides: false, count: 0 });
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-edit-me')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-edit-me'));

      await waitFor(() => {
        expect(screen.getByText('Edit Scheduled Transaction')).toBeInTheDocument();
      });
    });

    it('closes form modal on cancel', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByText('+ New Schedule')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ New Schedule'));

      await waitFor(() => {
        expect(screen.getByTestId('modal')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('form-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
      });
    });

    it('closes form and reloads data on successful save', async () => {
      mockGetAll.mockResolvedValue([]);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByText('+ New Schedule')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ New Schedule'));

      await waitFor(() => {
        expect(screen.getByTestId('modal')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('form-save'));

      await waitFor(() => {
        expect(screen.queryByTestId('modal')).not.toBeInTheDocument();
      });

      // loadData called again: once on mount + once after save
      expect(mockGetAll).toHaveBeenCalledTimes(2);
    });
  });

  // --- Override Confirmation Dialog ---

  describe('override confirmation dialog', () => {
    it('shows override confirmation when editing a transaction with overrides', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'has-overrides', name: 'Overridden Bill', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 3 });
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-has-overrides')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-has-overrides'));

      await waitFor(() => {
        expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument();
        expect(screen.getByText(/3 individual occurrences with custom modifications/)).toBeInTheDocument();
      });
    });

    it('closes override dialog on cancel', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'ov-cancel', name: 'Cancel Override', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-ov-cancel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-ov-cancel'));

      await waitFor(() => {
        expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() => {
        expect(screen.queryByText('Existing Overrides Found')).not.toBeInTheDocument();
      });
    });

    it('opens form with "Keep Modifications" option', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'ov-keep', name: 'Keep Mods', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 1 });
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-ov-keep')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-ov-keep'));

      await waitFor(() => {
        expect(screen.getByText('Keep Modifications')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Keep Modifications'));

      await waitFor(() => {
        expect(screen.getByText('Edit Scheduled Transaction')).toBeInTheDocument();
        expect(screen.getByTestId('scheduled-transaction-form')).toBeInTheDocument();
      });
    });

    it('deletes overrides and opens form with "Delete All Modifications"', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'ov-del', name: 'Delete Mods', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      mockDeleteAllOverrides.mockResolvedValue(2);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-ov-del')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-ov-del'));

      await waitFor(() => {
        expect(screen.getByText('Delete All Modifications')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Delete All Modifications'));

      await waitFor(() => {
        expect(mockDeleteAllOverrides).toHaveBeenCalledWith('ov-del');
        expect(screen.getByText('Edit Scheduled Transaction')).toBeInTheDocument();
      });
    });
  });

  // --- Occurrence Date Picker ---

  describe('occurrence date picker', () => {
    it('opens occurrence date picker when edit occurrence is clicked', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'occ-edit', name: 'Occurrence Edit', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockGetOverrides.mockResolvedValue([]);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-occurrence-occ-edit')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-occurrence-occ-edit'));

      await waitFor(() => {
        expect(screen.getByTestId('occurrence-date-picker')).toBeInTheDocument();
      });
    });

    it('closes occurrence date picker when close is clicked', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'occ-close', name: 'Close Picker', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      mockGetOverrides.mockResolvedValue([]);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('edit-occurrence-occ-close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('edit-occurrence-occ-close'));

      await waitFor(() => {
        expect(screen.getByTestId('occurrence-date-picker')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('close-picker'));

      await waitFor(() => {
        expect(screen.queryByTestId('occurrence-date-picker')).not.toBeInTheDocument();
      });
    });
  });

  // --- Post Transaction Dialog ---

  describe('post transaction dialog', () => {
    it('opens post dialog when post button is clicked', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'post-me', name: 'Post This', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('post-post-me')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('post-post-me'));

      await waitFor(() => {
        expect(screen.getByTestId('post-transaction-dialog')).toBeInTheDocument();
      });
    });

    it('closes post dialog when close is clicked', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'post-close', name: 'Close Post', amount: -100 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('post-post-close')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('post-post-close'));

      await waitFor(() => {
        expect(screen.getByTestId('post-transaction-dialog')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('close-post-dialog'));

      await waitFor(() => {
        expect(screen.queryByTestId('post-transaction-dialog')).not.toBeInTheDocument();
      });
    });
  });

  // --- Data Loading ---

  describe('data loading', () => {
    it('calls scheduledTransactionsApi.getAll on mount', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledTimes(1);
      });
    });

    it('renders transactions in list after data loads', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'loaded-1', name: 'Loaded Bill', amount: -200 }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('transaction-loaded-1')).toBeInTheDocument();
        expect(screen.getByText('Loaded Bill')).toBeInTheDocument();
      });
    });
  });

  // --- Summary card excludes transfers from counts ---

  describe('summary card transfer exclusion', () => {
    it('excludes transfers from active bills count', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'bill-only', name: 'Real Bill', amount: -100, isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'transfer-only', name: 'Transfer', amount: -200, isActive: true, isTransfer: true }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const billsCard = screen.getByTestId('summary-Active Bills');
        expect(billsCard).toHaveAttribute('data-value', '1');
      });
    });

    it('excludes transfers from active deposits count', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'dep-only', name: 'Real Deposit', amount: 500, isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'transfer-dep', name: 'Transfer In', amount: 300, isActive: true, isTransfer: true }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const depositsCard = screen.getByTestId('summary-Active Deposits');
        expect(depositsCard).toHaveAttribute('data-value', '1');
      });
    });

    it('excludes transfers from monthly net calculation', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'real-bill', name: 'Real', amount: -100, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'transfer-bill', name: 'Transfer', amount: -500, frequency: 'MONTHLY', isActive: true, isTransfer: true }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // Only real bill counted: net = 0 - 100 = -100 (transfer excluded)
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-100.00');
      });
    });

    it('excludes inactive transactions from bills count', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'active-bill', name: 'Active', amount: -100, isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'inactive-bill', name: 'Inactive', amount: -200, isActive: false, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        const billsCard = screen.getByTestId('summary-Active Bills');
        expect(billsCard).toHaveAttribute('data-value', '1');
      });
    });

    it('excludes inactive transactions from monthly net calculation', async () => {
      const transactions = [
        makeScheduledTransaction({ id: 'active-net', name: 'Active', amount: -100, frequency: 'MONTHLY', isActive: true, isTransfer: false }),
        makeScheduledTransaction({ id: 'inactive-net', name: 'Inactive', amount: -999, frequency: 'MONTHLY', isActive: false, isTransfer: false }),
      ];
      mockGetAll.mockResolvedValue(transactions);
      render(<BillsPage />);
      await waitFor(() => {
        // Only active bill counted: net = 0 - 100 = -100
        const netCard = screen.getByTestId('summary-Monthly Net');
        expect(netCard).toHaveAttribute('data-value', '$-100.00');
      });
    });
  });

  // --- Edge case: singular override text ---

  it('uses singular text for 1 override', async () => {
    const transactions = [
      makeScheduledTransaction({ id: 'ov-singular', name: 'One Override', amount: -100 }),
    ];
    mockGetAll.mockResolvedValue(transactions);
    mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 1 });
    render(<BillsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('edit-ov-singular')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('edit-ov-singular'));

    await waitFor(() => {
      // "1 individual occurrence with custom modifications" (singular, no 's')
      expect(screen.getByText(/1 individual occurrence with custom modifications\./)).toBeInTheDocument();
    });
  });

  // --- Edge case: zero scheduled transactions ---

  it('shows zero for all summary cards with no transactions', async () => {
    mockGetAll.mockResolvedValue([]);
    render(<BillsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Active Bills')).toHaveAttribute('data-value', '0');
      expect(screen.getByTestId('summary-Active Deposits')).toHaveAttribute('data-value', '0');
      expect(screen.getByTestId('summary-Monthly Net')).toHaveAttribute('data-value', '$0.00');
      expect(screen.getByTestId('summary-Due Now')).toHaveAttribute('data-value', '0');
    });
  });
});
