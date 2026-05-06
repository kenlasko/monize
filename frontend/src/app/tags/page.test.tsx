import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import TagsPage from './page';
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

// Mock tags API
const mockGetAll = vi.fn().mockResolvedValue([]);
const mockCreate = vi.fn();
const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockGetTransactionCount = vi.fn().mockResolvedValue(0);
const mockGetAllTransactionCounts = vi.fn().mockResolvedValue({});

vi.mock('@/lib/tags', () => ({
  tagsApi: {
    getAll: (...args: any[]) => mockGetAll(...args),
    create: (...args: any[]) => mockCreate(...args),
    update: (...args: any[]) => mockUpdate(...args),
    delete: (...args: any[]) => mockDelete(...args),
    getTransactionCount: (...args: any[]) => mockGetTransactionCount(...args),
    getAllTransactionCounts: (...args: any[]) => mockGetAllTransactionCounts(...args),
  },
}));

// Stateful useFormModal mock that preserves state across renders within a single test
const formModalRef: { current: any } = { current: null };
vi.mock('@/hooks/useFormModal', () => ({
  useFormModal: () => {
    const [showForm, setShowForm] = useState(false);
    const [editingItem, setEditingItem] = useState<any>(undefined);
    const openCreate = () => {
      setEditingItem(undefined);
      setShowForm(true);
    };
    const openEdit = (item: any) => {
      setEditingItem(item);
      setShowForm(true);
    };
    const close = () => {
      setEditingItem(undefined);
      setShowForm(false);
    };
    const value = {
      showForm,
      editingItem,
      openCreate,
      openEdit,
      close,
      isEditing: !!editingItem,
      modalProps: { pushHistory: false, onBeforeClose: vi.fn() },
      setFormDirty: vi.fn(),
      unsavedChangesDialog: { isOpen: false, onSave: vi.fn(), onDiscard: vi.fn(), onCancel: vi.fn() },
      formSubmitRef: { current: null },
    };
    formModalRef.current = value;
    return value;
  },
}));

// Mock child components
vi.mock('@/components/tags/TagForm', () => ({
  TagForm: ({ onSubmit, tag }: any) => (
    <div data-testid="tag-form">
      TagForm
      {tag && <span data-testid="editing-tag">{tag.name}</span>}
      <button data-testid="submit-form" onClick={() => Promise.resolve(onSubmit({ name: 'Test Tag', color: '', icon: '' })).catch(() => {})}>Submit</button>
      <button data-testid="submit-form-with-color" onClick={() => Promise.resolve(onSubmit({ name: 'New', color: '#ff0000', icon: 'star' })).catch(() => {})}>SubmitWithColor</button>
    </div>
  ),
}));

