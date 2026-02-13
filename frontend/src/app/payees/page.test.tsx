import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import PayeesPage from './page';

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
vi.mock('@/lib/payees', () => ({
  payeesApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'p1', name: 'Grocery Store', defaultCategoryId: 'c1', defaultCategory: { id: 'c1', name: 'Food' }, transactionCount: 5 },
      { id: 'p2', name: 'Gas Station', defaultCategoryId: null, defaultCategory: null, transactionCount: 3 },
      { id: 'p3', name: 'Rent', defaultCategoryId: 'c2', defaultCategory: { id: 'c2', name: 'Housing' }, transactionCount: 12 },
    ]),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([
      { id: 'c1', name: 'Food' },
      { id: 'c2', name: 'Housing' },
    ]),
  },
}));

// Mock child components
vi.mock('@/components/payees/PayeeList', () => ({
  PayeeList: ({ payees }: any) => (
    <div data-testid="payee-list">
      {payees.map((p: any) => (
        <div key={p.id} data-testid={`payee-${p.id}`}>{p.name}</div>
      ))}
    </div>
  ),
  DensityLevel: {},
  SortField: {},
  SortDirection: {},
}));

vi.mock('@/components/payees/PayeeForm', () => ({
  PayeeForm: () => <div data-testid="payee-form">PayeeForm</div>,
}));

vi.mock('@/components/payees/CategoryAutoAssignDialog', () => ({
  CategoryAutoAssignDialog: ({ isOpen }: any) =>
    isOpen ? <div data-testid="auto-assign-dialog">AutoAssignDialog</div> : null,
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
  Pagination: () => <div data-testid="pagination">Pagination</div>,
}));

vi.mock('@/components/ui/Button', () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>{children}</button>
  ),
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
      {actions && <div data-testid="page-header-actions">{actions}</div>}
    </div>
  ),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: undefined,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: false,
    modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
    setFormDirty: vi.fn(),
    unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
    formSubmitRef: { current: null },
  }),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (error: any, fallback: string) => fallback,
}));

describe('PayeesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page header with Payees title', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('Payees')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('Manage your payees and their default categories')).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Payees')).toBeInTheDocument();
      expect(screen.getByTestId('summary-With Category')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Without Category')).toBeInTheDocument();
    });
  });

  it('renders summary card values after data loads', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      // 3 total payees, 2 with category, 1 without
      expect(screen.getByTestId('summary-Total Payees')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-With Category')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Without Category')).toHaveTextContent('1');
    });
  });

  it('renders search input', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search payees...')).toBeInTheDocument();
    });
  });

  it('renders the payee list after loading', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('payee-list')).toBeInTheDocument();
    });
  });

  it('renders payees in the list', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('Grocery Store')).toBeInTheDocument();
      expect(screen.getByText('Gas Station')).toBeInTheDocument();
      expect(screen.getByText('Rent')).toBeInTheDocument();
    });
  });

  it('renders create payee button', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Payee')).toBeInTheDocument();
    });
  });

  it('renders auto-assign categories button', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('Auto-Assign Categories')).toBeInTheDocument();
    });
  });

  it('shows total count when single page', async () => {
    render(<PayeesPage />);
    await waitFor(() => {
      expect(screen.getByText('3 payees')).toBeInTheDocument();
    });
  });
});
