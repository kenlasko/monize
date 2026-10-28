import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import TransactionsPage from './page';
import { TRANSACTION_SORT_STORAGE_KEY } from '@/lib/transaction-sort';
import { useDensityStore } from '@/store/densityStore';

// The global setup mock builds a fresh router per call, so pushes cannot be
// observed. This one keeps a stable `push` for the navigation assertions.
const mockPush = vi.fn();
// The query string the page starts from. Empty for every test but the ones
// that need a single account's register; reset in the top-level `beforeEach`.
const mockSearchParams = { value: '' };
vi.mock('next/navigation', () => {
  // One stable object, as the real hook returns. A fresh router per call makes
  // every `useCallback([router])` change identity each render, and this page's
  // filter effect depends on one of those -- so it re-ran on every render,
  // re-fetched, set state, and looped. See the note in `src/test/setup.ts`.
  // Built on first use rather than here: the factory is hoisted above
  // `mockPush`'s declaration, so reading it eagerly is a temporal-dead-zone
  // error.
  let router: ReturnType<typeof buildRouter> | null = null;
  const buildRouter = () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  });
  return {
    useRouter: () => (router ??= buildRouter()),
    usePathname: () => '/transactions',
    // Empty unless a test sets it. The page reads the account filter from the
    // URL, so this is the only way to render it as a single account's
    // register, which is the state that draws the Balance column.
    useSearchParams: () => new URLSearchParams(mockSearchParams.value),
  };
});

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Mock next/dynamic to return mock components that render with props
vi.mock('next/dynamic', () => ({
  default: (_loader: any) => {
    // Return a component that passes through props
    const DynamicComponent = (props: any) => {
      // Check loader path to determine which component
      if (props.transaction !== undefined || props.onSuccess !== undefined) {
        return (
          <div data-testid="dynamic-transaction-form">
            TransactionForm
            {props.onAddWarranty && (
              <button data-testid="form-add-warranty" onClick={() => props.onAddWarranty(props.transaction)}>
                Form add warranty
              </button>
            )}
            {props.onAddWarrantyAfterCreate && (
              <button data-testid="form-add-warranty-after-create" onClick={() => props.onAddWarrantyAfterCreate({ id: 'tx-new' })}>
                Form add warranty after create
              </button>
            )}
            {props.onOpenWarranty && (
              <button data-testid="form-open-warranty" onClick={() => props.onOpenWarranty('w-9')}>
                Form open warranty
              </button>
            )}
            {props.onDirtyChange && (
              <button data-testid="form-make-dirty" onClick={() => props.onDirtyChange(true)}>
                Make dirty
              </button>
            )}
          </div>
        );
      }
      if (props.payee !== undefined) {
        return <div data-testid="dynamic-payee-form">PayeeForm</div>;
      }
      if (props.selectionCount !== undefined) {
        return (
          <div data-testid="dynamic-bulk-update-modal">
            BulkUpdateModal
            {props.isOpen && (
              <button
                data-testid="bulk-modal-submit"
                onClick={() => props.onSubmit({ categoryId: 'cat-1' })}
              >
                Submit Bulk Update
              </button>
            )}
          </div>
        );
      }
      // Chart components all receive `data` + `isLoading`; distinguish by their
      // unique click handlers / currency code prop.
      // Every chart the page draws is handed `onCollapse`; the mocks expose it
      // as the header button the real cards draw.
      const hideButton = props.onCollapse ? (
        <button type="button" onClick={props.onCollapse}>Hide chart</button>
      ) : null;
      if (props.onMonthClick !== undefined) {
        return (
          <div data-testid="chart-monthly-totals">
            <span data-testid="chart-monthly-totals-filter-label">
              {props.filterLabel ?? ''}
            </span>
            {hideButton}
          </div>
        );
      }
      if (props.onAccountClick !== undefined) {
        return (
          <div data-testid="chart-account-balances">
            {Array.isArray(props.data) && props.data.map((a: any) => (
              <span key={a.accountId} data-testid={`chart-account-${a.accountId}`}>
                {a.accountName}:{a.balance}
              </span>
            ))}
            {hideButton}
          </div>
        );
      }
      if (props.currencyCode !== undefined || Array.isArray(props.data)) {
        return (
          <div data-testid="chart-balance-history">
            <span data-testid="chart-balance-history-account-name">
              {props.accountName ?? ''}
            </span>
            {hideButton}
          </div>
        );
      }
      // The calendar is loaded through `dynamic()`, and it too draws the
      // switch -- at the right-hand end of its own toolbar row.
      return (
        <div data-testid="dynamic-component">
          DynamicComponent
          {props.viewToggle}
        </div>
      );
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

// Mock auth store. `mockActing` is who the reader is acting as; a delegate
// test sets it and the top-level `beforeEach` puts it back.
const { mockActing } = vi.hoisted(() => ({
  mockActing: {
    actingAsUserId: null as string | null,
    delegateSections: null as Record<string, boolean> | null,
  },
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
        actingAsUserId: mockActing.actingAsUserId,
        delegateSections: mockActing.delegateSections,
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

// Mock preferences store. `mockPreferences.value` is what the store answers
// with; a test that needs another row (a hidden column) swaps it and puts it
// back.
const DEFAULT_MOCK_PREFERENCES = {
  twoFactorEnabled: true,
  theme: 'system',
  defaultCurrency: 'USD',
} as Record<string, unknown>;
const { mockPreferences } = vi.hoisted(() => ({
  mockPreferences: { value: undefined as Record<string, unknown> | undefined },
}));
vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { reportingBasis: 'cash', accrualEnabled: true, ...(mockPreferences.value ?? {
        twoFactorEnabled: true,
        theme: 'system',
        defaultCurrency: 'USD',
      }) },
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

// Mock API libs
const mockGetAll = vi.fn();
const mockGetSummary = vi.fn();
const mockGetById = vi.fn();
const mockBulkUpdate = vi.fn();
const mockGetMonthlyTotals = vi.fn();

vi.mock('@/lib/transactions', () => ({
  transactionsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    getSummary: (...args: any[]) => mockGetSummary(...args),
    getById: (...args: any[]) => mockGetById(...args),
    bulkUpdate: (...args: any[]) => mockBulkUpdate(...args),
    getMonthlyTotals: (...args: any[]) => mockGetMonthlyTotals(...args),
    // Used by the payee/category info widgets that mount on single-entity filters
    getGroupedTotals: vi.fn().mockResolvedValue([]),
    getRecurringCharges: vi.fn().mockResolvedValue([]),
    // The register marks rows overdue for reconciliation from this summary.
    // Default: no account has anything outstanding, so no row is marked.
    getStaleUnreconciled: vi.fn().mockResolvedValue({
      staleAfterDays: 45,
      overdueBefore: '2026-07-04',
      accounts: [],
      totalCount: 0,
    }),
  },
}));

const mockGetAllAccounts = vi.fn();
const mockGetDailyBalances = vi.fn();
vi.mock('@/lib/accounts', () => ({
  accountsApi: {
    getAll: (...args: any[]) => mockGetAllAccounts(...args),
    getDailyBalances: (...args: any[]) => mockGetDailyBalances(...args),
  },
}));

vi.mock('@/lib/institutions', () => ({
  institutionsApi: { getAll: vi.fn().mockResolvedValue([]) },
  institutionLogoUrl: (id: string) => `/api/v1/institutions/${id}/logo`,
}));

vi.mock('@/lib/scheduled-transactions', () => ({
  scheduledTransactionsApi: { getAll: vi.fn().mockResolvedValue([]) },
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
    // Used by the payee info widget that mounts on single-payee filters
    getAliases: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('@/lib/constants', () => ({
  PAGE_SIZE: 25,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
  showErrorToast: vi.fn(),
}));

const mockExportToCsv = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: any[]) => mockExportToCsv(...args),
}));

// Mock budgets API (used for category budget status indicators)
vi.mock('@/lib/budgets', () => ({
  budgetsApi: {
    getCategoryBudgetStatus: vi.fn().mockResolvedValue({}),
  },
}));

// Mock child components
vi.mock('@/components/transactions/TransactionList', () => ({
  TransactionList: (props: any) => (
    <div data-testid="transaction-list">
      {/* The Table / Calendar switch is the register's now, handed down by the
          page: a mock that dropped it would hide the only control this suite
          uses to change the view. */}
      {props.viewToggle}
      <span data-testid="tx-count">{props.transactions?.length ?? 0} transactions</span>
      {props.transactions?.map((t: any) => (
        <div key={t.id} data-testid={`tx-${t.id}`} onClick={() => props.onEdit(t)}>
          {t.payee?.name || 'No payee'}
          <span data-testid={`tx-${t.id}-attachments`}>{t.attachmentCount ?? 'none'}</span>
        </div>
      ))}
      {(props.onAddWarranty || props.onViewWarranties) && <span data-testid="row-warranty-actions" />}
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
      <span data-testid="sort">
        {props.sort ? `${props.sort.field}:${props.sort.direction}` : 'none'}
      </span>
      {/* The order the rows on screen were fetched in, which the register uses
          for every figure derived from them. It trails `sort` by a request. */}
      <span data-testid="rows-sort">
        {props.rowsSort ? `${props.rowsSort.field}:${props.rowsSort.direction}` : 'none'}
      </span>
      <span data-testid="balance-withheld">{props.startingBalanceWithheld ?? 'none'}</span>
      {props.onSortChange && (
        <button data-testid="sort-amount" onClick={() => props.onSortChange('amount')}>
          Sort by amount
        </button>
      )}
      {props.onSortChange && (
        <button data-testid="sort-date" onClick={() => props.onSortChange('date')}>
          Sort by date
        </button>
      )}
      {props.onSortChange && (
        <button data-testid="sort-payee" onClick={() => props.onSortChange('payee')}>
          Sort by payee
        </button>
      )}
      <span data-testid="selection-mode">{props.selectionMode ? 'on' : 'off'}</span>
      {props.onToggleSelection && (
        <button data-testid="select-tx-1" onClick={() => props.onToggleSelection('tx-1')}>
          Select tx-1
        </button>
      )}
      {props.onExport && (
        <button data-testid="export-btn" onClick={props.onExport} disabled={props.isExporting}>
          {props.isExporting ? 'Exporting...' : 'Export'}
        </button>
      )}
      <span data-testid="is-exporting">{props.isExporting ? 'true' : 'false'}</span>
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
      <button data-testid="set-two-account-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterAccountIds, ['acc-1', 'acc-2']);
      }}>Set Two Account Filter</button>
      <button data-testid="set-account-status-active" onClick={() => {
        props.setFilterAccountStatus('active');
      }}>Show Active Accounts</button>
      <button data-testid="set-account-status-closed" onClick={() => {
        props.setFilterAccountStatus('closed');
      }}>Show Closed Accounts</button>
      <button data-testid="set-category-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterCategoryIds, ['cat-1']);
      }}>Set Category Filter</button>
      <button data-testid="set-payee-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterPayeeIds, ['payee-1']);
      }}>Set Payee Filter</button>
      <button data-testid="set-many-long-categories" onClick={() => {
        props.handleArrayFilterChange(props.setFilterCategoryIds, ['long-cat-1', 'long-cat-2', 'long-cat-3']);
      }}>Set Many Long Categories</button>
      <button data-testid="set-single-cat-and-many-long-payees" onClick={() => {
        props.handleArrayFilterChange(props.setFilterCategoryIds, ['long-cat-1']);
        props.handleArrayFilterChange(props.setFilterPayeeIds, ['long-pay-1', 'long-pay-2', 'long-pay-3']);
      }}>Single Cat + Many Payees</button>
      <button data-testid="set-date-filter" onClick={() => {
        props.handleFilterChange(props.setFilterStartDate, '2026-01-01');
        props.handleFilterChange(props.setFilterEndDate, '2026-01-31');
      }}>Set Date Filter</button>
      <button data-testid="set-search" onClick={() => {
        props.handleSearchChange('test search');
      }}>Set Search</button>
      <button data-testid="set-amount-filter" onClick={() => {
        props.handleFilterChange(props.setFilterAmountFrom, '10');
        props.handleFilterChange(props.setFilterAmountTo, '100');
      }}>Set Amount Filter</button>
      <button data-testid="set-tag-filter" onClick={() => {
        props.handleArrayFilterChange(props.setFilterTagIds, ['tag-1']);
      }}>Set Tag Filter</button>
      <span data-testid="active-filter-count">{props.activeFilterCount}</span>
      <span data-testid="filters-expanded">{props.filtersExpanded ? 'expanded' : 'collapsed'}</span>
      <span data-testid="search-input">{props.searchInput}</span>
      <span data-testid="bulk-select-mode">{props.bulkSelectMode ? 'active' : 'inactive'}</span>
      {props.onToggleBulkSelectMode && (
        <button data-testid="toggle-bulk-select" onClick={props.onToggleBulkSelectMode}>
          {props.bulkSelectMode ? 'Cancel Bulk' : 'Bulk Update'}
        </button>
      )}
    </div>
  ),
}));

