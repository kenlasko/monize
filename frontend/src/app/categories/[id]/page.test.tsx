import { usePreferencesStore } from '@/store/preferencesStore';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor, within } from '@/test/render';
import CategoryDetailPage from './page';
import type { Category, CategoryDetail } from '@/types/category';
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
/** Mutable so the stale-response test can move to another category in place. */
const routeParams = { current: { id: 'cat-1' } as { id: string } };
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
  usePathname: () => '/categories/cat-1',
  useParams: () => routeParams.current,
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
const mockGetAllCategories = vi.fn();
const mockUpdateCategory = vi.fn();
const mockDeleteCategory = vi.fn();
const mockGetTransactionCount = vi.fn();
const mockReassignTransactions = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getDetail: (...args: unknown[]) => mockGetDetail(...args),
    getAll: (...args: unknown[]) => mockGetAllCategories(...args),
    update: (...args: unknown[]) => mockUpdateCategory(...args),
    delete: (...args: unknown[]) => mockDeleteCategory(...args),
    getTransactionCount: (...args: unknown[]) => mockGetTransactionCount(...args),
    reassignTransactions: (...args: unknown[]) => mockReassignTransactions(...args),
  },
}));

const mockGetSummary = vi.fn();
const mockGetMonthlyTotals = vi.fn();
const mockGetGroupedTotals = vi.fn();
const mockGetAllTransactions = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getSummary: (...args: unknown[]) => mockGetSummary(...args),
    getMonthlyTotals: (...args: unknown[]) => mockGetMonthlyTotals(...args),
    getGroupedTotals: (...args: unknown[]) => mockGetGroupedTotals(...args),
    getAll: (...args: unknown[]) => mockGetAllTransactions(...args),
    getTagKeyBreakdown: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/lib/tags', () => ({
  tagsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (amount: number) => amount,
    defaultCurrency: 'CAD',
    rates: {},
    isLoading: false,
  }),
}));

function categoryFixture(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Groceries',
    description: null,
    icon: null,
    color: '#22c55e',
    effectiveColor: '#22c55e',
    effectiveIcon: null,
    autoSign: null,
    effectiveAutoSign: true,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

/** The user's category list: Groceries with one child, plus an income root. */
function categoryListFixture(): Category[] {
  return [
    categoryFixture(),
    categoryFixture({
      id: 'cat-1a',
      parentId: 'cat-1',
      name: 'Produce',
      color: null,
      effectiveColor: '#22c55e',
      effectiveIcon: null,
      autoSign: null,
      effectiveAutoSign: true,
    }),
    categoryFixture({ id: 'cat-2', name: 'Salary', isIncome: true }),
  ];
}

function detailFixture(overrides: Partial<CategoryDetail> = {}): CategoryDetail {
  return {
    category: categoryFixture(),
    stats: {
      transactionCount: 42,
      firstTransactionDate: '2019-03-01',
      lastTransactionDate: '2026-07-15',
      payeeCount: 7,
      subcategoryCount: 1,
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
      payeeName: 'Loblaws',
    },
    defaultCategoryForPayees: [],
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
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<CategoryDetailPage />);
  });
  return result;
}

