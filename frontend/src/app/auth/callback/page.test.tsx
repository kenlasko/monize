import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import CallbackPage from './page';

const mockRouterPush = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/auth/callback',
  useSearchParams: () => mockSearchParams,
}));

const mockLogin = vi.fn();
const mockSetLoading = vi.fn();
const mockSetError = vi.fn();

vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: null,
        isAuthenticated: false,
        isLoading: true,
        _hasHydrated: true,
        login: mockLogin,
        setLoading: mockSetLoading,
        setError: mockSetError,
        logout: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: null,
        isAuthenticated: false,
        isLoading: true,
        _hasHydrated: true,
      })),
    },
  ),
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: false, theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
    };
    return selector ? selector(state) : state;
  },
}));

const mockGetProfile = vi.fn();

vi.mock('@/lib/auth', () => ({
  authApi: {
    getProfile: (...args: any[]) => mockGetProfile(...args),
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: true, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

describe('CallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('renders loading state', () => {
    mockGetProfile.mockReturnValue(new Promise(() => {}));
    render(<CallbackPage />);
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
    expect(screen.getByText('Please wait while we authenticate you')).toBeInTheDocument();
  });

  it('redirects to login on OIDC error', async () => {
    const toast = await import('react-hot-toast');
    mockSearchParams = new URLSearchParams('error=access_denied');
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/login');
      expect(toast.default.error).toHaveBeenCalledWith('Authentication failed. Please try again.');
    });
  });

  it('logs in and redirects to dashboard on success', async () => {
    const toast = await import('react-hot-toast');
    const mockUser = {
      id: 'user-1', email: 'test@example.com', firstName: 'Test', lastName: 'User',
      authProvider: 'oidc', hasPassword: false, role: 'user', isActive: true, mustChangePassword: false,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(mockUser, 'httpOnly');
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
      expect(toast.default.success).toHaveBeenCalledWith('Successfully signed in!');
    });
  });

  it('redirects to change-password when mustChangePassword and hasPassword', async () => {
    const mockUser = {
      id: 'user-1', email: 'test@example.com', authProvider: 'local', hasPassword: true,
      role: 'user', isActive: true, mustChangePassword: true,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/change-password');
    });
  });

  it('redirects to dashboard when mustChangePassword but no password', async () => {
    const mockUser = {
      id: 'user-1', email: 'test@example.com', authProvider: 'oidc', hasPassword: false,
      role: 'user', isActive: true, mustChangePassword: true,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('shows correct error when getProfile fails without success param', async () => {
    const toast = await import('react-hot-toast');
    mockGetProfile.mockRejectedValue(new Error('Unauthorized'));
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/login');
      expect(toast.default.error).toHaveBeenCalledWith('No authentication token received');
    });
  });

  it('shows correct error when getProfile fails with success param', async () => {
    const toast = await import('react-hot-toast');
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockRejectedValue(new Error('Unauthorized'));
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/login');
      expect(toast.default.error).toHaveBeenCalledWith('Authentication failed');
    });
  });

  it('manages loading state correctly', async () => {
    mockGetProfile.mockResolvedValue({
      id: 'user-1', email: 'test@example.com', mustChangePassword: false, hasPassword: false,
    });
    mockSearchParams = new URLSearchParams('success=true');
    render(<CallbackPage />);
    expect(mockSetLoading).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(mockSetLoading).toHaveBeenCalledWith(false);
    });
  });
});
