import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
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

// Stateful useFormModal mock
vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => {
    const [showForm, setShowForm] = useState(false);
    const [editingItem, setEditingItem] = useState<any>(undefined);
    const openCreate = () => { setEditingItem(undefined); setShowForm(true); };
    const openEdit = (item: any) => { setEditingItem(item); setShowForm(true); };
    const close = () => { setEditingItem(undefined); setShowForm(false); };
    return {
      showForm,
      editingItem,
      openCreate,
      openEdit,
      close,
      isEditing: !!editingItem,
      modalProps: { pushHistory: true, onBeforeClose: vi.fn() },
      setFormDirty: vi.fn(),
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
      <button data-testid="submit-form" onClick={() => Promise.resolve(onSubmit({ name: 'Test', isIncome: false })).catch(() => {})}>Submit</button>
      <button data-testid="submit-form-full" onClick={() => Promise.resolve(onSubmit({ name: 'Full', isIncome: true, parentId: 'cat-1', description: 'desc', icon: 'star', color: '#fff' })).catch(() => {})}>SubmitFull</button>
    </div>
  ),
}));

vi.mock('@/components/categories/CategoryList', () => ({
  CategoryList: ({ categories, onEdit, onRefresh, onDelete, sortField, sortDirection, onSort, density, onDensityChange }: any) => (
    <div data-testid="category-list">
      <span data-testid="sort-info">{sortField} {sortDirection}</span>
      <span data-testid="density-info">{density}</span>
      <button data-testid="density-btn" onClick={() => onDensityChange('compact')}>Density</button>
      <button data-testid="sort-name" onClick={() => onSort('name')}>SortByName</button>
      <button data-testid="sort-count" onClick={() => onSort('count')}>SortByCount</button>
      <button data-testid="refresh" onClick={() => onRefresh()}>Refresh</button>
      {categories.map((c: any) => (
        <div key={c.id} data-testid={`category-${c.id}`}>
          {c.name}
          <button data-testid={`edit-${c.id}`} onClick={() => onEdit(c)}>Edit</button>
          <button data-testid={`delete-${c.id}`} onClick={() => onDelete(c.id)}>Delete</button>
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
  useLocalStorage: (_key: string, defaultValue: any) => useState(defaultValue),
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

  it('renders filter buttons for All, Expenses, Income with counts', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByText(/All \(4\)/)).toBeInTheDocument();
      expect(screen.getByText(/Expenses \(3\)/)).toBeInTheDocument();
      expect(screen.getByText(/Income \(1\)/)).toBeInTheDocument();
    });
  });

  it('filters to expense categories when Expenses button is clicked', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Expenses \(3\)/));
    await waitFor(() => {
      expect(screen.queryByTestId('category-cat-1')).not.toBeInTheDocument();
      expect(screen.getByTestId('category-cat-2')).toBeInTheDocument();
    });
  });

  it('filters to income categories when Income button is clicked', async () => {
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

  it('renders search input', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search categories...')).toBeInTheDocument();
    });
  });

  it('filters categories by search query', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search categories...'), { target: { value: 'Salary' } });
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-1')).toBeInTheDocument();
      expect(screen.queryByTestId('category-cat-2')).not.toBeInTheDocument();
    });
  });

  it('search is case-insensitive', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search categories...'), { target: { value: 'salary' } });
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-1')).toBeInTheDocument();
    });
  });

  it('search by subcategory name includes the parent so the tree row renders', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    // 'Organic' is a subcategory of 'Groceries' (cat-2). Searching for it
    // should surface both the subcategory and its parent so the hierarchy
    // row renders in the tree view.
    fireEvent.change(screen.getByPlaceholderText('Search categories...'), { target: { value: 'Organic' } });
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-4')).toBeInTheDocument();
      expect(screen.getByTestId('category-cat-2')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('category-cat-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('category-cat-3')).not.toBeInTheDocument();
  });

  it('search by parent name includes all its subcategories', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search categories...'), { target: { value: 'Groceries' } });
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-2')).toBeInTheDocument();
      expect(screen.getByTestId('category-cat-4')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('category-cat-1')).not.toBeInTheDocument();
  });

  it('combines search with type filter', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => {
      expect(screen.getByTestId('category-list')).toBeInTheDocument();
    });
    // Filter to expenses first
    fireEvent.click(screen.getByText(/Expenses \(3\)/));
    // Then search
    fireEvent.change(screen.getByPlaceholderText('Search categories...'), { target: { value: 'Rent' } });
    await waitFor(() => {
      expect(screen.getByTestId('category-cat-3')).toBeInTheDocument();
      expect(screen.queryByTestId('category-cat-1')).not.toBeInTheDocument();
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

  it('opens create modal when + New Category is clicked', async () => {
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByText('+ New Category')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Category'));
    });
    await waitFor(() => {
      expect(screen.getByText('New Category')).toBeInTheDocument();
      expect(screen.getByTestId('category-form')).toBeInTheDocument();
    });
  });

  it('opens edit modal when edit is clicked on category', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-cat-1'));
    });
    await waitFor(() => {
      expect(screen.getByText('Edit Category')).toBeInTheDocument();
      expect(screen.getByTestId('editing-category')).toHaveTextContent('Salary');
    });
  });

  it('opens create modal from empty state Create Your Own', async () => {
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByText('Create Your Own')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByText('Create Your Own'));
    });
    await waitFor(() => expect(screen.getByText('New Category')).toBeInTheDocument());
  });

  it('creates category when form is submitted', async () => {
    mockCreate.mockResolvedValue({ id: 'cat-new', name: 'Test', isIncome: false });
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByText('+ New Category')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('+ New Category')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'Test', isIncome: false, parentId: null, description: null, icon: null, color: null });
      expect(toast.success).toHaveBeenCalledWith('Category created successfully');
    });
  });

  it('preserves provided fields when creating category', async () => {
    mockCreate.mockResolvedValue({ id: 'cat-new', name: 'Full' });
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByText('+ New Category')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('+ New Category')); });
    await waitFor(() => expect(screen.getByTestId('submit-form-full')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form-full')); });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'Full', isIncome: true, parentId: 'cat-1', description: 'desc', icon: 'star', color: '#fff' });
    });
  });

  it('updates category when form is submitted in edit mode', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    mockUpdate.mockResolvedValue(mockCategories[0]);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('edit-cat-1')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('cat-1', expect.objectContaining({ name: 'Test', isIncome: false }));
      expect(toast.success).toHaveBeenCalledWith('Category updated successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('fail'));
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByText('+ New Category')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByText('+ New Category')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create category');
    });
  });

  it('shows error toast when update fails', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    mockUpdate.mockRejectedValueOnce(new Error('fail'));
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('edit-cat-1')); });
    await waitFor(() => expect(screen.getByTestId('submit-form')).toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByTestId('submit-form')); });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update category');
    });
  });

  it('toggles sort direction when clicking same sort field', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    expect(screen.getByTestId('sort-info')).toHaveTextContent('name asc');
    fireEvent.click(screen.getByTestId('sort-name'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-info')).toHaveTextContent('name desc');
    });
  });

  it('switches to count sort with desc default', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sort-count'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-info')).toHaveTextContent('count desc');
    });
  });

  it('refreshCategories handles error gracefully', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    mockGetAll.mockRejectedValueOnce(new Error('Refresh fail'));
    await act(async () => { fireEvent.click(screen.getByTestId('refresh')); });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load categories');
    });
  });

  it('removes deleted category from list', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    expect(screen.getByTestId('category-cat-2')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByTestId('delete-cat-2')); });
    await waitFor(() => {
      // cat-2 and cat-4 (its child) are removed
      expect(screen.queryByTestId('category-cat-2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('category-cat-4')).not.toBeInTheDocument();
    });
  });

  it('updates list density when changed', async () => {
    mockGetAll.mockResolvedValue(mockCategories);
    render(<CategoriesPage />);
    await waitFor(() => expect(screen.getByTestId('category-list')).toBeInTheDocument());
    expect(screen.getByTestId('density-info')).toHaveTextContent('normal');
    fireEvent.click(screen.getByTestId('density-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('density-info')).toHaveTextContent('compact');
    });
  });
});
