import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import CategoriesPage from './page';
import toast from 'react-hot-toast';

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

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_e: any, fallback: string) => fallback),
}));

// Mock categories API
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockImportDefaults = vi.fn();

vi.mock('@/lib/categories', () => ({
  categoriesApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
    importDefaults: (...args: any[]) => mockImportDefaults(...args),
  },
}));

// Track useFormModal state
let mockOpenCreate: ReturnType<typeof vi.fn>;
let mockOpenEdit: ReturnType<typeof vi.fn>;
let mockClose: ReturnType<typeof vi.fn>;
let mockSetFormDirty: ReturnType<typeof vi.fn>;
let formModalState = {
  showForm: false,
  editingItem: undefined as any,
  isEditing: false,
};

vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => {
    mockOpenCreate = vi.fn(() => {
      formModalState = { showForm: true, editingItem: undefined, isEditing: false };
    });
    mockOpenEdit = vi.fn((item: any) => {
      formModalState = { showForm: true, editingItem: item, isEditing: true };
    });
    mockClose = vi.fn(() => {
      formModalState = { showForm: false, editingItem: undefined, isEditing: false };
    });
    mockSetFormDirty = vi.fn();
    return {
      ...formModalState,
      openCreate: mockOpenCreate,
      openEdit: mockOpenEdit,
      close: mockClose,
      modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
      setFormDirty: mockSetFormDirty,
      unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
      formSubmitRef: { current: null },
    };
  },
}));

// Mock child components
vi.mock('@/components/categories/CategoryForm', () => ({
  CategoryForm: ({ onSubmit, category }: any) => (
    <div data-testid="category-form">
      CategoryForm
      {category && <span data-testid="editing-category">{category.name}</span>}
      <button data-testid="submit-form" onClick={() => onSubmit({ name: 'Test', isIncome: false })}>Submit</button>
    </div>
  ),
}));

vi.mock('@/components/categories/CategoryList', () => ({
  CategoryList: ({ categories, onEdit }: any) => (
    <div data-testid="category-list">
      {categories.map((c: any) => (
        <div key={c.id} data-testid={`category-${c.id}`}>
          {c.name}
          <button data-testid={`edit-${c.id}`} onClick={() => onEdit(c)}>Edit</button>
        </div>
      ))}
    </div>
  ),
  DensityLevel: {},
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
  SummaryIcons: { tag: null, plusCircle: null, minus: null, list: null },
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

vi.mock('@/hooks/useLocalStorage', () => ({
  useLocalStorage: (key: string, defaultValue: any) => [defaultValue, vi.fn()],
}));

const mockCategories = [
  { id: 'cat-1', name: 'Salary', isIncome: true, parentId: null, description: null, icon: null, color: null },
  { id: 'cat-2', name: 'Groceries', isIncome: false, parentId: null, description: null, icon: null, color: null },
  { id: 'cat-3', name: 'Rent', isIncome: false, parentId: null, description: null, icon: null, color: null },
  { id: 'cat-4', name: 'Organic', isIncome: false, parentId: 'cat-2', description: null, icon: null, color: null },
];

describe('CategoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formModalState = { showForm: false, editingItem: undefined, isEditing: false };
    mockGetAll.mockResolvedValue([]);
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

  it('shows loading spinner while data is loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('shows correct summary counts with categories', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Categories')).toHaveTextContent('4');
      expect(screen.getByTestId('summary-Income Categories')).toHaveTextContent('1');
      expect(screen.getByTestId('summary-Expense Categories')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Top-Level')).toHaveTextContent('3');
    });
  });

  it('renders category list when categories exist', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
  });

  it('renders + New Category button', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Category')).toBeInTheDocument();
    });
  });

  it('renders filter tabs for All, Expense, Income', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/All \(4\)/)).toBeInTheDocument();
      expect(screen.getByText(/Expense \(3\)/)).toBeInTheDocument();
      expect(screen.getByText(/Income \(1\)/)).toBeInTheDocument();
    });
  });

  it('filters to expense categories when Expense tab is clicked', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Expense \(3\)/));
    await waitFor(() => {
      expect(screen.queryByTestId('category-cat-1')).not.toBeInTheDocument();
      expect(screen.getByTestId('category-cat-2')).toBeInTheDocument();
    });
  });

  it('filters to income categories when Income tab is clicked', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Income \(1\)/));
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-1')).toBeInTheDocument();
      expect(screen.queryByTestId('category-cat-2')).not.toBeInTheDocument();
    });
  });

  it('shows total count text for filtered categories', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('4 categories')).toBeInTheDocument();
    });
  });

  it('shows singular "category" for count of 1', async () => {
    mockGetAll.mockResolvedValue([mockCategories[0]]);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('1 category')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully and shows toast', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load categories');
    });
  });

  it('empty state shows Import Default Categories button', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Import Default Categories')).toBeInTheDocument();
    });
  });

  it('empty state shows Create Your Own button', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Create Your Own')).toBeInTheDocument();
    });
  });

  it('calls importDefaults when Import Default Categories is clicked', async () => {
    mockImportDefaults.mockResolvedValueOnce({ categoriesCreated: 15 });
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Import Default Categories')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Import Default Categories'));
    });
    await waitFor(() => {
      expect(mockImportDefaults).toHaveBeenCalled();
    });
  });

  it('shows success toast after importing default categories', async () => {
    mockImportDefaults.mockResolvedValueOnce({ categoriesCreated: 15 });
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Import Default Categories')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Import Default Categories'));
    });
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Successfully imported 15 categories');
    });
  });

  it('shows error toast when import fails', async () => {
    mockImportDefaults.mockRejectedValueOnce(new Error('Import failed'));
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText('Import Default Categories')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Import Default Categories'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to import default categories');
    });
  });

  it('displays empty state hint about default categories', async () => {
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/The default set includes common income and expense categories/i)).toBeInTheDocument();
    });
  });
});
