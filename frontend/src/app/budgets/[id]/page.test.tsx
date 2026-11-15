import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import toast from 'react-hot-toast';
import BudgetDetailPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets/budget-1',
  useParams: () => ({ id: 'budget-1' }),
}));

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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD', numberFormat: 'en-US' },
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

// Mock number format
vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (amount: number) => `$${amount.toFixed(2)}`,
      formatNumber: (amount: number) => amount.toFixed(2),
      formatPercent: (amount: number) => `${amount}%`,
      defaultCurrency: 'USD',
    }),
  };
});

// Mock budgets API
const mockGetSummary = vi.fn();
const mockGetVelocity = vi.fn();
const mockGetPeriods = vi.fn();
const mockGetDailySpending = vi.fn();
const mockGetTrend = vi.fn();
const mockDeleteBudget = vi.fn();
const mockGetPeriodDetail = vi.fn();
const mockGetAll = vi.fn();

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getSummary: (...args: any[]) => mockGetSummary(...args),
    getVelocity: (...args: any[]) => mockGetVelocity(...args),
    getPeriods: (...args: any[]) => mockGetPeriods(...args),
    getDailySpending: (...args: any[]) => mockGetDailySpending(...args),
    getTrend: (...args: any[]) => mockGetTrend(...args),
    delete: (...args: any[]) => mockDeleteBudget(...args),
    getPeriodDetail: (...args: any[]) => mockGetPeriodDetail(...args),
    getAll: (...args: any[]) => mockGetAll(...args),
  },
}));

// Mock scheduled transactions API
vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, confirmLabel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <button data-testid="confirm-btn" onClick={onConfirm}>{confirmLabel || 'Confirm'}</button>
        <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('@/components/budgets/utils/budget-labels', () => ({
  STRATEGY_LABELS: {
    FIXED: 'Fixed',
    ROLLOVER: 'Rollover',
    ZERO_BASED: 'Zero-Based',
    FIFTY_THIRTY_TWENTY: '50/30/20',
    BUCKET: 'Bucket',
  },
}));

// Mock components
let capturedOnCategoryClick: ((budgetCategoryId: string) => void) | undefined;
vi.mock('@/components/budgets/BudgetDashboard', () => ({
  BudgetDashboard: (props: any) => {
    capturedOnCategoryClick = props.onCategoryClick;
    return <div data-testid="budget-dashboard">Dashboard</div>;
  },
}));

let capturedOnPeriodChange: ((periodId: string | null) => void) | undefined;
vi.mock('@/components/budgets/BudgetPeriodSelector', () => ({
  BudgetPeriodSelector: (props: any) => {
    capturedOnPeriodChange = props.onPeriodChange;
    return <div data-testid="period-selector" />;
  },
}));

