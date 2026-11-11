import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@/test/render';
import { act } from '@testing-library/react';
import toast from 'react-hot-toast';
import DashboardPage from './page';
import { DEFAULT_DASHBOARD_WIDGET_IDS } from '@/components/dashboard/widget-registry';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
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

// Mock auth store (mutable so tests can switch to a delegate context)
const { authState } = vi.hoisted(() => {
  const baseUser = {
    id: 'test-user-id',
    email: 'test@example.com',
    firstName: 'Test',
    lastName: 'User',
    role: 'user',
    hasPassword: true,
  };
  return {
    authState: {
      current: {
        user: baseUser,
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: () => {},
        actingAsUserId: null as string | null,
        delegateSections: null as Record<string, boolean> | null,
      },
    },
  };
});

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) =>
      selector ? selector(authState.current) : authState.current,
    { getState: () => authState.current },
  ),
}));

// Mock preferences store (mutable so tests can set a custom widget layout;
// `updatePreferences` writes through, as the real store does)
const { prefsState, updateStorePreferences } = vi.hoisted(() => {
  const prefsState = {
    current: {
      twoFactorEnabled: true,
      theme: 'system',
      dashboardWidgets: [] as string[],
      timezone: 'UTC' as string | undefined,
      dashboardWidgetConfig: undefined as Record<string, Record<string, unknown>> | undefined,
    },
  };
  const updateStorePreferences = vi.fn((patch: Record<string, unknown>) => {
    prefsState.current = { ...prefsState.current, ...patch };
  });
  return { prefsState, updateStorePreferences };
});
vi.mock('@/store/preferencesStore', () => {
  const state = () => ({
    preferences: prefsState.current,
    isLoaded: true,
    _hasHydrated: true,
    updatePreferences: updateStorePreferences,
  });
  return {
    usePreferencesStore: Object.assign(
      (selector?: any) => (selector ? selector(state()) : state()),
      { getState: state },
    ),
  };
});

const { mockUpdatePreferences } = vi.hoisted(() => ({ mockUpdatePreferences: vi.fn() }));
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: { updatePreferences: (...args: any[]) => mockUpdatePreferences(...args) },
}));

// Mock auth API for ProtectedRoute
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false, demo: false,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock all API libs
const mockGetAccounts = vi.fn().mockResolvedValue([]);
const mockGetInstitutions = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/institutions', () => ({
  institutionsApi: { getAll: (...args: any[]) => mockGetInstitutions(...args) },
}));
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAccounts(...args),
  },
}));

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: vi.fn().mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0, hasMore: false } }),
    getAllPages: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

const { mockGetScheduled } = vi.hoisted(() => ({
  mockGetScheduled: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetScheduled(...args),
  },
}));

const mockGetTopMovers = vi.fn().mockResolvedValue([]);
const mockGetFavouriteSecurities = vi.fn().mockResolvedValue([]);
const mockGetSecurities = vi.fn().mockResolvedValue([{ id: 'sec-1', symbol: 'AAPL' }]);
const mockGetPortfolioValuation = vi.fn().mockResolvedValue(null);
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getTopMovers: (...args: any[]) => mockGetTopMovers(...args),
    getFavouriteSecurities: (...args: any[]) => mockGetFavouriteSecurities(...args),
    getSecurities: (...args: any[]) => mockGetSecurities(...args),
    getPortfolioValuation: (...args: any[]) => mockGetPortfolioValuation(...args),
  },
}));

vi.mock('@/lib/apiCache', () => ({
  invalidateCache: vi.fn(),
}));

const mockGetMonthly = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/net-worth', () => ({
  netWorthApi: {
    getMonthly: (...args: any[]) => mockGetMonthly(...args),
  },
}));

// Mock all dashboard child components
vi.mock('@/components/dashboard/DashboardHero', () => ({
  DashboardHero: ({ header }: any) => (
    <div>
      {header}
      <div data-testid="dashboard-hero" />
    </div>
  ),
}));

vi.mock('@/components/dashboard/FavouriteAccounts', () => ({
  FavouriteAccounts: ({ isLoading, institutions }: any) => (
    <div data-testid="favourite-accounts" data-institutions={institutions?.length}>
      {isLoading ? 'loading' : 'loaded'}
    </div>
  ),
}));

vi.mock('@/components/dashboard/UpcomingBills', () => ({
  UpcomingBills: ({ isLoading }: any) => <div data-testid="upcoming-bills">{isLoading ? 'loading' : 'loaded'}</div>,
}));

vi.mock('@/components/dashboard/ExpensesPieChart', () => ({
  ExpensesPieChart: () => <div data-testid="expenses-chart">ExpensesPieChart</div>,
}));

vi.mock('@/components/dashboard/IncomeExpensesBarChart', () => ({
  IncomeExpensesBarChart: () => <div data-testid="income-expenses-chart">IncomeExpensesBarChart</div>,
}));

vi.mock('@/components/dashboard/GettingStarted', () => ({
  GettingStarted: () => <div data-testid="getting-started">GettingStarted</div>,
}));

vi.mock('@/components/dashboard/TopMovers', () => ({
  TopMovers: ({ hasInvestmentAccounts }: any) => (
    <div data-testid="top-movers">{hasInvestmentAccounts ? 'has-investments' : 'no-investments'}</div>
  ),
}));

vi.mock('@/components/dashboard/NetWorthChart', () => ({
  NetWorthChart: () => <div data-testid="net-worth-chart">NetWorthChart</div>,
}));

vi.mock('@/components/dashboard/AssetsVsLiabilities', () => ({
  AssetsVsLiabilities: ({ error }: any) => (
    <div data-testid="assets-vs-liabilities" data-error={String(error === true)}>AssetsVsLiabilities</div>
  ),
}));

vi.mock('@/components/dashboard/FavouriteSecurities', () => ({
  FavouriteSecurities: ({ securities, isLoading }: any) => (
    <div data-testid="favourite-securities">{isLoading ? 'loading' : `count-${securities.length}`}</div>
  ),
}));

vi.mock('@/components/dashboard/PortfolioValueWidget', () => ({
  PortfolioValueWidget: ({ isLoading }: any) => (
    <div data-testid="portfolio-value-widget">{isLoading ? 'loading' : 'loaded'}</div>
  ),
}));

