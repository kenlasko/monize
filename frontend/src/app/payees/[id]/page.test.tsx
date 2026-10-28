import { usePreferencesStore } from '@/store/preferencesStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, within } from '@/test/render';
import toast from 'react-hot-toast';
import PayeeDetailPage from './page';
import type { PayeeDetail } from '@/types/payee';
import type { TransactionSummary } from '@/types/transaction';

const mockPush = vi.fn();
/**
 * One router object for the whole file, as real Next returns. A fresh object
 * per call would churn every `useCallback` that depends on it, which would hide
 * exactly the prop-stability this file asserts below.
 */
const stableRouter = { push: mockPush, replace: vi.fn() };
/** Mutable so a test can arrive with `?tab=` the way a deep link does. */
const searchParams = { current: new URLSearchParams() };
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  usePathname: () => '/payees/payee-1',
  useParams: () => ({ id: 'payee-1' }),
  useSearchParams: () => searchParams.current,
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
        user: { id: 'user-1', email: 'test@example.com', role: 'user' },
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

// The chart has its own tests; stub it so this page test does not depend on
// Recharts measuring a zero-size container. The props of each render are
// recorded so the prop-stability guard below can compare them.
const chartProps: Array<{ data: unknown; onMonthClick: unknown }> = [];
vi.mock('@/components/transactions/CategoryPayeeBarChart', () => ({
  CategoryPayeeBarChart: ({
    data,
    onMonthClick,
  }: {
    data: unknown[];
    onMonthClick?: unknown;
  }) => {
    chartProps.push({ data, onMonthClick });
    return <div data-testid="chart">{data.length}</div>;
  },
}));

const mockGetDetail = vi.fn();
const mockGetAllPayees = vi.fn();
const mockUpdatePayee = vi.fn();
const mockReactivatePayee = vi.fn();
vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getDetail: (...args: unknown[]) => mockGetDetail(...args),
    getAll: (...args: unknown[]) => mockGetAllPayees(...args),
    update: (...args: unknown[]) => mockUpdatePayee(...args),
    reactivatePayee: (...args: unknown[]) => mockReactivatePayee(...args),
    getAliases: vi.fn().mockResolvedValue([]),
    createAlias: vi.fn(),
    deleteAlias: vi.fn(),
    mergePayees: vi.fn(),
  },
}));

const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetRecurringCharges = vi.fn();
const mockGetAllTransactions = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: (...args: unknown[]) => mockGetSummary(...args),
    getMonthlyTotals: (...args: unknown[]) => mockGetMonthlyTotals(...args),
    getGroupedTotals: (...args: unknown[]) => mockGetGroupedTotals(...args),
    getRecurringCharges: (...args: unknown[]) => mockGetRecurringCharges(...args),
    getAll: (...args: unknown[]) => mockGetAllTransactions(...args),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'CAD',
    rates: {},
    isLoading: false,
  }),
}));

