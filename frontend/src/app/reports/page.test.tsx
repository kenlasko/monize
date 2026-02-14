import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import ReportsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
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
      preferences: { twoFactorEnabled: true, theme: 'system' },
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
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock custom reports API
const mockGetAllReports = vi.fn().mockResolvedValue([]);
vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: {
    getAll: (...args: any[]) => mockGetAllReports(...args),
  },
}));

// Mock IconPicker
vi.mock('@/components/ui/IconPicker', () => ({
  getIconComponent: () => null,
}));

// Mock AppHeader
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

const mockSetDensity = vi.fn();
const mockSetCategoryFilter = vi.fn();
let currentDensity = 'normal';
let currentCategoryFilter = 'all';

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => {
    if (key === 'monize-reports-density') {
      return [currentDensity, mockSetDensity];
    }
    if (key === 'monize-reports-category') {
      return [currentCategoryFilter, mockSetCategoryFilter];
    }
    return [defaultValue, vi.fn()];
  },
}));

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/reports',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions}
    </div>
  ),
}));

describe('ReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentDensity = 'normal';
    currentCategoryFilter = 'all';
    mockGetAllReports.mockResolvedValue([]);
  });

  it('renders the Reports heading', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Reports')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Generate insights/i)).toBeInTheDocument();
    });
  });

  it('renders built-in report cards', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
      expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
      expect(screen.getByText('Net Worth Over Time')).toBeInTheDocument();
    });
  });

  it('renders the All Reports filter button', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All Reports' })).toBeInTheDocument();
    });
  });

  it('renders report count', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/reports? available/i)).toBeInTheDocument();
    });
  });

  it('renders category filter buttons', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Spending' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Income' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Net Worth' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Tax' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Debt & Loans' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Investment' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Insights' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Maintenance' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Bills' })).toBeInTheDocument();
    });
  });

  it('navigates to report when report card is clicked', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
    });
    // Find the button with that text
    const reportCard = screen.getByText('Spending by Category').closest('button');
    if (reportCard) {
      fireEvent.click(reportCard);
    }
    expect(mockPush).toHaveBeenCalledWith('/reports/spending-by-category');
  });

  it('renders New Custom Report button', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('New Custom Report')).toBeInTheDocument();
    });
  });

  it('navigates to custom report creation when button is clicked', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('New Custom Report')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('New Custom Report'));
    expect(mockPush).toHaveBeenCalledWith('/reports/custom/new');
  });

  it('renders density toggle button', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Normal')).toBeInTheDocument();
    });
  });

  it('cycles density when toggle button is clicked', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('Normal')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Normal'));
    expect(mockSetDensity).toHaveBeenCalled();
  });

  it('renders compact density view', async () => {
    currentDensity = 'compact';
    render(<ReportsPage />);
    await waitFor(() => {
      // In compact view, reports still render with names
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
    });
  });

  it('renders dense density view as table', async () => {
    currentDensity = 'dense';
    render(<ReportsPage />);
    await waitFor(() => {
      // Dense view renders as a table with Report / Category / Description columns
      expect(screen.getByText('Report')).toBeInTheDocument();
      expect(screen.getByText('Category')).toBeInTheDocument();
      expect(screen.getByText('Description')).toBeInTheDocument();
    });
  });

  it('filters reports by category when a filter button is clicked', async () => {
    currentCategoryFilter = 'tax';
    render(<ReportsPage />);
    await waitFor(() => {
      // Only tax reports should be shown
      expect(screen.getByText('Tax Summary')).toBeInTheDocument();
    });
    // Non-tax reports should not appear
    expect(screen.queryByText('Spending by Category')).not.toBeInTheDocument();
  });

  it('renders custom reports when loaded', async () => {
    mockGetAllReports.mockResolvedValue([
      {
        id: 'cr-1',
        name: 'My Custom Report',
        description: 'A custom report',
        icon: null,
        backgroundColor: null,
        viewType: 'TABLE',
        timeframeType: 'LAST_30_DAYS',
        groupBy: 'CATEGORY',
        filters: {},
        config: {},
        isFavourite: false,
        sortOrder: 0,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    ]);
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('My Custom Report')).toBeInTheDocument();
    });
  });

  it('shows loading custom reports text', async () => {
    mockGetAllReports.mockReturnValue(new Promise(() => {}));
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/loading custom reports/i)).toBeInTheDocument();
    });
  });

  it('handles custom reports API error gracefully', async () => {
    mockGetAllReports.mockRejectedValueOnce(new Error('Network error'));
    render(<ReportsPage />);
    // Page should still render built-in reports
    await waitFor(() => {
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
    });
  });

  it('shows all report categories in normal density view', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      // Check for reports from different categories
      expect(screen.getByText('Spending by Category')).toBeInTheDocument();
      expect(screen.getByText('Income vs Expenses')).toBeInTheDocument();
      expect(screen.getByText('Tax Summary')).toBeInTheDocument();
      expect(screen.getByText('Debt Payoff Timeline')).toBeInTheDocument();
      expect(screen.getByText('Investment Performance')).toBeInTheDocument();
      expect(screen.getByText('Recurring Expenses Tracker')).toBeInTheDocument();
      expect(screen.getByText('Uncategorized Transactions')).toBeInTheDocument();
      expect(screen.getByText('Upcoming Bills Calendar')).toBeInTheDocument();
    });
  });

  it('renders report descriptions', async () => {
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText(/See where your money goes/i)).toBeInTheDocument();
    });
  });

  it('filters to custom category shows only custom reports', async () => {
    currentCategoryFilter = 'custom';
    mockGetAllReports.mockResolvedValue([
      {
        id: 'cr-1',
        name: 'My Custom Report',
        description: 'Custom',
        icon: null,
        backgroundColor: '#ff0000',
        viewType: 'TABLE',
        timeframeType: 'LAST_30_DAYS',
        groupBy: 'CATEGORY',
        filters: {},
        config: {},
        isFavourite: false,
        sortOrder: 0,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
    ]);
    render(<ReportsPage />);
    await waitFor(() => {
      expect(screen.getByText('My Custom Report')).toBeInTheDocument();
    });
    // Built-in reports should not appear
    expect(screen.queryByText('Spending by Category')).not.toBeInTheDocument();
  });
});
