import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import PayeesPage from './page';
import toast from 'react-hot-toast';

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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
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

vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: (...args: any[]) => mockGetAllPayees(...args),
    create: (...args: any[]) => mockCreatePayee(...args),
    update: (...args: any[]) => mockUpdatePayee(...args),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAllCategories(...args),
  },
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

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, defaultValue: any) => [defaultValue, vi.fn()],
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
  SummaryIcons: { users: null, checkCircle: null, warning: null },
}));

vi.mock('@/components/ui/Pagination', () => ({
  Pagination: ({ currentPage, totalPages }: any) => <div data-testid="pagination">Page {currentPage} of {totalPages}</div>,
}));

vi.mock('@/components/payees/PayeeForm', () => ({
  PayeeForm: () => <div data-testid="payee-form">PayeeForm</div>,
}));

vi.mock('@/components/payees/PayeeList', () => ({
  PayeeList: ({ payees, sortField, sortDirection, onSort }: any) => (
    <div data-testid="payee-list">
      {payees.map((p: any) => <div key={p.id} data-testid={`payee-${p.id}`}>{p.name}</div>)}
      <span data-testid="sort-info">{sortField} {sortDirection}</span>
      <button data-testid="sort-by-name" onClick={() => onSort('name')}>Sort Name</button>
      <button data-testid="sort-by-count" onClick={() => onSort('count')}>Sort Count</button>
      <button data-testid="sort-by-category" onClick={() => onSort('category')}>Sort Category</button>
    </div>
  ),
}));

vi.mock('@/components/payees/CategoryAutoAssignDialog', () => ({
  CategoryAutoAssignDialog: ({ isOpen }: any) => isOpen ? <div data-testid="auto-assign-dialog">Auto-Assign</div> : null,
}));

const mockPayees = [
  { id: 'p-1', name: 'Grocery Store', defaultCategoryId: 'cat-1', defaultCategory: { name: 'Food' }, transactionCount: 50 },
  { id: 'p-2', name: 'Gas Station', defaultCategoryId: 'cat-2', defaultCategory: { name: 'Auto' }, transactionCount: 20 },
  { id: 'p-3', name: 'Amazon', defaultCategoryId: null, defaultCategory: null, transactionCount: 35 },
  { id: 'p-4', name: 'Electric Co', defaultCategoryId: null, defaultCategory: null, transactionCount: 12 },
];

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

    it('renders New Payee and Auto-Assign buttons', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByText('+ New Payee')).toBeInTheDocument();
        expect(screen.getByText('Auto-Assign Categories')).toBeInTheDocument();
      });
    });
  });

  describe('Summary Cards', () => {
    it('renders all three summary cards', async () => {
      render(<PayeesPage />);
      await waitFor(() => {
        expect(screen.getByTestId('summary-Total Payees')).toHaveTextContent('4');
        expect(screen.getByTestId('summary-With Category')).toHaveTextContent('2');
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
      await waitFor(() => expect(screen.getByText('Auto-Assign Categories')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Auto-Assign Categories'));
      await waitFor(() => expect(screen.getByTestId('auto-assign-dialog')).toBeInTheDocument());
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
});
