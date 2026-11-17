import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import toast from 'react-hot-toast';
import BudgetsPage from './page';

// Mock next/navigation
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => '/budgets',
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
// Mutable so a test can choose the reader's date format; reset in beforeEach.
const mockPreferences: Record<string, unknown> = {};
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD', ...mockPreferences },
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

// Mock accounts API
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

// Mock exchange rates
vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    convertToDefault: vi.fn((amount: number) => amount),
  }),
}));

// Mock budgets API
const mockGetAll = vi.fn().mockResolvedValue([]);

vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    generate: vi.fn(),
    applyGenerated: vi.fn(),
  },
}));

// Mock components
vi.mock('@/components/budgets/BudgetWizard', () => ({
  BudgetWizard: ({ onComplete, onCancel }: any) => (
    <div data-testid="budget-wizard">
      <button data-testid="wizard-complete" onClick={onComplete}>Complete</button>
      <button data-testid="wizard-cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions, primaryAction }: { title: string; subtitle?: string; actions?: React.ReactNode; primaryAction?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions}
      {primaryAction}
    </div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner">Loading...</div>,
}));

describe('BudgetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
    for (const key of Object.keys(mockPreferences)) delete mockPreferences[key];
  });

  it('renders the page with title', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('Budgets')).toBeInTheDocument();
    });
  });

  it('shows empty state when no budgets exist', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });
    expect(screen.getByText('Create Your First Budget')).toBeInTheDocument();
  });

  it('draws the last list at once on a return, while it refetches it', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'budget-1', name: 'February 2026', description: null, strategy: 'FIXED', budgetType: 'MONTHLY',
        isActive: true, periodStart: '2026-02-01', categories: [] },
    ]);
    const first = render(<BudgetsPage />);
    await screen.findByRole('row', { name: /February 2026/ });
    first.unmount();

    mockGetAll.mockReturnValue(new Promise(() => {}));
    await act(async () => render(<BudgetsPage />));
    expect(screen.getByRole('row', { name: /February 2026/ })).toBeInTheDocument();
  });

  it('lists budgets as table rows, not a card grid', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'February 2026',
        description: null,
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [{ id: 'bc-1' }, { id: 'bc-2' }],
      },
    ]);

    render(<BudgetsPage />);

    const row = await screen.findByRole('row', { name: /February 2026/ });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /February 2026/ })).toBeNull();
    const headers = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headers).toEqual(['Name', 'Strategy', 'Type', 'Categories', 'Started', 'Status']);
    const cells = within(row).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('Fixed');
    expect(cells[2]).toHaveTextContent('Monthly');
    // The count is a number column, right-aligned.
    expect(cells[3]).toHaveTextContent('2');
    expect(cells[3].className).toContain('text-right');
    expect(screen.getAllByRole('columnheader')[3].className).toContain('text-right');
    // The status is the shared Badge.
    expect(within(cells[5]).getByText('Active').className).toContain('rounded-full');
  });

  it('shows the start date in the reader\'s date format', async () => {
    mockPreferences.dateFormat = 'DD/MM/YYYY';
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'February 2026',
        description: null,
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [],
      },
    ]);

    render(<BudgetsPage />);

    const row = await screen.findByRole('row', { name: /February 2026/ });
    expect(within(row).getByText('01/02/2026')).toBeInTheDocument();
  });

  it('draws the list inside the card, with a spinner there while it loads', async () => {
    let resolve: (value: unknown[]) => void = () => {};
    mockGetAll.mockReturnValue(new Promise((r) => { resolve = r; }));

    render(<BudgetsPage />);

    const spinner = screen.getByTestId('loading-spinner');
    expect(spinner.parentElement?.className).toContain('overflow-hidden');
    await act(async () => {
      resolve([]);
    });
  });

  it('shows the wizard when clicking New Budget', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });
  });

  it('returns to list when wizard completes', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-complete'));

    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalledTimes(2);
    });
  });

  it('returns to list when wizard is cancelled', async () => {
    render(<BudgetsPage />);

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Create Your First Budget'));

    await waitFor(() => {
      expect(screen.getByTestId('budget-wizard')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('wizard-cancel'));

    await waitFor(() => {
      expect(screen.getByText('No budgets yet')).toBeInTheDocument();
    });
  });

  it('opens a budget from a click anywhere on its row, or Enter on the focused row', async () => {
    mockGetAll.mockResolvedValue([
      {
        id: 'budget-1',
        name: 'Budget',
        description: null,
        strategy: 'FIXED',
        budgetType: 'MONTHLY',
        isActive: true,
        periodStart: '2026-02-01',
        categories: [],
      },
    ]);

    render(<BudgetsPage />);

    const row = await screen.findByRole('row', { name: /Budget/ });
    // A cell away from the name opens it too: the whole row is the target.
    fireEvent.click(within(row).getByText('Monthly'));
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-1');

    mockPush.mockClear();
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mockPush).toHaveBeenCalledWith('/budgets/budget-1');
  });

  it('renders the shared EmptyState when there are no budgets', async () => {
    render(<BudgetsPage />);

    const title = await screen.findByText('No budgets yet');
    expect(title.tagName).toBe('H3');
    expect(title.parentElement?.className).toContain('text-center');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows error toast when loading budgets fails', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    render(<BudgetsPage />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled();
    });
  });

  it('does not toast on a 403 (the section guard owns that message)', async () => {
    mockGetAll.mockRejectedValueOnce({ response: { status: 403 } });
    render(<BudgetsPage />);
    await waitFor(() => {
      expect(mockGetAll).toHaveBeenCalled();
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

});
