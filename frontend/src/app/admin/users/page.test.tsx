import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import AdminUsersPage from './page';

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

const mockRouterPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/admin/users',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', role: 'admin', hasPassword: true },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', role: 'admin', hasPassword: true },
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

const mockGetUsers = vi.fn();
const mockUpdateUserRole = vi.fn();
const mockUpdateUserStatus = vi.fn();
const mockResetUserPassword = vi.fn();
const mockDeleteUser = vi.fn();

vi.mock('@/lib/admin', () => ({
  adminApi: {
    getUsers: (...args: any[]) => mockGetUsers(...args),
    updateUserRole: (...args: any[]) => mockUpdateUserRole(...args),
    updateUserStatus: (...args: any[]) => mockUpdateUserStatus(...args),
    resetUserPassword: (...args: any[]) => mockResetUserPassword(...args),
    deleteUser: (...args: any[]) => mockDeleteUser(...args),
  },
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="page-layout">{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div data-testid="page-header"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
  ),
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: ({ text }: { text?: string }) => <div data-testid="loading-spinner">{text}</div>,
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ isOpen, title, message, onConfirm, onCancel, confirmLabel }: any) => (
    isOpen ? (
      <div data-testid="confirm-dialog">
        <h3>{title}</h3>
        <p>{message}</p>
        <button onClick={onConfirm}>{confirmLabel}</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null
  ),
}));

vi.mock('@/components/admin/ResetPasswordModal', () => ({
  ResetPasswordModal: ({ isOpen, temporaryPassword, userName, onClose }: any) => (
    isOpen ? (
      <div data-testid="reset-password-modal">
        <p>Password for {userName}: {temporaryPassword}</p>
        <button onClick={onClose}>Close</button>
      </div>
    ) : null
  ),
}));

vi.mock('@/components/admin/UserManagementTable', () => ({
  UserManagementTable: ({ users, currentUserId, onChangeRole, onToggleStatus, onResetPassword, onDeleteUser }: any) => (
    <div data-testid="user-table">
      {users.map((user: any) => (
        <div key={user.id} data-testid={`user-row-${user.id}`}>
          <span>{user.email || user.firstName}</span>
          {user.id !== currentUserId && (
            <>
              <button onClick={() => onChangeRole(user, user.role === 'admin' ? 'user' : 'admin')}>
                {user.role === 'admin' ? 'Demote' : 'Promote'}
              </button>
              <button onClick={() => onToggleStatus(user)}>
                {user.isActive ? 'Disable' : 'Enable'}
              </button>
              <button onClick={() => onResetPassword(user)}>Reset Password</button>
              <button onClick={() => onDeleteUser(user)}>Delete</button>
            </>
          )}
        </div>
      ))}
    </div>
  ),
}));

const mockUsers = [
  { id: 'admin-id', email: 'admin@example.com', firstName: 'Admin', lastName: 'User', authProvider: 'local', hasPassword: true, role: 'admin', isActive: true, mustChangePassword: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastLogin: '2026-02-14T00:00:00Z' },
  { id: 'user-1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Smith', authProvider: 'local', hasPassword: true, role: 'user', isActive: true, mustChangePassword: false, createdAt: '2026-01-15T00:00:00Z', updatedAt: '2026-01-15T00:00:00Z', lastLogin: null },
  { id: 'user-2', email: 'bob@example.com', firstName: 'Bob', lastName: 'Jones', authProvider: 'oidc', hasPassword: false, role: 'user', isActive: false, mustChangePassword: false, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z', lastLogin: null },
];

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUsers.mockResolvedValue(mockUsers);
  });

  describe('Rendering', () => {
    it('renders page header with title', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('User Management')).toBeInTheDocument());
    });

    it('renders within page layout', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('page-layout')).toBeInTheDocument());
    });

    it('shows user count in subtitle', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('3 users')).toBeInTheDocument());
    });

    it('shows singular user count', async () => {
      mockGetUsers.mockResolvedValue([mockUsers[0]]);
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByText('1 user')).toBeInTheDocument());
    });

    it('renders all users in the table', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => {
        expect(screen.getByText('admin@example.com')).toBeInTheDocument();
        expect(screen.getByText('alice@example.com')).toBeInTheDocument();
        expect(screen.getByText('bob@example.com')).toBeInTheDocument();
      });
    });

    it('does not show action buttons for current user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      const adminRow = screen.getByTestId('user-row-admin-id');
      expect(adminRow.querySelector('button')).toBeNull();
    });
  });

  describe('Loading State', () => {
    it('shows loading spinner while loading', async () => {
      mockGetUsers.mockReturnValue(new Promise(() => {}));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('loading-spinner')).toBeInTheDocument());
    });
  });

  describe('Role Management', () => {
    it('shows confirm dialog when promoting user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Promote')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Promote User/)).toBeInTheDocument();
      });
    });

    it('updates role on confirm', async () => {
      mockUpdateUserRole.mockResolvedValue({ ...mockUsers[1], role: 'admin' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Promote')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Promote to Admin'));
      await waitFor(() => expect(mockUpdateUserRole).toHaveBeenCalledWith('user-1', 'admin'));
    });
  });

  describe('User Status', () => {
    it('shows confirm dialog when disabling user', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Disable')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Disable User\?/)).toBeInTheDocument();
      });
    });

    it('enables user without confirmation', async () => {
      mockUpdateUserStatus.mockResolvedValue({ ...mockUsers[2], isActive: true });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Enable'));
      await waitFor(() => expect(mockUpdateUserStatus).toHaveBeenCalledWith('user-2', true));
    });
  });

  describe('Password Reset', () => {
    it('shows confirm dialog before reset', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/temporary password for Alice/)).toBeInTheDocument();
      });
    });

    it('shows temporary password modal after reset', async () => {
      mockResetUserPassword.mockResolvedValue({ temporaryPassword: 'TempPass123!' });
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Reset Password')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Reset Password', { selector: '[data-testid="confirm-dialog"] button' }));
      await waitFor(() => {
        expect(screen.getByTestId('reset-password-modal')).toBeInTheDocument();
        expect(screen.getByText(/TempPass123!/)).toBeInTheDocument();
      });
    });
  });

  describe('User Deletion', () => {
    it('shows danger confirm dialog before deletion', async () => {
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => {
        expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
        expect(screen.getByText(/Delete User\?/)).toBeInTheDocument();
        expect(screen.getByText(/permanently remove/)).toBeInTheDocument();
      });
    });

    it('calls deleteUser on confirm', async () => {
      mockDeleteUser.mockResolvedValue(undefined);
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getAllByText('Delete')[0]);
      await waitFor(() => expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Delete User'));
      await waitFor(() => expect(mockDeleteUser).toHaveBeenCalledWith('user-1'));
    });
  });

  describe('Error Handling', () => {
    it('shows error toast when loading users fails', async () => {
      const toast = await import('react-hot-toast');
      mockGetUsers.mockRejectedValue(new Error('Network error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(toast.default.error).toHaveBeenCalledWith('Failed to load users'));
    });

    it('shows error toast when enabling user fails', async () => {
      const toast = await import('react-hot-toast');
      mockUpdateUserStatus.mockRejectedValue(new Error('Server error'));
      render(<AdminUsersPage />);
      await waitFor(() => expect(screen.getByTestId('user-table')).toBeInTheDocument());
      fireEvent.click(screen.getByText('Enable'));
      await waitFor(() => expect(toast.default.error).toHaveBeenCalled());
    });
  });
});
