import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import BillsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img alt="" {...props} />,
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
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

vi.mock('@/lib/utils', () => ({
  parseLocalDate: (dateStr: string) => new Date(dateStr + 'T00:00:00'),
}));

const mockGetAll = vi.fn();
const mockGetAllCategories = vi.fn();
const mockGetAllAccounts = vi.fn();
const mockHasOverrides = vi.fn();

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    hasOverrides: (...args: any[]) => mockHasOverrides(...args),
    getOverrides: vi.fn().mockResolvedValue([]),
    deleteAllOverrides: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${Math.abs(val).toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: false,
    modalProps: {},
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
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

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...rest }: any) => (
    <button onClick={onClick} {...rest}>{children}</button>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { clipboard: null, plus: null, money: null, clock: null },
}));

vi.mock('@/components/ui/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: any) => <>{children}</>,
}));

vi.mock('@/components/bills/CashFlowForecastChart', () => ({
  CashFlowForecastChart: () => <div data-testid="cash-flow-chart">CashFlowForecastChart</div>,
}));

vi.mock('@/components/scheduled-transactions/ScheduledTransactionForm', () => ({
  ScheduledTransactionForm: () => <div data-testid="scheduled-transaction-form">Form</div>,
}));

vi.mock('@/components/scheduled-transactions/ScheduledTransactionList', () => ({
  ScheduledTransactionList: ({ transactions, onEdit }: any) => (
    <div data-testid="scheduled-transaction-list">
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`st-${t.id}`} onClick={() => onEdit(t)}>{t.name}</div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/scheduled-transactions/OverrideEditorDialog', () => ({
  OverrideEditorDialog: () => null,
}));

vi.mock('@/components/scheduled-transactions/OccurrenceDatePicker', () => ({
  OccurrenceDatePicker: () => null,
}));

vi.mock('@/components/scheduled-transactions/PostTransactionDialog', () => ({
  PostTransactionDialog: () => null,
}));

const now = new Date('2026-02-14T12:00:00');

const mockScheduledTransactions = [
  { id: 'st-1', name: 'Rent', amount: -1200, frequency: 'MONTHLY', nextDueDate: '2026-02-15', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-2', name: 'Salary', amount: 5000, frequency: 'BIWEEKLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-3', name: 'Savings Transfer', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: true, startDate: '2026-01-01', endDate: null },
  { id: 'st-4', name: 'Netflix', amount: -15.99, frequency: 'MONTHLY', nextDueDate: '2026-02-10', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-5', name: 'Old Bill', amount: -50, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: false, isTransfer: false, startDate: '2026-01-01', endDate: null },
];

describe('BillsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now, shouldAdvanceTime: true });
    mockGetAll.mockResolvedValue(mockScheduledTransactions);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllAccounts.mockResolvedValue([]);
    mockHasOverrides.mockResolvedValue({ hasOverrides: false, count: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Rendering', () => {
    it('renders the page header with title', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('Bills & Deposits')).toBeInTheDocument();
      });
    });

    it('renders within page layout', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders the New Schedule button', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Schedule')).toBeInTheDocument();
      });
    });

    it('renders cash flow forecast chart', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('cash-flow-chart')).toBeInTheDocument();
      });
    });
  });

  describe('Summary Cards', () => {
    it('renders all four summary cards', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Active Bills')).toBeInTheDocument();
        expect(screen.getByTestId('summary-Active Deposits')).toBeInTheDocument();
        expect(screen.getByTestId('summary-Monthly Net')).toBeInTheDocument();
        expect(screen.getByTestId('summary-Due Now')).toBeInTheDocument();
      });
    });

    it('counts active non-transfer bills correctly', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        // Rent(-1200) and Netflix(-15.99) are active non-transfer bills = 2
        expect(screen.getByTestId('summary-Active Bills')).toHaveTextContent('2');
      });
    });

    it('counts active non-transfer deposits correctly', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        // Salary(5000) is only active non-transfer deposit = 1
        expect(screen.getByTestId('summary-Active Deposits')).toHaveTextContent('1');
      });
    });

    it('counts due now correctly', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        // Netflix due 2026-02-10 <= today (2026-02-14), active = 1
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('1');
      });
    });
  });

  describe('List View', () => {
    it('renders scheduled transaction list by default', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
      });
    });

    it('shows all transactions in default "all" filter', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('Rent')).toBeInTheDocument();
        expect(screen.getByText('Salary')).toBeInTheDocument();
        expect(screen.getByText('Savings Transfer')).toBeInTheDocument();
        expect(screen.getByText('Netflix')).toBeInTheDocument();
        expect(screen.getByText('Old Bill')).toBeInTheDocument();
      });
    });

    it('filters to bills only', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Bills \(/));
      expect(screen.getByText('Rent')).toBeInTheDocument();
      expect(screen.getByText('Netflix')).toBeInTheDocument();
      expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    });

    it('filters to deposits only', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Deposits \(/));
      expect(screen.getByText('Salary')).toBeInTheDocument();
      expect(screen.queryByText('Rent')).not.toBeInTheDocument();
    });

    it('shows correct filter counts', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('All (5)')).toBeInTheDocument();
        expect(screen.getByText('Bills (4)')).toBeInTheDocument();
        expect(screen.getByText('Deposits (1)')).toBeInTheDocument();
      });
    });
  });

  describe('View Toggle', () => {
    it('renders list and calendar tabs', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('List')).toBeInTheDocument();
        expect(screen.getByText('Calendar')).toBeInTheDocument();
      });
    });

    it('switches to calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('Sun')).toBeInTheDocument();
      expect(screen.getByText('Mon')).toBeInTheDocument();
      expect(screen.getByText('Sat')).toBeInTheDocument();
    });

    it('shows month navigation in calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('February 2026')).toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
    });

    it('switches back to list view from calendar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('Sun')).toBeInTheDocument();
      fireEvent.click(screen.getByText('List'));
      expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
    });
  });

  describe('Calendar View', () => {
    it('renders day numbers', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('14')).toBeInTheDocument();
      expect(screen.getByText('15')).toBeInTheDocument();
    });

    it('shows bill names on scheduled dates', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('Rent')).toBeInTheDocument();
    });

    it('excludes transfers from calendar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.queryByText('Savings Transfer')).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner while data is loading', async () => {
      mockGetAll.mockReturnValue(new Promise(() => {}));
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when data loading fails', async () => {
      const toast = await import('react-hot-toast');
      mockGetAll.mockRejectedValue(new Error('Network error'));
      render(<BillsPage />);
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to load scheduled transactions');
      });
    });
  });

  describe('Override Confirmation', () => {
    it('shows override confirmation when editing a transaction with overrides', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 3 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('st-st-1'));
      await waitFor(() => {
        expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument();
        expect(screen.getByText(/3 individual occurrences/)).toBeInTheDocument();
      });
    });

    it('shows Keep and Delete buttons in override dialog', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('st-st-1'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      expect(screen.getByText('Keep Modifications')).toBeInTheDocument();
      expect(screen.getByText('Delete All Modifications')).toBeInTheDocument();
    });

    it('closes override dialog on cancel', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('st-st-1'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      const cancelButtons = screen.getAllByText('Cancel');
      fireEvent.click(cancelButtons[cancelButtons.length - 1]);
      await waitFor(() => {
        expect(screen.queryByText('Existing Overrides Found')).not.toBeInTheDocument();
      });
    });
  });
});
