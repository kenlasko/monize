import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@/test/render';
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
const mockDetectMortgageTypeFromHistory = vi.fn();
const mockGetLoanSettlements = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getLoanSettlements: (...args: unknown[]) => mockGetLoanSettlements(...args),
    detectMortgageTypeFromHistory: (...args: unknown[]) =>
      mockDetectMortgageTypeFromHistory(...args),
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
const mockGetLoanProjectionAnchor = vi.fn();
const mockGetScheduledById = vi.fn();

vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
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
    // The Payment matching panel reads the loan's bill for its source account
    // and auto-post flag.
    getById: (...args: unknown[]) => mockGetScheduledById(...args),
    // The loan detail view prints per-installment interest, so the page
    // anchors its projection on the next scheduled installment's boundary
    // (INV-LOAN-006). These fixtures have no scheduled payment, which is what
    // {null, null} says -- the projection then stays today-anchored.
    getLoanProjectionAnchor: (...args: unknown[]) =>
      mockGetLoanProjectionAnchor(...args),
  },
}));

// The shared edit modal has its own tests; here only what it was opened
// with matters.
vi.mock('@/components/accounts/AccountFormModal', () => ({
  AccountFormModal: ({ formModal, preselectedMortgageType }: any) =>
    formModal.showForm ? (
      <div
        data-testid="account-form-modal"
        data-account-id={formModal.editingItem?.id}
        data-mortgage-type={preselectedMortgageType}
      />
    ) : null,
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
  mockGetLoanProjectionAnchor.mockResolvedValue({
    nextDueDate: null,
    debt: null,
  });
  mockGetLoanSettlements.mockResolvedValue([]);
  mockGetScheduledById.mockResolvedValue({
    id: 'st-1',
    accountId: 'chq-1',
    account: { id: 'chq-1', name: 'Chequing' },
    autoPost: false,
    startDate: '2024-01-01',
  });
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
  mockGetBalanceForecast.mockResolvedValue({
    accountId: 'loan-1',
    currencyCode: 'CAD',
    points: [],
    // The endpoint always reports completeness (issue #1247).
    complete: true,
    gaps: [],
  });
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

  it('opens the edit form with a detected mortgage type and saves nothing', async () => {
    mockGetById.mockResolvedValue(
      makeAccount({ accountType: 'MORTGAGE', name: 'Home', mortgageType: 'ANNUITY' }),
    );
    mockDetectMortgageTypeFromHistory.mockResolvedValue({
      type: 'CANADIAN_FIXED',
      confidence: 'high',
      reason: 'CONSTANT_INSTALLMENT_SEMI_ANNUAL',
      quotedAnnualRate: 6,
      paymentFrequency: 'MONTHLY',
      samples: [],
    });

    await renderPage();
    expect(screen.queryByTestId('account-form-modal')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Detect Mortgage Type' }));
    });
    expect(mockDetectMortgageTypeFromHistory).toHaveBeenCalledWith('loan-1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit Account With This Type' }));
    });

    const modal = screen.getByTestId('account-form-modal');
    expect(modal).toHaveAttribute('data-account-id', 'loan-1');
    expect(modal).toHaveAttribute('data-mortgage-type', 'CANADIAN_FIXED');
  });

  it('opens the edit form from the header Edit button', async () => {
    mockGetById.mockResolvedValue(makeAccount({ accountType: 'CHEQUING', id: 'loan-1' }));

    await renderPage();
    expect(screen.queryByTestId('account-form-modal')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Edit Account' }));
    });

    const modal = screen.getByTestId('account-form-modal');
    expect(modal).toHaveAttribute('data-account-id', 'loan-1');
    expect(modal).not.toHaveAttribute('data-mortgage-type');
  });

  it.each([
    ['closed', { isClosed: true }],
    ['joint', { isJoint: true }],
  ])('offers no Edit button for a %s account', async (_label, overrides) => {
    mockGetById.mockResolvedValue(makeAccount(overrides as Partial<Account>));

    await renderPage();

    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Account' })).not.toBeInTheDocument();
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

  it('surfaces a scenarios load failure instead of a silent empty list (issue: saved scenario "gone" but re-save hits 409)', async () => {
    // Scenarios feed no headline figure, so the page degrades to an empty panel
    // and says so. The rate history is a different case -- see below.
    mockGetById.mockResolvedValue(makeAccount());
    mockGetAllScenarios.mockRejectedValue(new Error('throttled'));

    await renderPage();

    const toast = (await import('react-hot-toast')).default;
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't load the saved scenarios"),
    );
    // The page itself stays usable
    expect(screen.getByText('Car Loan')).toBeInTheDocument();
    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
  });

  it('refuses to project after a failed rate-history load rather than using the stale scalar', async () => {
    // The rate history holds the loan's CURRENT rate: recording a rate change
    // deliberately leaves account.interestRate alone, and the projection
    // resolves both its rate and its payment from those rows. Substituting []
    // for a failed read prices the payoff at a stale scalar -- at 5% against a
    // real 12% a payment short of the interest looks comfortably amortizing --
    // so the failure has to reach the page's retryable error state instead.
    mockGetById.mockResolvedValue(makeAccount());
    mockGetAllRateChanges.mockRejectedValue(new Error('throttled'));

    await renderPage();

    expect(screen.getByText('Failed to load account details')).toBeInTheDocument();
    expect(screen.queryByText('Loan Schedule')).not.toBeInTheDocument();
  });

  it('refuses to keep the old payoff live after a rate mutation whose reload fails', async () => {
    // The mutation SUCCEEDED, so the rows on screen are known-stale -- and the
    // projection resolves its rate and payment from them, so the payoff, the
    // scenarios and the PDF export would all stay live over terms the user has
    // just replaced. A toast disappears; the page's retryable error state does
    // not, and it is the same treatment a failed initial load gets because it is
    // the same prerequisite.
    const { loanRateChangesApi } = await import('@/lib/loan-rate-changes');
    (loanRateChangesApi.detect as ReturnType<typeof vi.fn>).mockResolvedValue({
      created: [],
      warnings: [],
    });
    mockGetById.mockResolvedValue(makeAccount());
    await renderPage();
    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();

    // Detection succeeds, the follow-up authoritative reload does not.
    mockGetAllRateChanges.mockRejectedValue(new Error('throttled'));
    await act(async () => {
      fireEvent.click(screen.getByText('Detect from history'));
    });
    // The confirm dialog reuses the trigger's label, so there are two; the
    // dialog's is the later one.
    const confirms = screen.getAllByText('Detect from history');
    await act(async () => {
      fireEvent.click(confirms[confirms.length - 1]);
    });

    expect(screen.getByText(/Couldn't load the rate history/)).toBeInTheDocument();
    expect(screen.queryByText('Loan Schedule')).not.toBeInTheDocument();

    // "Retryable" has to mean there is a retry: the only control used to be
    // Back to Accounts, which is leaving the page, not trying again.
    mockGetAllRateChanges.mockResolvedValue([]);
  mockGetLoanProjectionAnchor.mockResolvedValue({
    nextDueDate: null,
    debt: null,
  });
    await act(async () => {
      fireEvent.click(screen.getByText('Try again'));
    });
    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
  });

  it('loads the settled installments with the loan history and hands them to the Payment matching panel', async () => {
    mockGetById.mockResolvedValue(makeAccount({ scheduledTransactionId: 'st-1', paymentMatchingRuleId: null }));
    mockGetLoanSettlements.mockResolvedValue([
      {
        claimId: 'c-1',
        dueDate: '2024-01-01',
        postedDate: '2024-01-03',
        transactionId: 'tx-9',
        transactionStatus: 'UNRECONCILED',
        principal: 833.33,
        interest: 500,
        extraPrincipal: 0,
        debtBefore: 300000,
        installmentNumber: 1,
        ruleId: 'rule-1',
      },
    ]);

    await renderPage();

    // One load: the settlements were asked for beside the history, for this loan.
    expect(mockGetLoanSettlements).toHaveBeenCalledTimes(1);
    expect(mockGetLoanSettlements).toHaveBeenCalledWith('loan-1');
    expect(screen.getByText('Payment matching')).toBeInTheDocument();
    expect(screen.getByText('Settled installments (1)')).toBeInTheDocument();
    expect(screen.getByText('$833.33')).toBeInTheDocument();
  });

  it('renders a failed settlements request as an error, never as an empty list, and keeps the page', async () => {
    mockGetById.mockResolvedValue(makeAccount({ scheduledTransactionId: 'st-1', paymentMatchingRuleId: null }));
    mockGetLoanSettlements.mockRejectedValue(new Error('boom'));

    await renderPage();

    expect(screen.getByText('Loan Schedule')).toBeInTheDocument();
    expect(screen.getByText('The settled installments could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('No installments settled yet')).not.toBeInTheDocument();

    // Its retry reloads them.
    mockGetLoanSettlements.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(mockGetLoanSettlements).toHaveBeenCalledTimes(2);
    expect(screen.getByText('No installments settled yet')).toBeInTheDocument();
  });

  it('does not load settlements for an account without the loan view', async () => {
    mockGetById.mockResolvedValue(makeAccount({ accountType: 'CHEQUING' }));

    await renderPage();

    expect(mockGetLoanSettlements).not.toHaveBeenCalled();
  });

  it('projects future payments from the account terms', async () => {
    mockGetById.mockResolvedValue(makeAccount());

    await renderPage();

    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
    expect(screen.getByText('Est. Payoff')).toBeInTheDocument();
  });

  it('anchors the loan projection on the next scheduled installment (issue #1253)', async () => {
    // This page's schedule table prints per-installment interest, so it prices
    // the same installment the amortization report does. Left today-anchored it
    // showed one figure while the report showed another for one payment.
    mockGetById.mockResolvedValue(makeAccount());
    mockGetLoanProjectionAnchor.mockResolvedValue({
      // Consistent with the fixture (an 8,000 loan at 6% paying 500): a debt
      // the installment can actually amortize, or the projection refuses for
      // a reason unrelated to anchoring.
      nextDueDate: '2026-08-01',
      debt: 7500,
    });

    await renderPage();

    expect(mockGetLoanProjectionAnchor).toHaveBeenCalledWith('loan-1');
    expect(screen.getByText('Projected Future Payments')).toBeInTheDocument();
  });

  it('fails the page when the projection anchor cannot be read', async () => {
    // Like the rate history beside it: a failed lookup is not "no scheduled
    // payment", and quietly projecting from today is the drift this anchor
    // exists to remove.
    mockGetById.mockResolvedValue(makeAccount());
    mockGetLoanProjectionAnchor.mockRejectedValue(new Error('boom'));

    await renderPage();

    expect(
      screen.queryByText('Projected Future Payments'),
    ).not.toBeInTheDocument();
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