vi.mock('@/components/dashboard/InsightsWidget', () => ({
  InsightsWidget: ({ isLoading }: any) => <div data-testid="insights-widget">{isLoading ? 'loading' : 'loaded'}</div>,
}));

vi.mock('@/components/dashboard/BudgetStatusWidget', () => ({
  BudgetStatusWidget: ({ isLoading }: any) => <div data-testid="budget-status">{isLoading ? 'loading' : 'loaded'}</div>,
}));

vi.mock('@/components/dashboard/FavouriteReportsWidget', () => ({
  FavouriteReportsWidget: ({ isLoading }: any) => (
    <div data-testid="favourite-reports">{isLoading ? 'loading' : 'loaded'}</div>
  ),
}));

const mockTriggerAutoRefresh = vi.fn();
vi.mock('@/hooks/usePriceRefresh', () => ({
  usePriceRefresh: () => ({
    isRefreshing: false,
    triggerManualRefresh: vi.fn(),
    triggerAutoRefresh: mockTriggerAutoRefresh,
  }),
}));

// Mock PageLayout to simplify
vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccounts.mockResolvedValue([]);
    mockGetScheduled.mockResolvedValue([]);
    mockGetTopMovers.mockResolvedValue([]);
    mockGetFavouriteSecurities.mockResolvedValue([]);
    mockGetSecurities.mockResolvedValue([{ id: 'sec-1', symbol: 'AAPL' }]);
    mockGetPortfolioValuation.mockResolvedValue(null);
    mockGetMonthly.mockResolvedValue([]);
    mockUpdatePreferences.mockImplementation(async (body: any) => ({ ...prefsState.current, ...body }));
    authState.current.actingAsUserId = null;
    authState.current.delegateSections = null;
    prefsState.current = {
      twoFactorEnabled: true,
      theme: 'system',
      dashboardWidgets: [],
      timezone: 'UTC',
      dashboardWidgetConfig: undefined,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('greets the reader for the part of the day, by name, with today\'s date as the subtitle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T15:00:00Z'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Good afternoon, Test' })).toBeInTheDocument();
    });
    expect(screen.getByText(/November 6/)).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-hero')).toBeInTheDocument();
  });

  it('reads the part of the day in the timezone preference', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 09:00 in UTC is the morning there and 18:00 in Tokyo.
    vi.setSystemTime(new Date('2026-11-06T09:00:00Z'));
    prefsState.current.timezone = 'Asia/Tokyo';
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Good evening, Test' })).toBeInTheDocument();
    });
  });

  it('offers Customize as a gear beside the greeting', async () => {
    render(<DashboardPage />);
    const heading = await screen.findByRole('heading', { level: 1 });
    const gear = within(heading.parentElement as HTMLElement).getByRole('button', { name: 'Customize' });
    expect(gear).toHaveTextContent('');
  });

  it('hands Favourite Accounts the institutions its logos come from', async () => {
    mockGetInstitutions.mockResolvedValueOnce([{ id: 'inst-1', name: 'TD', hasLogo: true }]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toHaveAttribute('data-institutions', '1');
    });
  });

  it('still loads the dashboard when the institutions cannot be read', async () => {
    mockGetInstitutions.mockRejectedValueOnce(new Error('nope'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toHaveTextContent('loaded');
    });
    expect(screen.getByTestId('favourite-accounts')).toHaveAttribute('data-institutions', '0');
  });

  it('renders dashboard child components', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
      expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-chart')).toBeInTheDocument();
      expect(screen.getByTestId('income-expenses-chart')).toBeInTheDocument();
    });
  });

  it('renders within the page layout', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders GettingStarted component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('getting-started')).toBeInTheDocument();
    });
  });

  it('renders NetWorthChart component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
    });
  });

  it('renders TopMovers component', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toBeInTheDocument();
    });
  });

  it('detects investment accounts and sets hasInvestments', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('has-investments');
    });
  });

  it('does not set hasInvestments when no investment accounts exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('no-investments');
    });
  });

  it('ignores closed investment accounts for hasInvestments', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Old Brokerage', accountType: 'INVESTMENT', isClosed: true },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('no-investments');
    });
  });

  it('triggers auto price refresh when investment accounts exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockTriggerAutoRefresh).toHaveBeenCalled();
    });
  });

  it('holds the auto price refresh until the portfolio valuation has answered', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    let answer: (value: null) => void = () => {};
    mockGetPortfolioValuation.mockReturnValue(
      new Promise<null>((resolve) => {
        answer = resolve;
      }),
    );
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockGetPortfolioValuation).toHaveBeenCalled();
    });
    expect(mockTriggerAutoRefresh).not.toHaveBeenCalled();

    await act(async () => {
      answer(null);
    });
    await waitFor(() => {
      expect(mockTriggerAutoRefresh).toHaveBeenCalled();
    });
  });

  it('loads top movers directly when investment accounts exist', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Brokerage', accountType: 'INVESTMENT', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockGetTopMovers).toHaveBeenCalled();
    });
  });

  it('does not load top movers when no investment accounts', async () => {
    mockGetAccounts.mockResolvedValue([
      { id: 'acc-1', name: 'Checking', accountType: 'CHECKING', isClosed: false },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toHaveTextContent('no-investments');
    });
    expect(mockGetTopMovers).not.toHaveBeenCalled();
  });

  it('shows loading state in child components while data loads', async () => {
    mockGetAccounts.mockReturnValue(new Promise(() => {}));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toHaveTextContent('loading');
    });
  });

  it('shows a delegate no net worth hero', async () => {
    authState.current.actingAsUserId = 'owner-1';
    authState.current.delegateSections = { bills: true };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('dashboard-hero')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  });

  it('delegate without the Bills grant sees only Favourite Accounts', async () => {
    authState.current.actingAsUserId = 'owner-1';
    authState.current.delegateSections = { bills: false };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('upcoming-bills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('getting-started')).not.toBeInTheDocument();
    expect(mockGetScheduled).not.toHaveBeenCalled();
    // Not a delegate-accessible endpoint: a delegate's cards keep the star.
    expect(mockGetInstitutions).not.toHaveBeenCalled();
  });

  it('delegate with the Bills grant also sees Upcoming Bills', async () => {
    authState.current.actingAsUserId = 'owner-1';
    authState.current.delegateSections = { bills: true };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
    });
    expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    expect(mockGetScheduled).toHaveBeenCalled();
  });

  it('renders the AssetsVsLiabilities and FavouriteSecurities widgets', async () => {
    // Favourite Securities is opt-in (not part of the default layout), so add it.
    prefsState.current.dashboardWidgets = ['assets-liabilities', 'favourite-securities'];
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('assets-vs-liabilities')).toBeInTheDocument();
      expect(screen.getByTestId('favourite-securities')).toBeInTheDocument();
    });
  });

  it('tells the assets widget when the net worth request failed, instead of handing it an empty series', async () => {
    prefsState.current.dashboardWidgets = ['assets-liabilities'];
    mockGetMonthly.mockRejectedValue(new Error('500'));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('assets-vs-liabilities')).toHaveAttribute('data-error', 'true');
    });
  });

  it('does not flag the assets widget when the net worth answer is a successful empty one', async () => {
    prefsState.current.dashboardWidgets = ['assets-liabilities'];
    mockGetMonthly.mockResolvedValue([]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(mockGetMonthly).toHaveBeenCalled();
      expect(screen.getByTestId('assets-vs-liabilities')).toHaveAttribute('data-error', 'false');
    });
  });

  it('passes loaded favourite securities to the widget', async () => {
    prefsState.current.dashboardWidgets = ['favourite-securities'];
    mockGetFavouriteSecurities.mockResolvedValue([
      { securityId: '1', symbol: 'AAPL', name: 'Apple', currencyCode: 'USD', currentPrice: 1, previousPrice: 1, dailyChange: 0, dailyChangePercent: 0 },
    ]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-securities')).toHaveTextContent('count-1');
    });
  });

  it('hides Top Movers and Favourite Securities when there are no securities', async () => {
    prefsState.current.dashboardWidgets = ['top-movers', 'favourite-securities', 'assets-liabilities'];
    mockGetSecurities.mockResolvedValue([]);
    render(<DashboardPage />);
    await waitFor(() => {
      // Assets row still renders, so the dashboard has finished loading.
      expect(screen.getByTestId('assets-vs-liabilities')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('top-movers')).not.toBeInTheDocument();
    expect(screen.queryByTestId('favourite-securities')).not.toBeInTheDocument();
  });

  it('shows Top Movers and Favourite Securities when securities exist', async () => {
    prefsState.current.dashboardWidgets = ['top-movers', 'favourite-securities'];
    mockGetSecurities.mockResolvedValue([{ id: 'sec-1', symbol: 'AAPL' }]);
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('top-movers')).toBeInTheDocument();
      expect(screen.getByTestId('favourite-securities')).toBeInTheDocument();
    });
  });

  it('shows the Customize button for the account owner', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Customize' })).toBeInTheDocument();
    });
  });

  it('keeps shared-expense navigation out of the dashboard greeting actions', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    const dashboard = within(screen.getByRole('main'));
    expect(
      dashboard.getByRole('button', { name: 'Customize' }),
    ).toBeInTheDocument();
    expect(
      dashboard.queryByRole('link', { name: 'Shared Expenses' }),
    ).not.toBeInTheDocument();
  });

  it('hides the Customize button in the delegate view', async () => {
    authState.current.actingAsUserId = 'owner-1';
    authState.current.delegateSections = { bills: false };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
  });

  it('renders only the configured widgets when the layout is customized', async () => {
    prefsState.current.dashboardWidgets = ['insights', 'favourite-accounts'];
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('insights-widget')).toBeInTheDocument();
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('upcoming-bills')).not.toBeInTheDocument();
    expect(screen.queryByTestId('expenses-chart')).not.toBeInTheDocument();
    expect(screen.queryByTestId('net-worth-chart')).not.toBeInTheDocument();
  });

  it('renders the Favourite Reports widget when configured', async () => {
    prefsState.current.dashboardWidgets = ['favourite-reports'];
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-reports')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('favourite-accounts')).not.toBeInTheDocument();
  });

  it('draws each widget in a grid item at its default size, the floor on the item', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
    });
    const itemOf = (testId: string) => screen.getByTestId(testId).closest('[data-widget-id]') as HTMLElement;
    // Net Worth's floor was 500px on its card; it is the standard 540px on the item.
    expect(itemOf('net-worth-chart')).toHaveAttribute('data-widget-id', 'net-worth');
    expect(itemOf('net-worth-chart')).toHaveClass('lg:col-span-6', 'lg:min-h-[540px]');
    expect(itemOf('budget-status')).toHaveClass('lg:col-span-6', 'lg:min-h-[390px]');
    expect(itemOf('favourite-accounts').className).not.toMatch(/min-h-/);
    expect(itemOf('favourite-accounts').parentElement).toHaveClass('lg:grid-cols-12');
  });

  it('draws a widget at the size stored in its settings', async () => {
    prefsState.current.dashboardWidgets = ['net-worth', 'insights'];
    prefsState.current.dashboardWidgetConfig = {
      'net-worth': { range: '2y', gridWidth: 'full', gridHeight: 'tall' },
      insights: { gridWidth: 'huge' },
    };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('insights-widget')).toBeInTheDocument();
    });
    const itemOf = (testId: string) => screen.getByTestId(testId).closest('[data-widget-id]') as HTMLElement;
    expect(itemOf('net-worth-chart')).toHaveClass('lg:col-span-12', 'lg:min-h-[720px]');
    // An unknown preset falls back to the default size.
    expect(itemOf('insights-widget')).toHaveClass('lg:col-span-6', 'lg:min-h-[390px]');
  });

  it('draws a delegate through the same grid at default sizes, ignoring the owner\'s sizes', async () => {
    authState.current.actingAsUserId = 'owner-1';
    authState.current.delegateSections = { bills: true };
    prefsState.current.dashboardWidgetConfig = { 'favourite-accounts': { gridWidth: 'full' } };
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
    });
    const ids = Array.from(document.querySelectorAll('[data-widget-id]')).map((el) =>
      el.getAttribute('data-widget-id'),
    );
    expect(ids).toEqual(['favourite-accounts', 'upcoming-bills']);
    const accounts = screen.getByTestId('favourite-accounts').closest('[data-widget-id]') as HTMLElement;
    expect(accounts).toHaveClass('lg:col-span-6');
    expect(accounts.parentElement).toHaveAttribute('data-tour-id', 'dashboard-widgets');
  });

  it('does not render the Favourite Reports widget in the default layout', async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId('favourite-accounts')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('favourite-reports')).not.toBeInTheDocument();
  });

  describe('edit mode', () => {
    const widgetIds = () =>
      Array.from(document.querySelectorAll('[data-widget-id]')).map((el) => el.getAttribute('data-widget-id'));

    // Outside edit mode a widget with nothing to show is skipped: with no
    // investment accounts that is Portfolio Value.
    const SHOWN_BY_DEFAULT = DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'portfolio-value');

    async function renderLoaded() {
      await act(async () => {
        render(<DashboardPage />);
      });
      await waitFor(() => {
        expect(mockGetAccounts).toHaveBeenCalled();
      });
      await act(async () => {});
    }

    async function enterEditMode() {
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
      });
      await screen.findByRole('region', { name: 'Arrange the dashboard' });
      await screen.findAllByRole('button', { name: /^Remove / });
      await screen.findByTestId('add-widget-tile');
    }

    async function click(element: HTMLElement) {
      await act(async () => {
        fireEvent.click(element);
      });
    }

    const done = () => screen.getByRole('button', { name: 'Done' });
    const editBar = () => screen.queryByRole('region', { name: 'Arrange the dashboard' });

    it('enters from the gear, keeping its name and tour anchor, and makes the widgets inert', async () => {
      await renderLoaded();
      const gear = screen.getByRole('button', { name: 'Customize' });
      expect(gear).toHaveAttribute('data-tour-id', 'dashboard-customize');
      expect(editBar()).not.toBeInTheDocument();
      await enterEditMode();
      expect(screen.getByTestId('net-worth-chart').closest('[inert]')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Remove Net Worth' }).closest('[inert]')).toBeNull();
      expect(screen.getByTestId('dashboard-hero')).toBeInTheDocument();
      expect(widgetIds()).toEqual(DEFAULT_DASHBOARD_WIDGET_IDS);
    });

    it('removes a widget with its remove button', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
      expect(screen.queryByTestId('net-worth-chart')).not.toBeInTheDocument();
      expect(widgetIds()).not.toContain('net-worth');
    });

    it('moves a widget with its arrow buttons and reads the move out', async () => {
      await renderLoaded();
      await enterEditMode();
      expect(screen.getByRole('button', { name: 'Move Favourite Accounts earlier' })).toBeDisabled();
      await click(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits earlier' }));
      expect(widgetIds().slice(0, 2)).toEqual(['upcoming-bills', 'favourite-accounts']);
      expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(
        `Upcoming Bills & Deposits moved to position 1 of ${DEFAULT_DASHBOARD_WIDGET_IDS.length}`,
      );
      // First now, so its earlier button is disabled: focus stays on the widget's next move button.
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits later' }));
      });
      await click(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits later' }));
      expect(widgetIds().slice(0, 2)).toEqual(['favourite-accounts', 'upcoming-bills']);
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits later' }));
      });
    });

    it('adds a hidden widget at the end from the Add Widget dialog', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByTestId('add-widget-tile'));
      const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
      expect(within(dialog).queryByTestId('add-widget-net-worth')).not.toBeInTheDocument();
      await click(within(dialog).getByTestId('add-widget-favourite-reports'));
      expect(screen.queryByRole('dialog', { name: 'Add Widget' })).not.toBeInTheDocument();
      await waitFor(() => {
        expect(screen.getByTestId('favourite-reports')).toBeInTheDocument();
      });
      expect(widgetIds()).toEqual([...DEFAULT_DASHBOARD_WIDGET_IDS, 'favourite-reports']);
    });

    it('opens the Add Widget dialog from the bar too', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(within(editBar()!).getByRole('button', { name: 'Add Widget' }));
      expect(await screen.findByRole('dialog', { name: 'Add Widget' })).toBeInTheDocument();
    });

    it('keeps the same widget elements through enter and leave, never remounting them', async () => {
      await renderLoaded();
      const chart = screen.getByTestId('net-worth-chart');
      await enterEditMode();
      expect(screen.getByTestId('net-worth-chart')).toBe(chart);
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByTestId('net-worth-chart')).toBe(chart);
    });

    it('leaves at once on Cancel with nothing changed, storing nothing (DASH-4)', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(editBar()).not.toBeInTheDocument();
      expect(screen.getByTestId('net-worth-chart').closest('[inert]')).toBeNull();
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('asks before Cancel throws a changed layout away, then restores it and stores nothing (DASH-4)', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
      await click(screen.getByRole('button', { name: 'Cancel' }));
      const discard = await screen.findByRole('button', { name: 'Discard' });
      expect(editBar()).toBeInTheDocument();
      await click(discard);
      expect(editBar()).not.toBeInTheDocument();
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
      expect(widgetIds()).toEqual(SHOWN_BY_DEFAULT);
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('leaves on Escape, storing nothing (DASH-4)', async () => {
      await renderLoaded();
      await enterEditMode();
      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(editBar()).not.toBeInTheDocument();
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('closes only the dialog on top when Escape is pressed in it', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByTestId('add-widget-tile'));
      const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
      await act(async () => {
        fireEvent.keyDown(within(dialog).getAllByRole('button')[0], { key: 'Escape' });
      });
      expect(screen.queryByRole('dialog', { name: 'Add Widget' })).not.toBeInTheDocument();
      expect(editBar()).toBeInTheDocument();
    });

    it('leaves on the browser Back with a changed layout once the reader discards it (DASH-4)', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
      await act(async () => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      });
      await click(await screen.findByRole('button', { name: 'Discard' }));
      expect(editBar()).not.toBeInTheDocument();
      expect(screen.getByTestId('net-worth-chart')).toBeInTheDocument();
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('leaves on the browser Back at once when nothing changed', async () => {
      await renderLoaded();
      await enterEditMode();
      await act(async () => {
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      });
      expect(editBar()).not.toBeInTheDocument();
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('leaves on Done with nothing changed, sending no request', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(done());
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
      expect(editBar()).not.toBeInTheDocument();
    });

    it('sends one request on Done, with the new order, and leaves (DASH-5)', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
      await click(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits earlier' }));
      await click(done());
      expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
      const expected = DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights');
      [expected[0], expected[1]] = [expected[1], expected[0]];
      expect(mockUpdatePreferences).toHaveBeenCalledWith({ dashboardWidgets: expected, dashboardWidgetConfig: {} });
      expect(updateStorePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ dashboardWidgets: expected }),
      );
      expect(editBar()).not.toBeInTheDocument();
      expect(widgetIds()).toEqual(expected.filter((id) => id !== 'portfolio-value'));
    });

    describe('the grip', () => {
      // One column below lg (jsdom's matchMedia matches nothing): item i spans
      // 100 + 124i to 200 + 124i, as the hook reads it on press.
      let rects: ReturnType<typeof vi.spyOn>;
      beforeEach(() => {
        rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const items = Array.from(document.querySelectorAll('[data-widget-id]'));
          const i = items.indexOf(this);
          const top = 100 + Math.max(i, 0) * 124;
          return { left: 0, right: 500, top, bottom: top + 100, x: 0, y: top, width: 500, height: 100 } as DOMRect;
        });
      });
      afterEach(() => rects.mockRestore());

      const grip = (name: string) => screen.getByRole('button', { name: `Move ${name}` });

      it('is a named drag handle, and the only part of a widget that keeps a finger from scrolling', async () => {
        await renderLoaded();
        await enterEditMode();
        const handle = grip('Net Worth');
        expect(handle).toHaveAttribute('title', 'Drag to move Net Worth, or press the arrow keys');
        expect(handle).toHaveClass('touch-none');
        const item = handle.closest('[data-widget-id]') as HTMLElement;
        expect(Array.from(item.querySelectorAll('.touch-none'))).toEqual([handle]);
        expect(item.className).not.toContain('touch-none');
        // The move buttons from F3 stay beside it.
        expect(screen.getByRole('button', { name: 'Move Net Worth earlier' })).toBeInTheDocument();
      });

      it('moves a widget dropped further down, once, and reads the move out', async () => {
        await renderLoaded();
        await enterEditMode();
        const handle = grip('Favourite Accounts');
        await act(async () => {
          fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 150 });
          fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 420 });
        });
        expect(await screen.findByTestId('widget-drag-chip')).toHaveTextContent('Favourite Accounts');
        // The page does not reflow while dragging.
        expect(widgetIds()).toEqual(DEFAULT_DASHBOARD_WIDGET_IDS);
        await act(async () => {
          // The bottom half of the third widget: after it.
          fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 420 });
        });
        const [first, second, third, ...rest] = DEFAULT_DASHBOARD_WIDGET_IDS;
        expect(widgetIds()).toEqual([second, third, first, ...rest]);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(
          `Favourite Accounts moved to position 3 of ${DEFAULT_DASHBOARD_WIDGET_IDS.length}`,
        );
        expect(screen.queryByTestId('widget-drag-chip')).not.toBeInTheDocument();
        expect(mockUpdatePreferences).not.toHaveBeenCalled();
      });

      it('cancels the drag on Escape and stays in edit mode', async () => {
        await renderLoaded();
        await enterEditMode();
        const handle = grip('Favourite Accounts');
        await act(async () => {
          fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 150 });
          fireEvent.pointerMove(handle, { pointerId: 1, clientX: 10, clientY: 420 });
        });
        await screen.findByTestId('widget-drag-chip');
        await act(async () => {
          fireEvent.keyDown(document, { key: 'Escape' });
        });
        expect(screen.queryByTestId('widget-drag-chip')).not.toBeInTheDocument();
        expect(editBar()).toBeInTheDocument();
        await act(async () => {
          fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 420 });
        });
        expect(widgetIds()).toEqual(DEFAULT_DASHBOARD_WIDGET_IDS);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('');
        // The next Escape, with no drag under way, leaves edit mode as before.
        await act(async () => {
          fireEvent.keyDown(document, { key: 'Escape' });
        });
        expect(editBar()).not.toBeInTheDocument();
      });

      it('moves one place per arrow key and keeps focus on the grip', async () => {
        await renderLoaded();
        await enterEditMode();
        await act(async () => {
          fireEvent.keyDown(grip('Favourite Accounts'), { key: 'ArrowDown' });
        });
        const [first, second, ...rest] = DEFAULT_DASHBOARD_WIDGET_IDS;
        expect(widgetIds()).toEqual([second, first, ...rest]);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(
          `Favourite Accounts moved to position 2 of ${DEFAULT_DASHBOARD_WIDGET_IDS.length}`,
        );
        await waitFor(() => {
          expect(document.activeElement).toBe(grip('Favourite Accounts'));
        });
      });
    });

    describe('width and height choices', () => {
      const original = window.matchMedia;
      afterEach(() => {
        window.matchMedia = original;
      });
      const setWide = (wide: boolean) => {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: wide && query.includes('min-width: 64rem'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })) as unknown as typeof window.matchMedia;
      };

      it('stores a chosen width in that widget slice on Done, and only the changed key', async () => {
        setWide(true);
        await renderLoaded();
        await enterEditMode();
        const widths = screen.getByRole('group', { name: 'Width of Net Worth' });
        await click(within(widths).getByRole('button', { name: 'Full, Full width' }));
        expect(within(widths).getByRole('button', { name: 'Full, Full width' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Net Worth is now Full width');
        const heights = screen.getByRole('group', { name: 'Height of Net Worth' });
        await click(within(heights).getByRole('button', { name: 'L, Tall height' }));
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Net Worth is now Tall height');
        await click(within(heights).getByRole('button', { name: 'M, Standard height' }));
        expect(mockUpdatePreferences).not.toHaveBeenCalled();
        await click(done());
        expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
        const config = mockUpdatePreferences.mock.calls[0][0].dashboardWidgetConfig;
        expect(config['net-worth']).toEqual({ gridWidth: 'full' });
        expect(Object.keys(config)).toEqual(['net-worth']);
      });

      it('sends no request for a size pressed back to its default, and leaves', async () => {
        setWide(true);
        await renderLoaded();
        await enterEditMode();
        const widths = screen.getByRole('group', { name: 'Width of Net Worth' });
        await click(within(widths).getByRole('button', { name: 'Full, Full width' }));
        await click(within(widths).getByRole('button', { name: '1/2, Half width' }));
        await click(done());
        expect(mockUpdatePreferences).not.toHaveBeenCalled();
        expect(editBar()).not.toBeInTheDocument();
      });

      it('stores only a resize as never customized, keeping the size (DASH-1)', async () => {
        setWide(true);
        await renderLoaded();
        await enterEditMode();
        const widths = screen.getByRole('group', { name: 'Width of Net Worth' });
        await click(within(widths).getByRole('button', { name: 'Full, Full width' }));
        await click(done());
        expect(mockUpdatePreferences).toHaveBeenCalledWith({
          dashboardWidgets: [],
          dashboardWidgetConfig: { 'net-worth': { gridWidth: 'full' } },
        });
      });

      it('shows no size choices below lg', async () => {
        setWide(false);
        await renderLoaded();
        await enterEditMode();
        expect(screen.queryByRole('group', { name: /^Width of / })).not.toBeInTheDocument();
        expect(screen.queryByRole('group', { name: /^Height of / })).not.toBeInTheDocument();
      });
    });

    describe('gap slots, from lg up', () => {
      const original = window.matchMedia;
      let rects: ReturnType<typeof vi.spyOn>;
      // Net Worth two thirds wide ends row 1 a third short; the next two are half wide.
      const storeLayout = (third: string) => {
        prefsState.current.dashboardWidgets = ['net-worth', 'insights', third];
        prefsState.current.dashboardWidgetConfig = { 'net-worth': { gridWidth: 'twoThirds' } };
      };
      // Row 1: Net Worth, then the slot; row 2: the other two.
      const BOXES: Record<string, [number, number, number, number]> = {
        'net-worth': [0, 100, 888, 400],
        'gap-1': [912, 100, 1344, 400],
        insights: [0, 424, 660, 724],
        third: [684, 424, 1344, 724],
      };
      beforeEach(() => {
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({
          matches: query.includes('min-width: 64rem'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        })) as unknown as typeof window.matchMedia;
        rects = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
          const id = this.getAttribute('data-widget-id');
          const gap = this.getAttribute('data-gap-index');
          const key = gap !== null ? `gap-${gap}` : id && BOXES[id] ? id : id ? 'third' : null;
          const [left, top, right, bottom] = key ? BOXES[key] : [0, 0, 0, 0];
          return { left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top } as DOMRect;
        });
      });
      afterEach(() => {
        window.matchMedia = original;
        rects.mockRestore();
      });

      const slot = () => screen.getByRole('button', { name: 'Add Widget to this space (One third width)' });

      it('draws a slot in the short row only, and adds a widget that fits there at the gap width', async () => {
        storeLayout('favourite-accounts');
        await renderLoaded();
        await enterEditMode();
        await waitFor(() => expect(slot()).toHaveAttribute('data-gap-index', '1'));
        expect(document.querySelectorAll('[data-gap-index]')).toHaveLength(1);
        await click(slot());
        const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
        // At least half wide: hidden, but it does not fit a third.
        expect(within(dialog).queryByTestId('add-widget-income-expenses')).not.toBeInTheDocument();
        await click(within(dialog).getByTestId('add-widget-budget-status'));
        expect(widgetIds()).toEqual(['net-worth', 'budget-status', 'insights', 'favourite-accounts']);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Budget Status added');
        // The row is full now: no slot.
        expect(document.querySelector('[data-gap-index]')).toBeNull();
        await click(done());
        expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
        const body = mockUpdatePreferences.mock.calls[0][0];
        expect(body.dashboardWidgets).toEqual(['net-worth', 'budget-status', 'insights', 'favourite-accounts']);
        expect(body.dashboardWidgetConfig['budget-status']).toEqual({ gridWidth: 'third' });
      });

      it('keeps the end tile listing every hidden widget, added at the end at default size', async () => {
        storeLayout('favourite-accounts');
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByTestId('add-widget-tile'));
        const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
        await click(within(dialog).getByTestId('add-widget-income-expenses'));
        expect(widgetIds().at(-1)).toBe('income-expenses');
      });

      async function dragOntoSlot(name: string) {
        const handle = screen.getByRole('button', { name: `Move ${name}` });
        await act(async () => {
          fireEvent.pointerDown(handle, { pointerId: 1, clientX: 1000, clientY: 600 });
          fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1100, clientY: 250 });
        });
        await screen.findByTestId('widget-drag-chip');
        return {
          release: () =>
            act(async () => {
              fireEvent.pointerUp(handle, { pointerId: 1, clientX: 1100, clientY: 250 });
            }),
        };
      }

      it('takes a dragged widget that can be a third, moving it there narrowed, and reads out both', async () => {
        storeLayout('favourite-accounts');
        await renderLoaded();
        await enterEditMode();
        const drag = await dragOntoSlot('Favourite Accounts');
        await waitFor(() => expect(slot()).toHaveAttribute('data-drop-target', 'true'));
        await drag.release();
        expect(widgetIds()).toEqual(['net-worth', 'favourite-accounts', 'insights']);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(
          'Favourite Accounts moved to position 2 of 3. Favourite Accounts is now One third width',
        );
        await click(done());
        const body = mockUpdatePreferences.mock.calls[0][0];
        expect(body.dashboardWidgets).toEqual(['net-worth', 'favourite-accounts', 'insights']);
        expect(body.dashboardWidgetConfig['favourite-accounts']).toEqual({ gridWidth: 'third' });
      });

      it('does not take a widget at least half wide: it moves by the row rule, at its own width', async () => {
        storeLayout('income-expenses');
        await renderLoaded();
        await enterEditMode();
        const drag = await dragOntoSlot('Income vs Expenses');
        // Give the frame its chance to mark the slot; it must not.
        await act(async () => {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        });
        expect(slot()).not.toHaveAttribute('data-drop-target');
        await drag.release();
        expect(widgetIds()).toEqual(['net-worth', 'income-expenses', 'insights']);
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(
          'Income vs Expenses moved to position 2 of 3',
        );
        await click(done());
        const body = mockUpdatePreferences.mock.calls[0][0];
        expect(body.dashboardWidgetConfig['income-expenses']).toBeUndefined();
      });

      it('draws no slot below lg', async () => {
        window.matchMedia = original;
        storeLayout('favourite-accounts');
        await renderLoaded();
        await enterEditMode();
        expect(document.querySelector('[data-gap-index]')).toBeNull();
      });
    });

    it('stores a layout reset to the default as never customized, and only on Done', async () => {
      prefsState.current.dashboardWidgets = ['insights', 'net-worth'];
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Reset to default' }));
      expect(widgetIds()).toEqual(DEFAULT_DASHBOARD_WIDGET_IDS);
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
      await click(done());
      expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
      expect(mockUpdatePreferences.mock.calls[0][0].dashboardWidgets).toEqual([]);
    });

    it('keeps every other widget setting at Done, read from the store at that moment (DASH-6)', async () => {
      prefsState.current.dashboardWidgetConfig = { 'net-worth': { range: '2y' } };
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
      // A widget's own gear saved while the layout was being edited.
      prefsState.current = {
        ...prefsState.current,
        dashboardWidgetConfig: {
          'net-worth': { range: '5y' },
          'expenses-pie': { months: 6 },
          'dashboard-hero': { enabled: false },
        },
      };
      await click(done());
      expect(mockUpdatePreferences.mock.calls[0][0].dashboardWidgetConfig).toEqual({
        'net-worth': { range: '5y' },
        'expenses-pie': { months: 6 },
        'dashboard-hero': { enabled: false },
      });
    });

    it('keeps edit mode and the draft when Done is refused', async () => {
      const toastError = vi.spyOn(toast, 'error');
      mockUpdatePreferences.mockRejectedValue(new Error('nope'));
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
      await click(done());
      expect(toastError).toHaveBeenCalled();
      expect(editBar()).toBeInTheDocument();
      expect(widgetIds()).not.toContain('net-worth');
      expect(done()).not.toBeDisabled();
      toastError.mockRestore();
    });

    it('disables the discard prompt Save and says why when no widget is left', async () => {
      prefsState.current.dashboardWidgets = ['insights'];
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
      await click(screen.getByRole('button', { name: 'Cancel' }));
      const prompt = await screen.findByRole('dialog');
      expect(within(prompt).getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(within(prompt).getByText('Select at least one widget to show on the dashboard.')).toBeInTheDocument();
      expect(within(prompt).getByRole('button', { name: 'Discard' })).toBeEnabled();
      expect(mockUpdatePreferences).not.toHaveBeenCalled();
    });

    it('disables Done and says why when no widget is left', async () => {
      prefsState.current.dashboardWidgets = ['insights'];
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
      expect(done()).toBeDisabled();
      expect(screen.getByText('Select at least one widget to show on the dashboard.')).toBeInTheDocument();
    });

    it('draws a widget with nothing to show as a placeholder tile, only in edit mode (DASH-8)', async () => {
      prefsState.current.dashboardWidgets = ['top-movers', 'net-worth'];
      mockGetSecurities.mockResolvedValue([]);
      await renderLoaded();
      expect(widgetIds()).toEqual(['net-worth']);
      await enterEditMode();
      const placeholder = await screen.findByTestId('widget-placeholder-top-movers');
      expect(placeholder).toHaveTextContent('Top Movers');
      expect(within(placeholder).getByTestId('widget-tint-top-movers')).toBeInTheDocument();
      expect(widgetIds()).toEqual(['top-movers', 'net-worth']);
      expect(screen.getByRole('button', { name: 'Remove Top Movers' })).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByTestId('widget-placeholder-top-movers')).not.toBeInTheDocument();
    });

    it('gives a delegate no gear and no edit mode (DASH-9)', async () => {
      authState.current.actingAsUserId = 'owner-1';
      authState.current.delegateSections = { bills: true };
      await renderLoaded();
      expect(screen.queryByRole('button', { name: 'Customize' })).not.toBeInTheDocument();
      expect(editBar()).not.toBeInTheDocument();
      expect(screen.queryByTestId('add-widget-tile')).not.toBeInTheDocument();
    });

    it('opens the hero settings from the bar', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Hero Settings' }));
      expect(await screen.findByRole('dialog', { name: 'Dashboard hero' })).toBeInTheDocument();
    });

    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

    /** The next updatePreferences answers only when `answer` is called. */
    function holdNextSave() {
      let answer!: () => void;
      mockUpdatePreferences.mockImplementationOnce(
        (body: any) =>
          new Promise((resolve) => {
            answer = () => resolve({ ...prefsState.current, ...body });
          }),
      );
      return () => answer();
    }

    describe('while Done is saving', () => {
      it('takes no remove, and stores the draft Done was pressed on', async () => {
        const answer = holdNextSave();
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
        await click(done());
        const grid = screen.getByTestId('net-worth-chart').closest('[data-tour-id="dashboard-widgets"]');
        expect(grid).toHaveAttribute('inert');
        await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
        expect(widgetIds()).toContain('net-worth');
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Spending Insights removed');
        await act(async () => answer());
        expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
        expect(mockUpdatePreferences.mock.calls[0][0].dashboardWidgets).toEqual(
          DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
        );
        expect(editBar()).not.toBeInTheDocument();
      });

      it('takes no widget from the Add dialog', async () => {
        const answer = holdNextSave();
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
        await click(screen.getByTestId('add-widget-tile'));
        const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
        // The bar is under the dialog for a pointer; jsdom reaches it anyway.
        await click(done());
        await click(within(dialog).getByTestId('add-widget-favourite-reports'));
        expect(widgetIds()).not.toContain('favourite-reports');
        await act(async () => answer());
        expect(mockUpdatePreferences.mock.calls[0][0].dashboardWidgets).toEqual(
          DEFAULT_DASHBOARD_WIDGET_IDS.filter((id) => id !== 'insights'),
        );
        expect(screen.queryByTestId('favourite-reports')).not.toBeInTheDocument();
      });
    });

    it('keeps the hero dialog open through Escape and its backdrop while it saves, so Done keeps the hero', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByRole('button', { name: 'Hero Settings' }));
      const dialog = await screen.findByRole('dialog', { name: 'Dashboard hero' });
      const answer = holdNextSave();
      await click(within(dialog).getByRole('button', { name: 'Save' }));
      await act(async () => {
        fireEvent.keyDown(within(dialog).getByRole('button', { name: 'Save' }), { key: 'Escape' });
      });
      expect(screen.getByRole('dialog', { name: 'Dashboard hero' })).toBeInTheDocument();
      await click(dialog.parentElement as HTMLElement);
      expect(screen.getByRole('dialog', { name: 'Dashboard hero' })).toBeInTheDocument();
      expect(editBar()).toBeInTheDocument();
      await act(async () => answer());
      expect(screen.queryByRole('dialog', { name: 'Dashboard hero' })).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
      await click(done());
      expect(mockUpdatePreferences).toHaveBeenCalledTimes(2);
      expect(mockUpdatePreferences.mock.calls[1][0].dashboardWidgetConfig).toHaveProperty('dashboard-hero');
    });

    it('closes the Add dialog on Back after it was closed and opened again, and stays in edit mode', async () => {
      await renderLoaded();
      await enterEditMode();
      await click(screen.getByTestId('add-widget-tile'));
      const first = await screen.findByRole('dialog', { name: 'Add Widget' });
      await click(within(first).getByRole('button', { name: 'Close' }));
      // The dialog's own entry is popped; let that land.
      await settle();
      await click(screen.getByTestId('add-widget-tile'));
      await screen.findByRole('dialog', { name: 'Add Widget' });
      await act(async () => {
        window.history.back();
      });
      await settle();
      expect(screen.queryByRole('dialog', { name: 'Add Widget' })).not.toBeInTheDocument();
      expect(editBar()).toBeInTheDocument();
    });

    it('leaves on one Back when an earlier visit left its entry under the page', async () => {
      // A stale entry, as a link's navigation out of edit mode leaves it.
      window.history.replaceState({ ...window.history.state, dashboardEdit: true }, '');
      await renderLoaded();
      await enterEditMode();
      await act(async () => {
        window.history.back();
      });
      await settle();
      expect(editBar()).not.toBeInTheDocument();
      window.history.replaceState(null, '');
    });

    describe('focus and announcements', () => {
      const gear = () => screen.getByRole('button', { name: 'Customize' });
      const gripOf = (id: string) =>
        document.querySelector<HTMLElement>(`[data-widget-id="${id}"] [data-edit-slot="grip"] button`);

      it.each([
        ['Cancel', async () => click(screen.getByRole('button', { name: 'Cancel' }))],
        ['Done', async () => click(done())],
        ['Escape', async () => act(async () => {
          fireEvent.keyDown(document, { key: 'Escape' });
        })],
        ['Back', async () => act(async () => {
          window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
        })],
      ])('hands focus back to the gear on %s', async (_way, leave) => {
        await renderLoaded();
        await enterEditMode();
        await leave();
        expect(editBar()).not.toBeInTheDocument();
        expect(document.activeElement).toBe(gear());
      });

      it('hands focus back to the gear on Discard, and after a saved Done', async () => {
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
        await click(screen.getByRole('button', { name: 'Cancel' }));
        await click(await screen.findByRole('button', { name: 'Discard' }));
        expect(document.activeElement).toBe(gear());
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
        await click(done());
        expect(mockUpdatePreferences).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(gear());
      });

      it('moves focus after a remove to the next grip, then the previous one, then the Add tile, reading each out', async () => {
        prefsState.current.dashboardWidgets = ['insights', 'net-worth', 'budget-status'];
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Remove Net Worth' }));
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Net Worth removed');
        await waitFor(() => expect(document.activeElement).toBe(gripOf('budget-status')));
        await click(screen.getByRole('button', { name: /^Remove Budget/ }));
        await waitFor(() => expect(document.activeElement).toBe(gripOf('insights')));
        await click(screen.getByRole('button', { name: 'Remove Spending Insights' }));
        await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('add-widget-tile')));
      });

      it('focuses the grip of a widget just added, and reads it out', async () => {
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByTestId('add-widget-tile'));
        const dialog = await screen.findByRole('dialog', { name: 'Add Widget' });
        await click(within(dialog).getByTestId('add-widget-favourite-reports'));
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent('Favourite Reports added');
        await waitFor(() => expect(document.activeElement).toBe(gripOf('favourite-reports')));
      });

      it('starts each visit with nothing announced', async () => {
        await renderLoaded();
        await enterEditMode();
        await click(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits earlier' }));
        await click(screen.getByRole('button', { name: 'Move Upcoming Bills & Deposits later' }));
        expect(screen.getByTestId('dashboard-edit-announcement')).not.toHaveTextContent(/^$/);
        await click(screen.getByRole('button', { name: 'Cancel' }));
        await enterEditMode();
        expect(screen.getByTestId('dashboard-edit-announcement')).toHaveTextContent(/^$/);
      });
    });

    it('takes the edit-mode parts away when the view switches to a delegate mid-edit (DASH-9)', async () => {
      let view!: ReturnType<typeof render>;
      await act(async () => {
        view = render(<DashboardPage />);
      });
      await waitFor(() => {
        expect(mockGetAccounts).toHaveBeenCalled();
      });
      await act(async () => {});
      await enterEditMode();
      authState.current.actingAsUserId = 'owner-1';
      authState.current.delegateSections = { bills: true };
      await act(async () => {
        view.rerender(<DashboardPage />);
      });
      await waitFor(() => {
        expect(screen.getByTestId('upcoming-bills')).toBeInTheDocument();
      });
      expect(editBar()).not.toBeInTheDocument();
      expect(document.querySelector('[data-testid^="widget-edit-overlay-"]')).toBeNull();
      expect(screen.queryByTestId('add-widget-tile')).not.toBeInTheDocument();
      expect(screen.queryByTestId('dashboard-edit-announcement')).not.toBeInTheDocument();
      expect(widgetIds()).toEqual(['favourite-accounts', 'upcoming-bills']);
    });
  });
});
