import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import CategoriesPage from './page';

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

// Mock categories API
vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    importDefaults: vi.fn(),
  },
}));

// Mock child components
vi.mock('@/components/categories/CategoryForm', () => ({
  CategoryForm: () => <div data-testid="category-form">CategoryForm</div>,
}));

vi.mock('@/components/categories/CategoryList', () => ({
  CategoryList: () => <div data-testid="category-list">CategoryList</div>,
  DensityLevel: {},
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/SummaryCard', () => ({
  SummaryCard: ({ label, value }: any) => <div data-testid={`summary-${label}`}>{value}</div>,
  SummaryIcons: { tag: null, plusCircle: null, minus: null, list: null },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  ),
}));

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => ({
    showForm: false,
    editingItem: null,
    openCreate: vi.fn(),
    openEdit: vi.fn(),
    close: vi.fn(),
    isEditing: false,
  }),
}));

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

describe('CategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page header with title', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Categories')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/Organize your transactions/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Categories')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Income Categories')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Expense Categories')).toBeInTheDocument();
    });
  });

  it('shows empty state with import button when no categories exist', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/No categories yet/i)).toBeInTheDocument();
    });
  });
});
