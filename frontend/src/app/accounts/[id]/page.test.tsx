import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import AccountDetailPage from './page';
import { Account } from '@/types/account';

const mockPush = vi.fn();
const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/accounts/loan-1',
  useParams: () => ({ id: 'loan-1' }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = {
        user: { id: 'user-1', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'user-1', email: 'test@example.com', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: unknown, fallback: string) => fallback),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
  }),
}));

const mockGetById = vi.fn();
const mockDetectLoanPayments = vi.fn();
const mockGetDailyBalances = vi.fn();
const mockGetBalanceForecast = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getById: (...args: unknown[]) => mockGetById(...args),
    detectLoanPayments: (...args: unknown[]) => mockDetectLoanPayments(...args),
    getDailyBalances: (...args: unknown[]) => mockGetDailyBalances(...args),
    getBalanceForecast: (...args: unknown[]) => mockGetBalanceForecast(...args),
  },
}));

// The line-of-credit view renders the register's balance-history chart; keep
// it light here (it has its own tests).
vi.mock('@/components/transactions/BalanceHistoryChart', () => ({
  BalanceHistoryChart: () => <div data-testid="balance-history-chart" />,
}));

const mockGetAllTransactions = vi.fn();
const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => mockGetAllTransactions(...args),
    getSummary: (...args: unknown[]) => mockGetSummary(...args),
    getMonthlyTotals: (...args: unknown[]) => mockGetMonthlyTotals(...args),
    getGroupedTotals: (...args: unknown[]) => mockGetGroupedTotals(...args),
    getRecurringCharges: (...args: unknown[]) => mockGetRecurringCharges(...args),
  },
}));

const mockGetAllScenarios = vi.fn();
vi.mock('@/lib/loan-scenarios', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/loan-scenarios')>();
  return {
    ...original,
    loanScenariosApi: {
      getAll: (...args: unknown[]) => mockGetAllScenarios(...args),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
});

const mockGetAllRateChanges = vi.fn();
vi.mock('@/lib/loan-rate-changes', () => ({
  loanRateChangesApi: {
    getAll: (...args: unknown[]) => mockGetAllRateChanges(...args),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    detect: vi.fn(),
  },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

// RecurringChargesPanel (rendered by the banking/credit-card views) loads
// scheduled transactions; stub it so the panel makes no real request.
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: () => Promise.resolve([]),
  },
}));

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'loan-1',
    accountType: 'LOAN',
    name: 'Car Loan',
    currencyCode: 'CAD',
    openingBalance: -10000,
    currentBalance: -8000,
    interestRate: 6,
    paymentAmount: 500,
    paymentFrequency: 'MONTHLY',
    isCanadianMortgage: false,
    isVariableRate: false,
    ...overrides,
  } as Account;
}

async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AccountDetailPage />);
  });
  return result!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectLoanPayments.mockResolvedValue(null);
  mockGetDailyBalances.mockResolvedValue([]);
  mockGetAllScenarios.mockResolvedValue([]);
  mockGetAllRateChanges.mockResolvedValue([]);
  mockGetAllTransactions.mockResolvedValue({
    data: [
      {
        id: 'tx-1',
        accountId: 'loan-1',
        transactionDate: '2026-01-15',
        amount: 450,
        linkedTransaction: null,
      },
    ],
    pagination: { hasMore: false },
  });
  mockGetSummary.mockResolvedValue({ totalIncome: 100, totalExpenses: 40, netCashFlow: 60, transactionCount: 3 });
  mockGetBalanceForecast.mockResolvedValue({ accountId: 'loan-1', currencyCode: 'CAD', points: [] });
  mockGetMonthlyTotals.mockResolvedValue([]);
  mockGetGroupedTotals.mockResolvedValue([]);
  mockGetRecurringCharges.mockResolvedValue([]);
});

describe('AccountDetailPage', () => {
  it('renders the loan detail view for a loan account', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText(/Loan - CAD/)).toBeInTheDocument();
    expect(screen.getByText('Current Balance')).toBeInTheDocument();
    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
    expect(mockGetById).toHaveBeenCalledWith('loan-1');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('projects future payments from the account terms', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
  });

  it('redirects account types without a registered detail view to their register', async () => {
    // Every real account type now has a detail page; an unrecognised type falls
    // back to the register.
    mockGetById.mockResolvedValue(
      makeAccount({ accountType: 'UNKNOWN' as unknown as Account['accountType'] }),
    );

    await renderPage();

    expect(mockReplace).toHaveBeenCalledWith('/transactions?accountId=loan-1');
  });

  it('renders the banking detail view for a chequing account', async () => {
    mockGetById.mockResolvedValue(makeAccount({ accountType: 'CHEQUING', name: 'Everyday Chequing' }));

    await renderPage();

    expect(screen.getByText('Everyday Chequing')).toBeInTheDocument();
    expect(screen.getByText('Cash Flow')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
    // Banking uses its own analytics, not the loan transaction history.
    expect(mockGetAllScenarios).not.toHaveBeenCalled();
  });

  it('shows the revolving balance-history view for a line of credit', async () => {
    mockGetById.mockResolvedValue(
      makeAccount({
        accountType: 'LINE_OF_CREDIT',
        name: 'Home Equity Line',
        openingBalance: 0,
        currentBalance: -3000,
        creditLimit: 10000,
      }),
    );

    await renderPage();

    expect(screen.getByText('Home Equity Line')).toBeInTheDocument();
    expect(screen.getByText('Credit Limit')).toBeInTheDocument();
    expect(screen.getByText('Balance History')).toBeInTheDocument();
    // Revolving accounts get the balance view, not the amortization schedule
    expect(screen.queryByText('Loan Schedule')).not.toBeInTheDocument();
    expect(mockGetDailyBalances).toHaveBeenCalledWith({ accountIds: 'loan-1' });
    // Transactions are not fetched for the revolving view
    expect(mockGetAllTransactions).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('shows an error state with a back button when loading fails', async () => {
    mockGetById.mockRejectedValue(new Error('boom'));

    await renderPage();
    await act(async () => {}); // flush pending rejection handlers

    expect(screen.getByText('Failed to load account details')).toBeInTheDocument();
    const backButton = screen.getByText('Back to Accounts');
    await act(async () => {
      backButton.click();
    });
    expect(mockPush).toHaveBeenCalledWith('/accounts');
  });

  it('navigates to the transaction register from the header action', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    const viewTransactions = screen.getByText('View Transactions');
    await act(async () => {
      viewTransactions.click();
    });
    expect(mockPush).toHaveBeenCalledWith('/transactions?accountId=loan-1');
  });
});
