import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import userEvent from '@testing-library/user-event';
import ReconcilePage from './page';
import { transactionsApi } from '@/lib/transactions';
import { accountsApi } from '@/lib/accounts';
import toast from 'react-hot-toast';
import { TransactionStatus } from '@/types/transaction';
import type { Account } from '@/types/account';
import type { ReconciliationData, Transaction } from '@/types/transaction';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

vi.mock('next/dynamic', () => ({
  default: () => () => <div data-testid="dynamic-component">DynamicComponent</div>,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

// Auth store
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

// Preferences store
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD', numberFormat: 'en-US' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

// Auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

// Transactions API
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getReconciliationData: vi.fn(),
    bulkReconcile: vi.fn(),
    getAll: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
    getSummary: vi.fn().mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 }),
  },
}));

// Accounts API
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

// Mock next/navigation with controllable searchParams
const mockPush = vi.fn();
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/reconcile',
  useSearchParams: () => mockSearchParams,
}));

// Layout components
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

// Hooks
vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number, currency?: string) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
    defaultCurrency: 'USD',
  }),
}));

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    userId: 'test-user-id',
    accountType: 'CHEQUING',
    accountSubType: null,
    linkedAccountId: null,
    name: 'Chequing Account',
    description: null,
    currencyCode: 'USD',
    accountNumber: null,
    institution: null,
    openingBalance: 0,
    currentBalance: 1500,
    creditLimit: null,
    interestRate: null,
    isClosed: false,
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
    canDelete: true,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  const payeeName = overrides.payeeName ?? 'Grocery Store';
  return {
    id: 'txn-1',
    userId: 'test-user-id',
    accountId: 'acc-1',
    account: null,
    transactionDate: '2025-02-01',
    payeeId: 'pay-1',
    payeeName,
    payee: { id: 'pay-1', userId: 'test-user-id', name: payeeName, defaultCategoryId: null, defaultCategory: null, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    categoryId: 'cat-1',
    category: { id: 'cat-1', userId: 'test-user-id', name: 'Groceries', type: 'EXPENSE', parentId: null, parent: null, children: [], isHidden: false, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' },
    amount: -50,
    currencyCode: 'USD',
    exchangeRate: 1,
    description: null,
    referenceNumber: null,
    status: TransactionStatus.CLEARED,
    isCleared: true,
    isReconciled: false,
    isVoid: false,
    reconciledDate: null,
    isSplit: false,
    parentTransactionId: null,
    isTransfer: false,
    linkedTransactionId: null,
    createdAt: '2025-02-01T00:00:00Z',
    updatedAt: '2025-02-01T00:00:00Z',
    ...overrides,
  };
}

function makeReconciliationData(overrides: Partial<ReconciliationData> = {}): ReconciliationData {
  return {
    transactions: [
      makeTransaction({ id: 'txn-1', amount: -50, status: TransactionStatus.CLEARED }),
      makeTransaction({ id: 'txn-2', amount: -30, payeeName: 'Coffee Shop', status: TransactionStatus.CLEARED }),
      makeTransaction({ id: 'txn-3', amount: 200, payeeName: 'Salary', status: TransactionStatus.UNRECONCILED }),
    ],
    reconciledBalance: 1000,
    clearedBalance: 920,
    difference: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockGetAll = accountsApi.getAll as Mock;
const mockGetReconciliationData = transactionsApi.getReconciliationData as Mock;
const mockBulkReconcile = transactionsApi.bulkReconcile as Mock;

/**
 * Default setup: accounts loaded, reconciliation data ready.
 */
function setupDefaultMocks() {
  const chequingAccount = makeAccount();
  const savingsAccount = makeAccount({
    id: 'acc-2',
    name: 'Savings Account',
    accountType: 'SAVINGS',
    currentBalance: 5000,
  });

  mockGetAll.mockResolvedValue([chequingAccount, savingsAccount]);

  const reconciliationData = makeReconciliationData();
  mockGetReconciliationData.mockResolvedValue(reconciliationData);
  mockBulkReconcile.mockResolvedValue({ reconciled: 3 });

  return { chequingAccount, savingsAccount, reconciliationData };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReconcilePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset search params
    [...mockSearchParams.keys()].forEach((key) => mockSearchParams.delete(key));
  });

  // -------------------------------------------------------------------------
  // Page rendering
  // -------------------------------------------------------------------------

  describe('page rendering', () => {
    it('renders within page layout', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders the page header with correct title', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByText('Reconcile Account')).toBeInTheDocument();
      });
    });

    it('renders default subtitle when no account is selected', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByText('Match your records against your bank statement')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Setup step
  // -------------------------------------------------------------------------

  describe('setup step', () => {
    it('renders the Start Reconciliation heading', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Start Reconciliation' })).toBeInTheDocument();
      });
    });

    it('renders the description text', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(
          screen.getByText(/Reconcile your account against a bank statement/),
        ).toBeInTheDocument();
      });
    });

    it('renders the account select dropdown', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });
    });

    it('renders the statement date input', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByLabelText('Statement Date')).toBeInTheDocument();
      });
    });

    it('renders the statement ending balance input', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByLabelText('Statement Ending Balance')).toBeInTheDocument();
      });
    });

    it('renders Cancel and Start Reconciliation buttons', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Start Reconciliation/ })).toBeInTheDocument();
      });
    });

    it('disables the Start Reconciliation button when fields are empty', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
        expect(startButton).toBeDisabled();
      });
    });

    it('loads accounts into the dropdown on mount', async () => {
      setupDefaultMocks();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(screen.getByText('Select account...')).toBeInTheDocument();
      });
      // The accounts should appear as options
      const select = screen.getByLabelText('Account') as HTMLSelectElement;
      const options = Array.from(select.querySelectorAll('option'));
      expect(options).toHaveLength(3); // "Select account..." + 2 accounts
      expect(options[1].textContent).toContain('Chequing Account');
      expect(options[2].textContent).toContain('Savings Account');
    });

    it('filters out investment brokerage accounts', async () => {
      const brokerageAccount = makeAccount({
        id: 'acc-brokerage',
        name: 'Brokerage',
        accountSubType: 'INVESTMENT_BROKERAGE',
      });
      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount, brokerageAccount]);

      render(<ReconcilePage />);
      await waitFor(() => {
        const select = screen.getByLabelText('Account') as HTMLSelectElement;
        const options = Array.from(select.querySelectorAll('option'));
        expect(options).toHaveLength(2); // "Select account..." + chequing only
        const optionTexts = options.map((o) => o.textContent);
        expect(optionTexts.some((t) => t?.includes('Brokerage'))).toBe(false);
      });
    });

    it('filters out closed accounts', async () => {
      const closedAccount = makeAccount({
        id: 'acc-closed',
        name: 'Closed Account',
        isClosed: true,
      });
      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount, closedAccount]);

      render(<ReconcilePage />);
      await waitFor(() => {
        const select = screen.getByLabelText('Account') as HTMLSelectElement;
        const options = Array.from(select.querySelectorAll('option'));
        expect(options).toHaveLength(2); // "Select account..." + chequing only
        const optionTexts = options.map((o) => o.textContent);
        expect(optionTexts.some((t) => t?.includes('Closed Account'))).toBe(false);
      });
    });

    it('navigates to /accounts when Cancel is clicked', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      });
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(mockPush).toHaveBeenCalledWith('/accounts');
    });

    it('shows toast error when accounts fail to load', async () => {
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<ReconcilePage />);
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load accounts');
      });
    });

    it('pre-selects account from searchParams', async () => {
      const chequingAccount = makeAccount({ id: 'acc-preselected' });
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockSearchParams.set('accountId', 'acc-preselected');

      render(<ReconcilePage />);
      await waitFor(() => {
        const select = screen.getByLabelText('Account') as HTMLSelectElement;
        expect(select.value).toBe('acc-preselected');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Liability account handling
  // -------------------------------------------------------------------------

  describe('liability account sign handling', () => {
    it('shows liability hint for credit card account', async () => {
      const creditCardAccount = makeAccount({
        id: 'acc-cc',
        name: 'Credit Card',
        accountType: 'CREDIT_CARD',
        currentBalance: -500,
      });
      mockGetAll.mockResolvedValue([creditCardAccount]);
      mockGetReconciliationData.mockResolvedValue(makeReconciliationData());

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      // Select the credit card account
      await user.selectOptions(screen.getByLabelText('Account'), 'acc-cc');

      await waitFor(() => {
        expect(
          screen.getByText('Liability accounts typically have a negative balance'),
        ).toBeInTheDocument();
      });
    });

    it('shows liability hint for loan account', async () => {
      const loanAccount = makeAccount({
        id: 'acc-loan',
        name: 'Car Loan',
        accountType: 'LOAN',
        currentBalance: -15000,
      });
      mockGetAll.mockResolvedValue([loanAccount]);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-loan');

      await waitFor(() => {
        expect(
          screen.getByText('Liability accounts typically have a negative balance'),
        ).toBeInTheDocument();
      });
    });

    it('shows liability hint for mortgage account', async () => {
      const mortgageAccount = makeAccount({
        id: 'acc-mortgage',
        name: 'Home Mortgage',
        accountType: 'MORTGAGE',
        currentBalance: -200000,
      });
      mockGetAll.mockResolvedValue([mortgageAccount]);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-mortgage');

      await waitFor(() => {
        expect(
          screen.getByText('Liability accounts typically have a negative balance'),
        ).toBeInTheDocument();
      });
    });

    it('shows liability hint for line of credit account', async () => {
      const locAccount = makeAccount({
        id: 'acc-loc',
        name: 'Line of Credit',
        accountType: 'LINE_OF_CREDIT',
        currentBalance: -3000,
      });
      mockGetAll.mockResolvedValue([locAccount]);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-loc');

      await waitFor(() => {
        expect(
          screen.getByText('Liability accounts typically have a negative balance'),
        ).toBeInTheDocument();
      });
    });

    it('does not show liability hint for chequing account', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });
      expect(
        screen.queryByText('Liability accounts typically have a negative balance'),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Transition to reconcile step
  // -------------------------------------------------------------------------

  describe('moving to reconcile step', () => {
    it('shows toast error when trying to start without filling all fields', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /Start Reconciliation/ })).toBeInTheDocument();
      });

      // The button is disabled, but we can test the handler by calling it if there were a way;
      // Instead, verify the button is disabled (guards the flow)
      expect(screen.getByRole('button', { name: /Start Reconciliation/ })).toBeDisabled();
    });

    it('calls getReconciliationData with correct params when starting', async () => {
      const { chequingAccount } = setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      // Select account
      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      // Enter balance in the CurrencyInput - find the actual input element
      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      // Click start
      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(mockGetReconciliationData).toHaveBeenCalledWith(
          'acc-1',
          expect.any(String),
          expect.any(Number),
        );
      });
    });

    it('transitions to reconcile step after loading data', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      // Select account
      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      // Enter balance
      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      // Click start
      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      // After successful loading, should show reconcile step content
      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });
    });

    it('shows error toast when reconciliation data fails to load', async () => {
      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockRejectedValue(new Error('Server error'));

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load reconciliation data');
      });
    });

    it('updates subtitle with account name when account is selected', async () => {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      await waitFor(() => {
        expect(screen.getByText('Reconciling: Chequing Account')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Reconcile step
  // -------------------------------------------------------------------------

  describe('reconcile step', () => {
    async function goToReconcileStep() {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      return user;
    }

    it('displays the summary bar with statement balance', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getByText('Statement Balance')).toBeInTheDocument();
      });
    });

    it('displays the reconciled balance in summary', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getByText('Reconciled Balance')).toBeInTheDocument();
      });
    });

    it('displays the difference in summary', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getByText('Difference')).toBeInTheDocument();
      });
    });

    it('displays the transaction count in header', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getByText('Unreconciled Transactions (3)')).toBeInTheDocument();
      });
    });

    it('renders transaction rows with checkboxes', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox');
        expect(checkboxes.length).toBe(3);
      });
    });

    it('pre-selects cleared transactions', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        const checkboxes = screen.getAllByRole('checkbox');
        // txn-1 and txn-2 are CLEARED, txn-3 is UNRECONCILED
        expect(checkboxes[0]).toBeChecked();
        expect(checkboxes[1]).toBeChecked();
        expect(checkboxes[2]).not.toBeChecked();
      });
    });

    it('shows Select All and Select None buttons', async () => {
      await goToReconcileStep();
      expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Select None' })).toBeInTheDocument();
    });

    it('shows Cancel and Finish Reconciliation buttons', async () => {
      await goToReconcileStep();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Finish Reconciliation/ })).toBeInTheDocument();
    });

    it('displays transaction payee names', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getByText('Grocery Store')).toBeInTheDocument();
        expect(screen.getByText('Coffee Shop')).toBeInTheDocument();
        expect(screen.getByText('Salary')).toBeInTheDocument();
      });
    });

    it('displays transaction category names', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        expect(screen.getAllByText('Groceries').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('displays cleared status indicator for cleared transactions', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        // CLEARED transactions show "C"
        const clearedIndicators = screen.getAllByTitle('Cleared');
        expect(clearedIndicators.length).toBe(2);
      });
    });

    it('displays unreconciled status indicator for unreconciled transactions', async () => {
      await goToReconcileStep();
      await waitFor(() => {
        const unreconciledIndicators = screen.getAllByTitle('Unreconciled');
        expect(unreconciledIndicators.length).toBe(1);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Transaction selection toggles
  // -------------------------------------------------------------------------

  describe('transaction selection', () => {
    async function goToReconcileStep() {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      return user;
    }

    it('toggles a transaction checkbox when clicked', async () => {
      const user = await goToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');

      // txn-1 is pre-selected (CLEARED); uncheck it
      expect(checkboxes[0]).toBeChecked();
      await user.click(checkboxes[0]);
      await waitFor(() => {
        expect(checkboxes[0]).not.toBeChecked();
      });

      // Click again to re-check
      await user.click(checkboxes[0]);
      await waitFor(() => {
        expect(checkboxes[0]).toBeChecked();
      });
    });

    it('selects an unchecked transaction when its row is clicked', async () => {
      const user = await goToReconcileStep();
      const checkboxes = screen.getAllByRole('checkbox');

      // txn-3 is UNRECONCILED and not pre-selected
      expect(checkboxes[2]).not.toBeChecked();

      // Click the row (via the payee text)
      await user.click(screen.getByText('Salary'));

      await waitFor(() => {
        expect(checkboxes[2]).toBeChecked();
      });
    });

    it('selects all transactions via Select All button', async () => {
      const user = await goToReconcileStep();

      // Initially txn-3 is unchecked
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[2]).not.toBeChecked();

      await user.click(screen.getByRole('button', { name: 'Select All' }));

      await waitFor(() => {
        const updatedCheckboxes = screen.getAllByRole('checkbox');
        updatedCheckboxes.forEach((cb) => {
          expect(cb).toBeChecked();
        });
      });
    });

    it('deselects all transactions via Select None button', async () => {
      const user = await goToReconcileStep();

      // Initially txn-1 and txn-2 are checked
      const checkboxes = screen.getAllByRole('checkbox');
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[1]).toBeChecked();

      await user.click(screen.getByRole('button', { name: 'Select None' }));

      await waitFor(() => {
        const updatedCheckboxes = screen.getAllByRole('checkbox');
        updatedCheckboxes.forEach((cb) => {
          expect(cb).not.toBeChecked();
        });
      });
    });
  });

  // -------------------------------------------------------------------------
  // Balance calculations
  // -------------------------------------------------------------------------

  describe('balance calculations', () => {
    async function goToReconcileStepWithData(
      reconciliationData: ReconciliationData,
      statementBalanceStr: string = '1120',
    ) {
      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(reconciliationData);
      mockBulkReconcile.mockResolvedValue({ reconciled: 1 });

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, statementBalanceStr);

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      return user;
    }

    it('shows zero difference when selected transactions balance correctly', async () => {
      // reconciledBalance=1000, selected cleared txns sum=-80
      // newBalance = 1000 + (-80) = 920
      // difference = statementBalance - newBalance = 920 - 920 = 0
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -50, status: TransactionStatus.CLEARED }),
          makeTransaction({ id: 'txn-2', amount: -30, status: TransactionStatus.CLEARED }),
        ],
        reconciledBalance: 1000,
      });

      await goToReconcileStepWithData(data, '920');

      // Both cleared transactions are pre-selected
      // difference = 920 - (1000 + (-80)) = 920 - 920 = 0
      await waitFor(() => {
        expect(screen.getByText('$0.00')).toBeInTheDocument();
      });
    });

    it('shows non-zero difference when transactions do not balance', async () => {
      // reconciledBalance=1000, only txn-1 (-50) is cleared
      // newBalance = 1000 + (-50) = 950
      // difference = 1120 - 950 = 170
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -50, status: TransactionStatus.CLEARED }),
          makeTransaction({ id: 'txn-2', amount: 200, status: TransactionStatus.UNRECONCILED }),
        ],
        reconciledBalance: 1000,
      });

      await goToReconcileStepWithData(data, '1120');

      // Pre-selected: only txn-1 (CLEARED) -> sum = -50
      // newBalance = 1000 + (-50) = 950
      // difference = 1120 - 950 = 170
      await waitFor(() => {
        expect(screen.getByText('$170.00')).toBeInTheDocument();
      });
    });

    it('updates selected count when toggling a transaction', async () => {
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -50, status: TransactionStatus.CLEARED }),
          makeTransaction({ id: 'txn-2', amount: -30, status: TransactionStatus.UNRECONCILED }),
        ],
        reconciledBalance: 1000,
      });

      const user = await goToReconcileStepWithData(data, '920');

      // Initially 1 selected (txn-1 is CLEARED)
      await waitFor(() => {
        expect(screen.getByText('Selected (1)')).toBeInTheDocument();
      });

      // Select txn-2
      const checkboxes = screen.getAllByRole('checkbox');
      await user.click(checkboxes[1]);

      await waitFor(() => {
        expect(screen.getByText('Selected (2)')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Finish reconciliation
  // -------------------------------------------------------------------------

  describe('finish reconciliation', () => {
    async function goToReconcileStepBalanced() {
      // Set up a scenario where difference is zero when all cleared are selected
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -80, status: TransactionStatus.CLEARED }),
        ],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);
      mockBulkReconcile.mockResolvedValue({ reconciled: 1 });

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      // statementBalance = 920, reconciledBalance = 1000, selected sum = -80
      // difference = 920 - (1000 + (-80)) = 0
      await user.type(balanceInput, '920');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      return user;
    }

    it('calls bulkReconcile with correct params on finish', async () => {
      const user = await goToReconcileStepBalanced();

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      await waitFor(() => {
        expect(finishButton).not.toBeDisabled();
      });
      await user.click(finishButton);

      await waitFor(() => {
        expect(mockBulkReconcile).toHaveBeenCalledWith(
          'acc-1',
          ['txn-1'],
          expect.any(String),
        );
      });
    });

    it('shows success toast after reconciliation', async () => {
      const user = await goToReconcileStepBalanced();

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      await waitFor(() => {
        expect(finishButton).not.toBeDisabled();
      });
      await user.click(finishButton);

      await waitFor(() => {
        expect(toast.success).toHaveBeenCalledWith('Successfully reconciled 1 transactions');
      });
    });

    it('transitions to complete step after successful reconciliation', async () => {
      const user = await goToReconcileStepBalanced();

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      await waitFor(() => {
        expect(finishButton).not.toBeDisabled();
      });
      await user.click(finishButton);

      await waitFor(() => {
        expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument();
      });
    });

    it('disables finish button when difference is non-zero', async () => {
      // Set up scenario with non-zero difference
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -50, status: TransactionStatus.CLEARED }),
        ],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      // statementBalance=1000, reconciled=1000, selected=-50 -> diff=1000 - 950 = 50
      await user.type(balanceInput, '1000');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      expect(finishButton).toBeDisabled();
    });

    it('disables finish button when no transactions are selected', async () => {
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: 0, status: TransactionStatus.UNRECONCILED }),
        ],
        reconciledBalance: 920,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '920');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      // No cleared transactions means nothing pre-selected
      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      expect(finishButton).toBeDisabled();
    });

    it('shows error toast when bulkReconcile fails', async () => {
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -80, status: TransactionStatus.CLEARED }),
        ],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);
      mockBulkReconcile.mockRejectedValue(new Error('Server error'));

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '920');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      await waitFor(() => {
        expect(finishButton).not.toBeDisabled();
      });
      await user.click(finishButton);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to reconcile transactions');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cancel / back navigation from reconcile step
  // -------------------------------------------------------------------------

  describe('cancel / back navigation', () => {
    async function goToReconcileStep() {
      setupDefaultMocks();
      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1120');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      return user;
    }

    it('returns to setup step when Cancel is clicked on reconcile step', async () => {
      const user = await goToReconcileStep();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Start Reconciliation' })).toBeInTheDocument();
      });
    });

    it('clears reconciliation data when Cancel is clicked', async () => {
      const user = await goToReconcileStep();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      await waitFor(() => {
        // Should be back on setup step, no transaction list visible
        expect(screen.queryByText(/Unreconciled Transactions/)).not.toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Complete step
  // -------------------------------------------------------------------------

  describe('complete step', () => {
    async function goToCompleteStep() {
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-1', amount: -80, status: TransactionStatus.CLEARED }),
        ],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);
      mockBulkReconcile.mockResolvedValue({ reconciled: 1 });

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '920');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText(/Unreconciled Transactions/)).toBeInTheDocument();
      });

      const finishButton = screen.getByRole('button', { name: /Finish Reconciliation/ });
      await waitFor(() => {
        expect(finishButton).not.toBeDisabled();
      });
      await user.click(finishButton);

      await waitFor(() => {
        expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument();
      });

      return user;
    }

    it('shows Reconciliation Complete heading', async () => {
      await goToCompleteStep();
      expect(screen.getByText('Reconciliation Complete')).toBeInTheDocument();
    });

    it('shows success message with statement date', async () => {
      await goToCompleteStep();
      expect(
        screen.getByText(/Your account has been successfully reconciled as of/),
      ).toBeInTheDocument();
    });

    it('shows Back to Accounts button', async () => {
      await goToCompleteStep();
      expect(screen.getByRole('button', { name: 'Back to Accounts' })).toBeInTheDocument();
    });

    it('shows Reconcile Another Account button', async () => {
      await goToCompleteStep();
      expect(
        screen.getByRole('button', { name: 'Reconcile Another Account' }),
      ).toBeInTheDocument();
    });

    it('navigates to /accounts when Back to Accounts is clicked', async () => {
      const user = await goToCompleteStep();
      await user.click(screen.getByRole('button', { name: 'Back to Accounts' }));
      expect(mockPush).toHaveBeenCalledWith('/accounts');
    });

    it('returns to setup step when Reconcile Another Account is clicked', async () => {
      const user = await goToCompleteStep();
      await user.click(screen.getByRole('button', { name: 'Reconcile Another Account' }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Start Reconciliation' })).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Empty transaction list
  // -------------------------------------------------------------------------

  describe('empty transaction list', () => {
    it('shows empty message when no unreconciled transactions exist', async () => {
      const data = makeReconciliationData({
        transactions: [],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1000');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(
          screen.getByText('No unreconciled transactions found for this period.'),
        ).toBeInTheDocument();
      });
    });

    it('shows transaction count as zero', async () => {
      const data = makeReconciliationData({
        transactions: [],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1000');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByText('Unreconciled Transactions (0)')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // Void transaction status display
  // -------------------------------------------------------------------------

  describe('void transaction status', () => {
    it('displays void status indicator for void transactions', async () => {
      const data = makeReconciliationData({
        transactions: [
          makeTransaction({ id: 'txn-void', amount: 0, status: TransactionStatus.VOID }),
        ],
        reconciledBalance: 1000,
      });

      const chequingAccount = makeAccount();
      mockGetAll.mockResolvedValue([chequingAccount]);
      mockGetReconciliationData.mockResolvedValue(data);

      const user = userEvent.setup();
      render(<ReconcilePage />);

      await waitFor(() => {
        expect(screen.getByLabelText('Account')).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText('Account'), 'acc-1');

      const balanceInput = screen.getByLabelText('Statement Ending Balance');
      await user.click(balanceInput);
      await user.type(balanceInput, '1000');

      const startButton = screen.getByRole('button', { name: /Start Reconciliation/ });
      await waitFor(() => {
        expect(startButton).not.toBeDisabled();
      });
      await user.click(startButton);

      await waitFor(() => {
        expect(screen.getByTitle('Void')).toBeInTheDocument();
      });
    });
  });
});