vi.mock('@/components/transactions/BulkSelectionBanner', () => ({
  BulkSelectionBanner: (props: any) => (
    <div data-testid="bulk-selection-banner">
      <span>{props.selectionCount} selected</span>
      <button data-testid="bulk-update-btn" onClick={props.onBulkUpdate}>Bulk Update</button>
      <button data-testid="bulk-delete-btn" onClick={props.onBulkDelete}>Delete</button>
      <button data-testid="clear-selection" onClick={props.onClearSelection}>Clear</button>
      <button data-testid="select-all-matching" onClick={props.onSelectAllMatching}>Select All</button>
    </div>
  ),
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, title, message }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <span>{message}</span>
        <button data-testid="confirm-delete" onClick={onConfirm}>Confirm</button>
        <button data-testid="cancel-delete" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: ({ isOpen, onSave, onDiscard, onCancel }: any) =>
    isOpen ? (
      <div data-testid="unsaved-dialog">
        <button data-testid="unsaved-save" onClick={onSave}>Save</button>
        <button data-testid="unsaved-discard" onClick={onDiscard}>Discard</button>
        <button data-testid="unsaved-cancel" onClick={onCancel}>Keep editing</button>
      </div>
    ) : null,
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

// A stub by default; a test that drives the edit window's close path (the
// unsaved-changes check) sets `mockRealFormModal.value` for the real hook.
const { mockRealFormModal } = vi.hoisted(() => ({ mockRealFormModal: { value: false } }));
vi.mock('@/hooks/useFormModal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useFormModal')>();
  return {
    useFormModal: () =>
      mockRealFormModal.value
        ? actual.useFormModal()
        : {
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
          },
  };
});

// Stateless by default, which is what almost every test here wants. The sort
// tests swap in a stateful implementation, because a click that cannot change
// the remembered value proves nothing about what the click does.
const mockUseLocalStorage = vi.fn((_key: string, defaultValue: any) => [defaultValue, vi.fn()]);
vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (...args: any[]) => (mockUseLocalStorage as any)(...args),
}));

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ dateFormat: 'browser', datePattern: 'YYYY-MM-DD',
    formatDate: (d: string) => d,
  }),
}));

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (val: number) => `$${val.toFixed(2)}`,
      formatNumber: (val: number) => val.toString(),
    }),
  };
});
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

// Long-named fixtures used to exercise the filename-length fallback in the
// Monthly Totals filter label (page.tsx `monthlyTotalsFilterLabel`). Three
// ~30-char names joined with ", " plus the "Monthly Totals - " prefix easily
// exceeds the 100-character threshold.
const mockLongCategories = [
  { id: 'long-cat-1', name: 'Food and Groceries and Restaurants', parentId: null },
  { id: 'long-cat-2', name: 'Transportation Expenses and Fuel', parentId: null },
  { id: 'long-cat-3', name: 'Health Insurance and Medical Costs', parentId: null },
];
const mockLongPayees = [
  { id: 'long-pay-1', name: 'Grocery Chain Supermarket Location One', defaultCategoryId: null },
  { id: 'long-pay-2', name: 'Grocery Chain Supermarket Location Two', defaultCategoryId: null },
  { id: 'long-pay-3', name: 'Grocery Chain Supermarket Location Three', defaultCategoryId: null },
];

// Every suite in this file starts as the owner with the stubbed form modal.
beforeEach(() => {
  mockActing.actingAsUserId = null;
  mockActing.delegateSections = null;
  mockRealFormModal.value = false;
});

