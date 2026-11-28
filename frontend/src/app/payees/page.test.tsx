import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, act, within } from '@/test/render';
import PayeesPage from './page';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import toast from 'react-hot-toast';

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img alt="" {...props} />,
}));

// Callable toast mock: the bulk backfill uses the bare toast() for the
// "nothing to do" notice, so the default export must be a function (the
// global setup mock only exposes toast.success/.error).
vi.mock('react-hot-toast', () => {
  const fn: any = vi.fn();
  fn.success = vi.fn();
  fn.error = vi.fn();
  fn.loading = vi.fn();
  fn.dismiss = vi.fn();
  return { default: fn, Toaster: () => null };
});

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

vi.mock('@/lib/constants', () => ({
  PAGE_SIZE: 25,
}));

const mockGetAllPayees = vi.fn();
const mockGetAllCategories = vi.fn();
const mockCreatePayee = vi.fn();
const mockUpdatePayee = vi.fn();
const mockReactivatePayee = vi.fn();
const mockCreateAlias = vi.fn();
const mockApplyCategorySuggestions = vi.fn();

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockGetAllPayees(...args),
    create: (...args: any[]) => mockCreatePayee(...args),
    update: (...args: any[]) => mockUpdatePayee(...args),
    reactivatePayee: (...args: any[]) => mockReactivatePayee(...args),
    createAlias: (...args: any[]) => mockCreateAlias(...args),
    applyCategorySuggestions: (...args: any[]) => mockApplyCategorySuggestions(...args),
  },
}));

// Spread the real module: these are pure helpers, and a hand-listed mock
// silently omits every one added later -- adding `buildCategoryIconMap` to the
// page broke all 52 cases here with "No export is defined on the mock".
vi.mock('@/lib/categoryUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categoryUtils')>()),
  buildCategoryColorMap: () => new Map(),
  buildCategoryLabelMap: () => new Map(),
  buildCategoryTree: () => [],
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => {
    const [showForm, setShowForm] = useState(false);
    const [editingItem, setEditingItem] = useState<any>(null);
    return {
      showForm,
      editingItem,
      openCreate: () => { setEditingItem(null); setShowForm(true); },
      openEdit: (item: any) => { setEditingItem(item); setShowForm(true); },
      close: () => { setEditingItem(null); setShowForm(false); },
      isEditing: !!editingItem,
      modalProps: {},
      setFormDirty: vi.fn(),
      unsavedChangesDialog: { isOpen: false, onConfirm: vi.fn(), onCancel: vi.fn() },
      formSubmitRef: { current: null },
    };
  },
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: any) => useState(defaultValue),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}{actions}</div>
  ),
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...rest }: any) => <button onClick={onClick} {...rest}>{children}</button>,
}));

vi.mock('@/lib/payee-lookup', () => ({
  payeeLookupApi: {
    getSettings: vi.fn().mockResolvedValue({
      mode: 'none',
      configured: false,
      enabled: true,
      aiEnabled: true,
      capEnabled: true,
      monthlyCap: 1000,
      apiKeyMasked: null,
      apiKeyReadable: true,
      usedThisMonth: 0,
      preferredSource: 'google-places',
      aiProviderConfigId: null,
      encryptionAvailable: true,
    }),
    updateSettings: vi.fn(),
    testKey: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({
      available: false,
      source: null,
      aiConfigured: false,
      aiEnabled: true,
      preferredSource: 'google-places',
      googlePlaces: { mode: 'none', enabled: true, capReached: false },
    }),
  },
}));

vi.mock('@/lib/ai', () => ({
  aiApi: { getConfigs: vi.fn().mockResolvedValue([]) },
}));

vi.mock('@/components/ui/Modal', () => ({
  // `maxWidth` is surfaced because one of these modals has to match a width
  // set on another page; the real component turns it into a Tailwind class
  // this mock never renders, so nothing else could see a change to it.
  Modal: ({ children, isOpen, maxWidth }: any) =>
    isOpen ? (
      <div data-testid="modal" data-max-width={maxWidth}>
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
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { users: null, checkCircle: null, warning: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages }: any) => <div data-testid="pagination">Page {currentPage} of {totalPages}</div>,
}));

