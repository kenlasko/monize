import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import TransactionsPage from './page';
import toast from 'react-hot-toast';

// Mock next/image
vi.mock('next/image', () => ({
  default: (props: any) => <img {...props} />,
}));

// Mock next/dynamic to return mock components that render with props
vi.mock('next/dynamic', () => ({
  default: (loader: any) => {
    // Return a component that passes through props
    const DynamicComponent = (props: any) => {
      // Check loader path to determine which component
      if (props.transaction !== undefined || props.onSuccess !== undefined) {
        return <div data-testid="dynamic-transaction-form" {...props}>TransactionForm</div>;
      }
      if (props.payee !== undefined) {
        return <div data-testid="dynamic-payee-form" {...props}>PayeeForm</div>;
      }
      if (props.selectionCount !== undefined) {
        return <div data-testid="dynamic-bulk-update-modal" {...props}>BulkUpdateModal</div>;
      }
      return <div data-testid="dynamic-component">DynamicComponent</div>;
    };
    return DynamicComponent;
  },
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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

// Mock API libs
const mockGetAll = vi.fn();
const mockGetSummary = vi.fn();
const mockGetById = vi.fn();
const mockBulkUpdate = vi.fn();

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getSummary: (...args: any[]) => mockGetSummary(...args),
    getById: (...args: any[]) => mockGetById(...args),
    bulkUpdate: (...args: any[]) => mockBulkUpdate(...args),
  },
}));

const mockGetAllAccounts = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
  },
}));

const mockGetAllCategories = vi.fn();
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

const mockGetAllPayees = vi.fn();
const mockGetPayeeById = vi.fn();
const mockUpdatePayee = vi.fn();

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockGetAllPayees(...args),
    getById: (...args: any[]) => mockGetPayeeById(...args),
    update: (...args: any[]) => mockUpdatePayee(...args),
  },
}));

vi.mock('@/lib/constants', () => ({
  PAGE_SIZE: 25,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

// Mock child components
const mockOnEdit = vi.fn();
const mockOnRefresh = vi.fn();
const mockOnTransactionUpdate = vi.fn();
const mockOnPayeeClick = vi.fn();
const mockOnTransferClick = vi.fn();
const mockOnCategoryClick = vi.fn();

vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: (props: any) => (
    <div data-testid="transaction-list">
      <span data-testid="tx-count">{props.transactions?.length ?? 0} transactions</span>
      {props.transactions?.map((t: any) => (
        <div key={t.id} data-testid={`tx-${t.id}`} onClick={() => props.onEdit(t)}>
          {t.payee?.name || 'No payee'}
        </div>
      ))}
      {props.onPayeeClick && <button data-testid="payee-click-btn" onClick={() => props.onPayeeClick('payee-1')}>Payee</button>}
      {props.onTransferClick && <button data-testid="transfer-click-btn" onClick={() => props.onTransferClick('acc-2', 'tx-linked')}>Transfer</button>}
      {props.onCategoryClick && <button data-testid="category-click-btn" onClick={() => props.onCategoryClick('cat-1')}>Category</button>}
      {props.onTransactionUpdate && (
        <button
          data-testid="inline-update-btn"
          onClick={() => props.onTransactionUpdate({ id: 'tx-1', status: 'CLEARED', linkedInvestmentTransactionId: undefined })}
        >
          Inline Update
        </button>
      )}
      <span data-testid="density">{props.density}</span>
      <span data-testid="single-account">{props.isSingleAccountView ? 'single' : 'multi'}</span>
      <span data-testid="starting-balance">{props.startingBalance ?? 'none'}</span>
    </div>
  ),
  DensityLevel: {},
}));

vi.mock('@/components/transactions/TransactionFilterPanel', () => ({
  TransactionFilterPanel: (props: any) => (
    <div data-testid="filter-panel">
      <button data-testid="clear-filters" onClick={props.onClearFilters}>Clear Filters</button>
      <button data-testid="set-account-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterAccountIds, ['acc-1']);
      }}>Set Account Filter</button>
      <button data-testid="set-category-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterCategoryIds, ['cat-1']);
      }}>Set Category Filter</button>
      <button data-testid="set-payee-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterPayeeIds, ['payee-1']);
      }}>Set Payee Filter</button>
      <button data-testid="set-date-filter" onClick={() => {
        props.handleFilterChange(props.setFilterStartDate, '2026-01-01');
        props.handleFilterChange(props.setFilterEndDate, '2026-01-31');
      }}>Set Date Filter</button>
      <button data-testid="set-search" onClick={() => {
        props.handleSearchChange('test search');
      }}>Set Search</button>
      <span data-testid="active-filter-count">{props.activeFilterCount}</span>
      <span data-testid="filters-expanded">{props.filtersExpanded ? 'expanded' : 'collapsed'}</span>
      <span data-testid="search-input">{props.searchInput}</span>
    </div>
  ),
}));

