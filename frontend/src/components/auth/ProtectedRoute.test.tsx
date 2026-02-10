import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useAuthStore } from '@/store/authStore';
import { usePreferencesStore } from '@/store/preferencesStore';
import { setAuthenticatedState, resetStores } from '@/test/mocks/stores';

// Track the latest push call
const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({ force2fa: false }),
  },
}));

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStores();
    // Reset preferences store
    usePreferencesStore.setState({
      preferences: null,
      isLoaded: false,
      _hasHydrated: true,
    });
  });

  it('shows loading spinner when store has not hydrated', () => {
    useAuthStore.setState({
      _hasHydrated: false,
      isLoading: true,
      isAuthenticated: false,
      user: null,
    });

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('shows loading spinner when isLoading is true', () => {
    useAuthStore.setState({
      _hasHydrated: true,
      isLoading: true,
      isAuthenticated: false,
      user: null,
    });

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('redirects to /login when not authenticated', async () => {
    useAuthStore.setState({
      _hasHydrated: true,
      isLoading: false,
      isAuthenticated: false,
      user: null,
    });

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/login');
    });

    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('renders children when authenticated', () => {
    setAuthenticatedState();

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('redirects to /change-password when user must change password', async () => {
    setAuthenticatedState();
    useAuthStore.setState({
      user: {
        ...useAuthStore.getState().user!,
        mustChangePassword: true,
      },
    });

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/change-password');
    });
  });

  it('redirects to /setup-2fa when force2fa enabled and 2FA not set up', async () => {
    const { authApi } = await import('@/lib/auth');
    vi.mocked(authApi.getAuthMethods).mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: true,
    });

    setAuthenticatedState();
    usePreferencesStore.setState({
      preferences: {
        userId: 'test-user-id',
        defaultCurrency: 'USD',
        dateFormat: 'browser',
        numberFormat: 'browser',
        theme: 'system',
        timezone: 'browser',
        notificationEmail: false,
        notificationBrowser: false,
        twoFactorEnabled: false,
        gettingStartedDismissed: false,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      isLoaded: true,
      _hasHydrated: true,
    });

    render(
      <ProtectedRoute>
        <div data-testid="protected-content">Dashboard</div>
      </ProtectedRoute>,
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/setup-2fa');
    });
  });
});