vi.mock('@/components/payees/PayeeForm', () => ({
  PayeeForm: ({ onSubmit, payee }: any) => (
    <div data-testid="payee-form">
      PayeeForm
      {payee && <span data-testid="editing-payee">{payee.name}</span>}
      <button data-testid="submit-form" onClick={() => Promise.resolve(onSubmit({ name: 'New Payee', defaultCategoryId: '', notes: '' })).catch(() => {})}>Submit</button>
      <button data-testid="submit-with-aliases" onClick={() => Promise.resolve(onSubmit({ name: 'WithAliases', defaultCategoryId: 'cat-1', notes: 'note', pendingAliases: ['Alias1', 'Alias2'] })).catch(() => {})}>SubmitWithAliases</button>
      <button data-testid="submit-apply-category" onClick={() => Promise.resolve(onSubmit({ name: 'Updated', defaultCategoryId: 'cat-1', notes: '', applyCategoryToTransactions: 'all' })).catch(() => {})}>SubmitApplyCategory</button>
    </div>
  ),
}));

vi.mock('@/components/payees/PayeeList', () => ({
  PayeeList: ({ payees, sortField, sortDirection, onSort, onEdit, onDelete, onReactivate, onMerge }: any) => (
    <div data-testid="payee-list">
      {payees.map((p: any) => (
        <div key={p.id} data-testid={`payee-${p.id}`}>
          {p.name}
          <span data-testid={`usage-${p.id}`}>{p.usageCount ?? 'none'}</span>
          <button data-testid={`edit-${p.id}`} onClick={() => onEdit(p)}>Edit</button>
          <button data-testid={`delete-${p.id}`} onClick={() => onDelete(p.id)}>Delete</button>
          <button data-testid={`reactivate-${p.id}`} onClick={() => onReactivate(p.id)}>Reactivate</button>
          <button data-testid={`merge-${p.id}`} onClick={() => onMerge(p)}>Merge</button>
        </div>
      ))}
      <span data-testid="sort-info">{sortField} {sortDirection}</span>
      <button data-testid="sort-by-name" onClick={() => onSort('name')}>Sort Name</button>
      <button data-testid="sort-by-count" onClick={() => onSort('count')}>Sort Count</button>
      <button data-testid="sort-by-category" onClick={() => onSort('category')}>Sort Category</button>
      <button data-testid="sort-by-aliases" onClick={() => onSort('aliases')}>Sort Aliases</button>
      <button data-testid="sort-by-lastUsed" onClick={() => onSort('lastUsed')}>Sort LastUsed</button>
      <button data-testid="sort-by-createdAt" onClick={() => onSort('createdAt')}>Sort CreatedAt</button>
    </div>
  ),
}));

vi.mock('@/components/payees/CategoryAutoAssignDialog', () => ({
  CategoryAutoAssignDialog: ({ isOpen, onClose, onSuccess }: any) => isOpen ? (
    <div data-testid="auto-assign-dialog">
      Auto-Assign
      <button data-testid="auto-assign-close" onClick={onClose}>Close</button>
      <button data-testid="auto-assign-success" onClick={onSuccess}>Success</button>
    </div>
  ) : null,
}));

vi.mock('@/components/payees/DeactivateUnusedPayeesDialog', () => ({
  DeactivateUnusedPayeesDialog: ({ isOpen, onClose, onSuccess }: any) => isOpen ? (
    <div data-testid="deactivate-dialog">
      Deactivate
      <button data-testid="deactivate-close" onClick={onClose}>Close</button>
      <button data-testid="deactivate-success" onClick={onSuccess}>Success</button>
    </div>
  ) : null,
}));

vi.mock('@/components/payees/MergePayeeDialog', () => ({
  MergePayeeDialog: ({ isOpen, onClose }: any) => isOpen ? (
    <div data-testid="merge-dialog">
      Merge
      <button data-testid="merge-close" onClick={onClose}>Close</button>
    </div>
  ) : null,
}));

const mockPayees = [
  { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { name: 'Food' }, transactionCount: 50, isActive: true },
  { id: 'p-2', name: 'Gas Station', defaultCategoryId: 'cat-2', defaultCategory: { name: 'Auto' }, transactionCount: 20, isActive: true },
  { id: 'p-3', name: 'Amazon', defaultCategoryId: null, defaultCategory: null, transactionCount: 35, isActive: true },
  { id: 'p-4', name: 'Electric Co', defaultCategoryId: null, defaultCategory: null, transactionCount: 12, isActive: true },
];