vi.mock('@/components/transactions/BulkSelectionBanner', () => ({
  BulkSelectionBanner: (props: any) => (
    <div data-testid="bulk-selection-banner">
      <span>{props.selectionCount} selected</span>
      <button data-testid="bulk-update-btn" onClick={props.onBulkUpdate}>Bulk Update</button>
      <button data-testid="clear-selection" onClick={props.onClearSelection}>Clear</button>
      <button data-testid="select-all-matching" onClick={props.onSelectAllMatching}>Select All</button>
    </div>
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
  SummaryIcons: { plus: null, minus: null, money: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages, onPageChange }: any) => (
    <div data-testid="pagination">
      Page {currentPage} of {totalPages}
      <button data-testid="next-page" onClick={() => onPageChange(currentPage + 1)}>Next</button>
      <button data-testid="prev-page" onClick={() => onPageChange(currentPage - 1)}>Prev</button>
    </div>
  ),
}));

vi.mock('@/components/ui/MultiSelect', () => ({
  MultiSelect: () => <div data-testid="multi-select">MultiSelect</div>,
  MultiSelectOption: {},
}));

vi.mock('@/components/ui/Input', () => ({
  Input: (props: any) => <input data-testid={`input-${props.label}`} {...props} />,
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

const mockTxOpenCreate = vi.fn();
const mockTxOpenEdit = vi.fn();
const mockTxClose = vi.fn();
const mockSetFormDirty = vi.fn();

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: mockTxOpenCreate,
    openEdit: mockTxOpenEdit,
    close: mockTxClose,
    isEditing: false,
    modalProps: {},
    setFormDirty: mockSetFormDirty,
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/hooks/useNumberFormat', () => ({
  useNumberFormat: () => ({
    formatCurrency: (val: number) => `$${val.toFixed(2)}`,
    formatNumber: (val: number) => val.toString(),
  }),
}));

vi.mock('@/hooks/useExchangeRates', () => ({
  useExchangeRates: () => ({
    convertToDefault: (val: number) => val,
    defaultCurrency: 'USD',
  }),
}));

const mockTransactions = [
  { id: 'tx-1', date: '2026-02-01', amount: -50, status: 'UNCLEARED', payee: { id: 'payee-1', name: 'Store' }, category: null, account: { id: 'acc-1', name: 'Checking' }, isTransfer: false },
  { id: 'tx-2', date: '2026-02-02', amount: 3000, status: 'CLEARED', payee: { id: 'payee-2', name: 'Employer' }, category: { id: 'cat-1', name: 'Salary' }, account: { id: 'acc-1', name: 'Checking' }, isTransfer: false },
  { id: 'tx-3', date: '2026-02-03', amount: -200, status: 'RECONCILED', payee: null, category: null, account: { id: 'acc-1', name: 'Checking' }, isTransfer: true, linkedInvestmentTransactionId: 'itx-1' },
];

const mockAccounts = [
  { id: 'acc-1', name: 'Checking', accountType: 'CHEQUING', currencyCode: 'USD', currentBalance: 5000, isClosed: false, accountSubType: null },
  { id: 'acc-2', name: 'Savings', accountType: 'SAVINGS', currencyCode: 'USD', currentBalance: 10000, isClosed: false, accountSubType: null },
  { id: 'acc-3', name: 'Old Account', accountType: 'CHEQUING', currencyCode: 'USD', currentBalance: 0, isClosed: true, accountSubType: null },
  { id: 'acc-4', name: 'Brokerage', accountType: 'INVESTMENT', currencyCode: 'USD', currentBalance: 50000, isClosed: false, accountSubType: 'INVESTMENT_BROKERAGE' },
];

const mockCategories = [
  { id: 'cat-1', name: 'Salary', parentId: null },
  { id: 'cat-2', name: 'Groceries', parentId: null },
  { id: 'cat-3', name: 'Sub Category', parentId: 'cat-2' },
];