const mockOnSort = vi.fn();
vi.mock('@/components/tags/TagList', () => ({
  TagList: ({ tags, onEdit, onDelete, onTagClick, onSort, sortField, sortDirection, density, onDensityChange }: any) => {
    mockOnSort.mockImplementation((field: any) => onSort(field));
    return (
      <div data-testid="tag-list">
        <span data-testid="sort-info">{sortField} {sortDirection}</span>
        <span data-testid="density-info">{density}</span>
        <button data-testid="density-btn" onClick={() => onDensityChange('compact')}>Density</button>
        <button data-testid="sort-name" onClick={() => onSort('name')}>SortByName</button>
        <button data-testid="sort-count" onClick={() => onSort('count')}>SortByCount</button>
        <button data-testid="sort-created" onClick={() => onSort('createdAt')}>SortByCreated</button>
        {tags.map((t: any) => (
          <div key={t.id} data-testid={`tag-${t.id}`}>
            {t.name}
            <button data-testid={`edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
            <button data-testid={`delete-${t.id}`} onClick={() => onDelete(t)}>Delete</button>
            <button data-testid={`click-${t.id}`} onClick={() => onTagClick(t)}>Click</button>
          </div>
        ))}
      </div>
    );
  },
  DensityLevel: {},
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

vi.mock('@/components/ui/UnsavedChangesDialog', () => ({
  UnsavedChangesDialog: () => null,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, message }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <span data-testid="dialog-message">{message}</span>
        <button data-testid="confirm-delete" onClick={onConfirm}>Confirm</button>
        <button data-testid="cancel-delete" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
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

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const mockTags = [
  { id: 'tag-1', userId: 'u1', name: 'Groceries', color: '#22c55e', icon: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'tag-2', userId: 'u1', name: 'Urgent', color: null, icon: 'star', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
  { id: 'tag-3', userId: 'u1', name: 'Recurring', color: '#3b82f6', icon: null, createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' },
];

async function renderPage() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<TagsPage />);
  });
  return result!;
}

describe('TagsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAll.mockResolvedValue([]);
    mockGetAllTransactionCounts.mockResolvedValue({});
    mockGetTransactionCount.mockResolvedValue(0);
  });

  it('renders the page header with title', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/Label your transactions with custom tags/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Tags')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Tags with Colour')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Tags with Icon')).toBeInTheDocument();
    });
  });

  it('shows empty state when no tags exist', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText(/No tags yet/i)).toBeInTheDocument();
    });
  });

  it('shows loading spinner while data is loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    await renderPage();
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows correct summary counts with tags', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Tags')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Tags with Colour')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Tags with Icon')).toHaveTextContent('1');
    });
  });

  it('renders tag list when tags exist', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('tag-list')).toBeInTheDocument();
    });
  });

  it('renders + New Tag button', async () => {
    await renderPage();
    expect(screen.getByText('+ New Tag')).toBeInTheDocument();
  });

  it('renders search input', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();
    });
  });

  it('filters tags by search query', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'Urgent' } });
    expect(screen.getByTestId('tag-tag-2')).toBeInTheDocument();
    expect(screen.queryByTestId('tag-tag-1')).not.toBeInTheDocument();
  });

  it('search is case-insensitive', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'groceries' } });
    expect(screen.getByTestId('tag-tag-1')).toBeInTheDocument();
  });

  it('shows total count text for tags', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('3 tags')).toBeInTheDocument();
    });
  });

  it('shows singular "tag" for count of 1', async () => {
    mockGetAll.mockResolvedValue([mockTags[0]]);
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('1 tag')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully and shows toast', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    await renderPage();
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load tags');
    });
  });

  it('empty state shows Create Your First Tag button', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('Create Your First Tag')).toBeInTheDocument();
    });
  });

  it('opens create modal when + New Tag is clicked', async () => {
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Tag'));
    });
    expect(screen.getByTestId('modal')).toBeInTheDocument();
    expect(screen.getByText('New Tag')).toBeInTheDocument();
  });

  it('opens create modal from empty state button', async () => {
    await renderPage();
    await waitFor(() => {
      expect(screen.getByText('Create Your First Tag')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create Your First Tag'));
    });
    expect(screen.getByTestId('modal')).toBeInTheDocument();
  });

  it('opens edit modal when edit is clicked on a tag', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-tag-1'));
    });
    expect(screen.getByText('Edit Tag')).toBeInTheDocument();
    expect(screen.getByTestId('editing-tag')).toHaveTextContent('Groceries');
  });

  it('creates a tag when form is submitted in create mode', async () => {
    mockCreate.mockResolvedValue({ id: 'tag-new', name: 'Test Tag', color: null, icon: null });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Tag'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'Test Tag', color: null, icon: null });
      expect(toast.success).toHaveBeenCalledWith('Tag created successfully');
    });
  });

  it('creates tag preserving non-empty color/icon', async () => {
    mockCreate.mockResolvedValue({ id: 'tag-new', name: 'New', color: '#ff0000', icon: 'star' });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Tag'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form-with-color'));
    });
    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalledWith({ name: 'New', color: '#ff0000', icon: 'star' });
    });
  });

  it('updates a tag when form is submitted in edit mode', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockUpdate.mockResolvedValue(mockTags[0]);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-tag-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith('tag-1', { name: 'Test Tag', color: null, icon: null });
      expect(toast.success).toHaveBeenCalledWith('Tag updated successfully');
    });
  });

  it('shows error toast when create fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Create failed'));
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Tag'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to create tag');
    });
  });

  it('shows error toast when update fails', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockUpdate.mockRejectedValueOnce(new Error('Update failed'));
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('edit-tag-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('submit-form'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update tag');
    });
  });

  it('opens delete confirmation when delete is clicked', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockGetTransactionCount.mockResolvedValue(0);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });
  });

  it('shows transaction count in delete dialog when tag is in use', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockGetTransactionCount.mockResolvedValue(5);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('dialog-message')).toHaveTextContent(/used on 5 transaction/);
    });
  });

  it('shows singular "transaction" in delete dialog when count is 1', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockGetTransactionCount.mockResolvedValue(1);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('dialog-message')).toHaveTextContent(/used on 1 transaction\./);
    });
  });

  it('handles getTransactionCount error gracefully', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockGetTransactionCount.mockRejectedValueOnce(new Error('fail'));
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    });
  });

  it('deletes tag when confirmed', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockDelete.mockResolvedValue(undefined);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete'));
    });
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalledWith('tag-1');
      expect(toast.success).toHaveBeenCalledWith('Tag deleted successfully');
    });
  });

  it('cancels delete when cancel is clicked', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('cancel-delete'));
    });
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('shows error toast when delete fails', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    mockDelete.mockRejectedValueOnce(new Error('Delete failed'));
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('delete-tag-1'));
    });
    await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete'));
    });
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to delete tag');
    });
  });

  it('navigates to transactions page when tag is clicked', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('click-tag-1'));
    expect(mockPush).toHaveBeenCalledWith('/transactions?tagIds=tag-1');
  });

  it('toggles sort direction when clicking same sort field', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    expect(screen.getByTestId('sort-info')).toHaveTextContent('name asc');
    fireEvent.click(screen.getByTestId('sort-name'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-info')).toHaveTextContent('name desc');
    });
  });

  it('switches to count sort with asc default', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sort-count'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-info')).toHaveTextContent('count asc');
    });
  });

  it('switches to createdAt sort with desc default', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('sort-created'));
    await waitFor(() => {
      expect(screen.getByTestId('sort-info')).toHaveTextContent('createdAt desc');
    });
  });

  it('updates list density when changed', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    await renderPage();
    await waitFor(() => expect(screen.getByTestId('tag-list')).toBeInTheDocument());
    expect(screen.getByTestId('density-info')).toHaveTextContent('normal');
    fireEvent.click(screen.getByTestId('density-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('density-info')).toHaveTextContent('compact');
    });
  });
});
