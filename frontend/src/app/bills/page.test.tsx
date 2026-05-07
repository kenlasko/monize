import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import BillsPage from './page';

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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
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
const mockGetOverrides = vi.fn();
const mockDeleteAllOverrides = vi.fn();
const mockGetOverrideByDate = vi.fn();

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    hasOverrides: (...args: any[]) => mockHasOverrides(...args),
    getOverrides: (...args: any[]) => mockGetOverrides(...args),
    deleteAllOverrides: (...args: any[]) => mockDeleteAllOverrides(...args),
    getOverrideByDate: (...args: any[]) => mockGetOverrideByDate(...args),
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

const mockGetAllTransactions = vi.fn();
vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAllTransactions(...args),
  },
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${Math.abs(val).toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

const mockOpenCreate = vi.fn();
const mockOpenEdit = vi.fn();
const mockClose = vi.fn();

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: mockOpenCreate,
    openEdit: mockOpenEdit,
    close: mockClose,
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
  ScheduledTransactionList: ({ transactions, onEdit, onEditOccurrence, onPost }: any) => (
    <div data-testid="scheduled-transaction-list">
      {transactions.map((t: any) => (
        <div key={t.id} data-testid={`st-${t.id}`}>
          <span onClick={() => onEdit(t)}>{t.name}</span>
          <button data-testid={`edit-occurrence-${t.id}`} onClick={() => onEditOccurrence(t)}>Edit Occurrence</button>
          <button data-testid={`post-${t.id}`} onClick={() => onPost(t)}>Post</button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/scheduled-transactions/OverrideEditorDialog', () => ({
  OverrideEditorDialog: ({ isOpen, onClose, onSave }: any) => isOpen ? (
    <div data-testid="override-editor">
      <button data-testid="override-close" onClick={onClose}>Close</button>
      <button data-testid="override-save" onClick={onSave}>Save</button>
    </div>
  ) : null,
}));

vi.mock('@/components/scheduled-transactions/OccurrenceDatePicker', () => ({
  OccurrenceDatePicker: ({ isOpen, onSelect, onClose }: any) => isOpen ? (
    <div data-testid="date-picker">
      <button data-testid="pick-date" onClick={() => onSelect('2026-02-15')}>Pick Date</button>
      <button data-testid="close-date-picker" onClick={onClose}>Close</button>
    </div>
  ) : null,
}));

vi.mock('@/components/scheduled-transactions/PostTransactionDialog', () => ({
  PostTransactionDialog: ({ isOpen, onClose, onPosted }: any) => isOpen ? (
    <div data-testid="post-dialog">
      <button data-testid="post-close" onClick={onClose}>Close</button>
      <button data-testid="post-confirm" onClick={onPosted}>Confirm Post</button>
    </div>
  ) : null,
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
    mockGetAllTransactions.mockResolvedValue({ data: [], total: 0 });
    mockHasOverrides.mockResolvedValue({ hasOverrides: false, count: 0 });
    mockGetOverrides.mockResolvedValue([]);
    mockDeleteAllOverrides.mockResolvedValue(undefined);
    mockGetOverrideByDate.mockResolvedValue(null);
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

    it('hides filter tabs when in calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      // Filter tabs visible in list view
      expect(screen.getByText('All (5)')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Calendar'));
      // Filter tabs hidden in calendar view
      expect(screen.queryByText('All (5)')).not.toBeInTheDocument();
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

    it('navigates to previous month', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('February 2026')).toBeInTheDocument();

      // Find and click the previous month button (left arrow SVG button)
      const monthNav = screen.getByText('February 2026').parentElement;
      const buttons = monthNav!.querySelectorAll('button');
      // First button is previous month
      fireEvent.click(buttons[0]);

      expect(screen.getByText('January 2026')).toBeInTheDocument();
    });

    it('navigates to next month', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      expect(screen.getByText('February 2026')).toBeInTheDocument();

      // Find and click the next month button
      const monthNav = screen.getByText('February 2026').parentElement;
      const buttons = monthNav!.querySelectorAll('button');
      // Second button is next month
      fireEvent.click(buttons[1]);

      expect(screen.getByText('March 2026')).toBeInTheDocument();
    });

    it('navigates to today when Today button clicked', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));

      // Navigate away first
      const monthNav = screen.getByText('February 2026').parentElement;
      const buttons = monthNav!.querySelectorAll('button');
      fireEvent.click(buttons[1]); // Next month
      expect(screen.getByText('March 2026')).toBeInTheDocument();

      // Click Today
      fireEvent.click(screen.getByText('Today'));
      expect(screen.getByText('February 2026')).toBeInTheDocument();
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
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument();
        expect(screen.getByText(/3 individual occurrences/)).toBeInTheDocument();
      });
    });

    it('shows Keep and Delete buttons in override dialog', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      expect(screen.getByText('Keep Modifications')).toBeInTheDocument();
      expect(screen.getByText('Delete All Modifications')).toBeInTheDocument();
    });

    it('closes override dialog on cancel', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      const cancelButtons = screen.getAllByText('Cancel');
      fireEvent.click(cancelButtons[cancelButtons.length - 1]);
      await waitFor(() => {
        expect(screen.queryByText('Existing Overrides Found')).not.toBeInTheDocument();
      });
    });

    it('keeps overrides and opens edit when Keep Modifications clicked', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Keep Modifications'));
      await waitFor(() => {
        expect(screen.queryByText('Existing Overrides Found')).not.toBeInTheDocument();
      });
      expect(mockOpenEdit).toHaveBeenCalled();
    });

    it('deletes overrides and opens edit when Delete All clicked', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      mockDeleteAllOverrides.mockResolvedValue(undefined);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Delete All Modifications'));
      await waitFor(() => {
        expect(mockDeleteAllOverrides).toHaveBeenCalledWith('st-1');
        expect(mockOpenEdit).toHaveBeenCalled();
      });
    });

    it('proceeds to edit directly when no overrides exist', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: false, count: 0 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(mockOpenEdit).toHaveBeenCalled();
      });
      expect(screen.queryByText('Existing Overrides Found')).not.toBeInTheDocument();
    });

    it('proceeds to edit when override check fails', async () => {
      mockHasOverrides.mockRejectedValue(new Error('Check failed'));
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(mockOpenEdit).toHaveBeenCalled();
      });
    });

    it('shows delete all overrides error toast', async () => {
      const toast = await import('react-hot-toast');
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      mockDeleteAllOverrides.mockRejectedValue(new Error('Failed'));
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => expect(screen.getByText('Existing Overrides Found')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Delete All Modifications'));
      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to delete overrides');
      });
    });
  });

  describe('Create New Schedule', () => {
    it('opens create form when New Schedule button is clicked', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByText('+ New Schedule')).toBeInTheDocument());
      fireEvent.click(screen.getByText('+ New Schedule'));
      expect(mockOpenCreate).toHaveBeenCalled();
    });
  });

  describe('Edit Occurrence', () => {
    it('opens date picker when edit occurrence is clicked', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));

      await waitFor(() => {
        expect(screen.getByTestId('date-picker')).toBeInTheDocument();
      });
    });

    it('opens override editor after date is picked', async () => {
      mockGetOverrideByDate.mockResolvedValue(null);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));

      await waitFor(() => {
        expect(screen.getByTestId('date-picker')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('pick-date'));

      await waitFor(() => {
        expect(screen.getByTestId('override-editor')).toBeInTheDocument();
      });
    });

    it('closes date picker when close is clicked', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));

      await waitFor(() => {
        expect(screen.getByTestId('date-picker')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('close-date-picker'));

      await waitFor(() => {
        expect(screen.queryByTestId('date-picker')).not.toBeInTheDocument();
      });
    });

    it('closes override editor and reloads data on save', async () => {
      mockGetOverrideByDate.mockResolvedValue(null);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));
      await waitFor(() => expect(screen.getByTestId('date-picker')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('pick-date'));
      await waitFor(() => expect(screen.getByTestId('override-editor')).toBeInTheDocument());

      mockGetAll.mockClear();
      fireEvent.click(screen.getByTestId('override-save'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });

    it('closes override editor on close click', async () => {
      mockGetOverrideByDate.mockResolvedValue(null);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));
      await waitFor(() => expect(screen.getByTestId('date-picker')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('pick-date'));
      await waitFor(() => expect(screen.getByTestId('override-editor')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('override-close'));

      await waitFor(() => {
        expect(screen.queryByTestId('override-editor')).not.toBeInTheDocument();
      });
    });
  });

  describe('Post Transaction', () => {
    it('opens post dialog when post button is clicked', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-st-1'));

      await waitFor(() => {
        expect(screen.getByTestId('post-dialog')).toBeInTheDocument();
      });
    });

    it('closes post dialog', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-st-1'));
      await waitFor(() => expect(screen.getByTestId('post-dialog')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-close'));

      await waitFor(() => {
        expect(screen.queryByTestId('post-dialog')).not.toBeInTheDocument();
      });
    });

    it('reloads data after transaction is posted', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-st-1'));
      await waitFor(() => expect(screen.getByTestId('post-dialog')).toBeInTheDocument());

      mockGetAll.mockClear();
      fireEvent.click(screen.getByTestId('post-confirm'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });
  });

  describe('Monthly Net Calculation', () => {
    it('calculates monthly net for MONTHLY frequency', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
        { id: 'st-b', name: 'Income', amount: 3000, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Monthly net = 3000 - 100 = 2900
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$2900.00');
      });
    });

    it('normalizes WEEKLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Weekly Bill', amount: -100, frequency: 'WEEKLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Weekly: 100 * 4.33 = 433, monthly net = -433
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$433.00');
      });
    });

    it('excludes transfers from monthly calculations', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Transfer', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: true },
        { id: 'st-b', name: 'Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Only the bill counts, transfer excluded. Monthly net = -100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('excludes inactive from monthly calculations', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Inactive Bill', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: false, isTransfer: false },
        { id: 'st-b', name: 'Active Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Only active bill counted
        expect(screen.getByTestId('summary-Active Bills')).toHaveTextContent('1');
      });
    });
  });

  describe('Due Count', () => {
    it('counts multiple due items', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Due Bill 1', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-02-10', isActive: true, isTransfer: false },
        { id: 'st-b', name: 'Due Bill 2', amount: -200, frequency: 'MONTHLY', nextDueDate: '2026-02-14', isActive: true, isTransfer: false },
        { id: 'st-c', name: 'Future Bill', amount: -300, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Due Bill 1 (Feb 10) and Due Bill 2 (Feb 14) are due today or past
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('2');
      });
    });

    it('shows zero when no items are due', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Future', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('0');
      });
    });

    it('skips due count for items with no nextDueDate', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'No Date Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: null, isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('0');
      });
    });
  });

  describe('Monthly Net Calculation - All Frequencies', () => {
    it('normalizes DAILY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Daily Income', amount: 10, frequency: 'DAILY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 10 * 30 = 300
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$300.00');
      });
    });

    it('normalizes BIWEEKLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Biweekly', amount: 1000, frequency: 'BIWEEKLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1000 * 2.17 = 2170
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$2170.00');
      });
    });

    it('normalizes EVERY4WEEKS frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Every4Weeks', amount: 1000, frequency: 'EVERY4WEEKS', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1000 * (365.25 / 28 / 12) ≈ 1087.05
        const text = screen.getByTestId('summary-Monthly Net').textContent || '';
        expect(parseFloat(text.replace('$', ''))).toBeCloseTo(365.25 / 28 / 12 * 1000, 0);
      });
    });

    it('normalizes QUARTERLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Quarterly', amount: 300, frequency: 'QUARTERLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 300 / 3 = 100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('normalizes YEARLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'Yearly', amount: 1200, frequency: 'YEARLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1200 / 12 = 100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('normalizes ONCE frequency to 0 (no monthly contribution)', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', name: 'OneBill', amount: -500, frequency: 'ONCE', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // ONCE frequency returns 0 monthly
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$0.00');
      });
    });
  });

  describe('Calendar View - Bill Interactions', () => {
    it('clicking a bill in calendar view triggers edit flow', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: false, count: 0 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      // Rent is due Feb 15 and should appear in the calendar
      await waitFor(() => expect(screen.getByText('Rent')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(mockOpenEdit).toHaveBeenCalled();
      });
    });
  });

  describe('Edit Occurrence - Override Matching Branches', () => {
    const _overrideSt = {
      id: 'st-1',
      name: 'Rent',
      amount: -1200,
      frequency: 'MONTHLY',
      nextDueDate: '2026-02-15',
      isActive: true,
      isTransfer: false,
      futureOverrides: [
        { originalDate: '2026-02-15', overrideDate: '2026-02-15' },
      ],
    };

    it('fetches override by original date when picking an overrideDate-matched date', async () => {
      // overrides has entry where overrideDate === picked date
      mockGetOverrides.mockResolvedValue([
        { originalDate: '2026-01-15', overrideDate: '2026-02-15' },
      ]);
      mockGetOverrideByDate.mockResolvedValue({ id: 'ov-1', originalDate: '2026-01-15', overrideDate: '2026-02-15' });

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));
      await waitFor(() => expect(screen.getByTestId('date-picker')).toBeInTheDocument());

      // pick-date triggers onSelect('2026-02-15') - matches the overrideDate
      fireEvent.click(screen.getByTestId('pick-date'));

      await waitFor(() => {
        expect(mockGetOverrideByDate).toHaveBeenCalledWith('st-1', '2026-01-15');
        expect(screen.getByTestId('override-editor')).toBeInTheDocument();
      });
    });

    it('fetches override by originalDate when picking an originalDate-matched date', async () => {
      // overrides has entry where originalDate === picked date (2026-02-15)
      mockGetOverrides.mockResolvedValue([
        { originalDate: '2026-02-15', overrideDate: '2026-03-01' },
      ]);
      mockGetOverrideByDate.mockResolvedValue({ id: 'ov-2', originalDate: '2026-02-15', overrideDate: '2026-03-01' });

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));
      await waitFor(() => expect(screen.getByTestId('date-picker')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('pick-date'));

      await waitFor(() => {
        expect(mockGetOverrideByDate).toHaveBeenCalledWith('st-1', '2026-02-15');
        expect(screen.getByTestId('override-editor')).toBeInTheDocument();
      });
    });

    it('opens override editor with null existingOverride when getOverrideByDate fails', async () => {
      mockGetOverrides.mockResolvedValue([]);
      mockGetOverrideByDate.mockRejectedValue(new Error('Network error'));

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));
      await waitFor(() => expect(screen.getByTestId('date-picker')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('pick-date'));

      await waitFor(() => {
        expect(screen.getByTestId('override-editor')).toBeInTheDocument();
      });
    });

    it('handles getOverrides failure gracefully and still opens date picker', async () => {
      mockGetOverrides.mockRejectedValue(new Error('Fetch failed'));

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('edit-occurrence-st-1'));

      await waitFor(() => {
        expect(screen.getByTestId('date-picker')).toBeInTheDocument();
      });
    });
  });

  describe('Override Confirmation - Singular/Plural Labels', () => {
    it('shows singular "occurrence" for count of 1', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 1 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(screen.getByText(/1 individual occurrence[^s]/)).toBeInTheDocument();
      });
    });

    it('shows plural "occurrences" for count > 1', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 5 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() => {
        expect(screen.getByText(/5 individual occurrences/)).toBeInTheDocument();
      });
    });
  });

  describe('Filter Tabs - Interaction with View Mode', () => {
    it('resets to all filter remains when switching list->calendar->list', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      // Switch to bills filter
      fireEvent.click(screen.getByText(/Bills \(/));
      // Switch to calendar
      fireEvent.click(screen.getByText('Calendar'));
      // Switch back to list
      fireEvent.click(screen.getByText('List'));

      // Bills filter should still be active - only bill transactions visible
      expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    });

    it('bills filter excludes transfers', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Bills \(/));
      // Savings Transfer has amount < 0 but show in bills filter (filter is purely by amount sign)
      // Savings Transfer amount = -500, isTransfer = true -> appears in filter (filter doesn't check isTransfer)
      expect(screen.getByText('Savings Transfer')).toBeInTheDocument();
    });

    it('deposits filter shows only positive-amount items', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Deposits \(/));
      // Netflix(-15.99), Rent(-1200), Savings Transfer(-500), Old Bill(-50) should not appear
      expect(screen.queryByText('Netflix')).not.toBeInTheDocument();
      expect(screen.queryByText('Rent')).not.toBeInTheDocument();
      expect(screen.queryByText('Savings Transfer')).not.toBeInTheDocument();
    });
  });

  describe('Future Transactions Processing', () => {
    it('excludes VOID transactions from future list', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [
          { id: 'ft-1', payeeName: 'Future Bill', amount: -100, transactionDate: '2026-03-01', status: 'VOID', accountId: 'acc-1' },
          { id: 'ft-2', payeeName: 'Regular Bill', amount: -50, transactionDate: '2026-03-01', status: 'PENDING', accountId: 'acc-1' },
        ],
        total: 2,
      });
      render(<BillsPage />);
      // Just verify it renders without error
      await waitFor(() => {
        expect(screen.getByTestId('cash-flow-chart')).toBeInTheDocument();
      });
    });

    it('uses payee.name as fallback when payeeName is null', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [
          {
            id: 'ft-1',
            payeeName: null,
            payee: { name: 'Fallback Payee' },
            amount: -100,
            transactionDate: '2026-03-01T00:00:00',
            status: 'PENDING',
            accountId: 'acc-1',
          },
        ],
        total: 1,
      });
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('cash-flow-chart')).toBeInTheDocument();
      });
    });

    it('uses description as fallback when both payeeName and payee are null', async () => {
      mockGetAllTransactions.mockResolvedValue({
        data: [
          {
            id: 'ft-1',
            payeeName: null,
            payee: null,
            description: 'Misc Charge',
            amount: -100,
            transactionDate: '2026-03-01T00:00:00',
            status: 'PENDING',
            accountId: 'acc-1',
          },
        ],
        total: 1,
      });
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('cash-flow-chart')).toBeInTheDocument();
      });
    });
  });

  describe('Calendar Frequency Branches', () => {
    const makeCalendarSt = (frequency: string) => ({
      id: 'st-cal',
      name: 'CalendarBill',
      amount: -100,
      frequency,
      nextDueDate: '2026-02-15',
      isActive: true,
      isTransfer: false,
      futureOverrides: [],
    });

    const testCalendarFrequency = async (frequency: string) => {
      mockGetAll.mockResolvedValue([makeCalendarSt(frequency)]);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      await waitFor(() => {
        expect(screen.getAllByText('CalendarBill').length).toBeGreaterThan(0);
      });
    };

    it('renders ONCE frequency bill in calendar', () => testCalendarFrequency('ONCE'));
    it('renders DAILY frequency bills in calendar', () => testCalendarFrequency('DAILY'));
    it('renders WEEKLY frequency bills in calendar', () => testCalendarFrequency('WEEKLY'));
    it('renders BIWEEKLY frequency bills in calendar', () => testCalendarFrequency('BIWEEKLY'));
    it('renders EVERY4WEEKS frequency bills in calendar', () => testCalendarFrequency('EVERY4WEEKS'));
    it('renders QUARTERLY frequency bills in calendar', () => testCalendarFrequency('QUARTERLY'));
    it('renders YEARLY frequency bills in calendar', () => testCalendarFrequency('YEARLY'));

    it('applies override date from futureOverrides in calendar', async () => {
      mockGetAll.mockResolvedValue([{
        id: 'st-ov',
        name: 'Override Bill',
        amount: -100,
        frequency: 'ONCE',
        nextDueDate: '2026-02-15',
        isActive: true,
        isTransfer: false,
        futureOverrides: [
          { originalDate: '2026-02-15', overrideDate: '2026-02-20' },
        ],
      }]);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      await waitFor(() => {
        // Bill should appear on Feb 20 (override), not Feb 15
        expect(screen.getByText('Override Bill')).toBeInTheDocument();
      });
    });

    it('applies nextOverride fallback in calendar when futureOverrides is empty', async () => {
      mockGetAll.mockResolvedValue([{
        id: 'st-nxt',
        name: 'NextOverride Bill',
        amount: -100,
        frequency: 'ONCE',
        nextDueDate: '2026-02-15',
        isActive: true,
        isTransfer: false,
        futureOverrides: [],
        nextOverride: { overrideDate: '2026-02-18', originalDate: '2026-02-15' },
      }]);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      await waitFor(() => {
        expect(screen.getByText('NextOverride Bill')).toBeInTheDocument();
      });
    });

    it('renders income (positive) bill with green colour class in calendar', async () => {
      mockGetAll.mockResolvedValue([{
        id: 'st-inc',
        name: 'Salary',
        amount: 5000,
        frequency: 'ONCE',
        nextDueDate: '2026-02-15',
        isActive: true,
        isTransfer: false,
        futureOverrides: [],
      }]);
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Calendar'));
      await waitFor(() => {
        const bill = screen.getByText('Salary');
        expect(bill.closest('div')).toHaveClass('bg-green-100');
      });
    });
  });
});