vi.mock('@/components/budgets/BudgetPeriodDetail', () => ({
  BudgetPeriodDetail: () => <div data-testid="period-detail">Period Detail</div>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({
    title,
    actions,
    titleAdornment,
  }: {
    title: string;
    actions?: React.ReactNode;
    titleAdornment?: React.ReactNode;
  }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {titleAdornment}
      {actions}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

const mockSummary = {
  budget: {
    id: 'budget-1',
    userId: 'user-1',
    name: 'February 2026',
    description: null,
    budgetType: 'MONTHLY',
    periodStart: '2026-02-01',
    periodEnd: '2026-02-28',
    baseIncome: 6000,
    incomeLinked: false,
    strategy: 'FIXED',
    isActive: true,
    currencyCode: 'USD',
    config: {},
    categories: [],
    createdAt: '2026-02-01',
    updatedAt: '2026-02-01',
  },
  totalBudgeted: 5200,
  totalSpent: 3100,
  totalIncome: 6000,
  remaining: 2100,
  percentUsed: 59.62,
  categoryBreakdown: [
    {
      budgetCategoryId: 'bc-1',
      categoryId: 'cat-groceries',
      categoryName: 'Groceries',
      budgeted: 600,
      spent: 420,
      remaining: 180,
      percentUsed: 70,
      isIncome: false,
    },
  ],
};

const mockVelocity = {
  dailyBurnRate: 155,
  projectedTotal: 4650,
  budgetTotal: 5200,
  projectedVariance: -550,
  safeDailySpend: 124,
  daysElapsed: 13,
  daysRemaining: 15,
  totalDays: 28,
  currentSpent: 2015,
  paceStatus: 'under',
};

describe('BudgetDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    capturedOnCategoryClick = undefined;
    capturedOnPeriodChange = undefined;
    mockGetSummary.mockResolvedValue(mockSummary);
    mockGetVelocity.mockResolvedValue(mockVelocity);
    mockGetPeriods.mockResolvedValue([]);
    mockGetDailySpending.mockResolvedValue([]);
    mockGetTrend.mockResolvedValue([]);
    mockDeleteBudget.mockResolvedValue(undefined);
    mockGetAll.mockResolvedValue([]);
  });

  it('shows loading spinner initially', async () => {
    render(<BudgetDetailPage />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();

    // Wait for async operations to complete to prevent act() warnings
    await waitFor(() => {
      expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
    });
  });

  it('renders budget dashboard after loading', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });
  });

  it('displays budget name in header', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('February 2026')).toBeInTheDocument();
    });
  });

  it('shows error state on API failure', async () => {
    mockGetSummary.mockRejectedValue(new Error('Network error'));

    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Failed to load budget')).toBeInTheDocument();
    });
  });

  it('renders the edit button, and the way back as a link above the title', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByText('Edit')).toBeInTheDocument();
    });
    // The way back is not an action on the budget: a chevron link on the line
    // above the title, not a button among the header actions.
    const back = screen.getByRole('link', { name: 'Back to Budgets' });
    expect(back).toHaveAttribute('href', '/budgets');
    const header = screen.getByTestId('page-header');
    expect(header.contains(back)).toBe(false);
    expect(back.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back to Budgets' })).toBeNull();
  });

  it('switches to another budget from the caret beside the title', async () => {
    mockGetAll.mockResolvedValue([
      { ...mockSummary.budget },
      { ...mockSummary.budget, id: 'budget-2', name: 'Vacation Fund', budgetType: 'ANNUAL' },
    ]);
    render(<BudgetDetailPage />);

    const caret = await screen.findByRole('button', { name: 'Switch to another budget' });
    // Beside the title, inside the header.
    expect(screen.getByTestId('page-header').contains(caret)).toBe(true);
    await act(async () => {
      fireEvent.click(caret);
    });
    // The budget on screen is not offered as a destination.
    expect(screen.queryByRole('menuitem', { name: /February 2026/ })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: /Vacation Fund/ }));
    });
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-2');
  });

  it('draws no switcher when the budget list fails to load', async () => {
    mockGetAll.mockRejectedValue(new Error('Network error'));
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Switch to another budget' })).toBeNull();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('calls API with correct budget ID', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(mockGetSummary).toHaveBeenCalledWith('budget-1');
      expect(mockGetVelocity).toHaveBeenCalledWith('budget-1');
      expect(mockGetPeriods).toHaveBeenCalledWith('budget-1');
    });
  });

  it('navigates to transactions with category filter on category click', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });

    // The BudgetDashboard mock captures onCategoryClick
    expect(capturedOnCategoryClick).toBeDefined();
    capturedOnCategoryClick!('bc-1');

    expect(localStorage.getItem('transactions.filter.accountStatus')).toBe(
      JSON.stringify('active'),
    );
    expect(mockPush).toHaveBeenCalledWith(
      '/transactions?startDate=2026-02-01&endDate=2026-02-28&categoryIds=cat-groceries',
    );
  });

  it('does not navigate when category is not found', async () => {
    render(<BudgetDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });

    capturedOnCategoryClick!('non-existent-bc');

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('navigates to edit page when Edit button is clicked', async () => {
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Edit')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Edit'));
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-1/edit');
  });

  it('shows delete confirm dialog when Delete button is clicked', async () => {
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });
  });

  it('deletes budget and navigates to list when confirmed', async () => {
    mockDeleteBudget.mockResolvedValue(undefined);
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-btn'));
    });
    await waitFor(() => {
      expect(mockDeleteBudget).toHaveBeenCalledWith('budget-1');
      expect(mockPush).toHaveBeenCalledWith('/budgets');
    });
  });

  it('shows error toast when delete fails', async () => {
    mockDeleteBudget.mockRejectedValueOnce(new Error('Delete failed'));
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-btn'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('closes delete dialog when Cancel is clicked', async () => {
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Delete')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    });
  });

  it('navigates to budgets when Back to Budgets is clicked in error state', async () => {
    mockGetSummary.mockRejectedValue(new Error('Not found'));
    render(<BudgetDetailPage />);
    await waitFor(() => expect(screen.getByText('Back to Budgets')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Back to Budgets'));
    expect(mockPush).toHaveBeenCalledWith('/budgets');
  });

  describe('Period Selection', () => {
    const mockClosedPeriod = {
      id: 'period-1',
      budgetId: 'budget-1',
      status: 'CLOSED',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
    };

    it('clears selection when null period is selected', async () => {
      mockGetPeriods.mockResolvedValue([mockClosedPeriod]);
      render(<BudgetDetailPage />);
      await waitFor(() => expect(capturedOnPeriodChange).toBeDefined());

      await act(async () => {
        capturedOnPeriodChange!(null);
      });

      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
      expect(screen.queryByTestId('period-detail')).not.toBeInTheDocument();
    });

    it('shows period detail for closed period', async () => {
      mockGetPeriods.mockResolvedValue([mockClosedPeriod]);
      mockGetPeriodDetail.mockResolvedValue({ ...mockClosedPeriod, categories: [] });
      render(<BudgetDetailPage />);
      await waitFor(() => expect(capturedOnPeriodChange).toBeDefined());

      await act(async () => {
        capturedOnPeriodChange!('period-1');
      });

      await waitFor(() => {
        expect(screen.getByTestId('period-detail')).toBeInTheDocument();
      });
      expect(mockGetPeriodDetail).toHaveBeenCalledWith('budget-1', 'period-1');
    });

    it('does not fetch period detail for OPEN period', async () => {
      const openPeriod = { ...mockClosedPeriod, id: 'period-open', status: 'OPEN' };
      mockGetPeriods.mockResolvedValue([openPeriod]);
      render(<BudgetDetailPage />);
      await waitFor(() => expect(capturedOnPeriodChange).toBeDefined());

      await act(async () => {
        capturedOnPeriodChange!('period-open');
      });

      expect(mockGetPeriodDetail).not.toHaveBeenCalled();
      expect(screen.getByTestId('budget-dashboard')).toBeInTheDocument();
    });

    it('shows error toast when period detail fetch fails', async () => {
      mockGetPeriods.mockResolvedValue([mockClosedPeriod]);
      mockGetPeriodDetail.mockRejectedValue(new Error('Not found'));
      render(<BudgetDetailPage />);
      await waitFor(() => expect(capturedOnPeriodChange).toBeDefined());

      await act(async () => {
        capturedOnPeriodChange!('period-1');
      });

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalled();
      });
    });
  });
});