describe('CategoryDetailPage', () => {
  beforeEach(() => {
    usePreferencesStore.setState({preferences:{accrualEnabled:true,reportingBasis:"accrual"} as never});
    vi.clearAllMocks();
    chartProps.length = 0;
    searchParams.current = new URLSearchParams();
    routeParams.current = { id: 'cat-1' };
    mockGetDetail.mockResolvedValue(detailFixture());
    mockGetAllCategories.mockResolvedValue(categoryListFixture());
    mockGetSummary.mockResolvedValue(summaryFixture());
    mockGetMonthlyTotals.mockResolvedValue([
      { month: '2026-06', total: -120, count: 4 },
    ]);
    mockGetGroupedTotals.mockImplementation(({ groupBy }: { groupBy: string }) =>
      Promise.resolve(
        groupBy === 'payee'
          ? [{ id: 'payee-9', name: 'Loblaws', currencyCode: 'CAD', total: -800, count: 20 }]
          : [
              { id: 'cat-1', name: 'Groceries', currencyCode: 'CAD', total: -700, count: 25 },
              { id: 'cat-1a', name: 'Produce', currencyCode: 'CAD', total: -300, count: 10 },
            ],
      ),
    );
    mockGetAllTransactions.mockResolvedValue({
      data: [],
      pagination: { page: 1, limit: 10, total: 0, totalPages: 0, hasMore: false },
    });
  });

  it('uses the user basis for trends and supports a view override', async () => {
    usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
    await renderPage();
    expect(mockGetMonthlyTotals).toHaveBeenLastCalledWith({basis:'cash', categoryIds:['cat-1']});
    await act(async()=>fireEvent.click(screen.getByRole('button', { name: /^Accrual(?: \(user default\))?$/ })));
    expect(mockGetMonthlyTotals).toHaveBeenLastCalledWith({basis:'accrual', categoryIds:['cat-1']});
    expect(usePreferencesStore.getState().preferences?.reportingBasis).toBe('cash');
    await act(async()=>usePreferencesStore.setState({preferences:null}));
  });
  it('shows a retryable error rather than empty history when a required trend fails', async () => {
    mockGetMonthlyTotals.mockRejectedValueOnce(new Error('trend unavailable'));
    await renderPage();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to load category details');
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Reporting basis' })).toBeInTheDocument();
  });
  it('renders the header, cards and overview panels', async () => {
    await renderPage();

    expect(mockGetDetail).toHaveBeenCalledWith('cat-1');
    expect(screen.getByRole('heading', { name: 'Groceries' })).toBeInTheDocument();
    expect(screen.getByText('Spent This Year')).toBeInTheDocument();
    expect(screen.getByText('Monthly Average')).toBeInTheDocument();
    expect(screen.getByText('Top Payees')).toBeInTheDocument();
    expect(screen.getByText('Paid From Accounts')).toBeInTheDocument();
    expect(screen.getByText('Upcoming Scheduled')).toBeInTheDocument();
    expect(screen.getByText('Seasonality')).toBeInTheDocument();
    expect(screen.getByTestId('chart')).toBeInTheDocument();
  });

  it('titles a subcategory page "Parent: Child"', async () => {
    routeParams.current = { id: 'cat-1a' };
    mockGetDetail.mockResolvedValue(
      detailFixture({
        category: categoryFixture({ id: 'cat-1a', parentId: 'cat-1', name: 'Produce' }),
      }),
    );

    await renderPage();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Groceries: Produce' }),
    ).toBeInTheDocument();
  });

  it('frames an income category as received, not spent', async () => {
    mockGetDetail.mockResolvedValue(
      detailFixture({ category: categoryFixture({ isIncome: true }) }),
    );

    await renderPage();

    expect(screen.getByText('Received This Year')).toBeInTheDocument();
    expect(screen.queryByText('Spent This Year')).toBeNull();
  });

  it('shows the error panel with retry when the detail fails to load', async () => {
    mockGetDetail.mockRejectedValueOnce(new Error('boom'));

    await renderPage();
    await act(async () => {});

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Failed to load category details')).toBeInTheDocument();

    // Retry reloads and recovers.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Groceries' })).toBeInTheDocument(),
    );
  });

  it('shows a retryable error when every analytics call fails', async () => {
    mockGetSummary.mockRejectedValue(new Error('summary down'));
    mockGetMonthlyTotals.mockRejectedValue(new Error('down'));
    mockGetGroupedTotals.mockRejectedValue(new Error('down'));

    await renderPage();

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Retry'})).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
  });

  it('opens on the tab a deep link names', async () => {
    searchParams.current = new URLSearchParams('tab=transactions');

    await renderPage();

    expect(
      screen.getByRole('tab', { name: 'Transactions', selected: true }),
    ).toBeInTheDocument();
  });

  it('offers the Subcategories tab only when children exist, and falls back on a leaf deep link', async () => {
    // A leaf: the category list holds no child of cat-1.
    mockGetAllCategories.mockResolvedValue([categoryFixture()]);
    searchParams.current = new URLSearchParams('tab=subcategories');

    await renderPage();

    expect(screen.queryByRole('tab', { name: 'Subcategories' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Overview', selected: true })).toBeInTheDocument();
  });

  it('opens the Subcategories tab from a deep link when children exist', async () => {
    searchParams.current = new URLSearchParams('tab=subcategories');

    await renderPage();

    expect(
      screen.getByRole('tab', { name: 'Subcategories', selected: true }),
    ).toBeInTheDocument();
  });

  it('navigates to the register from View Transactions', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'View Transactions' }));
    // accountStatus=all, or the register hides payments made from an account
    // that has since been closed.
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=cat-1&accountStatus=all&basis=accrual',
    );
  });

  it('filters by category and account together when an account row is clicked', async () => {
    await renderPage();

    fireEvent.click(screen.getByText('Chequing'));

    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=cat-1&accountStatus=all&accountId=acct-1&basis=accrual',
    );
  });

  it('narrows the register to one day from the largest transaction', async () => {
    await renderPage();

    fireEvent.click(screen.getByRole('button', { name: /95\.20/ }));

    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?categoryId=cat-1&accountStatus=all&startDate=2025-12-24&endDate=2025-12-24&basis=cash',
    );
  });

  it('opens a subcategory page from the breakdown panel', async () => {
    await renderPage();

    const panel = screen.getByText('Subcategories', { selector: 'h2' }).closest('section')!;
    fireEvent.click(within(panel).getByText('Produce'));

    expect(mockPush).toHaveBeenCalledWith('/categories/cat-1a');
  });

  it('asks for the whole history for the chart, not a window', async () => {
    await renderPage();

    expect(mockGetMonthlyTotals).toHaveBeenCalledWith({ basis: 'accrual', categoryIds: ['cat-1'] });
  });

  it('hides Edit and Delete for a system category', async () => {
    mockGetDetail.mockResolvedValue(
      detailFixture({ category: categoryFixture({ isSystem: true }) }),
    );

    await renderPage();

    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('deletes the category and leaves for the list', async () => {
    mockGetTransactionCount.mockResolvedValue(0);
    mockDeleteCategory.mockResolvedValue(undefined);

    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    });
    // The delete dialog's own confirm button.
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: /Delete/ }).at(-1)!);
    });

    expect(mockDeleteCategory).toHaveBeenCalledWith('cat-1');
    expect(mockReassignTransactions).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/categories');
  });

  describe('Top Payees range toggle', () => {
    beforeEach(() => {
      // Trailing 12 months and all time return different breakdowns, so the
      // panel visibly changes when the range does.
      mockGetGroupedTotals.mockImplementation(
        ({ groupBy, startDate }: { groupBy: string; startDate?: string }) =>
          Promise.resolve(
            groupBy === 'payee'
              ? startDate
                ? [{ id: 'payee-9', name: 'Loblaws', currencyCode: 'CAD', total: -100, count: 5 }]
                : [{ id: 'payee-8', name: 'Metro', currencyCode: 'CAD', total: -900, count: 60 }]
              : [],
          ),
      );
    });

    it('fetches both ranges up front so switching needs no request', async () => {
      await renderPage();

      expect(mockGetGroupedTotals).toHaveBeenCalledWith(
        expect.objectContaining({ groupBy: 'payee', startDate: expect.any(String) }),
      );
      const allTimeCall = mockGetGroupedTotals.mock.calls.find(
        ([params]) => params.groupBy === 'payee' && params.startDate === undefined,
      );
      expect(allTimeCall).toBeDefined();
    });

    it('switches to all time without refetching', async () => {
      await renderPage();
      const callsBefore = mockGetGroupedTotals.mock.calls.length;

      const panel = screen.getByText('Top Payees').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });

      expect(within(panel).getByText('Metro')).toBeInTheDocument();
      expect(within(panel).queryByText('Loblaws')).toBeNull();
      expect(mockGetGroupedTotals.mock.calls.length).toBe(callsBefore);
    });

    // The chart is memoized because Recharts hides a bar's value labels while
    // its entry animation runs: an unrelated re-render blanks every label and
    // fades it back, which reads as the chart reloading. Memo only bails out
    // when the props are referentially equal, so the page has to keep them so.
    it('hands the chart unchanged props when the range toggles', async () => {
      await renderPage();
      const before = chartProps.at(-1)!;

      const panel = screen.getByText('Top Payees').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });

      const after = chartProps.at(-1)!;
      expect(after.data).toBe(before.data);
      expect(after.onMonthClick).toBe(before.onMonthClick);
    });

    it('carries the 12-month window into a payee link', async () => {
      usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
      await renderPage();

      const panel = screen.getByText('Top Payees').closest('section')!;
      fireEvent.click(within(panel).getByText('Loblaws'));

      const url = mockPush.mock.calls.at(-1)![0] as string;
      expect(url).toContain('categoryId=cat-1');
      expect(url).toContain('accountStatus=all');
      expect(url).toContain('payeeId=payee-9');
      expect(url).toContain('startDate=');
      expect(url).toContain('endDate=');
    });

    it('drops the date filter from a payee link when showing all time', async () => {
      usePreferencesStore.getState().updatePreferences({reportingBasis:'cash'});
      await renderPage();

      const panel = screen.getByText('Top Payees').closest('section')!;
      await act(async () => {
        fireEvent.click(within(panel).getByRole('button', { name: 'All time' }));
      });
      fireEvent.click(within(panel).getByText('Metro'));

      expect(mockPush).toHaveBeenCalledWith(
        '/transactions?categoryId=cat-1&accountStatus=all&payeeId=payee-8&basis=cash',
      );
    });
  });

  it('discards a load that resolves after the reader moved to another category', async () => {
    // The switcher moves between categories on the same route, so this
    // component stays mounted and a load started for the previous one keeps
    // running. With nothing discarding the late response, it would write its
    // own figures over the new page: another category's spending under this
    // category's URL, with nothing on screen to say so.
    let resolveSlowRead: ((detail: CategoryDetail) => void) | undefined;
    const slowRead = new Promise<CategoryDetail>((resolve) => {
      resolveSlowRead = resolve;
    });
    const salary = detailFixture({
      category: categoryFixture({ id: 'cat-2', name: 'Salary', isIncome: true }),
    });
    mockGetDetail.mockImplementation((id: string) =>
      id === 'cat-1' ? slowRead : Promise.resolve(salary),
    );

    // Groceries' read is still in flight when the reader picks Salary.
    const { rerender } = await renderPage();
    routeParams.current = { id: 'cat-2' };
    await act(async () => {
      rerender(<CategoryDetailPage />);
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Salary' })).toBeInTheDocument();
    });

    // Only now does Groceries' response arrive.
    await act(async () => {
      resolveSlowRead?.(detailFixture());
    });

    expect(screen.getByRole('heading', { level: 1, name: 'Salary' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Groceries' }),
    ).not.toBeInTheDocument();
  });
});
