import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import CallbackPage from './page';

const mockPush = vi.fn();
let mockSearchParams = new URLSearchParams();

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
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

// Mock auth store
vi.mock('@/store/authStore', () => ({
  useAuthStore: Object.assign(
    (selector?: any) => {
      const state = {
        user: null,
        isAuthenticated: false,
        isLoading: false,
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
        isLoading: false,
        _hasHydrated: true,
      })),
    },
  ),
}));

const mockGetProfile = vi.fn();

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getProfile: (...args: any[]) => mockGetProfile(...args),
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
  },
}));

// Mock errors
vi.mock('@/lib/errors', () => ({
  getErrorMessage: (error: any, fallback: string) => fallback,
}));

describe('CallbackPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockGetProfile.mockResolvedValue({
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'user',
      hasPassword: true,
      mustChangePassword: false,
    });
  });

  it('renders the completing sign in message', () => {
    render(<CallbackPage />);
    expect(screen.getByText('Completing sign in...')).toBeInTheDocument();
  });

  it('renders the wait message', () => {
    render(<CallbackPage />);
    expect(screen.getByText('Please wait while we authenticate you')).toBeInTheDocument();
  });

  it('fetches profile on success param and redirects to dashboard', async () => {
    mockSearchParams = new URLSearchParams('success=true');

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockGetProfile).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(mockLogin).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'test-user-id', email: 'test@example.com' }),
        'httpOnly',
      );
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  it('redirects to change-password when user must change password', async () => {
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue({
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: 'user',
      hasPassword: true,
      mustChangePassword: true,
    });

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/change-password');
    });
  });

  it('handles error param by redirecting to login', async () => {
    mockSearchParams = new URLSearchParams('error=access_denied');

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/login');
    });
  });

  it('does not fetch profile when error param is present', async () => {
    mockSearchParams = new URLSearchParams('error=access_denied');

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/login');
    });

    expect(mockGetProfile).not.toHaveBeenCalled();
  });

  it('handles missing params by attempting profile fetch', async () => {
    mockSearchParams = new URLSearchParams();

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockGetProfile).toHaveBeenCalled();
    });
  });

  it('redirects to login when profile fetch fails with no success param', async () => {
    mockSearchParams = new URLSearchParams();
    mockGetProfile.mockRejectedValue(new Error('Unauthorized'));

    render(<CallbackPage />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/login');
    });
  });

  it('sets loading state during callback processing', async () => {
    mockSearchParams = new URLSearchParams('success=true');

    render(<CallbackPage />);

    expect(mockSetLoading).toHaveBeenCalledWith(true);

    await waitFor(() => {
      expect(mockSetLoading).toHaveBeenCalledWith(false);
    });
  });
});
