import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import AdminUsersPage from './page';

const mockPush = vi.fn();

// Mock next/navigation (override global mock for push tracking)
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/admin/users',
  useSearchParams: () => new URLSearchParams(),
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

const mockUsers = [
  {
    id: 'user-1',
    email: 'admin@example.com',
    firstName: 'Admin',
    lastName: 'User',
    role: 'admin',
    isActive: true,
    hasPassword: true,
    createdAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-2',
    email: 'regular@example.com',
    firstName: 'Regular',
    lastName: 'User',
    role: 'user',
    isActive: true,
    hasPassword: true,
    createdAt: '2024-02-01T00:00:00Z',
  },
];

// Mock admin API
vi.mock('@/lib/admin', () => ({
  adminApi: {
    getUsers: vi.fn().mockResolvedValue([
      {
        id: 'user-1',
        email: 'admin@example.com',
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin',
        isActive: true,
        hasPassword: true,
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        id: 'user-2',
        email: 'regular@example.com',
        firstName: 'Regular',
        lastName: 'User',
        role: 'user',
        isActive: true,
        hasPassword: true,
        createdAt: '2024-02-01T00:00:00Z',
      },
    ]),
    updateUserRole: vi.fn(),
    updateUserStatus: vi.fn(),
    resetUserPassword: vi.fn(),
    deleteUser: vi.fn(),
  },
}));

// Mock auth store - admin user
const mockAuthStore = {
  user: { id: 'user-1', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', role: 'admin', hasPassword: true },
  isAuthenticated: true,
  isLoading: false,
  _hasHydrated: true,
  logout: vi.fn(),
};

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      return selector ? selector(mockAuthStore) : mockAuthStore;
    },
    {
      getState: vi.fn(() => mockAuthStore),
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

// Mock child components
vi.mock('@/components/admin/UserManagementTable', () => ({
  UserManagementTable: ({ users, onChangeRole, onToggleStatus, onResetPassword, onDeleteUser }: any) => (
    <div data-testid="user-management-table">
      {users.map((u: any) => (
        <div key={u.id} data-testid={`user-row-${u.id}`}>
          <span>{u.email}</span>
          <button data-testid={`role-btn-${u.id}`} onClick={() => onChangeRole(u, u.role === 'admin' ? 'user' : 'admin')}>
            Change Role
          </button>
          <button data-testid={`status-btn-${u.id}`} onClick={() => onToggleStatus(u)}>
            Toggle Status
          </button>
          <button data-testid={`reset-btn-${u.id}`} onClick={() => onResetPassword(u)}>
            Reset Password
          </button>
          <button data-testid={`delete-btn-${u.id}`} onClick={() => onDeleteUser(u)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  ),
}));

vi.mock('@/components/admin/ResetPasswordModal', () => ({
  ResetPasswordModal: ({ isOpen }: any) =>
    isOpen ? <div data-testid="reset-password-modal">ResetPasswordModal</div> : null,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <span>{message}</span>
        <button data-testid="confirm-btn" onClick={onConfirm}>Confirm</button>
        <button data-testid="cancel-btn" onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
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

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (error: any, fallback: string) => fallback,
}));

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to admin role
    mockAuthStore.user = {
      id: 'user-1',
      email: 'admin@example.com',
      firstName: 'Admin',
      lastName: 'User',
      role: 'admin',
      hasPassword: true,
    };
  });

  it('renders the page header with User Management title', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByText('User Management')).toBeInTheDocument();
    });
  });

  it('renders within page layout', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('page-layout')).toBeInTheDocument();
    });
  });

  it('renders user management table after loading', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('user-management-table')).toBeInTheDocument();
    });
  });

  it('displays user emails in the table', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByText('admin@example.com')).toBeInTheDocument();
      expect(screen.getByText('regular@example.com')).toBeInTheDocument();
    });
  });

  it('renders role change buttons for each user', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('role-btn-user-1')).toBeInTheDocument();
      expect(screen.getByTestId('role-btn-user-2')).toBeInTheDocument();
    });
  });

  it('renders status toggle buttons for each user', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('status-btn-user-1')).toBeInTheDocument();
      expect(screen.getByTestId('status-btn-user-2')).toBeInTheDocument();
    });
  });

  it('renders password reset buttons for each user', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('reset-btn-user-1')).toBeInTheDocument();
      expect(screen.getByTestId('reset-btn-user-2')).toBeInTheDocument();
    });
  });

  it('renders delete buttons for each user', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByTestId('delete-btn-user-1')).toBeInTheDocument();
      expect(screen.getByTestId('delete-btn-user-2')).toBeInTheDocument();
    });
  });

  it('renders null and redirects for non-admin users', () => {
    mockAuthStore.user = {
      id: 'user-2',
      email: 'regular@example.com',
      firstName: 'Regular',
      lastName: 'User',
      role: 'user',
      hasPassword: true,
    };

    const { container } = render(<AdminUsersPage />);
    expect(container.innerHTML).toBe('');
    expect(mockPush).toHaveBeenCalledWith('/dashboard');
  });

  it('shows subtitle with user count', async () => {
    render(<AdminUsersPage />);
    await waitFor(() => {
      expect(screen.getByText('2 users')).toBeInTheDocument();
    });
  });
});