describe('TransactionsPage', () => {
  beforeEach(() => {
    mockPreferences.value = undefined;
    mockSearchParams.value = '';
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue({ data: [], pagination: { page: 1, totalPages: 1, total: 0 } });
    mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockGetDailyBalances.mockResolvedValue([]);
    mockGetMonthlyTotals.mockResolvedValue([]);
  });

  it('requests recognition rows and opens their original parent transaction', async () => {
    mockPreferences.value = {defaultCurrency:'USD', reportingBasis:'accrual'};
    const row={...mockTransactions[0],id:'recognition',reportingProvenance:{readOnly:true,reportId:'recognition',sourceTransactionId:'parent',cashDate:'2026-02-01',effectiveDate:'2026-02-28',sourceAmount:'-600',nativeAmount:'-50'}};
    mockGetAll.mockResolvedValue({data:[row],pagination:{page:1,totalPages:1,total:1}});
    mockGetById.mockResolvedValue({...mockTransactions[0],id:'parent'});
    render(<TransactionsPage/>);
    await screen.findByTestId('tx-recognition');
    expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({basis:'accrual'}));
    expect(screen.queryByRole('button',{name:'Bulk Update'})).not.toBeInTheDocument();
    await act(async()=>fireEvent.click(screen.getByTestId('tx-recognition')));
    expect(mockGetById).toHaveBeenCalledWith('parent');
    expect(mockTxOpenEdit).toHaveBeenCalledWith(expect.objectContaining({id:'parent'}));
  });

  it('starts on page one when the basis changes without changing the saved preference', async () => {
    mockSearchParams.value='page=3';
    render(<TransactionsPage/>);
    await waitFor(()=>expect(mockGetAll).toHaveBeenCalledWith(expect.objectContaining({basis:'cash',page:3})));
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Accrual'})));
    await waitFor(()=>expect(mockGetAll).toHaveBeenLastCalledWith(expect.objectContaining({basis:'accrual',page:1})));
    expect(mockPreferences.value).toBeUndefined();
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

    it('renders the New Transaction button', async () => {
      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
      });
    });
  });

  describe('Table / Calendar', () => {
    /**
     * One test rather than three: the view is a persisted store, so a test that
     * leaves it on Calendar leaves it there for the next one. This ends where it
     * started, and the store is deliberately not imported here -- doing so
     * rehydrates it mid-render and the page updates outside act().
     */
    it('starts on the table, swaps the register for the calendar, and swaps back', async () => {
      await act(async () => {
        render(<TransactionsPage />);
      });
      await waitFor(() => expect(screen.getByTestId('transaction-list')).toBeInTheDocument());

      expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Calendar' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
      });

      await waitFor(() =>
        expect(screen.queryByTestId('transaction-list')).not.toBeInTheDocument(),
      );
      expect(screen.getByTestId('dynamic-component')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Table' }));
      });

      await waitFor(() => expect(screen.getByTestId('transaction-list')).toBeInTheDocument());
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

    it('loads transactions on mount', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAll).toHaveBeenCalled();
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
      const { showErrorToast } = await import('@/lib/errors');
      mockGetAll.mockRejectedValue(new Error('Network error'));
      mockGetSummary.mockRejectedValue(new Error('Network error'));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(showErrorToast).toHaveBeenCalledWith(expect.any(Error), 'Failed to load transactions');
      });
    });

    it('shows error toast when static data loading fails', async () => {
      const { showErrorToast } = await import('@/lib/errors');
      mockGetAllAccounts.mockRejectedValue(new Error('Error'));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(showErrorToast).toHaveBeenCalledWith(expect.any(Error), 'Failed to load form data');
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

    it('fetches monthly totals instead of daily balances when search filter is active', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetMonthlyTotals.mockClear();
      mockGetDailyBalances.mockClear();

      fireEvent.click(screen.getByTestId('set-search'));

      await waitFor(() => {
        expect(mockGetMonthlyTotals).toHaveBeenCalledWith(expect.objectContaining({basis:'cash'}));
      }, { timeout: 3000 });
    });
  });

  describe('Chart switching', () => {
    beforeEach(() => {
      // useTransactionFilters persists filter state to localStorage, which is
      // a shared mock across tests in this file. Clear it so each test starts
      // with no filters active.
      window.localStorage.clear();
    });

    it('renders Account Balances chart when no category/payee/tag filter is active and multiple accounts have transactions', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 5000, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 5200, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-account-balances')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-balance-history')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chart-monthly-totals')).not.toBeInTheDocument();
    });

    it('excludes zero-balance accounts from the Account Balances chart', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 5000, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 5200, accountId: 'acc-2', currencyCode: 'USD' },
        // acc-3's latest balance rounds to 0 at 4-decimal precision -- it must
        // be hidden even though it had an earlier non-zero balance.
        { date: '2026-02-01', balance: 800, accountId: 'acc-3', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 0, accountId: 'acc-3', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-account-balances')).toBeInTheDocument();
      });
      expect(screen.getByTestId('chart-account-acc-1')).toBeInTheDocument();
      expect(screen.getByTestId('chart-account-acc-2')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-account-acc-3')).not.toBeInTheDocument();
    });

    it('falls back to Balance History when filtering zeros leaves only one account', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
        // acc-2 has a zero balance throughout -- after filtering only acc-1
        // remains, so there is nothing to compare in a bar chart and we should
        // fall back to the single-account history view.
        { date: '2026-02-01', balance: 0, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 0, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-account-balances')).not.toBeInTheDocument();
    });

    it('keeps accounts whose balance is small but non-zero at 4-decimal precision', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        // 0.0001 is the smallest representable balance -- it must NOT be filtered.
        { date: '2026-02-01', balance: 0.0001, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 0.0001, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-account-balances')).toBeInTheDocument();
      });
      expect(screen.getByTestId('chart-account-acc-2')).toBeInTheDocument();
    });

    it('passes the latest-per-account balance and the account name to the Account Balances chart', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 5000, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 5200, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-account-balances')).toBeInTheDocument();
      });
      // Latest date per account wins, and the account name comes from the accounts state.
      expect(screen.getByTestId('chart-account-acc-1')).toHaveTextContent('Checking:1500');
      expect(screen.getByTestId('chart-account-acc-2')).toHaveTextContent('Savings:5200');
    });

    it('renders Balance History chart when only one account has transactions', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-account-balances')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chart-monthly-totals')).not.toBeInTheDocument();
    });

    it('renders Balance History chart when there are no daily balance rows', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-account-balances')).not.toBeInTheDocument();
    });

    it('shows the zero-balance banner when multiple accounts all have a zero balance', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      // Two accounts, each ending at a zero balance (e.g. closed accounts).
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 500, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 0, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 300, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 0, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-zero-balances')).toBeInTheDocument();
      });
      // Neither the bar chart nor the line chart is shown for the all-zero case.
      expect(screen.queryByTestId('chart-account-balances')).not.toBeInTheDocument();
      expect(screen.queryByTestId('chart-balance-history')).not.toBeInTheDocument();
    });

    it('requests all-time daily balances when no start-date filter is set', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetDailyBalances).toHaveBeenCalled();
      });

      const callArgs = mockGetDailyBalances.mock.calls.at(-1)?.[0];
      expect(callArgs?.allTime).toBe(true);
      expect(callArgs?.startDate).toBeUndefined();
    });

    it('forwards the Show Accounts filter (active) to the daily-balances chart query', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetDailyBalances.mockClear();
      fireEvent.click(screen.getByTestId('set-account-status-active'));

      await waitFor(() => {
        expect(mockGetDailyBalances).toHaveBeenCalled();
      });

      // Non-brokerage active accounts in the mock are acc-1 and acc-2.
      // acc-3 is closed and acc-4 is a brokerage account (excluded from the
      // transactions filter). The chart query must receive the same account
      // list the transaction list uses so the Account Balances chart only
      // shows accounts the transaction list is actually showing.
      const callArgs = mockGetDailyBalances.mock.calls.at(-1)?.[0];
      expect(callArgs).toBeDefined();
      const accountIds = (callArgs.accountIds as string).split(',').sort();
      expect(accountIds).toEqual(['acc-1', 'acc-2']);
    });

    it('forwards the Show Accounts filter (closed) to the daily-balances chart query', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      mockGetDailyBalances.mockClear();
      fireEvent.click(screen.getByTestId('set-account-status-closed'));

      await waitFor(() => {
        expect(mockGetDailyBalances).toHaveBeenCalled();
      });

      const callArgs = mockGetDailyBalances.mock.calls.at(-1)?.[0];
      expect(callArgs).toBeDefined();
      expect((callArgs.accountIds as string).split(',')).toEqual(['acc-3']);
    });

    it('excludes brokerage accounts from the chart query when no Show Accounts filter is set (All)', async () => {
      // Regression: previously the chart fell back to accountIds=undefined
      // when the Active/Closed/All toggle was on "All", which let the daily
      // balances API include brokerage accounts. The Account Balances chart
      // should never surface brokerage accounts here -- they're only
      // actionable from the Investments page.
      mockGetAllAccounts.mockResolvedValue(mockAccounts);

      render(<TransactionsPage />);

      // Wait until the filter panel shows -- that's our signal that accounts
      // have loaded and filteredAccounts is populated, so the subsequent
      // loadTransactions re-run has the real account list to work with.
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      await waitFor(() => {
        const latest = mockGetDailyBalances.mock.calls.at(-1)?.[0];
        expect(latest?.accountIds).toBeDefined();
      });

      const callArgs = mockGetDailyBalances.mock.calls.at(-1)?.[0];
      const accountIds = (callArgs.accountIds as string).split(',').sort();
      // acc-4 is a brokerage account in the mock fixtures and must not appear.
      expect(accountIds).not.toContain('acc-4');
      // All non-brokerage accounts (active + closed) should be requested.
      expect(accountIds).toEqual(['acc-1', 'acc-2', 'acc-3']);
    });

    it('forwards a filter label to Monthly Totals chart built from selected category/payee/tag names', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-category-filter'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      });
      // The mock's set-category-filter picks cat-1 (Salary), so the filter label
      // should surface that name so the download filename describes the chart.
      expect(screen.getByTestId('chart-monthly-totals-filter-label')).toHaveTextContent('Salary');
    });

    it('collapses multi-selections to "multiple X" when the filename would exceed 100 chars', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockLongCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-many-long-categories'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(
          screen.getByTestId('chart-monthly-totals-filter-label'),
        ).toHaveTextContent('multiple categories');
      });
      // The specific names must not leak through once we fall back.
      expect(
        screen.getByTestId('chart-monthly-totals-filter-label'),
      ).not.toHaveTextContent('Food and Groceries');
    });

    it('keeps single selections alongside "multiple X" fallbacks in the label', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockLongCategories);
      mockGetAllPayees.mockResolvedValue(mockLongPayees);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-single-cat-and-many-long-payees'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      });

      await waitFor(() => {
        const label = screen.getByTestId('chart-monthly-totals-filter-label');
        // Single category name is preserved, but the 3 long payees collapse.
        expect(label).toHaveTextContent('Food and Groceries and Restaurants');
        expect(label).toHaveTextContent('multiple payees');
        expect(label).not.toHaveTextContent('Grocery Chain Supermarket Location');
      });
    });

    it('keeps all specific names when the combined label fits within 100 chars', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      // set-category-filter picks cat-1 (Salary), set-payee-filter picks payee-1
      // (Store). Combined with the "Monthly Totals - " prefix this is ~30
      // chars, well under the 100-char threshold.
      fireEvent.click(screen.getByTestId('set-category-filter'));
      fireEvent.click(screen.getByTestId('set-payee-filter'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      });

      await waitFor(() => {
        const label = screen.getByTestId('chart-monthly-totals-filter-label');
        expect(label).toHaveTextContent('Salary');
        expect(label).toHaveTextContent('Store');
        expect(label).not.toHaveTextContent('multiple');
      });
    });

    it('includes the search term in the Monthly Totals filter label', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);
      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-search'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      }, { timeout: 3000 });

      await waitFor(() => {
        expect(
          screen.getByTestId('chart-monthly-totals-filter-label'),
        ).toHaveTextContent('"test search"');
      });
    });

    it('passes the single account name to the Balance History chart', async () => {
      // With only one account in the daily balances, the chart falls back to
      // Balance History. The account name should flow through so the download
      // filename describes which account is shown.
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('chart-balance-history-account-name'),
      ).toHaveTextContent('Checking');
    });

    it('does not pass an account name when the Balance History chart spans zero rows', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      // No data and no explicit account filter -- filename stays generic.
      expect(
        screen.getByTestId('chart-balance-history-account-name'),
      ).toHaveTextContent('');
    });

    it('renders Monthly Totals chart when a category filter is active, even with multiple accounts', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 5000, accountId: 'acc-2', currencyCode: 'USD' },
      ]);
      mockGetMonthlyTotals.mockResolvedValue([
        { month: '2026-02', total: -300, count: 5 },
      ]);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-category-filter'));

      await waitFor(() => {
        expect(screen.getByTestId('chart-monthly-totals')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-account-balances')).not.toBeInTheDocument();
    });
  });

  describe('Account Info Widget', () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it('shows the chart-derived current balance, not the stale account balance', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      // acc-1's stored currentBalance is 5000 (stale); the daily-balance
      // series — refetched whenever transactions change — ends at 1500.
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
      ]);

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-account-filter'));

      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });
      expect(screen.getByText('$1500.00')).toBeInTheDocument();
      expect(screen.queryByText('$5000.00')).not.toBeInTheDocument();
    });

    it('keeps the widget mounted and slides it out when the filter widens to two accounts', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      const rows = [
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 1500, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 5000, accountId: 'acc-2', currencyCode: 'USD' },
        { date: '2026-02-15', balance: 5200, accountId: 'acc-2', currencyCode: 'USD' },
      ];
      // Respect the accountIds chart param like the backend does, so the
      // single-account phase yields one account's series and the two-account
      // phase yields both.
      mockGetDailyBalances.mockImplementation((params?: { accountIds?: string }) => {
        const ids = params?.accountIds?.split(',');
        return Promise.resolve(ids ? rows.filter((r) => ids.includes(r.accountId)) : rows);
      });

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      // Narrow to one account: the widget is shown next to the history chart.
      fireEvent.click(screen.getByTestId('set-account-filter'));
      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });
      const widgetColumn = screen.getByText('Current Balance').closest('[aria-hidden]');
      expect(widgetColumn).toHaveAttribute('aria-hidden', 'false');

      // Widen to two accounts: the bar chart takes over and the widget stays
      // mounted but hidden, so its column can animate out of view.
      fireEvent.click(screen.getByTestId('set-two-account-filter'));
      await waitFor(() => {
        expect(screen.getByTestId('chart-account-balances')).toBeInTheDocument();
      });
      expect(screen.getByText('Current Balance')).toBeInTheDocument();
      expect(widgetColumn).toHaveAttribute('aria-hidden', 'true');
      expect(widgetColumn?.className).toContain('opacity-0');
      expect(widgetColumn?.className).toContain('pointer-events-none');

      // Narrow back down to one account: the same column slides back in.
      fireEvent.click(screen.getByTestId('set-account-filter'));
      await waitFor(() => {
        expect(widgetColumn).toHaveAttribute('aria-hidden', 'false');
      });
      expect(widgetColumn?.className).toContain('opacity-100');
    });

    it('switches to another account from the caret, keeping the Show Accounts toggle', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      // Show Closed accounts only, then narrow to the closed one. The status
      // toggle is the filter the caret must respect: switching goes through the
      // same command as the Accounts filter, so it survives the switch.
      fireEvent.click(screen.getByTestId('set-account-status-active'));
      fireEvent.click(screen.getByTestId('set-account-filter'));
      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });
      expect(screen.getByRole('heading', { name: 'Checking' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
      // Only the accounts the Active filter offers: the closed acc-3 and the
      // brokerage acc-4 are absent.
      expect(screen.getByRole('menuitem', { name: /Savings/ })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Old Account/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Brokerage/ })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: 'Savings' })).toBeInTheDocument();
      });
      // The list narrowed to the chosen account and the status toggle is
      // still Active: the persisted toggle would read '""' had it been reset.
      await waitFor(() => {
        const latest = mockGetAll.mock.calls.at(-1)?.[0];
        expect(latest?.accountIds).toEqual(['acc-2']);
      });
      expect(window.localStorage.getItem('transactions.filter.accountStatus')).toBe(JSON.stringify('active'));
    });

    it('falls back to the stored account balance when no daily-balance rows exist', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('set-account-filter'));

      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });
      expect(screen.getByText('$5000.00')).toBeInTheDocument();
    });
  });

  describe('Folding the chart band', () => {
    beforeEach(async () => {
      window.localStorage.clear();
      // The real hook, so a fold is remembered and an absent key reads as no
      // choice: the stateless default could prove neither.
      const actual = await vi.importActual<typeof import('@/hooks/useLocalStorage')>(
        '@/hooks/useLocalStorage',
      );
      mockUseLocalStorage.mockImplementation(actual.useLocalStorage as any);
    });
    afterEach(() => {
      mockPreferences.value = undefined;
      mockUseLocalStorage.mockImplementation((_key: string, defaultValue: any) => [
        defaultValue,
        vi.fn(),
      ]);
    });

    it('folds the chart into a strip, remembers it, and brings it back from the strip', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 1000, accountId: 'acc-1', currencyCode: 'USD' },
      ]);

      await act(async () => {
        render(<TransactionsPage />);
      });
      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));
      });

      expect(screen.queryByTestId('chart-balance-history')).not.toBeInTheDocument();
      expect(screen.getByTestId('chart-collapsed-strip')).toHaveTextContent('Chart hidden');
      expect(window.localStorage.getItem('monize-transactions-chart-collapsed')).toBe('true');

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));
      });

      expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      expect(screen.queryByTestId('chart-collapsed-strip')).not.toBeInTheDocument();
      expect(window.localStorage.getItem('monize-transactions-chart-collapsed')).toBe('false');
    });

    it('offers the fold on the zero-balances banner too', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([
        { date: '2026-02-01', balance: 0, accountId: 'acc-1', currencyCode: 'USD' },
        { date: '2026-02-01', balance: 0, accountId: 'acc-2', currencyCode: 'USD' },
      ]);

      // Inside act, as the first fold test: the page's other loads can
      // resolve after the banner shows, and an update outside act fails the
      // act guard (it did on CI).
      await act(async () => {
        render(<TransactionsPage />);
      });
      await waitFor(() => {
        expect(screen.getByTestId('chart-zero-balances')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));
      });

      expect(screen.queryByTestId('chart-zero-balances')).not.toBeInTheDocument();
      expect(screen.getByTestId('chart-collapsed-strip')).toBeInTheDocument();
    });

    it("starts folded on the account's default when this browser has no choice", async () => {
      mockPreferences.value = { defaultCurrency: 'USD', viewDefaults: { chartCollapsed: true } };

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-collapsed-strip')).toBeInTheDocument();
      });
    });

    it("keeps this browser's choice over the account's default", async () => {
      mockPreferences.value = { defaultCurrency: 'USD', viewDefaults: { chartCollapsed: true } };
      window.localStorage.setItem('monize-transactions-chart-collapsed', 'false');

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('chart-balance-history')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('chart-collapsed-strip')).not.toBeInTheDocument();
    });

    it('folds the info widget with the chart, and brings back both', async () => {
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('set-account-filter'));
      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Hide chart' }));

      expect(screen.queryByText('Current Balance')).not.toBeInTheDocument();
      // The widget's own state is untouched: it comes back open with the band.
      expect(window.localStorage.getItem('monize-transactions-account-widget-collapsed')).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: 'Show chart' }));

      await waitFor(() => {
        expect(screen.getByText('Current Balance')).toBeInTheDocument();
      });
    });

    it("starts the info widget folded on the account's widget default", async () => {
      mockPreferences.value = { defaultCurrency: 'USD', viewDefaults: { widgetsCollapsed: true } };
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetDailyBalances.mockResolvedValue([]);

      render(<TransactionsPage />);
      await waitFor(() => {
        expect(screen.getByTestId('filter-panel')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('set-account-filter'));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Show account info' })).toBeInTheDocument();
      });
      const widgetColumn = screen.getByText('Current Balance').closest('[aria-hidden]');
      expect(widgetColumn).toHaveAttribute('aria-hidden', 'true');
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

    it('fetches full transaction when editing a split transaction', async () => {
      const splitTx = { id: 'tx-split', date: '2026-02-01', amount: -100, payee: { name: 'Store' }, isTransfer: false, isSplit: true, splits: [{ id: 's1', amount: -60 }] };
      const fullSplitTx = { ...splitTx, splits: [{ id: 's1', amount: -60 }, { id: 's2', amount: -40 }] };
      mockGetAll.mockResolvedValue({
        data: [splitTx],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 100, netCashFlow: -100, transactionCount: 1 });
      mockGetById.mockResolvedValue(fullSplitTx);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-tx-split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('tx-tx-split'));

      await waitFor(() => {
        expect(mockGetById).toHaveBeenCalledWith('tx-split');
        expect(mockTxOpenEdit).toHaveBeenCalledWith(fullSplitTx);
      });
    });

    it('falls back to filtered transaction if getById fails for split transaction', async () => {
      const splitTx = { id: 'tx-split', date: '2026-02-01', amount: -100, payee: { name: 'Store' }, isTransfer: false, isSplit: true, splits: [{ id: 's1', amount: -60 }] };
      mockGetAll.mockResolvedValue({
        data: [splitTx],
        pagination: { page: 1, totalPages: 1, total: 1 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 100, netCashFlow: -100, transactionCount: 1 });
      mockGetById.mockRejectedValue(new Error('Network error'));

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-tx-split')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('tx-tx-split'));

      await waitFor(() => {
        expect(mockGetById).toHaveBeenCalledWith('tx-split');
        expect(mockTxOpenEdit).toHaveBeenCalledWith(splitTx);
      });
    });
  });

  describe('Warranties', () => {
    // A warranty is added from the transaction's form or the Warranties page.
    beforeEach(() => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
    });

    it('gives the register rows no warranty action', async () => {
      await act(async () => {
        render(<TransactionsPage />);
      });
      await waitFor(() => expect(screen.getByTestId('tx-count')).toHaveTextContent('3 transactions'));
      expect(screen.queryByTestId('row-warranty-actions')).not.toBeInTheDocument();
    });

    describe('for an acting delegate', () => {
      it("gives the edit window no Add warranty", async () => {
        mockRealFormModal.value = true;
        mockActing.actingAsUserId = 'owner-1';
        mockActing.delegateSections = { warranties: true };
        await act(async () => {
          render(<TransactionsPage />);
        });
        await waitFor(() => expect(screen.getByTestId('tx-tx-1')).toBeInTheDocument());
        await act(async () => {
          fireEvent.click(screen.getByTestId('tx-tx-1'));
        });
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
        expect(screen.queryByTestId('form-add-warranty')).not.toBeInTheDocument();
        expect(screen.queryByTestId('form-add-warranty-after-create')).not.toBeInTheDocument();
      });
    });

    describe('Add warranty from inside the edit window', () => {
      // A link out of the window would drop unsaved edits without asking; the
      // page closes the window through its own close path first.
      async function openEditWindow() {
        mockRealFormModal.value = true;
        await act(async () => {
          render(<TransactionsPage />);
        });
        await waitFor(() => expect(screen.getByTestId('tx-tx-1')).toBeInTheDocument());
        await act(async () => {
          fireEvent.click(screen.getByTestId('tx-tx-1'));
        });
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
      }

      it('asks about unsaved edits first and stays put', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-make-dirty'));
        fireEvent.click(screen.getByTestId('form-add-warranty'));
        expect(screen.getByTestId('unsaved-dialog')).toBeInTheDocument();
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 150));
        expect(mockPush).not.toHaveBeenCalled();
      });

      it('keeps editing and does not navigate when the dialog is dismissed', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-make-dirty'));
        fireEvent.click(screen.getByTestId('form-add-warranty'));
        fireEvent.click(screen.getByTestId('unsaved-cancel'));
        expect(screen.queryByTestId('unsaved-dialog')).not.toBeInTheDocument();
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 150));
        expect(mockPush).not.toHaveBeenCalled();
      });

      it('navigates once the edits are discarded', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-make-dirty'));
        fireEvent.click(screen.getByTestId('form-add-warranty'));
        fireEvent.click(screen.getByTestId('unsaved-discard'));
        expect(screen.queryByTestId('dynamic-transaction-form')).not.toBeInTheDocument();
        await waitFor(() =>
          expect(mockPush).toHaveBeenCalledWith('/warranties?new=1&transactionId=tx-1'),
        );
      });

      // On a new transaction the form calls Add only after it has saved the
      // row, so the window's dirty flag is stale: no dialog, and no register
      // reload behind a page that is being left.
      it('on a new transaction, closes without asking and opens the warranty for the created row', async () => {
        mockRealFormModal.value = true;
        await act(async () => {
          render(<TransactionsPage />);
        });
        await waitFor(() => expect(screen.getByText('+ New Transaction')).toBeInTheDocument());
        await act(async () => {
          fireEvent.click(screen.getByText('+ New Transaction'));
        });
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
        const loadsBefore = mockGetAll.mock.calls.length;
        fireEvent.click(screen.getByTestId('form-make-dirty'));
        fireEvent.click(screen.getByTestId('form-add-warranty-after-create'));
        expect(screen.queryByTestId('unsaved-dialog')).not.toBeInTheDocument();
        expect(screen.queryByTestId('dynamic-transaction-form')).not.toBeInTheDocument();
        await waitFor(() =>
          expect(mockPush).toHaveBeenCalledWith('/warranties?new=1&transactionId=tx-new'),
        );
        expect(mockGetAll.mock.calls.length).toBe(loadsBefore);
      });

      it('closes a clean form and navigates', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-add-warranty'));
        expect(screen.queryByTestId('unsaved-dialog')).not.toBeInTheDocument();
        expect(screen.queryByTestId('dynamic-transaction-form')).not.toBeInTheDocument();
        await waitFor(() =>
          expect(mockPush).toHaveBeenCalledWith('/warranties?new=1&transactionId=tx-1'),
        );
      });

      // A linked warranty in the window's Warranties line: a bare link was
      // undone by the closing Modal's history.back(), landing on Transactions.
      it('opens a linked warranty by closing the window first', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-open-warranty'));
        expect(screen.queryByTestId('unsaved-dialog')).not.toBeInTheDocument();
        expect(screen.queryByTestId('dynamic-transaction-form')).not.toBeInTheDocument();
        expect(mockPush).not.toHaveBeenCalled();
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/warranties/w-9'));
      });

      it('asks about unsaved edits before opening a linked warranty', async () => {
        await openEditWindow();
        fireEvent.click(screen.getByTestId('form-make-dirty'));
        fireEvent.click(screen.getByTestId('form-open-warranty'));
        expect(screen.getByTestId('unsaved-dialog')).toBeInTheDocument();
        expect(screen.getByTestId('dynamic-transaction-form')).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 150));
        expect(mockPush).not.toHaveBeenCalled();
        fireEvent.click(screen.getByTestId('unsaved-discard'));
        expect(screen.queryByTestId('dynamic-transaction-form')).not.toBeInTheDocument();
        await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/warranties/w-9'));
      });
    });

    it("keeps the row's warranty count when a split is re-read for editing", async () => {
      const splitTx = { id: 'tx-split', date: '2026-02-01', amount: -100, payee: { name: 'Store' }, isTransfer: false, isSplit: true, splits: [], warrantyCount: 2 };
      const fullSplitTx = { ...splitTx, warrantyCount: undefined, splits: [{ id: 's1', amount: -100 }] };
      mockGetAll.mockResolvedValue({ data: [splitTx], pagination: { page: 1, totalPages: 1, total: 1 } });
      mockGetById.mockResolvedValue(fullSplitTx);
      render(<TransactionsPage />);
      await waitFor(() => expect(screen.getByTestId('tx-tx-split')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('tx-tx-split'));
      await waitFor(() =>
        expect(mockTxOpenEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'tx-split', warrantyCount: 2 })),
      );
    });
  });

  describe('Payee Interaction', () => {
    // The payee name in a row goes to that payee's page. Editing a payee from
    // the register is still possible -- the payee info widget's pencil opens
    // the same form -- but it is no longer the row's primary click.
    it('navigates to the payee page when a payee is clicked', async () => {
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
        expect(mockPush).toHaveBeenCalledWith('/payees/payee-1');
      });
      // No longer fetches the payee to open a form.
      expect(mockGetPayeeById).not.toHaveBeenCalled();
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
      const accountCallsBefore = mockGetAllAccounts.mock.calls.length;
      const categoryCallsBefore = mockGetAllCategories.mock.calls.length;
      const payeeCallsBefore = mockGetAllPayees.mock.calls.length;

      fireEvent.click(screen.getByTestId('inline-update-btn'));

      // handleTransactionUpdate only calls setTransactions - it does NOT call loadAllData
      // which would reload accounts, categories, and payees. Verify that the static
      // data APIs are not called again.
      await waitFor(() => {
        expect(mockGetAllAccounts.mock.calls.length).toBe(accountCallsBefore);
      });
      expect(mockGetAllCategories.mock.calls.length).toBe(categoryCallsBefore);
      expect(mockGetAllPayees.mock.calls.length).toBe(payeeCallsBefore);
    });

    it('keeps the attachment count when the update payload omits it', async () => {
      mockGetAll.mockResolvedValue({
        data: [{ ...mockTransactions[0], attachmentCount: 2 }, ...mockTransactions.slice(1)],
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-tx-1-attachments')).toHaveTextContent('2');
      });

      // The inline update payload (a status change) carries no attachmentCount;
      // the row must keep the count it already had.
      fireEvent.click(screen.getByTestId('inline-update-btn'));

      // Asserted synchronously: a later refetch would restore the count and
      // hide the regression this test guards against.
      expect(screen.getByTestId('tx-tx-1-attachments')).toHaveTextContent('2');
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

  describe('Bulk Select Mode', () => {
    it('starts with bulk select mode off', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('inactive');
        expect(screen.getByTestId('selection-mode')).toHaveTextContent('off');
      });
    });

    it('activates bulk select mode when toggle button is clicked', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('toggle-bulk-select')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('active');
        expect(screen.getByTestId('selection-mode')).toHaveTextContent('on');
      });
    });

    it('deactivates bulk select mode when toggle is clicked again', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('toggle-bulk-select')).toBeInTheDocument();
      });

      // Activate
      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('active');
      });

      // Deactivate
      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('inactive');
        expect(screen.getByTestId('selection-mode')).toHaveTextContent('off');
      });
    });

    it('exits bulk select mode when clear selection is clicked in banner', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('toggle-bulk-select')).toBeInTheDocument();
      });

      // Enter bulk select mode
      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('active');
      });

      // If selection banner is visible, clear selection should also exit bulk mode
      // The banner only shows when hasSelection is true, which requires selecting transactions.
      // Since the useTransactionSelection hook is not mocked, we test the clear path
      // via the toggle button (which also clears selection when exiting).
      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('inactive');
      });
    });

    it('exits bulk select mode after successful bulk update', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
      mockBulkUpdate.mockResolvedValue({ updated: 2, skipped: 0, skippedReasons: [] });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('toggle-bulk-select')).toBeInTheDocument();
      });

      // Enter bulk select mode
      fireEvent.click(screen.getByTestId('toggle-bulk-select'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toHaveTextContent('active');
      });
    });

    it('passes bulkSelectMode and onToggleBulkSelectMode to filter panel', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('bulk-select-mode')).toBeInTheDocument();
        expect(screen.getByTestId('toggle-bulk-select')).toBeInTheDocument();
      });
    });
  });

  // Regression: CI run #2873, where this file's first Bulk Update test failed
  // with "Unable to find [data-testid=bulk-update-btn]" while the register
  // showed all three rows -- the selection had been cleared, not never made.
  // The page's bulk-update scope falls back to every visible account, so it
  // changes the moment the accounts request lands; on a loaded runner that
  // landed after the click and wiped the selection with it. A background load
  // finishing is not the user changing a filter.
  describe('Selection survives a background load', () => {
    it('keeps the row selected when the accounts request lands after the click', async () => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
      // The accounts request is the slow one, as it was on the CI runner.
      let landAccounts: () => void = () => {};
      mockGetAllAccounts.mockImplementation(
        () => new Promise((resolve) => { landAccounts = () => resolve(mockAccounts); }),
      );

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('select-tx-1')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('select-tx-1'));
      expect(screen.getByTestId('bulk-update-btn')).toBeInTheDocument();

      await act(async () => {
        landAccounts();
        await Promise.resolve();
      });

      expect(screen.getByTestId('bulk-update-btn')).toBeInTheDocument();
    });
  });

  describe('Bulk Update', () => {
    beforeEach(() => {
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
      });
      mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
    });

    // Select tx-1 via the list mock (shows the banner), open the modal, and
    // submit it (the dynamic modal mock submits { categoryId: 'cat-1' }).
    async function selectAndSubmitBulkUpdate() {
      await waitFor(() => {
        expect(screen.getByTestId('select-tx-1')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('select-tx-1'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-update-btn')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('bulk-update-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('bulk-modal-submit')).toBeInTheDocument();
      });
      // The submit handler awaits the API call, so state updates land in a
      // later microtask; the click must be act-wrapped (see frontend CLAUDE.md).
      await act(async () => {
        fireEvent.click(screen.getByTestId('bulk-modal-submit'));
      });
    }

    it('shows the success toast from the catalog, without a split-lines part when splitLinesUpdated is omitted', async () => {
      mockBulkUpdate.mockResolvedValue({ updated: 2, skipped: 0, skippedReasons: [] });
      const toast = await import('react-hot-toast');

      render(<TransactionsPage />);
      await selectAndSubmitBulkUpdate();

      // Exact match: no skipped part and no split-lines part.
      await waitFor(() => {
        expect(toast.default.success).toHaveBeenCalledWith('2 transactions updated');
      });
    });

    it('appends the split-lines toast part when the API reports splitLinesUpdated', async () => {
      mockBulkUpdate.mockResolvedValue({ updated: 2, skipped: 0, skippedReasons: [], splitLinesUpdated: 3 });
      const toast = await import('react-hot-toast');

      render(<TransactionsPage />);
      await selectAndSubmitBulkUpdate();

      await waitFor(() => {
        expect(toast.default.success).toHaveBeenCalledWith('2 transactions updated, 3 split lines recategorized');
      });
    });

    it('shows skipped counts from the catalog and renders server-localized skip reasons verbatim', async () => {
      // A non-English reason proves the string is passed through untranslated.
      mockBulkUpdate.mockResolvedValue({
        updated: 1,
        skipped: 2,
        skippedReasons: ['2 Splitbuchungen ohne passende Zeilen übersprungen'],
      });
      const toast = await import('react-hot-toast');

      render(<TransactionsPage />);
      await selectAndSubmitBulkUpdate();

      await waitFor(() => {
        expect(toast.default.success).toHaveBeenCalledWith('1 transaction updated, 2 transactions skipped');
        expect(toast.default).toHaveBeenCalledWith(
          '2 Splitbuchungen ohne passende Zeilen übersprungen',
          expect.objectContaining({ duration: 6000 }),
        );
      });
    });

    it('includes amountFrom/amountTo/tagIds filters in the select-all-matching payload', async () => {
      mockBulkUpdate.mockResolvedValue({ updated: 3, skipped: 0, skippedReasons: [] });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('set-amount-filter')).toBeInTheDocument();
      });

      // Filters first: changing them afterwards would clear the selection.
      fireEvent.click(screen.getByTestId('set-amount-filter'));
      fireEvent.click(screen.getByTestId('set-tag-filter'));

      await waitFor(() => {
        expect(screen.getByTestId('select-tx-1')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('select-tx-1'));

      await waitFor(() => {
        expect(screen.getByTestId('select-all-matching')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('select-all-matching'));

      fireEvent.click(screen.getByTestId('bulk-update-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('bulk-modal-submit')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('bulk-modal-submit'));
      });

      await waitFor(() => {
        expect(mockBulkUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'filter',
            categoryId: 'cat-1',
            filters: expect.objectContaining({
              amountFrom: 10,
              amountTo: 100,
              tagIds: ['tag-1'],
            }),
          }),
        );
      });
    });

    it('carries the active category filter as categoryFilterIds on a hand-picked (ids mode) selection', async () => {
      // Regression (user-reported): rows checked by hand under an active
      // category filter go up as mode "ids", and without the filter riding
      // along the server recategorized ALL of a split's lines instead of the
      // filtered one. The active filter must reach the server in both modes.
      mockBulkUpdate.mockResolvedValue({ updated: 1, skipped: 0, skippedReasons: [] });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('set-category-filter')).toBeInTheDocument();
      });
      // Filter first: changing it afterwards would clear the selection.
      fireEvent.click(screen.getByTestId('set-category-filter'));

      await waitFor(() => {
        expect(screen.getByTestId('select-tx-1')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('select-tx-1'));

      // Deliberately NOT clicking select-all-matching: this is the ids path.
      fireEvent.click(screen.getByTestId('bulk-update-btn'));
      await waitFor(() => {
        expect(screen.getByTestId('bulk-modal-submit')).toBeInTheDocument();
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId('bulk-modal-submit'));
      });

      await waitFor(() => {
        expect(mockBulkUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'ids',
            transactionIds: ['tx-1'],
            categoryFilterIds: ['cat-1'],
            categoryId: 'cat-1',
          }),
        );
      });
    });
  });

  describe('Stale filter cleanup', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('clears payee filter when selected payee no longer exists in loaded payees', async () => {
      // Simulate stale filter: a previously-selected payee was deleted elsewhere
      localStorage.setItem('transactions.filter.payeeIds', JSON.stringify(['deleted-payee']));

      mockGetAllPayees.mockResolvedValue(mockPayees); // doesn't include 'deleted-payee'
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);

      render(<TransactionsPage />);

      // Wait for static data to load so the cleanup effect can run
      await waitFor(() => {
        expect(mockGetAllPayees).toHaveBeenCalled();
      });

      // The stale payee filter should be automatically cleaned up
      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('0');
      });
    });

    it('clears category filter when selected category no longer exists in loaded categories', async () => {
      localStorage.setItem('transactions.filter.categoryIds', JSON.stringify(['deleted-cat']));

      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories); // doesn't include 'deleted-cat'

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllCategories).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('0');
      });
    });

    it('preserves special category IDs (uncategorized, transfer) during cleanup', async () => {
      // 'uncategorized' is a valid virtual filter, 'deleted-cat' is stale
      localStorage.setItem('transactions.filter.categoryIds', JSON.stringify(['uncategorized', 'deleted-cat']));

      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllCategories).toHaveBeenCalled();
      });

      // 'uncategorized' should be preserved, 'deleted-cat' removed → 1 active filter
      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('1');
      });
    });

    it('keeps valid payee filter when all selected payees still exist', async () => {
      localStorage.setItem('transactions.filter.payeeIds', JSON.stringify(['payee-1']));

      mockGetAllPayees.mockResolvedValue(mockPayees); // includes 'payee-1'
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllPayees).toHaveBeenCalled();
      });

      // payee-1 exists in mockPayees, so filter should remain active
      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('1');
      });
    });

    it('partially clears filter keeping only valid payee IDs', async () => {
      // One valid payee, one stale
      localStorage.setItem('transactions.filter.payeeIds', JSON.stringify(['payee-1', 'deleted-payee']));

      mockGetAllPayees.mockResolvedValue(mockPayees);
      mockGetAllAccounts.mockResolvedValue(mockAccounts);
      mockGetAllCategories.mockResolvedValue(mockCategories);

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(mockGetAllPayees).toHaveBeenCalled();
      });

      // Only payee-1 should remain → 1 active filter (down from 2)
      await waitFor(() => {
        expect(screen.getByTestId('active-filter-count')).toHaveTextContent('1');
      });
    });
  });

  describe('Export', () => {
    it('renders the export button', async () => {
      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('export-btn')).toBeInTheDocument();
        expect(screen.getByTestId('export-btn')).toHaveTextContent('Export');
      });
    });

    it('exports all transactions as CSV when export button is clicked', async () => {
      const exportTransactions = [
        { id: 'tx-1', transactionDate: '2026-02-01', amount: -50, status: 'UNRECONCILED', payee: { id: 'p1', name: 'Store' }, payeeName: 'Store', category: { id: 'c1', name: 'Groceries' }, account: { id: 'acc-1', name: 'Checking' }, description: 'Weekly shop', tags: [{ id: 't1', name: 'Essential' }], currencyCode: 'USD', isTransfer: false },
        { id: 'tx-2', transactionDate: '2026-02-02', amount: 3000, status: 'CLEARED', payee: { id: 'p2', name: 'Employer' }, payeeName: 'Employer', category: { id: 'c2', name: 'Salary' }, account: { id: 'acc-1', name: 'Checking' }, description: 'Monthly pay', tags: [], currencyCode: 'USD', isTransfer: false },
      ];

      mockGetAll.mockResolvedValue({
        data: exportTransactions,
        pagination: { page: 1, totalPages: 1, total: 2 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('2 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [filename, headers, rows] = mockExportToCsv.mock.calls[0];

      expect(filename).toMatch(/^Monize_Transactions_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/);
      expect(headers).toEqual(['Reporting basis', 'Payment date', 'Parent transaction', 'Date', 'Account', 'Payee', 'Category', 'Description', 'Tags', 'Amount', 'Currency', 'Status']);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual(['cash', '2026-02-01', 'tx-1', '2026-02-01', 'Checking', 'Store', 'Groceries', 'Weekly shop', 'Essential', -50, 'USD', 'UNRECONCILED']);
      expect(rows[1]).toEqual(['cash', '2026-02-02', 'tx-2', '2026-02-02', 'Checking', 'Employer', 'Salary', 'Monthly pay', '', 3000, 'USD', 'CLEARED']);
    });

    it('fetches all pages when exporting multi-page results', async () => {
      const page1Transactions = [
        { id: 'tx-1', transactionDate: '2026-02-01', amount: -50, status: 'UNRECONCILED', payee: null, payeeName: null, category: null, account: { id: 'acc-1', name: 'Checking' }, description: null, tags: [], currencyCode: 'USD', isTransfer: false },
      ];
      const page2Transactions = [
        { id: 'tx-2', transactionDate: '2026-02-02', amount: 100, status: 'CLEARED', payee: null, payeeName: null, category: null, account: { id: 'acc-1', name: 'Checking' }, description: null, tags: [], currencyCode: 'USD', isTransfer: false },
      ];

      mockGetAll.mockImplementation((params: any) => {
        if (params?.page === 2) {
          return Promise.resolve({ data: page2Transactions, pagination: { page: 2, totalPages: 2, total: 2 }, startingBalance: 5000 });
        }
        return Promise.resolve({ data: page1Transactions, pagination: { page: 1, totalPages: 2, total: 2 }, startingBalance: 5000 });
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      expect(rows).toHaveLength(2);
    });

    it('shows error toast when no transactions to export', async () => {
      const toast = await import('react-hot-toast');

      mockGetAll.mockResolvedValue({
        data: [],
        pagination: { page: 1, totalPages: 1, total: 0 },
        startingBalance: 0,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('export-btn')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(toast.default.error).toHaveBeenCalledWith('No transactions to export');
      });

      expect(mockExportToCsv).not.toHaveBeenCalled();
    });

    it('shows error toast when export fails', async () => {
      const { showErrorToast } = await import('@/lib/errors');

      // Initial load succeeds with data
      mockGetAll.mockResolvedValue({
        data: mockTransactions,
        pagination: { page: 1, totalPages: 1, total: 3 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('3 transactions');
      });

      // Now make next call fail (the export call)
      mockGetAll.mockRejectedValueOnce(new Error('Network error'));

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(showErrorToast).toHaveBeenCalledWith(expect.any(Error), 'Failed to export transactions');
      });

      expect(mockExportToCsv).not.toHaveBeenCalled();
    });

    it('generates filename starting with Monize', async () => {
      const exportTransactions = [
        { id: 'tx-1', transactionDate: '2026-02-01', amount: -50, status: 'UNRECONCILED', payee: null, payeeName: null, category: null, account: { id: 'acc-1', name: 'Checking' }, description: null, tags: [], currencyCode: 'USD', isTransfer: false },
      ];

      mockGetAll.mockResolvedValue({
        data: exportTransactions,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [filename] = mockExportToCsv.mock.calls[0];
      expect(filename).toMatch(/^Monize/);
      expect(filename).toMatch(/\.csv$/);
    });

    it('handles transactions with null/missing fields gracefully', async () => {
      const sparseTransaction = [
        { id: 'tx-1', transactionDate: '2026-02-01', amount: -25, status: 'UNRECONCILED', payee: null, payeeName: null, category: null, account: null, description: null, tags: undefined, currencyCode: 'USD', isTransfer: false },
      ];

      mockGetAll.mockResolvedValue({
        data: sparseTransaction,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 0,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      expect(rows[0]).toEqual(['cash', '2026-02-01', 'tx-1', '2026-02-01', '', '', '', '', '', -25, 'USD', 'UNRECONCILED']);
    });

    it('exports the amount as a number when the API sends it as a decimal string', async () => {
      // `decimal(20,4)` has no TypeORM transformer, so `amount` arrives as the
      // string "-67.9900" while the type says number. Passing it through
      // unconverted put text in the Amount column, which the CSV writer then
      // read as a formula and neutralized with a leading tab -- issue #1134.
      // The split branch below never showed it because it recomputes a real
      // number, and a positive string opens with no character the guard looks
      // for, which is why the reporter's only clean rows were splits and one
      // credit.
      const apiShapedTransactions = [
        { id: 'tx-1', transactionDate: '2026-08-12', amount: '-67.9900', status: 'UNRECONCILED', payee: { id: 'p1', name: 'AliExpress' }, payeeName: 'AliExpress', category: { id: 'c1', name: 'Sporting Goods' }, account: { id: 'acc-1', name: 'WS VISA' }, description: 'TPU tubes x6', tags: [], currencyCode: 'CAD', isTransfer: false },
        { id: 'tx-2', transactionDate: '2026-08-06', amount: '38.5700', status: 'UNRECONCILED', payee: { id: 'p2', name: 'WealthSimple' }, payeeName: 'WealthSimple', category: { id: 'c2', name: 'Cashback' }, account: { id: 'acc-1', name: 'WS VISA' }, description: 'From credit card', tags: [], currencyCode: 'CAD', isTransfer: false },
      ];

      mockGetAll.mockResolvedValue({
        data: apiShapedTransactions,
        pagination: { page: 1, totalPages: 1, total: 2 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('2 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      expect(rows[0][9]).toBe(-67.99);
      expect(rows[1][9]).toBe(38.57);
      expect(typeof rows[0][9]).toBe('number');
      expect(typeof rows[1][9]).toBe('number');
    });

    it('exports a transfer with the counterpart account and the direction', async () => {
      // The Category column was empty for a transfer -- the register shows the
      // counterpart as an arrow chip and the export said nothing at all. Each
      // leg is labelled from its own amount, so the pair reads To and From.
      const transfers = [
        { id: 'tx-1', transactionDate: '2026-08-12', amount: '-200.0000', status: 'CLEARED', payee: null, payeeName: 'Transfer to Savings', category: null, account: { id: 'acc-1', name: 'Chequing' }, description: '', tags: [], currencyCode: 'CAD', isTransfer: true, linkedTransaction: { id: 'tx-2', account: { id: 'acc-2', name: 'Savings' } } },
        { id: 'tx-2', transactionDate: '2026-08-12', amount: '200.0000', status: 'CLEARED', payee: null, payeeName: 'Transfer from Chequing', category: null, account: { id: 'acc-2', name: 'Savings' }, description: '', tags: [], currencyCode: 'CAD', isTransfer: true, linkedTransaction: { id: 'tx-1', account: { id: 'acc-1', name: 'Chequing' } } },
      ];

      mockGetAll.mockResolvedValue({
        data: transfers,
        pagination: { page: 1, totalPages: 1, total: 2 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('2 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      expect(rows[0][6]).toBe('Transfer To Savings');
      expect(rows[1][6]).toBe('Transfer From Chequing');
    });

    it('keeps a category a transfer also carries, beside the transfer label', async () => {
      // The register shows both chips for a categorized transfer (a monthly
      // investment contribution, say); dropping one in the export loses it.
      const transfers = [
        { id: 'tx-1', transactionDate: '2026-08-12', amount: '-200.0000', status: 'CLEARED', payee: null, payeeName: '', category: { id: 'c1', name: 'Investments' }, account: { id: 'acc-1', name: 'Chequing' }, description: '', tags: [], currencyCode: 'CAD', isTransfer: true, linkedTransaction: { id: 'tx-2', account: { id: 'acc-2', name: 'RRSP' } } },
      ];

      mockGetAll.mockResolvedValue({
        data: transfers,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      expect(mockExportToCsv.mock.calls[0][2][0][6]).toBe('Investments; Transfer To RRSP');
    });

    it('labels a transfer split line instead of calling it uncategorized', async () => {
      // A split line pointing at another account has no category, and naming
      // it "Uncategorized" says something untrue about where the money went.
      const splitTransaction = [
        {
          id: 'tx-split',
          transactionDate: '2026-08-12',
          amount: '-150.0000',
          status: 'CLEARED',
          payee: { id: 'p1', name: 'Store' },
          payeeName: 'Store',
          category: null,
          account: { id: 'acc-1', name: 'Chequing' },
          description: 'Mixed purchase',
          tags: [],
          currencyCode: 'CAD',
          isTransfer: false,
          isSplit: true,
          splits: [
            { id: 's1', amount: '-100.0000', category: { id: 'c1', name: 'Groceries' }, transferAccount: null, tags: [] },
            { id: 's2', amount: '-50.0000', category: null, transferAccount: { id: 'acc-2', name: 'Savings' }, tags: [] },
          ],
        },
      ];

      mockGetAll.mockResolvedValue({
        data: splitTransaction,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      expect(mockExportToCsv.mock.calls[0][2][0][6]).toBe('Groceries; Transfer To Savings');
    });

    it('exports filtered split amount when only some splits match the filter', async () => {
      const splitTransaction = [
        {
          id: 'tx-split',
          transactionDate: '2026-03-01',
          amount: -200,
          status: 'CLEARED',
          payee: { id: 'p1', name: 'Store' },
          payeeName: 'Store',
          category: null,
          account: { id: 'acc-1', name: 'Checking' },
          description: 'Split purchase',
          tags: [],
          currencyCode: 'USD',
          isTransfer: false,
          isSplit: true,
          splits: [
            { id: 's1', amount: -50, category: { id: 'c1', name: 'Groceries' }, tags: [] },
          ],
        },
      ];

      mockGetAll.mockResolvedValue({
        data: splitTransaction,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      // Amount should be the filtered split sum (-50), not the full amount (-200)
      expect(rows[0][9]).toBe(-50);
      // Category should show split categories
      expect(rows[0][6]).toBe('Groceries');
    });

    it('exports full amount when all splits are present', async () => {
      const splitTransaction = [
        {
          id: 'tx-split',
          transactionDate: '2026-03-01',
          amount: -200,
          status: 'CLEARED',
          payee: null,
          payeeName: null,
          category: null,
          account: { id: 'acc-1', name: 'Checking' },
          description: null,
          tags: [],
          currencyCode: 'USD',
          isTransfer: false,
          isSplit: true,
          splits: [
            { id: 's1', amount: -50, category: { id: 'c1', name: 'Groceries' }, tags: [] },
            { id: 's2', amount: -150, category: { id: 'c2', name: 'Dining' }, tags: [] },
          ],
        },
      ];

      mockGetAll.mockResolvedValue({
        data: splitTransaction,
        pagination: { page: 1, totalPages: 1, total: 1 },
        startingBalance: 5000,
      });

      render(<TransactionsPage />);

      await waitFor(() => {
        expect(screen.getByTestId('tx-count')).toHaveTextContent('1 transactions');
      });

      fireEvent.click(screen.getByTestId('export-btn'));

      await waitFor(() => {
        expect(mockExportToCsv).toHaveBeenCalledTimes(1);
      });

      const [, , rows] = mockExportToCsv.mock.calls[0];
      // Full amount since all splits are present
      expect(rows[0][9]).toBe(-200);
      // Category should show all split categories
      expect(rows[0][6]).toBe('Groceries; Dining');
    });
  });
});

describe('TransactionsPage register sorting', () => {
  /** The params of the most recent register request. */
  const lastGetAllParams = () => {
    const calls = mockGetAll.mock.calls;
    return calls[calls.length - 1][0];
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams.value = '';
    // Rows, because an empty register draws an empty state and no headers.
    mockGetAll.mockResolvedValue({
      data: mockTransactions,
      pagination: { page: 3, totalPages: 3, total: 120 },
    });
    mockGetSummary.mockResolvedValue({ totalIncome: 0, totalExpenses: 0, netCashFlow: 0, transactionCount: 0 });
    mockGetAllAccounts.mockResolvedValue([]);
    mockGetAllCategories.mockResolvedValue([]);
    mockGetAllPayees.mockResolvedValue([]);
    mockGetDailyBalances.mockResolvedValue([]);
    mockGetMonthlyTotals.mockResolvedValue([]);
    // A real remembered value, so a header click can actually change it.
    mockUseLocalStorage.mockImplementation((_key: string, defaultValue: any) => {
      const [value, setValue] = React.useState(defaultValue);
      return [value, setValue];
    });
  });

  afterEach(() => {
    mockUseLocalStorage.mockImplementation((_key: string, defaultValue: any) => [
      defaultValue,
      vi.fn(),
    ]);
  });

  it('asks for the register in date order, newest first, by default', async () => {
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(lastGetAllParams()).toMatchObject({ sortBy: 'date', sortDirection: 'desc' });
  });

  it('re-asks the server when a column header is used, from page 1', async () => {
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());

    const sortAmount = await screen.findByTestId('sort-amount');
    await act(async () => {
      fireEvent.click(sortAmount);
    });

    await waitFor(() => {
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'amount', sortDirection: 'asc' });
    });
    // Page 3 of one order is a different set of rows from page 3 of another,
    // so the register goes back to the first page.
    expect(lastGetAllParams().page).toBe(1);
  });

  it('reverses the column that is already sorted', async () => {
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-date'));
    });

    await waitFor(() => {
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'date', sortDirection: 'asc' });
    });
  });

  it('carries the withheld reason from the response to the register', async () => {
    mockGetAll.mockResolvedValue({
      data: mockTransactions,
      pagination: { page: 1, totalPages: 1, total: 3 },
      startingBalanceWithheld: 'sort',
    });
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    // The reason travels with the rows: the register turns it into the line
    // that tells a reader how to get the Balance column back.
    await waitFor(() => {
      expect(screen.getByTestId('balance-withheld')).toHaveTextContent('sort');
    });
  });

  it('keeps the sort out of the requests that are not the register', async () => {
    // The charts, the calendar and the export read the same filters. A sort is
    // not a filter: it reorders one list, and sending it anywhere else is a
    // parameter those endpoints have to ignore.
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetDailyBalances).toHaveBeenCalled());
    expect(lastGetAllParams()).toHaveProperty('sortBy');
    for (const call of mockGetDailyBalances.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('sortBy');
    }
  });

  it('drops back to the date order to reach a deep-linked row', async () => {
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    const sortAmount = await screen.findByTestId('sort-amount');
    await act(async () => {
      fireEvent.click(sortAmount);
    });
    await waitFor(() => {
      expect(screen.getByTestId('sort')).toHaveTextContent('amount:asc');
    });

    // Following a transfer to its other leg asks the server for the page that
    // row is on. A page number can only be counted in date order -- the server
    // refuses the pair outright -- so arriving at a row returns to the date
    // order, keeping the direction, exactly as it already drops the filters
    // that would have hidden the row.
    await act(async () => {
      fireEvent.click(screen.getByTestId('transfer-click-btn'));
    });

    await waitFor(() => {
      expect(lastGetAllParams()).toMatchObject({
        targetTransactionId: 'tx-linked',
        sortBy: 'date',
        sortDirection: 'asc',
      });
    });
    expect(screen.getByTestId('sort')).toHaveTextContent('date:asc');
  });

  it('describes the rows on screen by the order they were fetched in', async () => {
    // The header answers the press at once; the rows cannot. Between the two
    // the register holds a page fetched newest-first and a header saying
    // oldest-first, and the running balance is walked from a seed that is the
    // balance after the page's newest row. Reading the direction from the
    // header there reverses the page before walking it, so every figure in the
    // Balance column comes out inverted -- a column of numbers that was never
    // true of any state of the ledger, drawn at full opacity with no spinner
    // over it (`docs/frontend/api-and-cache.md`: the payload plus the complete
    // request key that produced it).
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');

    // The reload never answers, so the rows stay exactly as they are.
    const before = mockGetAll.mock.calls.length;
    mockGetAll.mockImplementation(() => new Promise(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-date'));
    });

    // Waited for, not assumed: the request has to be in flight for this to be
    // the in-flight state rather than a click nothing has acted on yet.
    await waitFor(() => {
      expect(mockGetAll.mock.calls.length).toBeGreaterThan(before);
    });
    expect(screen.getByTestId('sort')).toHaveTextContent('date:asc');
    expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');
  });

  it('keeps describing the rows it has when the reload fails', async () => {
    // A failed reload changes no rows and no seed, so it must change no order
    // either: the three are one payload. Leaving the header's order behind
    // would make the inverted column above permanent rather than momentary.
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');
    });

    mockGetAll.mockRejectedValueOnce(new Error('register unavailable'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-date'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('sort')).toHaveTextContent('date:asc');
    });
    expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');
  });

  it('adopts the new order once the rows that belong to it arrive', async () => {
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());

    const sortAmount = await screen.findByTestId('sort-amount');
    await act(async () => {
      fireEvent.click(sortAmount);
    });

    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('amount:asc');
    });
  });

  it('reverses the date column from the order the header is showing', async () => {
    // A remembered account sort is resolved away on a single account's page,
    // because that page draws no Account column to click back. The Date header
    // therefore shows the default, newest-first -- and toggling from the
    // REMEMBERED sort returns the default too, so the first press moves no
    // arrow, reverses nothing, and still drops the reader back to page 1.
    mockSearchParams.value = 'accountIds=acc-1';
    mockUseLocalStorage.mockImplementation((key: string, defaultValue: any) => {
      const [value, setValue] = React.useState(
        key === TRANSACTION_SORT_STORAGE_KEY
          ? { field: 'account', direction: 'asc' }
          : defaultValue,
      );
      return [value, setValue];
    });

    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getByTestId('single-account')).toHaveTextContent('single');
    });
    expect(screen.getByTestId('sort')).toHaveTextContent('date:desc');

    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-date'));
    });

    await waitFor(() => {
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'date', sortDirection: 'asc' });
    });
    expect(screen.getByTestId('sort')).toHaveTextContent('date:asc');
  });

  it('falls back to the date sort while the remembered column is hidden', async () => {
    // A column the reader has hidden has no header at any width, so a
    // remembered sort on it is resolved away like the account sort on a
    // single account's page: this render only, storage untouched. The request
    // goes out by date, and the header shows the default.
    mockPreferences.value = {
      ...DEFAULT_MOCK_PREFERENCES,
      hiddenTableColumns: { transactions: ['status'] },
    };
    mockUseLocalStorage.mockImplementation((key: string, defaultValue: any) => {
      const [value, setValue] = React.useState(
        key === TRANSACTION_SORT_STORAGE_KEY
          ? { field: 'status', direction: 'asc' }
          : defaultValue,
      );
      return [value, setValue];
    });

    try {
      render(<TransactionsPage />);
      await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
      expect(screen.getByTestId('sort')).toHaveTextContent('date:desc');
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'date', sortDirection: 'desc' });
    } finally {
      mockPreferences.value = undefined;
    }
  });

  it('falls back to the date sort on the phone card for a column the card does not show', async () => {
    // The phone card (a phone at Normal density) shows no description or
    // ref #, and its sort strip offers no chip for either, so a sort
    // remembered from the tier table is resolved away while the card is
    // drawn: this render only, storage untouched.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    const originalDensities = useDensityStore.getState().densities;
    useDensityStore.setState({ densities: { transactions: 'normal' } });
    mockUseLocalStorage.mockImplementation((key: string, defaultValue: any) => {
      const [value, setValue] = React.useState(
        key === TRANSACTION_SORT_STORAGE_KEY
          ? { field: 'refNumber', direction: 'asc' }
          : defaultValue,
      );
      return [value, setValue];
    });

    let unmount: (() => void) | undefined;
    try {
      ({ unmount } = render(<TransactionsPage />));
      await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
      expect(screen.getByTestId('sort')).toHaveTextContent('date:desc');
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'date', sortDirection: 'desc' });
      await waitFor(() => {
        expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');
      });

      // Compact keeps the tier table on a phone, Ref # column and all, so the
      // remembered sort comes back, and the rows are read again in it: the
      // switch is no click, so only the page's own watch on it can reload.
      await act(async () => {
        useDensityStore.setState({ densities: { transactions: 'compact' } });
      });
      expect(screen.getByTestId('sort')).toHaveTextContent('refNumber:asc');
      await waitFor(() => {
        expect(screen.getByTestId('rows-sort')).toHaveTextContent('refNumber:asc');
      });
      expect(lastGetAllParams()).toMatchObject({ sortBy: 'refNumber', sortDirection: 'asc', page: 1 });
    } finally {
      // Unmounted first: putting the store back re-renders a mounted page.
      unmount?.();
      window.matchMedia = originalMatchMedia;
      useDensityStore.setState({ densities: originalDensities });
    }
  });

  it('reads the register once for a deep link that arrives in the URL', async () => {
    // A `targetTransactionId` in the mount URL is not a filter change, so it
    // takes the loader's undebounced branch: nothing coalesces a second read
    // there. Remembering the date fallback from inside the loader used to
    // change the loader's own identity and fire one -- with the target already
    // consumed, for whatever page the register was on, racing the page the
    // first read resolved. Whichever answered last won, so the reader could
    // land on page 1 with the row they followed nowhere on it.
    mockSearchParams.value =
      'targetTransactionId=11111111-1111-4111-8111-111111111111';
    mockUseLocalStorage.mockImplementation((key: string, defaultValue: any) => {
      const [value, setValue] = React.useState(
        key === TRANSACTION_SORT_STORAGE_KEY
          ? { field: 'amount', direction: 'asc' }
          : defaultValue,
      );
      return [value, setValue];
    });

    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:asc');
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const reads = mockGetAll.mock.calls.map(([params]: any[]) => ({
      page: params.page,
      target: params.targetTransactionId,
      sortBy: params.sortBy,
    }));
    expect(reads).toEqual([
      {
        page: 1,
        target: '11111111-1111-4111-8111-111111111111',
        sortBy: 'date',
      },
      { page: 3, target: undefined, sortBy: 'date' },
    ]);
  });

  it('keeps the deep-link target on the read that supersedes the first one', async () => {
    // A cold load: the accounts answer while the first register read is still
    // in flight, the account scope changes and a second read replaces the
    // first. That second read must still ask for the target's page; sent
    // without it, the register stayed on page 1 and the linked row was only
    // found when it happened to be there.
    const target = '11111111-1111-4111-8111-111111111111';
    mockSearchParams.value = `targetTransactionId=${target}`;
    mockGetAllAccounts.mockResolvedValue(mockAccounts);
    let releaseFirst: (value: unknown) => void = () => {};
    mockGetAll.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseFirst = resolve;
        }),
    );

    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll.mock.calls.length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      releaseFirst({ data: [], pagination: { page: 1, totalPages: 3, total: 120 } });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    const reads = mockGetAll.mock.calls.map(([params]: any[]) => ({
      page: params.page,
      target: params.targetTransactionId,
      accounts: params.accountIds,
    }));
    expect(reads[0]).toEqual({ page: 1, target, accounts: undefined });
    expect(reads[1]).toMatchObject({ page: 1, target });
    expect(reads[1].accounts).toEqual(expect.arrayContaining(['acc-1', 'acc-2']));
    // The page the superseding read resolved is the one the register shows.
    expect(reads[reads.length - 1]).toMatchObject({ page: 3, target: undefined });
  });

  it('reads the register once to follow a transfer to its other leg', async () => {
    // The same shape on the path that goes through a filter change, where the
    // debounce would coalesce a duplicate rather than let it race.
    render(<TransactionsPage />);
    await waitFor(() => expect(mockGetAll).toHaveBeenCalled());
    const sortAmount = await screen.findByTestId('sort-amount');
    await act(async () => {
      fireEvent.click(sortAmount);
    });
    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('amount:asc');
    });

    const before = mockGetAll.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('transfer-click-btn'));
    });
    await waitFor(() => {
      expect(lastGetAllParams()).toMatchObject({ targetTransactionId: 'tx-linked' });
    });
    // Settle anything the response itself scheduled before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });

    // The read that follows carries the page the first one resolved, which is
    // the pager catching up. A read for the page the register was already on,
    // with the target gone, is the duplicate: it answers a question nobody
    // asked and can overwrite the row's page with the one it replaced.
    const reads = mockGetAll.mock.calls
      .slice(before)
      .map(([params]: any[]) => ({
        page: params.page,
        target: params.targetTransactionId,
      }));
    expect(reads).toEqual([
      { page: 1, target: 'tx-linked' },
      { page: 3, target: undefined },
    ]);
  });

  it('discards a reply a newer request has already superseded', async () => {
    // Two header clicks further apart than the debounce put two reads in
    // flight. Without a sequence the display is whichever answered last, so a
    // slow amount-ordered page can land under a Payee-active header.
    render(<TransactionsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('date:desc');
    });

    const before = mockGetAll.mock.calls.length;
    let releaseSlow: (value: unknown) => void = () => {};
    mockGetAll.mockImplementationOnce(
      () => new Promise((resolve) => { releaseSlow = resolve; }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-amount'));
    });
    // The slow read has to be in flight before the second click, or the
    // debounce cancels it and there is nothing to arrive late.
    await waitFor(() => {
      expect(mockGetAll.mock.calls.length).toBeGreaterThan(before);
    });

    mockGetAll.mockResolvedValue({
      data: mockTransactions,
      pagination: { page: 1, totalPages: 1, total: 3 },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sort-payee'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rows-sort')).toHaveTextContent('payee:asc');
    });

    // The abandoned amount request answers now, and must change nothing.
    await act(async () => {
      releaseSlow({
        data: [],
        pagination: { page: 9, totalPages: 9, total: 400 },
        startingBalanceWithheld: 'sort',
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId('rows-sort')).toHaveTextContent('payee:asc');
    expect(screen.getByTestId('tx-count')).toHaveTextContent(
      `${mockTransactions.length} transactions`,
    );
    expect(screen.getByTestId('balance-withheld')).toHaveTextContent('none');
  });
});