function detailFixture(overrides: Partial<PayeeDetail> = {}): PayeeDetail {
  return {
    payee: {
      id: 'payee-1',
      userId: 'user-1',
      name: 'Starbucks',
      defaultCategoryId: 'cat-1',
      defaultCategory: {
        id: 'cat-1',
        name: 'Coffee',
      } as PayeeDetail['payee']['defaultCategory'],
      notes: null,
      website: null,
      hasLogo: false,
      logoFetchedAt: null,
      contactLookupAt: null,
      contactLookupSource: null,
      address: null,
      email: null,
      phone: null,
      isActive: true,
      createdAt: '2024-01-15T00:00:00.000Z',
    },
    stats: {
      transactionCount: 42,
      firstTransactionDate: '2019-03-01',
      lastTransactionDate: '2026-07-15',
      uncategorizedCount: 5,
      aliasCount: 2,
    },
    accounts: [
      {
        accountId: 'acct-1',
        accountName: 'Chequing',
        accountType: 'CHEQUING',
        currencyCode: 'CAD',
        transactionCount: 40,
        total: -1234.56,
        lastTransactionDate: '2026-07-15',
      },
    ],
    largestTransaction: {
      id: 'tx-9',
      transactionDate: '2025-12-24',
      amount: -95.2,
      currencyCode: 'CAD',
      accountId: 'acct-1',
      accountName: 'Chequing',
      description: null,
    },
    overpaymentForAccounts: [],
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<TransactionSummary> = {}): TransactionSummary {
  return {
    totalIncome: 0,
    totalExpenses: 1234.56,
    netCashFlow: -1234.56,
    transactionCount: 42,
    byCurrency: {
      CAD: { totalIncome: 0, totalExpenses: 1234.56, netCashFlow: -1234.56, transactionCount: 42 },
    },
    ...overrides,
  } as TransactionSummary;
}

async function renderPage() {
  await act(async () => {
    render(<PayeeDetailPage />);
  });
}

describe('PayeeDetailPage', () => {
  beforeEach(() => {
    usePreferencesStore.setState({preferences:{accrualEnabled:true,reportingBasis:"accrual"} as never});
    vi.clearAllMocks();
    chartProps.length = 0;
    searchParams.current = new URLSearchParams();
    mockGetDetail.mockResolvedValue(detailFixture());
    mockGetAllPayees.mockResolvedValue([]);
    mockGetSummary.mockResolvedValue(summaryFixture());
    mockGetMonthlyTotals.mockResolvedValue([
      { month: '2026-06', total: -120, count: 4 },
    ]);
    mockGetGroupedTotals.mockResolvedValue([
      { id: 'cat-1', name: 'Coffee', currencyCode: 'CAD', total: -1000, count: 30 },
    ]);
    mockGetRecurringCharges.mockResolvedValue([]);
    mockGetAllTransactions.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
    });
  });

  it('uses the user basis for trends and supports a view override', async () => {
    usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
    await renderPage();
    expect(mockGetMonthlyTotals).toHaveBeenLastCalledWith({basis:'cash', payeeIds:['payee-1']});
    await act(async()=>fireEvent.click(screen.getByRole('button', { name: /^Accrual(?: \(user default\))?$/ })));
    expect(mockGetMonthlyTotals).toHaveBeenLastCalledWith({basis:'accrual', payeeIds:['payee-1']});
    expect(usePreferencesStore.getState().preferences?.reportingBasis).toBe('cash');
    await act(async()=>usePreferencesStore.setState({preferences:null}));
  });
  it('shows a retryable error rather than empty history when a required trend fails', async () => {
    mockGetMonthlyTotals.mockRejectedValueOnce(new Error('trend unavailable'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load payee details');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Reporting basis' })).toBeInTheDocument();
  });
  it('renders the header, cards and overview panels', async () => {
    await renderPage();

    expect(mockGetDetail).toHaveBeenCalledWith('payee-1');
    expect(screen.getByRole('heading', { name: 'Starbucks' })).toBeInTheDocument();
    expect(screen.getByText('Spent This Year')).toBeInTheDocument();
    expect(screen.getByText('Top Categories')).toBeInTheDocument();
    expect(screen.getByText('Paid From Accounts')).toBeInTheDocument();
    expect(screen.getByText('Bills & Recurring')).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('shows the error panel with retry when the detail fails to load', async () => {
    mockGetDetail.mockRejectedValueOnce(new Error('boom'));

    await renderPage();
    await act(async () => {});

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Failed to load payee details')).toBeInTheDocument();

    // Retry reloads and recovers.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Starbucks' })).toBeInTheDocument(),
    );
  });

  it('shows a retryable error when every analytics call fails', async () => {
    mockGetSummary.mockRejectedValue(new Error('summary down'));
    mockGetMonthlyTotals.mockRejectedValue(new Error('down'));
    mockGetGroupedTotals.mockRejectedValue(new Error('down'));
    mockGetRecurringCharges.mockRejectedValue(new Error('down'));

    await renderPage();

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Retry'})).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('opens on the tab a deep link names', async () => {
    searchParams.current = new URLSearchParams('tab=aliases');

    await renderPage();

    expect(screen.getByRole('tab', { name: 'Aliases', selected: true })).toBeInTheDocument();
  });

  it('navigates to the register from View Transactions', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'View Transactions' }));
    // accountStatus=all, or the register hides payments made from an account
    // that has since been closed.
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?payeeId=payee-1&accountStatus=all&basis=accrual',
    );
  });

  it('filters by payee and account together when an account row is clicked', async () => {
    await renderPage();

    fireEvent.click(screen.getByText('Chequing'));

    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?payeeId=payee-1&accountStatus=all&accountId=acct-1&basis=accrual',
    );
  });

  it('carries accountStatus=all on a category row too', async () => {
      usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
    await renderPage();

    // "Coffee" is also the payee's default category in Key Information, so the
    // click is scoped to the Top Categories panel.
    const panel = screen.getByText('Top Categories').closest('section')!;
    fireEvent.click(within(panel).getByText('Coffee'));

    // The panel's range also lands in the link; what matters here is that a
    // closed account is not pruned out of the result.
    const url = mockPush.mock.calls.at(-1)![0] as string;
    expect(url).toContain('payeeId=payee-1');
    expect(url).toContain('accountStatus=all');
    expect(url).toContain('categoryId=cat-1');
  });

  it('narrows the register to one day from the largest transaction', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /95\.20/ }));

    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?payeeId=payee-1&accountStatus=all&startDate=2025-12-24&endDate=2025-12-24&basis=cash',
    );
  });

  it('asks for the whole history for the chart, not a window', async () => {
    await renderPage();

    expect(mockGetMonthlyTotals).toHaveBeenCalledWith({ basis: 'accrual', payeeIds: ['payee-1'] });
  });

  describe('Top Categories range toggle', () => {
    beforeEach(() => {
      // Trailing 12 months and all time return different breakdowns, so the
      // panel visibly changes when the range does.
      mockGetGroupedTotals.mockImplementation((params: { startDate?: string }) =>
        Promise.resolve(
          params.startDate
            ? [{ id: 'cat-1', name: 'Coffee', currencyCode: 'CAD', total: -100, count: 5 }]
            : [{ id: 'cat-2', name: 'Pastry', currencyCode: 'CAD', total: -900, count: 60 }],
        ),
      );
    });

    it('fetches both ranges up front so switching needs no request', async () => {
      await renderPage();

      expect(mockGetGroupedTotals).toHaveBeenCalledWith(
        expect.objectContaining({ groupBy: 'category', startDate: expect.any(String) }),
      );
      const allTimeCall = mockGetGroupedTotals.mock.calls.find(
        ([params]) => params.groupBy === 'category' && params.startDate === undefined,
      );
      expect(allTimeCall).toBeDefined();
    });

    it('opens on the trailing 12 months', async () => {
      await renderPage();

      const panel = screen.getByText('Top Categories').closest('section')!;
      expect(within(panel).getByText('Trailing 12 months')).toBeInTheDocument();
      expect(within(panel).getByText('Coffee')).toBeInTheDocument();
    });

    it('switches to all time without refetching', async () => {
      await renderPage();
      const callsBefore = mockGetGroupedTotals.mock.calls.length;

      const panel = screen.getByText('Top Categories').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });

      expect(within(panel).getByText('Pastry')).toBeInTheDocument();
      expect(within(panel).queryByText('Coffee')).toBeNull();
      expect(mockGetGroupedTotals.mock.calls.length).toBe(callsBefore);
    });

    it('drops the date filter from a category link when showing all time', async () => {
      usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
      await renderPage();

      const panel = screen.getByText('Top Categories').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });
      fireEvent.click(within(panel).getByText('Pastry'));

      expect(mockPush).toHaveBeenCalledWith(
        '/transactions?payeeId=payee-1&accountStatus=all&categoryId=cat-2&basis=cash',
      );
    });

    // The chart is memoized because Recharts hides a bar's value labels while
    // its entry animation runs: an unrelated re-render blanks every label and
    // fades it back, which reads as the chart reloading. Memo only bails out
    // when the props are referentially equal, so the page has to keep them so.
    it('hands the chart unchanged props when the range toggles', async () => {
      await renderPage();
      const before = chartProps.at(-1)!;

      const panel = screen.getByText('Top Categories').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });

      const after = chartProps.at(-1)!;
      expect(after.data).toBe(before.data);
      expect(after.onMonthClick).toBe(before.onMonthClick);
    });

    it('carries the 12-month window into a category link', async () => {
      usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
      await renderPage();

      const panel = screen.getByText('Top Categories').closest('section')!;
      fireEvent.click(within(panel).getByText('Coffee'));

      const url = mockPush.mock.calls.at(-1)![0] as string;
      expect(url).toContain('categoryId=cat-1');
      expect(url).toContain('startDate=');
      expect(url).toContain('endDate=');
    });
  });

  it('applies the default category from the Uncategorized card', async () => {
    mockUpdatePayee.mockResolvedValue({
      ...detailFixture().payee,
      transactionsCategorized: 5,
    });

    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Uncategorized' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(mockUpdatePayee).toHaveBeenCalledWith('payee-1', {
      defaultCategoryId: 'cat-1',
      applyCategoryToTransactions: 'uncategorized',
    });
    expect(toast.success).toHaveBeenCalledWith('5 transactions categorized');
  });

  it('deactivates the payee after confirmation', async () => {
    mockUpdatePayee.mockResolvedValue(detailFixture().payee);

    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    });
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Deactivate' }).at(-1)!);
    });

    expect(mockUpdatePayee).toHaveBeenCalledWith('payee-1', { isActive: false });
  });

  it('reactivates an inactive payee', async () => {
    mockGetDetail.mockResolvedValue(
      detailFixture({
        payee: { ...detailFixture().payee, isActive: false },
      }),
    );
    mockReactivatePayee.mockResolvedValue({ ...detailFixture().payee, isActive: true });

    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    });
    // The confirm dialog's own Reactivate button.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Reactivate/ }).at(-1)!);
    });

    expect(mockReactivatePayee).toHaveBeenCalledWith('payee-1');
  });
});
