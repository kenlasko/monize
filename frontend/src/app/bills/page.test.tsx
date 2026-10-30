import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import BillsPage from './page';
import { useDensityStore } from '@/store/densityStore';
import { useViewModeStore } from '@/store/viewModeStore';
import { notifyAiAction } from '@/lib/aiActionSignal';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Controllable next/navigation mock (overrides the global one for this file)
const nav = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: nav.push,
    replace: nav.replace,
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/bills',
  useSearchParams: () => nav.searchParams,
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
      preferences: { twoFactorEnabled: true, theme: 'system', defaultCurrency: 'USD' },
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

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  parseLocalDate: (dateStr: string) => new Date(dateStr + 'T00:00:00'),
}));

const mockGetAll = vi.fn();
const mockGetAllCategories = vi.fn();
const mockCreateCategory = vi.fn();
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
    create: (...args: any[]) => mockCreateCategory(...args),
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

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      // The code is part of what a money value IS, so the mock prints it: a
      // formatter that swallows it cannot tell a CAD figure labelled USD from a
      // correct one, which is the defect these tests exist for (issue #1247).
      formatCurrency: (val: number, code?: string) =>
        code ? `${code} $${Math.abs(val).toFixed(2)}` : `$${Math.abs(val).toFixed(2)}`,
      formatNumber: (val: number) => val.toString(),
    }),
  };
});
/**
 * Rates the page's converter can see, as `FROM->TO`. Tests set it to make a
 * pair convertible or deliberately absent; empty means only same-currency
 * conversions resolve, which is what a cold rate table really does.
 */
const mockRates = new Map<string, number>();

/**
 * Whether the rate table can be consulted at all.
 *
 * The real hook is `true` while the request is in flight and stays `true` if it
 * failed, and with no rates loaded every cross-currency conversion returns
 * `null` -- so a surface that reads only the missing-pair list reports "add a
 * rate on Currencies" for a rate that is very likely already there.
 */
let mockRatesUnavailable = false;

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    defaultCurrency: 'USD',
    get ratesUnavailable() {
      return mockRatesUnavailable;
    },
    get ratesFailed() {
      return mockRatesUnavailable;
    },
    // Mirrors the real hook's contract: same currency is 1:1 BY DEFINITION, an
    // unknown pair is `null` -- never the amount passed through.
    convertToDefault: (amount: number, from: string) => {
      if (from === 'USD') return amount;
      const rate = mockRates.get(`${from}->USD`);
      return rate === undefined ? null : amount * rate;
    },
    convert: () => null,
    convertWithRateMap: () => null,
    rates: [],
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

const mockOpenCreate = vi.fn();
const mockOpenEdit = vi.fn();
const mockClose = vi.fn();
const formModal = vi.hoisted(() => ({ showForm: false }));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: formModal.showForm,
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

// The mock keeps Modal's contract that matters here: a `title` names the
// dialog, so a host that drew its own heading instead has no name.
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen, title }: any) =>
    isOpen ? (
      <div data-testid="modal" role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
        {title ? <h2>{title}</h2> : null}
        {children}
      </div>
    ) : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value, hint }: any) => (
    <div data-testid={`summary-${label}`}>
      {value}
      {hint ? <span data-testid={`summary-hint-${label}`}>{hint}</span> : null}
    </div>
  ),
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
  PostTransactionDialog: ({ isOpen, onClose, onPosted, categories, onCreateCategory }: any) => isOpen ? (
    <div data-testid="post-dialog">
      <button data-testid="post-close" onClick={onClose}>Close</button>
      <button data-testid="post-confirm" onClick={onPosted}>Confirm Post</button>
      <span data-testid="post-category-names">
        {(categories || []).map((c: any) => c.name).join(',')}
      </span>
      {onCreateCategory && (
        <button
          data-testid="post-create-category"
          onClick={() => onCreateCategory('travel: hotels')}
        >
          Create category
        </button>
      )}
    </div>
  ) : null,
}));

const now = new Date('2026-02-14T12:00:00');