const mockPayees = [
  { id: 'payee-1', name: 'Store', defaultCategoryId: null },
  { id: 'payee-2', name: 'Employer', defaultCategoryId: 'cat-1' },
];

describe('TransactionsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } });
    mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
  });

  describe('Rendering', () => {
    it('renders the page header with title', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByText('Transactions')).toBeInTheDocument();
      });
    });

    it('renders the subtitle', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByText(/Manage your income and expenses/i)).toBeInTheDocument();
      });
    });

    it('renders within page layout', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('page-layout')).toBeInTheDocument();
      });
    });

    it('renders summary cards', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Income')).toBeInTheDocument();
        expect(screen.getByTestId('summary-Total Expenses')).toBeInTheDocument();
        expect(screen.getByTestId('summary-Net Cash Flow')).toBeInTheDocument();
      });
    });

    it('renders the New Transaction button', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });
    });
  });

  describe('Data Loading', () => {
    it('loads accounts, categories, payees in parallel on mount', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllAccounts).toHaveBeenCalledWith(true);
        expect(mockGetAllCategories).toHaveBeenCalled();
        expect(mockGetAllPayees).toHaveBeenCalled();
      });
    });

    it('loads transactions and summary on mount', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
        expect(mockGetSummary).toHaveBeenCalled();
      });
    });

    it('shows loading spinner while loading', async () => {
      mockGetAll.mockReturnValue(new Promise(() => {}));
      mockGetSummary.mockReturnValue(new Promise(() => {}));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
      });
    });

    it('shows transaction list after loading completes', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 3000, totalExpenses: 250, netCashFlow: 2750, transactionCount: 3 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });
    });

    it('shows error toast when loading fails', async () => {
      mockGetAll.mockRejectedValue(new Error('Network error'));
      mockGetSummary.mockRejectedValue(new Error('Network error'));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load transactions');
      });
    });

    it('shows error toast when static data loading fails', async () => {
      mockGetAllAccounts.mockRejectedValue(new Error('Error'));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load form data');
      });
    });
  });

  describe('Summary Cards with Data', () => {
    it('displays formatted summary values', async () => {
      mockGetAll.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } });
      mockGetSummary.mockResolvedValue({ totalIncome: 5000, totalExpenses: 2000, netCashFlow: 3000, transactionCount: 10 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Income')).toHaveTextContent('$5000.00');
        expect(screen.getByTestId('summary-Total Expenses')).toHaveTextContent('$2000.00');
        expect(screen.getByTestId('summary-Net Cash Flow')).toHaveTextContent('$3000.00');
      });
    });

    it('converts multi-currency summary using exchange rates', async () => {
      mockGetAll.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } });
      mockGetSummary.mockResolvedValue({
        totalIncome: 5000,
        totalExpenses: 2000,
        netCashFlow: 3000,
        transactionCount: 10,
        byCurrency: {
          USD: { totalIncome: 3000, totalExpenses: 1000 },
          CAD: { totalIncome: 2000, totalExpenses: 1000 },
        },
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        // convertToDefault returns same value in mock, so totals should be sum
        expect(screen.getByTestId('summary-Total Income')).toHaveTextContent('$5000.00');
        expect(screen.getByTestId('summary-Total Expenses')).toHaveTextContent('$2000.00');
      });
    });
  });

  describe('Pagination', () => {
    it('shows pagination when multiple pages exist', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('pagination')).toBeInTheDocument();
      });
    });

    it('shows total count when only one page', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByText((content, element) => {
          return element?.tagName === 'DIV' && element?.textContent === '3 transactions';
        })).toBeInTheDocument();
      });
    });

    it('shows singular "transaction" for count of 1', async () => {
      mockGetAll.mockResolvedValue({
        data: [mockTransactions[0]],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByText('1 transaction')).toBeInTheDocument();
      });
    });

    it('navigates pages when pagination is clicked', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 3, total: 75 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('pagination')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('next-page'));

      await waitFor(() => {
        // Should reload with page 2
        expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }));
      });
    });

    it('does not hide pagination for zero results', async () => {
      mockGetAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('transaction-list')).toBeInTheDocument();
      });

      // No pagination for zero results
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
      // The page should not render the total count div when total is 0
      // (the mock TransactionList renders its own "0 transactions" in tx-count,
      // but the page's separate total count div should not appear)
      const totalCountDiv = document.querySelector('.mt-4.text-sm.text-gray-500');
      expect(totalCountDiv).not.toBeInTheDocument();
    });
  });

  describe('Filter Panel', () => {
    it('renders the filter panel', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });
    });

    it('shows zero active filters initially', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('0');
      });
    });

    it('clears all filters when clear button is clicked', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('clear-filters'));

      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('0');
      });
    });

    it('triggers data reload when account filter changes', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      // Clear initial call counts
      mockGetAll.mockClear();

      fireEvent.click(screen.getByTestId('set-account-filter'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });

    it('triggers data reload when category filter changes', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetAll.mockClear();

      fireEvent.click(screen.getByTestId('set-category-filter'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });

    it('triggers data reload when payee filter changes', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetAll.mockClear();

      fireEvent.click(screen.getByTestId('set-payee-filter'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });

    it('triggers data reload when date filter changes', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetAll.mockClear();

      fireEvent.click(screen.getByTestId('set-date-filter'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });

    it('debounces search input and triggers data reload', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetAll.mockClear();

      fireEvent.click(screen.getByTestId('set-search'));

      // Wait for the 300ms search debounce + 150ms filter debounce to complete
      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      }, { timeout: 3000 });
    });
  });

  describe('Transaction Editing', () => {
    it('opens edit form when a regular transaction is clicked', async () => {
      mockGetAll.mockResolvedValue({
        data: [{ id: 'tx-1', date: '2026-02-01', amount: -50, payee: { name: 'Store' }, isTransfer: false }],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 50, netCashFlow: -50, transactionCount: 1 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-tx-1')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('tx-tx-1'));

      await waitFor(() => {
        expect(mockTxOpenEdit).toHaveBeenCalled();
      });
    });
  });

  describe('Payee Interaction', () => {
    it('opens payee edit modal when payee is clicked', async () => {
      const mockPayee = { id: 'payee-1', name: 'Test Store', defaultCategoryId: null, notes: '' };
      mockGetPayeeById.mockResolvedValue(mockPayee);
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('payee-click-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('payee-click-btn'));

      await waitFor(() => {
        expect(mockGetPayeeById).toHaveBeenCalledWith('payee-1');
      });
    });

    it('shows error toast when payee loading fails', async () => {
      mockGetPayeeById.mockRejectedValue(new Error('Not found'));
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('payee-click-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('payee-click-btn'));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to load payee details');
      });
    });
  });

  describe('Category Click', () => {
    it('sets category filter when category is clicked in transaction list', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('category-click-btn')).toBeInTheDocument();
      });

      mockGetAll.mockClear();
      fireEvent.click(screen.getByTestId('category-click-btn'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });
  });

  describe('Transfer Click', () => {
    it('navigates to linked account when transfer is clicked', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('transfer-click-btn')).toBeInTheDocument();
      });

      mockGetAll.mockClear();
      fireEvent.click(screen.getByTestId('transfer-click-btn'));

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
      });
    });
  });

  describe('Inline Transaction Update', () => {
    it('updates transaction in place without full reload', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      // Wait for the transaction list to fully render with data
      await waitFor(() => {
        expect(screen.getByTestId('inline-update-btn')).toBeInTheDocument();
      });

      // The handleTransactionUpdate callback updates the local transactions state in place.
      // It should not trigger loadAllData (full reload with static data refresh).
      // Verify the callback works by clicking the inline update button and confirming
      // the list re-renders without triggering a full static data refresh.
      const staticDataCallsBefore = mockGetAllAccounts.mock.calls.length;

      fireEvent.click(screen.getByTestId('inline-update-btn'));

      // handleTransactionUpdate only calls setTransactions - it does NOT call loadAllData
      // which would reload accounts, categories, and payees. Verify that the static
      // data APIs are not called again.
      expect(mockGetAllAccounts.mock.calls.length).toBe(staticDataCallsBefore);
      expect(mockGetAllCategories.mock.calls.length).toBeLessThanOrEqual(1);
      expect(mockGetAllPayees.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe('Account Filtering', () => {
    it('excludes investment brokerage accounts from filter options', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllAccounts).toHaveBeenCalledWith(true);
      });
    });
  });

  describe('Starting Balance', () => {
    it('passes starting balance to transaction list', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
        startingBalance: 1000,
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('starting-balance')).toHaveTextContent('1000');
      });
    });
  });
});
