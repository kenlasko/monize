import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import AccountDetailPage from './page';
import { Account } from '@/types/account';

const mockPush = vi.fn();
const mockReplace = vi.fn();
// One router for the run, as the real useRouter returns. Rebuilt per call it
// changes identity every render, so every useCallback holding it does too --
// and an effect depending on such a callback re-runs forever.
vi.mock('next/navigation', () => {
  // Built on first use, not in the factory body: vi.mock is hoisted above the
  // consts it closes over.
  let router: { push: typeof mockPush; replace: typeof mockReplace } | null = null;
  return {
    useRouter: () => (router ??= { push: mockPush, replace: mockReplace }),
    usePathname: () => '/accounts/loan-1',
    useParams: () => ({ id: 'loan-1' }),
  };
});

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

// Only `formatCurrency` is pinned, so the assertions read `$1234.00` whatever
// the ambient preferences say. The rest of the hook's surface comes from the
// real one: a mock offering a subset is a fiction the moment a component this
// page mounts reaches for another formatter -- `InvestmentValueChart` calls
// `formatSignedPercent`, which is undefined on a hand-written object.
vi.mock('@/hooks/useNumberFormat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useNumberFormat')>();
  return {
    ...actual,
    useNumberFormat: () => ({
      ...actual.useNumberFormat(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
    }),
  };
});

const mockGetById = vi.fn();
const mockGetAll = vi.fn();
const mockDetectLoanPayments = vi.fn();
const mockGetDailyBalances = vi.fn();
const mockGetBalanceForecast = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getById: (...args: unknown[]) => mockGetById(...args),
    getAll: (...args: unknown[]) => mockGetAll(...args),
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

// The foreign-currency section is always mounted now and decides for itself
// whether to render; stub it so this page test stays independent of its
// data-loading (it has its own tests).
vi.mock('@/components/accounts/shared/ForeignCurrencyFeesSection', () => ({
  ForeignCurrencyFeesSection: ({ account }: { account: Account }) => (
    <div data-testid="fx-fees-section" data-account-id={account.id} />
  ),
}));

const mockGetAllTransactions = vi.fn();
const mockGetAllPages = vi.fn();
const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetRecurringCharges = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: unknown[]) => mockGetAllTransactions(...args),
    getAllPages: (...args: unknown[]) => mockGetAllPages(...args),
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
  mockGetAll.mockResolvedValue([]);
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
  mockGetAllPages.mockResolvedValue([]);
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

  it('mounts the foreign-currency section regardless of the fee percentage', async () => {
    // No fee configured -- the section still mounts and decides for itself
    // whether to render (it shows the register when foreign transactions exist).
    mockGetById.mockResolvedValue(makeAccount({ fxFeePercent: 0 }));

    await renderPage();

    const section = screen.getByTestId('fx-fees-section');
    expect(section).toBeInTheDocument();
    expect(section).toHaveAttribute('data-account-id', 'loan-1');
  });

  it('surfaces a scenarios/rate-history load failure instead of a silent empty list (issue: saved scenario "gone" but re-save hits 409)', async () => {
    mockGetById.mockResolvedValue(makeAccount());
    mockGetAllScenarios.mockRejectedValue(new Error('throttled'));
    mockGetAllRateChanges.mockRejectedValue(new Error('throttled'));

    await renderPage();

    const toast = (await import('react-hot-toast')).default;
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load the saved scenarios"),
    );
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load the rate history"),
    );
    // The page itself stays usable
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
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
  // A pair is one account, so it gets one URL. A link to the cash id -- an old
  // bookmark, a deep link out of a register -- lands on the same page instead
  // of a second one carrying its own switcher state and history entry.
  it('sends a link to the cash half to the account canonical URL', async () => {
    mockGetById.mockResolvedValue(makeAccount({
      id: 'cash-1',
      name: 'TFSA - Cash',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: 'brok-1',
    }));

    await act(async () => {
      render(<AccountDetailPage />);
    });

    expect(mockReplace).toHaveBeenCalledWith('/accounts/brok-1');
  });

  it('stays put for the brokerage half, which is the canonical URL', async () => {
    mockGetById.mockResolvedValue(makeAccount({
      id: 'brok-1',
      name: 'TFSA - Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      linkedAccountId: 'cash-1',
    }));

    await act(async () => {
      render(<AccountDetailPage />);
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  // The investment actions live on the title row via the shell's headerActions;
  // the body renders neither, so finding them at all proves the page wired
  // them into the header.
  it('renders the investment actions in the shared header', async () => {
    mockGetById.mockResolvedValue(makeAccount({
      id: 'brok-1',
      name: 'TFSA - Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      isClosed: false,
    }));

    await renderPage();

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in Investments' })).toBeInTheDocument();
  });

  it('drops the investments link for a closed investment account', async () => {
    mockGetById.mockResolvedValue(makeAccount({
      id: 'brok-closed',
      name: 'Old TFSA - Brokerage',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_BROKERAGE',
      isClosed: true,
      closedDate: '2024-01-01T00:00:00Z',
    }));

    await renderPage();

    expect(screen.queryByRole('button', { name: 'Open in Investments' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('stays put for an unpaired cash account, which has nowhere to redirect', async () => {
    mockGetById.mockResolvedValue(makeAccount({
      id: 'orphan-cash',
      name: 'RRSP - Cash',
      accountType: 'INVESTMENT',
      accountSubType: 'INVESTMENT_CASH',
      linkedAccountId: null,
    }));

    await act(async () => {
      render(<AccountDetailPage />);
    });

    expect(mockReplace).not.toHaveBeenCalled();
  });
});