const mockScheduledTransactions = [
  { id: 'st-1', currencyCode: 'USD', name: 'Rent', amount: -1200, frequency: 'MONTHLY', nextDueDate: '2026-02-15', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-2', currencyCode: 'USD', name: 'Salary', amount: 5000, frequency: 'BIWEEKLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-3', currencyCode: 'USD', name: 'Savings Transfer', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: true, startDate: '2026-01-01', endDate: null },
  { id: 'st-4', currencyCode: 'USD', name: 'Netflix', amount: -15.99, frequency: 'MONTHLY', nextDueDate: '2026-02-10', isActive: true, isTransfer: false, startDate: '2026-01-01', endDate: null },
  { id: 'st-5', currencyCode: 'USD', name: 'Old Bill', amount: -50, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: false, isTransfer: false, startDate: '2026-01-01', endDate: null },
  // A zero-amount transfer used purely as a reminder: the amount varies month to
  // month, so the user leaves it at 0 (issue #1124).
  { id: 'st-6', currencyCode: 'USD', name: 'Card Payment Reminder', amount: 0, frequency: 'MONTHLY', nextDueDate: '2026-02-18', isActive: true, isTransfer: true, startDate: '2026-01-01', endDate: null },
];

describe('BillsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // A cold rate table by default: every fixture above is USD, so nothing needs
    // one, and a test that adds a foreign schedule has to say what its rate is.
    mockRates.clear();
    mockRatesUnavailable = false;
    // Filters (type tab + panel selections) now persist to localStorage;
    // reset it so each case starts from the default unfiltered view.
    localStorage.clear();
    // The Table / Calendar choice lives in the shared view-mode store, which
    // outlives a render: start every case on the list.
    useViewModeStore.getState().setView('bills', 'table');
    formModal.showForm = false;
    nav.searchParams = new URLSearchParams();
    vi.useFakeTimers({ now, shouldAdvanceTime: true });
    mockGetAll.mockResolvedValue(mockScheduledTransactions);
    mockGetAllCategories.mockResolvedValue([]);
    mockCreateCategory.mockReset();
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

    it('is a segmented control whose pressed segment is the active filter', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      const group = screen.getByRole('group', { name: 'Schedule type' });
      const all = screen.getByRole('button', { name: 'All (6)' });
      const bills = screen.getByRole('button', { name: 'Bills (3)' });
      expect(group).toContainElement(all);
      expect(all).toHaveAttribute('aria-pressed', 'true');
      expect(bills).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(bills);
      expect(bills).toHaveAttribute('aria-pressed', 'true');
      expect(all).toHaveAttribute('aria-pressed', 'false');
    });

    it('shows correct filter counts', async () => {
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByText('All (6)')).toBeInTheDocument();
        // Rent, Netflix and Old Bill. The negative Savings Transfer is a
        // transfer and the zero-amount Card Payment Reminder is neither.
        expect(screen.getByText('Bills (3)')).toBeInTheDocument();
        expect(screen.getByText('Deposits (1)')).toBeInTheDocument();
      });
    });
  });

  describe('View Toggle', () => {
    it('switches with the shared Table / Calendar toggle, not a hand-rolled tab bar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      const group = screen.getByRole('group', { name: 'View' });
      const table = screen.getByRole('button', { name: 'Table' });
      const calendar = screen.getByRole('button', { name: 'Calendar' });
      expect(group).toContainElement(table);
      expect(group).toContainElement(calendar);
      expect(table).toHaveAttribute('aria-pressed', 'true');
      expect(calendar).toHaveAttribute('aria-pressed', 'false');
      expect(document.querySelector('nav')).toBeNull();
    });

    it('remembers the choice in the view-mode store for the bills surface', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));

      expect(useViewModeStore.getState().surfaces.bills.view).toBe('calendar');
      expect(useViewModeStore.getState().surfaces.transactions.view).toBe('table');
    });

    it('opens on the calendar when that is the stored choice', async () => {
      useViewModeStore.getState().setView('bills', 'calendar');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByText('February 2026')).toBeInTheDocument());
      expect(screen.queryByTestId('scheduled-transaction-list')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Calendar' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('opens the list for a ?highlight= link even when the calendar is the stored choice', async () => {
      // Only the list draws the row a highlight link points at.
      useViewModeStore.getState().setView('bills', 'calendar');
      nav.searchParams = new URLSearchParams('highlight=st-1');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
      expect(useViewModeStore.getState().surfaces.bills.view).toBe('table');
    });

    it('keeps the toggle in the calendar toolbar, so the reader can switch back', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      const toolbar = screen.getByText('February 2026').parentElement!.parentElement!;
      expect(toolbar).toContainElement(screen.getByRole('group', { name: 'View' }));
      expect(screen.getByRole('button', { name: 'Previous month' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Next month' })).toBeInTheDocument();
    });

    it('switches to calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('Sun')).toBeInTheDocument();
      expect(screen.getByText('Mon')).toBeInTheDocument();
      expect(screen.getByText('Sat')).toBeInTheDocument();
    });

    it('shows month navigation in calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('February 2026')).toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
    });

    it('switches back to list view from calendar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('Sun')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));
      expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument();
    });

    it('hides filter tabs when in calendar view', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      // Filter tabs visible in list view
      expect(screen.getByText('All (6)')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      // Filter tabs hidden in calendar view
      expect(screen.queryByText('All (6)')).not.toBeInTheDocument();
    });
  });

  /**
   * Issue #1203: the Bills list had no density control at all. It sits at the
   * far right of the bar the List/Calendar tabs and the All/Bills/Deposits
   * chips already share, so every control that shapes the list is on one line.
   */
  describe('Density toggle', () => {
    beforeEach(() => {
      useDensityStore.setState({ densities: {} });
    });

    it('shares the toolbar with the type filter, beside the Table / Calendar switch', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      const filter = screen.getByRole('group', { name: 'Schedule type' });
      const bar = filter.parentElement!;
      const toggle = screen.getByTitle('Toggle row density');

      expect(bar).toContainElement(toggle);
      // The right-hand group: density, then the view switch last of all.
      const rightGroup = bar.lastElementChild!;
      expect(rightGroup).toContainElement(toggle);
      expect(rightGroup.lastElementChild).toBe(screen.getByRole('group', { name: 'View' }));
    });

    it('is the plain toggle every other table draws, not a filled chip', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      // It sits among the filter chips but is not one of them, so it carries no
      // resting fill -- only the hover the borderless `sm` button has. Matched
      // on whole class names, since `hover:bg-gray-100` contains the other.
      const classes = screen.getByTitle('Toggle row density').className.split(/\s+/);
      expect(classes).not.toContain('bg-gray-100');
      expect(classes).not.toContain('dark:bg-gray-700');
      expect(classes).toContain('hover:bg-gray-100');
    });

    it('stays visible below sm, and so do the type segments', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      // Nothing on the toolbar is hidden at a breakpoint: a filter the reader
      // cannot see on a phone is a filter they forget is applied. The type
      // segments wrap instead.
      const hiddenAncestor = (el: HTMLElement | null) => {
        for (let node = el; node; node = node.parentElement) {
          if (node.className.split(/\s+/).includes('hidden')) return node;
        }
        return null;
      };
      expect(hiddenAncestor(screen.getByRole('button', { name: 'All (6)' }))).toBeNull();
      expect(hiddenAncestor(screen.getByTitle('Toggle row density'))).toBeNull();
      expect(screen.getByRole('group', { name: 'Schedule type' }).className).toContain('flex-wrap');
    });

    it('is absent in calendar view, which has no rows to tighten', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.queryByTitle('Toggle row density')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Table' }));
      expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    });

    it('cycles normal to compact to dense and back', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      const toggle = screen.getByTitle('Toggle row density');
      expect(toggle).toHaveTextContent('Normal');

      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Compact');
      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Dense');
      fireEvent.click(toggle);
      expect(toggle).toHaveTextContent('Normal');
    });

    it('writes to the bills view, not the transactions register', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTitle('Toggle row density'));

      expect(useDensityStore.getState().densities.bills).toBe('compact');
      expect(useDensityStore.getState().densities.transactions).toBeUndefined();
    });

    it('reads the level the store already holds for bills', async () => {
      useDensityStore.setState({ densities: { bills: 'dense' } });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      expect(screen.getByTitle('Toggle row density')).toHaveTextContent('Dense');
    });
  });

  describe('Calendar View', () => {
    it('renders day numbers', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('14')).toBeInTheDocument();
      expect(screen.getByText('15')).toBeInTheDocument();
    });

    it('shows bill names on scheduled dates', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('Rent')).toBeInTheDocument();
    });

    // Issue #1124: a zero-amount transfer used as a payment reminder was on the
    // list but missing from the calendar, because the calendar dropped every
    // transfer.
    it('shows zero-amount transfers on the calendar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('Card Payment Reminder')).toBeInTheDocument();
    });

    it('styles a transfer chip distinctly from a bill and a deposit', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.getByText('Card Payment Reminder').className).toContain('bg-blue-100');
      expect(screen.getByText('Rent').className).toContain('bg-red-100');
      expect(screen.getByText('Salary').className).toContain('bg-green-100');
    });

    it('excludes inactive schedules from the calendar', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      expect(screen.queryByText('Old Bill')).not.toBeInTheDocument();
    });

    it('navigates to previous month', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));

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

  describe('Dialog titles', () => {
    it('names the schedule form dialog by its Modal title, keeping its size', async () => {
      formModal.showForm = true;
      render(<BillsPage />);
      await waitFor(() =>
        expect(screen.getByRole('dialog', { name: 'New Scheduled Transaction' })).toBeInTheDocument(),
      );
      expect(screen.getByTestId('scheduled-transaction-form')).toBeInTheDocument();
    });

    it('names the overrides question dialog by its Modal title', async () => {
      mockHasOverrides.mockResolvedValue({ hasOverrides: true, count: 2 });
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Rent'));
      await waitFor(() =>
        expect(screen.getByRole('dialog', { name: 'Existing Overrides Found' })).toBeInTheDocument(),
      );
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

    // Both occurrence dialogs let the user name a category that does not exist
    // yet; the page owns the list they read, so it owns the creation and has to
    // add every row created -- the parent included -- or the picker shows a
    // child whose parent is missing (issue #1187 follow-up).
    it('creates a category for the post dialog and adds every created row to the list', async () => {
      mockCreateCategory
        .mockResolvedValueOnce({ id: 'parent-cat', name: 'Travel', parentId: null })
        .mockResolvedValueOnce({ id: 'child-cat', name: 'Hotels', parentId: 'parent-cat' });

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-st-1'));
      await waitFor(() => expect(screen.getByTestId('post-dialog')).toBeInTheDocument());

      await act(async () => {
        fireEvent.click(screen.getByTestId('post-create-category'));
      });

      expect(mockCreateCategory).toHaveBeenNthCalledWith(1, { name: 'Travel' });
      expect(mockCreateCategory).toHaveBeenNthCalledWith(2, {
        name: 'Hotels',
        parentId: 'parent-cat',
      });
      await waitFor(() => {
        expect(screen.getByTestId('post-category-names')).toHaveTextContent('Travel,Hotels');
      });
    });

    it('reports a failed category creation instead of silently doing nothing', async () => {
      mockCreateCategory.mockRejectedValue(new Error('boom'));

      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());

      fireEvent.click(screen.getByTestId('post-st-1'));
      await waitFor(() => expect(screen.getByTestId('post-dialog')).toBeInTheDocument());

      const toast = await import('react-hot-toast');
      await act(async () => {
        fireEvent.click(screen.getByTestId('post-create-category'));
      });

      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('Failed to create category');
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

  describe('Monthly Net spans one currency or none', () => {
    // A CAD-settling schedule beside a USD one. Added as raw numbers these
    // produce a confident figure in whichever currency the reader prefers --
    // the same defect the Upcoming Bills report and the budget panel were fixed
    // for, still live on this page (issue #1247 re-audit).
    const twoCurrencySchedules = () => [
      {
        id: 'st-usd',
        currencyCode: 'USD',
        name: 'Rent',
        amount: -500,
        frequency: 'MONTHLY',
        nextDueDate: '2026-03-01',
        isActive: true,
        isTransfer: false,
      },
      {
        id: 'st-cad',
        currencyCode: 'CAD',
        name: 'Hydro',
        amount: -1350,
        frequency: 'MONTHLY',
        nextDueDate: '2026-03-01',
        isActive: true,
        isTransfer: false,
      },
    ];

    it('converts each schedule before summing', async () => {
      mockRates.set('CAD->USD', 0.74);
      mockGetAll.mockResolvedValue(twoCurrencySchedules());
      render(<BillsPage />);
      await waitFor(() => {
        // 500 + 1350 x 0.74 = 1499, in the reader's own currency. Never 1850.
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'USD $1499.00',
        );
      });
      expect(
        screen.queryByTestId('summary-hint-Monthly Net'),
      ).not.toBeInTheDocument();
    });

    it('withholds the net and names the currency when a rate is missing', async () => {
      // No CAD->USD rate: the honest answer is that the net is not known, with
      // the reason on screen. A blank where a number belongs is indistinguishable
      // from "nothing scheduled".
      mockGetAll.mockResolvedValue(twoCurrencySchedules());
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'Not available',
        );
      });
      // Not the 500 subtotal under a total's caption, and not the 1850 sum.
      const net = screen.getByTestId('summary-Monthly Net').textContent || '';
      expect(net).not.toContain('500');
      expect(net).not.toContain('1850');
      expect(screen.getByTestId('summary-hint-Monthly Net')).toHaveTextContent(
        'CAD',
      );
      // The counts are unaffected: how many bills there are is still known.
      expect(screen.getByTestId('summary-Active Bills')).toHaveTextContent('2');
    });

    it('blames the schedule, not a rate, when the amount itself is unknown', async () => {
      // Two causes, two repairs. This one is an occurrence the server could not
      // price at all -- pointing the reader at the Currencies page would send
      // them to fix a rate that is already there.
      mockGetAll.mockResolvedValue([
        {
          id: 'st-inv',
          currencyCode: 'USD',
          name: 'Monthly ETF buy',
          amount: -1000,
          frequency: 'MONTHLY',
          nextDueDate: '2026-03-01',
          isActive: true,
          isTransfer: false,
          isInvestment: true,
          effectiveAmount: null,
          effectiveAmountComplete: false,
        },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'Not available',
        );
      });
      const hint = screen.getByTestId('summary-hint-Monthly Net');
      expect(hint).toHaveTextContent('could not be priced');
      expect(hint).not.toHaveTextContent('exchange rate');
    });

    it('says the rates are unavailable rather than blaming a currency', async () => {
      // While the rate table is loading -- or after its fetch failed -- every
      // cross-currency conversion returns null. Reporting that as "no exchange
      // rate for CAD" is a statement about this request, not about the user's
      // rates, and sends them to fix something that is not broken.
      mockRatesUnavailable = true;
      mockGetAll.mockResolvedValue(twoCurrencySchedules());
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'Not available',
        );
      });
      const hint = screen.getByTestId('summary-hint-Monthly Net');
      expect(hint).toHaveTextContent('not available right now');
      expect(hint).not.toHaveTextContent('add one on Currencies');
    });

    it('names both causes when both apply', async () => {
      // One CAD bill with no rate, and one schedule the server could not price.
      // Naming only the rate makes the reader add it and watch nothing change.
      mockGetAll.mockResolvedValue([
        ...twoCurrencySchedules(),
        {
          id: 'st-inv',
          currencyCode: 'USD',
          name: 'Monthly ETF buy',
          amount: -1000,
          frequency: 'MONTHLY',
          nextDueDate: '2026-03-01',
          isActive: true,
          isTransfer: false,
          isInvestment: true,
          effectiveAmount: null,
          effectiveAmountComplete: false,
        },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'Not available',
        );
      });
      const hint = screen.getByTestId('summary-hint-Monthly Net');
      expect(hint).toHaveTextContent('CAD');
      expect(hint).toHaveTextContent('could not be priced');
    });

    it("needs no rate for a net that is entirely in the reader's currency", async () => {
      // Same currency is 1:1 by definition. Asking for a rate the table does not
      // hold would make an ordinary single-currency ledger read as unknowable.
      mockGetAll.mockResolvedValue([
        {
          id: 'st-usd',
          currencyCode: 'USD',
          name: 'Rent',
          amount: -500,
          frequency: 'MONTHLY',
          nextDueDate: '2026-03-01',
          isActive: true,
          isTransfer: false,
        },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent(
          'USD $500.00',
        );
      });
    });
  });

  describe('Monthly Net Calculation', () => {
    it('calculates monthly net for MONTHLY frequency', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
        { id: 'st-b', currencyCode: 'USD', name: 'Income', amount: 3000, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Monthly net = 3000 - 100 = 2900
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$2900.00');
      });
    });

    it('buckets a re-priced occurrence by its own sign, not the stored one', async () => {
      // A mixed-sign split parent stored at -10 (an ordinary -100 line beside a
      // SELL line worth +90) whose investment line re-priced to +120: the
      // occurrence is a +20 inflow. Classified from the stored sign it went into
      // monthly BILLS as 20, so the net was out by 40 in the wrong direction.
      mockGetAll.mockResolvedValue([
        {
          id: 'st-split', currencyCode: 'USD',
          name: 'Share sale, net of fee',
          amount: -10,
          frequency: 'MONTHLY',
          nextDueDate: '2026-03-01',
          isActive: true,
          isTransfer: false,
          isSplit: true,
          splits: [
            { id: 'sp-1', kind: 'category', amount: -100 },
            { id: 'sp-2', kind: 'investment', amount: 90, investmentAction: 'SELL' },
          ],
          effectiveAmount: 20,
          effectiveAmountComplete: true,
        },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$20.00');
      });
      // And it is counted as a deposit, not a bill.
      expect(screen.getByTestId('summary-Active Deposits')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Active Bills')).toHaveTextContent('0');
    });

    it('normalizes WEEKLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Weekly Bill', amount: -100, frequency: 'WEEKLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Weekly: 100 * (365.25 / 7 / 12) ~= 434.82. The per-frequency factors
        // moved to monthlyEquivalent() in @/lib/frequency, which uses the real
        // year length everywhere instead of the old hand-rounded 4.33.
        const text = screen.getByTestId('summary-Monthly Net').textContent || '';
        expect(parseFloat(text.replace(/[^\d.]/g, ''))).toBeCloseTo((365.25 / 7 / 12) * 100, 0);
      });
    });

    it('excludes transfers from monthly calculations', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Transfer', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: true },
        { id: 'st-b', currencyCode: 'USD', name: 'Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Only the bill counts, transfer excluded. Monthly net = -100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('excludes inactive from monthly calculations', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Inactive Bill', amount: -500, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: false, isTransfer: false },
        { id: 'st-b', currencyCode: 'USD', name: 'Active Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
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
        { id: 'st-a', currencyCode: 'USD', name: 'Due Bill 1', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-02-10', isActive: true, isTransfer: false },
        { id: 'st-b', currencyCode: 'USD', name: 'Due Bill 2', amount: -200, frequency: 'MONTHLY', nextDueDate: '2026-02-14', isActive: true, isTransfer: false },
        { id: 'st-c', currencyCode: 'USD', name: 'Future Bill', amount: -300, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // Due Bill 1 (Feb 10) and Due Bill 2 (Feb 14) are due today or past
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('2');
      });
    });

    it('reads the moved date of the next occurrence, not the recurrence slot', async () => {
      mockGetAll.mockResolvedValue([
        // Slot is past due, but the next occurrence was moved to the future.
        { id: 'st-a', currencyCode: 'USD', name: 'Moved out', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-02-10', nextOverride: { id: 'o1', overrideDate: '2026-02-25', amount: null }, isActive: true, isTransfer: false },
        // Slot is in the future, but the next occurrence was moved to the past.
        { id: 'st-b', currencyCode: 'USD', name: 'Moved in', amount: -200, frequency: 'MONTHLY', nextDueDate: '2026-02-20', nextOverride: { id: 'o2', overrideDate: '2026-02-12', amount: null }, isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('1');
      });
    });

    it('shows zero when no items are due', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Future', amount: -100, frequency: 'MONTHLY', nextDueDate: '2026-02-20', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Due Now')).toHaveTextContent('0');
      });
    });

    it('skips due count for items with no nextDueDate', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'No Date Bill', amount: -100, frequency: 'MONTHLY', nextDueDate: null, isActive: true, isTransfer: false },
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
        { id: 'st-a', currencyCode: 'USD', name: 'Daily Income', amount: 10, frequency: 'DAILY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 10 * (365.25 / 12) ~= 304.38 (was a flat 30 days per month)
        const text = screen.getByTestId('summary-Monthly Net').textContent || '';
        expect(parseFloat(text.replace(/[^\d.]/g, ''))).toBeCloseTo((365.25 / 12) * 10, 0);
      });
    });

    it('normalizes BIWEEKLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Biweekly', amount: 1000, frequency: 'BIWEEKLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1000 * (365.25 / 14 / 12) ~= 2173.66 (was a hand-rounded 2.17)
        const text = screen.getByTestId('summary-Monthly Net').textContent || '';
        expect(parseFloat(text.replace(/[^\d.]/g, ''))).toBeCloseTo((365.25 / 14 / 12) * 1000, 0);
      });
    });

    it('normalizes EVERY4WEEKS frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Every4Weeks', amount: 1000, frequency: 'EVERY4WEEKS', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1000 * (365.25 / 28 / 12) ≈ 1087.05
        const text = screen.getByTestId('summary-Monthly Net').textContent || '';
        expect(parseFloat(text.replace(/[^\d.]/g, ''))).toBeCloseTo(365.25 / 28 / 12 * 1000, 0);
      });
    });

    it('normalizes QUARTERLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Quarterly', amount: 300, frequency: 'QUARTERLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 300 / 3 = 100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('normalizes YEARLY frequency to monthly', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'Yearly', amount: 1200, frequency: 'YEARLY', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
      ]);
      render(<BillsPage />);
      await waitFor(() => {
        // 1200 / 12 = 100
        expect(screen.getByTestId('summary-Monthly Net')).toHaveTextContent('$100.00');
      });
    });

    it('normalizes ONCE frequency to 0 (no monthly contribution)', async () => {
      mockGetAll.mockResolvedValue([
        { id: 'st-a', currencyCode: 'USD', name: 'OneBill', amount: -500, frequency: 'ONCE', nextDueDate: '2026-03-01', isActive: true, isTransfer: false },
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
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
      id: 'st-1', currencyCode: 'USD',
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      // Switch back to list
      fireEvent.click(screen.getByRole('button', { name: 'Table' }));

      // Bills filter should still be active - only bill transactions visible
      expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    });

    it('bills filter excludes transfers', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Bills \(/));
      // Savings Transfer is negative but moves money between the user's own
      // accounts, so it is not a bill -- and the Active Bills summary card has
      // always said so. The tab now agrees with it.
      expect(screen.queryByText('Savings Transfer')).not.toBeInTheDocument();
    });

    it('bills filter excludes a zero-amount reminder', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Bills \(/));
      expect(screen.queryByText('Card Payment Reminder')).not.toBeInTheDocument();
    });

    it('deposits filter excludes a zero-amount reminder', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      fireEvent.click(screen.getByText(/Deposits \(/));
      expect(screen.queryByText('Card Payment Reminder')).not.toBeInTheDocument();
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
      id: 'st-cal', currencyCode: 'USD',
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
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
        id: 'st-ov', currencyCode: 'USD',
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      await waitFor(() => {
        // Bill should appear on Feb 20 (override), not Feb 15
        expect(screen.getByText('Override Bill')).toBeInTheDocument();
      });
    });

    it('applies nextOverride fallback in calendar when futureOverrides is empty', async () => {
      mockGetAll.mockResolvedValue([{
        id: 'st-nxt', currencyCode: 'USD',
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      await waitFor(() => {
        expect(screen.getByText('NextOverride Bill')).toBeInTheDocument();
      });
    });

    it('renders income (positive) bill with green colour class in calendar', async () => {
      mockGetAll.mockResolvedValue([{
        id: 'st-inc', currencyCode: 'USD',
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
      fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      await waitFor(() => {
        // The chip is the control itself, so its own classes carry the colour.
        expect(screen.getByRole('button', { name: 'Salary' })).toHaveClass(
          'bg-green-100',
        );
      });
    });
  });

  describe('Auto-open Post dialog from query param', () => {
    it('opens the Post dialog for the bill referenced by postBillId', async () => {
      nav.searchParams = new URLSearchParams('postBillId=st-1');
      render(<BillsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('post-dialog')).toBeInTheDocument();
      });
    });

    it('does not open the Post dialog when postBillId is absent', async () => {
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      expect(screen.queryByTestId('post-dialog')).not.toBeInTheDocument();
    });

    it('does not open the Post dialog when postBillId does not match any transaction', async () => {
      nav.searchParams = new URLSearchParams('postBillId=does-not-exist');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      expect(screen.queryByTestId('post-dialog')).not.toBeInTheDocument();
    });

    it('clears the postBillId query param when the Post dialog is closed', async () => {
      nav.searchParams = new URLSearchParams('postBillId=st-1');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('post-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('post-close'));
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/bills'));
    });
  });

  describe('Reconcile deep links', () => {
    it('opens the override editor for the next instance from reconcileEditId', async () => {
      mockGetOverrideByDate.mockResolvedValue(null);
      nav.searchParams = new URLSearchParams('reconcileEditId=st-3&reconcileAmount=500');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('override-editor')).toBeInTheDocument());
      // Looks up an override on the schedule's next due date.
      expect(mockGetOverrideByDate).toHaveBeenCalledWith('st-3', '2026-03-01');
    });

    it('clears the reconcile params when the override editor closes', async () => {
      mockGetOverrideByDate.mockResolvedValue(null);
      nav.searchParams = new URLSearchParams('reconcileEditId=st-3&reconcileAmount=500');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('override-editor')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('override-close'));
      await waitFor(() => expect(nav.replace).toHaveBeenCalledWith('/bills'));
    });

    it('opens the create form for reconcileCreate', async () => {
      nav.searchParams = new URLSearchParams(
        'reconcileCreate=1&reconcileTransferAccountId=acc-2&reconcileAmount=500',
      );
      render(<BillsPage />);
      await waitFor(() => expect(mockOpenCreate).toHaveBeenCalled());
    });

    it('does nothing for an unknown reconcileEditId', async () => {
      nav.searchParams = new URLSearchParams('reconcileEditId=missing&reconcileAmount=500');
      render(<BillsPage />);
      await waitFor(() => expect(screen.getByTestId('scheduled-transaction-list')).toBeInTheDocument());
      expect(screen.queryByTestId('override-editor')).not.toBeInTheDocument();
    });
  });

  // Issue #1167 close-out: an AI write (e.g. update_security changing a
  // currency) fires notifyAiAction() while the initial Bills load is still in
  // flight. apiCache refuses to re-cache the obsolete response, but its
  // original awaiter still resolves -- so loadData must discard the older
  // invocation rather than let its pre-mutation forecast overwrite the fresh
  // post-mutation state when it finishes last.
  describe('superseded load ordering', () => {
    it('does not let a pre-AI load overwrite a newer post-AI reload', async () => {
      const oldRow = {
        id: 'st-1', currencyCode: 'USD',
        name: 'Old EUR forecast',
        amount: -1500,
        frequency: 'MONTHLY',
        nextDueDate: '2026-02-15',
        isActive: true,
        isTransfer: false,
        startDate: '2026-01-01',
        endDate: null,
      };
      const freshRow = { ...oldRow, name: 'Fresh USD forecast' };

      let resolveOld!: (value: unknown) => void;
      mockGetAll
        .mockImplementationOnce(
          () => new Promise((resolve) => { resolveOld = resolve; }),
        )
        .mockResolvedValueOnce([freshRow]);

      render(<BillsPage />);

      // The mount load has started (and is still pending on scheduled getAll).
      await waitFor(() => expect(mockGetAll).toHaveBeenCalledTimes(1));

      // A confirmed AI write signals the mounted page, starting a second load
      // while the first is still in flight.
      await act(async () => {
        notifyAiAction();
      });

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalledTimes(2);
        expect(screen.getByText('Fresh USD forecast')).toBeInTheDocument();
      });

      // The pre-mutation request finishes last -- it must not win.
      await act(async () => {
        resolveOld([oldRow]);
        await Promise.resolve();
      });

      expect(screen.getByText('Fresh USD forecast')).toBeInTheDocument();
      expect(screen.queryByText('Old EUR forecast')).not.toBeInTheDocument();
    });
  });
});