/**
 * Open the header's Maintenance menu. The four bulk actions moved behind it,
 * so anything that used to click them straight from the header opens it first.
 */
async function openMaintenance() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Maintenance/ })).toBeInTheDocument(),
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Maintenance/ }));
  });
}

describe('PayeesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAllPayees.mockResolvedValue(mockPayees);
    mockGetAllCategories.mockResolvedValue([]);
  });

  describe('Rendering', () => {
    it('renders the page header with title', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('Payees')).toBeInTheDocument());
    });

    it('renders the subtitle', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText(/Manage your payees and their default categories/i)).toBeInTheDocument());
    });

    it('renders within page layout', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('page-layout')).toBeInTheDocument());
    });

    it('keeps the bulk actions out of the header', async () => {
      render(<PayeesPage />);
      await openMaintenance();

      // Every occasional action behind one trigger; the header itself carries
      // only that trigger and the everyday New Payee button.
      expect(screen.getAllByRole('menuitem')).toHaveLength(5);
      for (const label of [
        'Auto-Merge Payees',
        'Deactivate Unused',
        'Auto-Assign Categories',
        'Apply Default Categories',
        'Payee Lookup settings',
      ]) {
        expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: label })).toBeNull();
      }
    });

    it('opens the same Payee Lookup settings the Settings page shows', async () => {
      // The menu item renders PayeeLookupSection itself -- one component, so
      // the two places cannot drift into offering different controls.
      render(<PayeesPage />);
      await openMaintenance();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('menuitem', { name: 'Payee Lookup settings' }),
        );
      });

      // The Modal is mocked in this file, so the dialog is its test id; what
      // matters is that the section itself rendered inside it.
      await waitFor(() =>
        expect(screen.getByTestId('modal')).toBeInTheDocument(),
      );
      expect(
        screen.getByRole('button', { name: 'Set up' }),
      ).toBeInTheDocument();
      // And at the width the same section gets on Settings, whose content
      // column is that page's max-w-6xl main less its lg:px-12, its lg:w-52
      // nav and the lg:gap-10 between them (50.5rem). Sized off the default
      // the card was half that and every row wrapped.
      expect(screen.getByTestId('modal')).toHaveAttribute(
        'data-max-width',
        '3xl',
      );
    });

    it('renders New Payee and the Maintenance trigger', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Payee')).toBeInTheDocument();
        expect(
          screen.getByRole('button', { name: /Maintenance/ }),
        ).toBeInTheDocument();
      });
    });
  });

  describe('Summary Cards', () => {
    it('renders all four summary cards', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Payees')).toHaveTextContent('4');
        expect(screen.getByTestId('summary-Active')).toHaveTextContent('4');
        expect(screen.getByTestId('summary-Inactive')).toHaveTextContent('0');
        expect(screen.getByTestId('summary-Without Category')).toHaveTextContent('2');
      });
    });
  });

  describe('Search', () => {
    it('renders search input', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByPlaceholderText('Search payees...')).toBeInTheDocument());
    });

    it('filters payees by search query', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('Grocery Store')).toBeInTheDocument());
      fireEvent.change(screen.getByPlaceholderText('Search payees...'), { target: { value: 'Grocery' } });
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      expect(screen.queryByText('Gas Station')).not.toBeInTheDocument();
    });

    it('search is case-insensitive', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('Grocery Store')).toBeInTheDocument());
      fireEvent.change(screen.getByPlaceholderText('Search payees...'), { target: { value: 'grocery' } });
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    });

    it('shows all payees when search is cleared', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('Grocery Store')).toBeInTheDocument());
      const input = screen.getByPlaceholderText('Search payees...');
      fireEvent.change(input, { target: { value: 'Grocery' } });
      expect(screen.queryByText('Amazon')).not.toBeInTheDocument();
      fireEvent.change(input, { target: { value: '' } });
      expect(screen.getByText('Amazon')).toBeInTheDocument();
    });
  });

  describe('Payee List', () => {
    it('renders payee list with all payees sorted by name', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        const list = screen.getByTestId('payee-list');
        const payeeElements = list.querySelectorAll('[data-testid^="payee-"]');
        expect(payeeElements[0]).toHaveTextContent('Amazon');
        expect(payeeElements[1]).toHaveTextContent('Electric Co');
        expect(payeeElements[2]).toHaveTextContent('Gas Station');
        expect(payeeElements[3]).toHaveTextContent('Grocery Store');
      });
    });

    it('shows total count below list', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('4 payees')).toBeInTheDocument());
    });

    it('shows singular "payee" for count of 1', async () => {
      mockGetAllPayees.mockResolvedValue([mockPayees[0]]);
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('1 payee')).toBeInTheDocument());
    });

    it('shows default sort info (name asc)', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('name asc');
      });
    });
  });

  describe('Sorting', () => {
    it('toggles sort direction when clicking same field', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('name asc');
      });
      fireEvent.click(screen.getByTestId('sort-by-name'));
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('name desc');
      });
    });

    it('sorts by count in desc order by default', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('payee-list')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('sort-by-count'));
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('count desc');
      });
    });

    it('sorts by category in asc order by default', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('payee-list')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('sort-by-category'));
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('category asc');
      });
    });
  });

  describe('Auto-Assign Categories', () => {
    it('opens auto-assign dialog when button is clicked', async () => {
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Auto-Assign Categories' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-Assign Categories' }));
      await waitFor(() => expect(screen.getByTestId('auto-assign-dialog')).toBeInTheDocument());
    });
  });

  describe('Apply Default Categories', () => {
    it('renders the Apply Default Categories button', async () => {
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Apply Default Categories' })).toBeInTheDocument();
    });

    it('backfills each payee default category into its uncategorized transactions', async () => {
      mockGetAllPayees.mockResolvedValue([
        { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { id: 'cat-1', name: 'Food' }, transactionCount: 50, uncategorizedCount: 5, isActive: true },
        { id: 'p-3', name: 'Amazon', defaultCategoryId: null, defaultCategory: null, transactionCount: 35, uncategorizedCount: 3, isActive: true },
      ]);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 1, transactionsBackfilled: 5 });
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Apply Default Categories' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Default Categories' })); });
      await act(async () => { fireEvent.click(screen.getByText('Apply', { exact: true })); });
      await waitFor(() =>
        expect(mockApplyCategorySuggestions).toHaveBeenCalledWith([
          { payeeId: 'p-1', categoryId: 'cat-1', backfillTransactions: true },
        ]),
      );
    });

    it('only targets payees that have a default category AND uncategorized transactions', async () => {
      mockGetAllPayees.mockResolvedValue([
        // has default + uncategorized -> included
        { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { id: 'cat-1', name: 'Food' }, transactionCount: 50, uncategorizedCount: 5, isActive: true },
        // has default but nothing uncategorized -> excluded
        { id: 'p-2', name: 'Gas Station', defaultCategoryId: 'cat-2', defaultCategory: { id: 'cat-2', name: 'Auto' }, transactionCount: 20, uncategorizedCount: 0, isActive: true },
        // uncategorized but no default category -> excluded
        { id: 'p-3', name: 'Amazon', defaultCategoryId: null, defaultCategory: null, transactionCount: 35, uncategorizedCount: 3, isActive: true },
      ]);
      mockApplyCategorySuggestions.mockResolvedValue({ updated: 1, transactionsBackfilled: 5 });
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Apply Default Categories' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Default Categories' })); });
      await act(async () => { fireEvent.click(screen.getByText('Apply', { exact: true })); });
      await waitFor(() =>
        expect(mockApplyCategorySuggestions).toHaveBeenCalledWith([
          { payeeId: 'p-1', categoryId: 'cat-1', backfillTransactions: true },
        ]),
      );
    });

    it('does nothing and does not call the API when there is nothing to backfill', async () => {
      mockGetAllPayees.mockResolvedValue([
        { id: 'p-2', name: 'Gas Station', defaultCategoryId: 'cat-2', defaultCategory: { id: 'cat-2', name: 'Auto' }, transactionCount: 20, uncategorizedCount: 0, isActive: true },
      ]);
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Apply Default Categories' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Default Categories' })); });
      await act(async () => { fireEvent.click(screen.getByText('Apply', { exact: true })); });
      expect(mockApplyCategorySuggestions).not.toHaveBeenCalled();
    });

    it('does not call the API when the confirmation is cancelled', async () => {
      mockGetAllPayees.mockResolvedValue([
        { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { id: 'cat-1', name: 'Food' }, transactionCount: 50, uncategorizedCount: 5, isActive: true },
      ]);
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Apply Default Categories' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Apply Default Categories' })); });
      await act(async () => { fireEvent.click(screen.getByText('Cancel', { exact: true })); });
      expect(mockApplyCategorySuggestions).not.toHaveBeenCalled();
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner while data is loading', async () => {
      mockGetAllPayees.mockReturnValue(new Promise(() => {}));
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument());
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when data loading fails', async () => {
      mockGetAllPayees.mockRejectedValue(new Error('Network error'));
      render(<PayeesPage />);
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to load data'));
    });
  });

  describe('Pagination', () => {
    it('shows pagination when more payees than page size', async () => {
      // PAGE_SIZE is mocked to 25, so create 30 payees
      const manyPayees = Array.from({ length: 30 }, (_, i) => ({
        id: `p-${i}`,
        name: `Payee ${String(i).padStart(3, '0')}`,
        defaultCategoryId: null,
        defaultCategory: null,
        transactionCount: i,
        isActive: true,
      }));
      mockGetAllPayees.mockResolvedValue(manyPayees);
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('pagination')).toBeInTheDocument();
      });
    });

    it('does not show pagination when fewer payees than page size', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('payee-list')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('pagination')).not.toBeInTheDocument();
    });
  });

  describe('Form Actions', () => {
    it('opens create modal when + New Payee is clicked', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('+ New Payee')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText('+ New Payee')); });
      await waitFor(() => {
        expect(screen.getByTestId('modal')).toBeInTheDocument();
        expect(screen.getByText('New Payee')).toBeInTheDocument();
      });
    });

    it('opens edit modal with payee data', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-p-1')); });
      await waitFor(() => {
        expect(screen.getByText('Edit Payee')).toBeInTheDocument();
        expect(screen.getByTestId('editing-payee')).toHaveTextContent('Grocery Store');
      });
    });

    it('creates a payee on form submit', async () => {
      mockCreatePayee.mockResolvedValue({ id: 'p-new', name: 'New Payee' });
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('+ New Payee')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText('+ New Payee')); });
      await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => {
        expect(mockCreatePayee).toHaveBeenCalledWith({ name: 'New Payee', defaultCategoryId: null, notes: undefined });
        expect(toast.success).toHaveBeenCalledWith('Payee created successfully');
      });
    });

    it('creates a payee with pending aliases', async () => {
      mockCreatePayee.mockResolvedValue({ id: 'p-new', name: 'WithAliases' });
      mockCreateAlias.mockResolvedValue({});
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('+ New Payee')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText('+ New Payee')); });
      await waitFor(() => expect(screen.getByTestId('submit-with-aliases')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-with-aliases')); });
      await waitFor(() => {
        expect(mockCreateAlias).toHaveBeenCalledTimes(2);
        expect(mockCreateAlias).toHaveBeenCalledWith({ payeeId: 'p-new', alias: 'Alias1' });
      });
    });

    it('updates a payee on form submit in edit mode', async () => {
      mockUpdatePayee.mockResolvedValue({ id: 'p-1', name: 'New Payee', defaultCategoryId: null });
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-p-1')); });
      await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => {
        expect(mockUpdatePayee).toHaveBeenCalledWith('p-1', { name: 'New Payee', defaultCategoryId: null, notes: undefined });
        expect(toast.success).toHaveBeenCalledWith('Payee updated successfully');
      });
    });

    it('shows error toast when create payee fails', async () => {
      mockCreatePayee.mockRejectedValueOnce(new Error('fail'));
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByText('+ New Payee')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText('+ New Payee')); });
      await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to create payee');
      });
    });

    it('shows error toast when update payee fails', async () => {
      mockUpdatePayee.mockRejectedValueOnce(new Error('fail'));
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-p-1')); });
      await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to update payee');
      });
    });
  });

  describe('Reactivation and Merge', () => {
    it('reactivates a payee successfully', async () => {
      mockReactivatePayee.mockResolvedValue({ id: 'p-1', name: 'Grocery Store', isActive: true });
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('reactivate-p-1')); });
      await waitFor(() => {
        expect(mockReactivatePayee).toHaveBeenCalledWith('p-1');
        expect(toast.success).toHaveBeenCalledWith('Payee "Grocery Store" reactivated');
      });
    });

    it('keeps the list-only counts of a reactivated payee', async () => {
      mockGetAllPayees.mockResolvedValue([{ ...mockPayees[0], usageCount: 7 }]);
      // The response is the bare payee row, without usageCount.
      mockReactivatePayee.mockResolvedValue({ id: 'p-1', name: 'Grocery Store', isActive: true });
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('usage-p-1')).toHaveTextContent('7'));
      await act(async () => { fireEvent.click(screen.getByTestId('reactivate-p-1')); });
      await waitFor(() => expect(mockReactivatePayee).toHaveBeenCalledWith('p-1'));
      expect(screen.getByTestId('usage-p-1')).toHaveTextContent('7');
    });

    it('shows error toast when reactivate fails', async () => {
      mockReactivatePayee.mockRejectedValueOnce(new Error('fail'));
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('reactivate-p-1')); });
      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to reactivate payee');
      });
    });

    it('opens merge dialog when merge action is triggered', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('merge-p-1')); });
      await waitFor(() => expect(screen.getByTestId('merge-dialog')).toBeInTheDocument());
    });

    it('closes merge dialog', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('merge-p-1')); });
      await waitFor(() => expect(screen.getByTestId('merge-dialog')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('merge-close')); });
      expect(screen.queryByTestId('merge-dialog')).not.toBeInTheDocument();
    });

    it('removes deleted payee from list', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      expect(screen.getByTestId('payee-p-1')).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByTestId('delete-p-1')); });
      await waitFor(() => {
        expect(screen.queryByTestId('payee-p-1')).not.toBeInTheDocument();
      });
    });
  });

  describe('Status Filter', () => {
    it('renders status filter buttons', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByText(/All \(4\)/)).toBeInTheDocument();
        expect(screen.getByText(/Active \(4\)/)).toBeInTheDocument();
        expect(screen.getByText(/Inactive \(0\)/)).toBeInTheDocument();
      });
    });

    it('shows all payees when All is selected', async () => {
      const mixed = [
        ...mockPayees,
        { id: 'p-5', name: 'Inactive Co', defaultCategoryId: null, defaultCategory: null, transactionCount: 0, isActive: false },
      ];
      mockGetAllPayees.mockResolvedValue(mixed);
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText(/All \(5\)/)); });
      await waitFor(() => {
        expect(screen.getByTestId('payee-p-5')).toBeInTheDocument();
      });
    });

    it('filters to inactive payees', async () => {
      const mixed = [
        ...mockPayees,
        { id: 'p-5', name: 'Inactive Co', defaultCategoryId: null, defaultCategory: null, transactionCount: 0, isActive: false },
      ];
      mockGetAllPayees.mockResolvedValue(mixed);
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText(/Inactive \(1\)/)); });
      await waitFor(() => {
        expect(screen.queryByTestId('payee-p-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('payee-p-5')).toBeInTheDocument();
      });
    });
  });

  describe('Filter segments', () => {
    // The two filters are the shared segmented control: a named group whose
    // pressed segment reports itself, in a toolbar row that wraps on a phone.
    it('draws the status and category filters as segmented groups with the pressed segment marked', async () => {
      render(<PayeesPage />);
      const status = await screen.findByRole('group', { name: 'Status' });
      expect(status.className).toBe(SEGMENTED_TOOLBAR_GROUP_CLASS);
      const active = within(status).getByRole('button', { name: 'Active (4)' });
      expect(active).toHaveAttribute('aria-pressed', 'true');
      expect(active.className).toBe(toolbarSegmentClass(true));
      expect(within(status).getByRole('button', { name: 'All (4)' })).toHaveAttribute('aria-pressed', 'false');

      const category = screen.getByRole('group', { name: 'Default Category' });
      expect(category.className).toBe(SEGMENTED_TOOLBAR_GROUP_CLASS);
      expect(within(category).getByRole('button', { name: 'All Payees (4)' })).toHaveAttribute('aria-pressed', 'true');
      const noCategory = within(category).getByRole('button', { name: 'No Default Category (2)' });
      await act(async () => { fireEvent.click(noCategory); });
      expect(noCategory).toHaveAttribute('aria-pressed', 'true');
      expect(noCategory.className).toBe(toolbarSegmentClass(true));
      expect(status.parentElement!.className).toContain('flex-wrap');
    });
  });

  describe('Category Filter', () => {
    it('renders category filter buttons with counts', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByText(/All Payees \(4\)/)).toBeInTheDocument();
        expect(screen.getByText(/No Default Category \(2\)/)).toBeInTheDocument();
        expect(screen.getByText(/Uncategorized Txns \(0\)/)).toBeInTheDocument();
      });
    });

    it('filters to payees without a default category', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText(/No Default Category \(2\)/)); });
      await waitFor(() => {
        expect(screen.queryByTestId('payee-p-1')).not.toBeInTheDocument();
        expect(screen.queryByTestId('payee-p-2')).not.toBeInTheDocument();
        expect(screen.getByTestId('payee-p-3')).toBeInTheDocument();
        expect(screen.getByTestId('payee-p-4')).toBeInTheDocument();
      });
    });

    it('filters to payees that have uncategorized transactions', async () => {
      const withUncat = [
        { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { name: 'Food' }, transactionCount: 50, uncategorizedCount: 5, isActive: true },
        { id: 'p-2', name: 'Gas Station', defaultCategoryId: 'cat-2', defaultCategory: { name: 'Auto' }, transactionCount: 20, uncategorizedCount: 0, isActive: true },
      ];
      mockGetAllPayees.mockResolvedValue(withUncat);
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByText(/Uncategorized Txns \(1\)/)); });
      await waitFor(() => {
        expect(screen.getByTestId('payee-p-1')).toBeInTheDocument();
        expect(screen.queryByTestId('payee-p-2')).not.toBeInTheDocument();
      });
    });
  });

  describe('Apply category to transactions', () => {
    it('passes the apply mode through, toasts, and reloads when transactions are categorized', async () => {
      mockUpdatePayee.mockResolvedValue({ id: 'p-1', name: 'Updated', defaultCategoryId: 'cat-1', transactionsCategorized: 7 });
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('edit-p-1')); });
      await waitFor(() => expect(screen.getByTestId('submit-apply-category')).toBeInTheDocument());
      mockGetAllPayees.mockClear();
      await act(async () => { fireEvent.click(screen.getByTestId('submit-apply-category')); });
      await waitFor(() => {
        expect(mockUpdatePayee).toHaveBeenCalledWith('p-1', { name: 'Updated', defaultCategoryId: 'cat-1', notes: undefined, applyCategoryToTransactions: 'all' });
        expect(toast.success).toHaveBeenCalledWith('Categorized 7 transactions');
        expect(mockGetAllPayees).toHaveBeenCalled();
      });
    });
  });

  describe('Sorting', () => {
    it('sorts by aliases', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('sort-by-aliases')); });
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('aliases desc');
      });
    });

    it('sorts by lastUsed', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('sort-by-lastUsed')); });
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('lastUsed desc');
      });
    });

    it('sorts by createdAt', async () => {
      render(<PayeesPage />);
      await waitFor(() => expect(screen.getByTestId('payee-list')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('sort-by-createdAt')); });
      await waitFor(() => {
        expect(screen.getByTestId('sort-info')).toHaveTextContent('createdAt desc');
      });
    });
  });

  describe('Deactivate Unused', () => {
    it('opens deactivate dialog when Deactivate Unused button is clicked', async () => {
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Deactivate Unused' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate Unused' })); });
      await waitFor(() => expect(screen.getByTestId('deactivate-dialog')).toBeInTheDocument());
    });

    it('closes deactivate dialog', async () => {
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Deactivate Unused' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate Unused' })); });
      await waitFor(() => expect(screen.getByTestId('deactivate-dialog')).toBeInTheDocument());
      await act(async () => { fireEvent.click(screen.getByTestId('deactivate-close')); });
      expect(screen.queryByTestId('deactivate-dialog')).not.toBeInTheDocument();
    });

    it('triggers data reload via auto-assign success callback', async () => {
      render(<PayeesPage />);
      await openMaintenance();
      expect(screen.getByRole('menuitem', { name: 'Auto-Assign Categories' })).toBeInTheDocument();
      await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Auto-Assign Categories' })); });
      await waitFor(() => expect(screen.getByTestId('auto-assign-dialog')).toBeInTheDocument());
      mockGetAllPayees.mockClear();
      await act(async () => { fireEvent.click(screen.getByTestId('auto-assign-success')); });
      await waitFor(() => {
        expect(mockGetAllPayees).toHaveBeenCalled();
      });
    });
  });
});
