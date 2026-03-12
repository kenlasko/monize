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
vi.mock('@/components/tags/TagForm', () => ({
  TagForm: ({ onSubmit, tag }: any) => (
    <div data-testid="tag-form">
      TagForm
      {tag && <span data-testid="editing-tag">{tag.name}</span>}
      <button data-testid="submit-form" onClick={() => onSubmit({ name: 'Test Tag' })}>Submit</button>
    </div>
  ),
}));

vi.mock('@/components/tags/TagList', () => ({
  TagList: ({ tags, onEdit, onDelete }: any) => (
    <div data-testid="tag-list">
      {tags.map((t: any) => (
        <div key={t.id} data-testid={`tag-${t.id}`}>
          {t.name}
          <button data-testid={`edit-${t.id}`} onClick={() => onEdit(t)}>Edit</button>
          <button data-testid={`delete-${t.id}`} onClick={() => onDelete(t)}>Delete</button>
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

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, onConfirm, onCancel, message }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <span>{message}</span>
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

const mockTags = [
  { id: 'tag-1', userId: 'u1', name: 'Groceries', color: '#22c55e', icon: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
  { id: 'tag-2', userId: 'u1', name: 'Urgent', color: null, icon: 'star', createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
  { id: 'tag-3', userId: 'u1', name: 'Recurring', color: '#3b82f6', icon: null, createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' },
];

describe('TagsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formModalState = { showForm: false, editingItem: undefined, isEditing: false };
    mockGetAll.mockResolvedValue([]);
  });

  it('renders the page header with title', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('Tags')).toBeInTheDocument();
    });
  });

  it('renders the subtitle', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Label your transactions with custom tags/i)).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders summary cards', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Tags')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Tags with Colour')).toBeInTheDocument();
      expect(screen.getByTestId('summary-Tags with Icon')).toBeInTheDocument();
    });
  });

  it('shows empty state when no tags exist', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText(/No tags yet/i)).toBeInTheDocument();
    });
  });

  it('shows loading spinner while data is loading', async () => {
    mockGetAll.mockReturnValue(new Promise(() => {}));
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    });
  });

  it('shows correct summary counts with tags', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('summary-Total Tags')).toHaveTextContent('3');
      expect(screen.getByTestId('summary-Tags with Colour')).toHaveTextContent('2');
      expect(screen.getByTestId('summary-Tags with Icon')).toHaveTextContent('1');
    });
  });

  it('renders tag list when tags exist', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('tag-list')).toBeInTheDocument();
    });
  });

  it('renders + New Tag button', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Tag')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tags...')).toBeInTheDocument();
    });
  });

  it('filters tags by search query', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('tag-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'Urgent' } });
    await waitFor(() => {
      expect(screen.getByTestId('tag-tag-2')).toBeInTheDocument();
      expect(screen.queryByTestId('tag-tag-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tag-tag-3')).not.toBeInTheDocument();
    });
  });

  it('search is case-insensitive', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByTestId('tag-list')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByPlaceholderText('Search tags...'), { target: { value: 'groceries' } });
    await waitFor(() => {
      expect(screen.getByTestId('tag-tag-1')).toBeInTheDocument();
    });
  });

  it('shows total count text for tags', async () => {
    mockGetAll.mockResolvedValue(mockTags);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('3 tags')).toBeInTheDocument();
    });
  });

  it('shows singular "tag" for count of 1', async () => {
    mockGetAll.mockResolvedValue([mockTags[0]]);
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('1 tag')).toBeInTheDocument();
    });
  });

  it('handles API error gracefully and shows toast', async () => {
    mockGetAll.mockRejectedValueOnce(new Error('Network error'));
    render(<TagsPage />);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to load tags');
    });
  });

  it('empty state shows Create Your First Tag button', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('Create Your First Tag')).toBeInTheDocument();
    });
  });

  it('opens create modal when + New Tag is clicked', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('+ New Tag')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Tag'));
    });
    expect(mockOpenCreate).toHaveBeenCalled();
  });

  it('opens create modal from empty state button', async () => {
    render(<TagsPage />);
    await waitFor(() => {
      expect(screen.getByText('Create Your First Tag')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Create Your First Tag'));
    });
    expect(mockOpenCreate).toHaveBeenCalled();
  });
});
