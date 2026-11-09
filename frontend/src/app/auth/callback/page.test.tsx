import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
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

const mockStoreUpdatePreferences = vi.fn();

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: (selector?: any) => {
    const state = {
      preferences: { twoFactorEnabled: false, theme: 'system' },
      isLoaded: true,
      _hasHydrated: true,
      updatePreferences: mockStoreUpdatePreferences,
    };
    return selector ? selector(state) : state;
  },
}));

// Reached only via the first-run preferences step below.
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencyCatalog: vi.fn().mockResolvedValue([
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 },
    ]),
  },
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: { updatePreferences: vi.fn().mockResolvedValue({}) },
}));

vi.mock('js-cookie', () => ({ default: { set: vi.fn(), get: vi.fn() } }));

vi.mock('@/lib/stepUpToken', () => ({
  stashOidcReauthArtifact: vi.fn(),
}));

const mockGetProfile = vi.fn();

vi.mock('@/lib/auth', () => ({
  authApi: {
    getProfile: (...args: any[]) => mockGetProfile(...args),
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: true, registration: true, smtp: false, force2fa: false, demo: false,
    }),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: (_error: any, fallback: string) => fallback,
}));

describe('CallbackPage', () => {
  // Tests that assert on redirects replace window.location wholesale; restore
  // it between tests so later ones (next/image needs a real URL) are not
  // affected by the stub.
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
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

  it('uses sessionStorage returnTo when present and valid', async () => {
    const mockUser = {
      id: 'user-1', email: 'test@example.com', mustChangePassword: false, hasPassword: false,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    sessionStorage.setItem('postLoginReturnTo', '/some/path?foo=bar');
    const assignSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      // The stashed path is resolved against this origin before it is followed.
      value: { href: '', origin: originalLocation.origin, assign: assignSpy },
      writable: true,
    });
    render(<CallbackPage />);
    await waitFor(() => {
      expect(window.location.href).toBe('/some/path?foo=bar');
    });
    expect(sessionStorage.getItem('postLoginReturnTo')).toBeNull();
  });

  // A prefix check (starts with "/", not "//", not "/\") accepts each of these,
  // and the URL parser then strips the tab/CR/LF and reads "//evil.example" --
  // a navigation to another origin.
  it.each([
    ['tab', '/\t/evil.example/attack'],
    ['CR', '/\r/evil.example/attack'],
    ['LF', '/\n/evil.example/attack'],
    ['backslash', '/\\evil.example/attack'],
    ['absolute URL', 'https://evil.example/attack'],
  ])('ignores a stashed returnTo that leaves the origin (%s)', async (_label, stashed) => {
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue({
      id: 'user-1', email: 'test@example.com', mustChangePassword: false, hasPassword: false,
    });
    sessionStorage.setItem('postLoginReturnTo', stashed);
    Object.defineProperty(window, 'location', {
      value: { href: '', origin: originalLocation.origin, assign: vi.fn() },
      writable: true,
    });
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
    expect(window.location.href).toBe('');
    expect(sessionStorage.getItem('postLoginReturnTo')).toBeNull();
  });

  it('does not router.push a stashed returnTo that leaves the origin after a re-auth', async () => {
    mockSearchParams = new URLSearchParams('reauth=delete-account');
    sessionStorage.setItem('postLoginReturnTo', '/\t/evil.example/attack');
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
    expect(mockRouterPush).not.toHaveBeenCalledWith(
      expect.stringContaining('evil.example'),
    );
  });

  it('ignores sessionStorage returnTo that starts with //', async () => {
    const mockUser = {
      id: 'user-1', email: 'test@example.com', mustChangePassword: false, hasPassword: false,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    sessionStorage.setItem('postLoginReturnTo', '//evil.example.com/attack');
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
    expect(sessionStorage.getItem('postLoginReturnTo')).toBeNull();
  });

  describe('first-run preferences step', () => {
    const newUser = {
      id: 'user-1', email: 'test@example.com', authProvider: 'oidc', hasPassword: false,
      role: 'user', isActive: true, mustChangePassword: false,
    };

    async function renderWelcome(search = 'success=true&welcome=true') {
      mockSearchParams = new URLSearchParams(search);
      mockGetProfile.mockResolvedValue(newUser);
      await act(async () => {
        render(<CallbackPage />);
      });
      await waitFor(() =>
        expect(screen.getByText('Set Your Preferences')).toBeInTheDocument(),
      );
    }

    it('shows the step for an account this login provisioned', async () => {
      await renderWelcome();
      expect(screen.getByLabelText('Language')).toBeInTheDocument();
      expect(screen.getByLabelText('Default currency')).toBeInTheDocument();
      // The user stays here until they finish; no redirect yet.
      expect(mockRouterPush).not.toHaveBeenCalledWith('/dashboard');
    });

    it('is skipped for an existing account signing in again', async () => {
      mockSearchParams = new URLSearchParams('success=true');
      mockGetProfile.mockResolvedValue(newUser);
      render(<CallbackPage />);
      await waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/dashboard'));
      expect(screen.queryByText('Set Your Preferences')).not.toBeInTheDocument();
    });

    it('continues to the dashboard once the step is done', async () => {
      await renderWelcome();
      await act(async () => {
        fireEvent.click(screen.getByText('Skip for now'));
      });
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });

    it('follows a stashed returnTo once the step is done', async () => {
      sessionStorage.setItem('postLoginReturnTo', '/some/path?foo=bar');
      // Reaching the step at all proves the returnTo was held rather than
      // followed on arrival, as it is without the step.
      await renderWelcome();
      const assignSpy = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { href: originalLocation.href, assign: assignSpy },
        writable: true,
        configurable: true,
      });
      await act(async () => {
        fireEvent.click(screen.getByText('Skip for now'));
      });
      expect(assignSpy).toHaveBeenCalledWith('/some/path?foo=bar');
    });
  });

  it('falls back to dashboard when sessionStorage throws', async () => {
    const mockUser = {
      id: 'user-1', email: 'test@example.com', mustChangePassword: false, hasPassword: false,
    };
    mockSearchParams = new URLSearchParams('success=true');
    mockGetProfile.mockResolvedValue(mockUser);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    render(<CallbackPage />);
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
    });
  });

  describe('re-authentication return', () => {
    function stubLocation(hash: string) {
      Object.defineProperty(window, 'location', {
        value: { hash, pathname: '/auth/callback', href: '' },
        writable: true,
        configurable: true,
      });
      vi.spyOn(window.history, 'replaceState').mockImplementation(() => {});
    }

    it('stashes the artifact and returns without a sign-in toast', async () => {
      const toast = await import('react-hot-toast');
      const { stashOidcReauthArtifact } = await import('@/lib/stepUpToken');
      mockSearchParams = new URLSearchParams('reauth=delete-account');
      stubLocation('#reauth_token=artifact-1');
      render(<CallbackPage />);
      await waitFor(() => {
        expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
      });
      expect(vi.mocked(stashOidcReauthArtifact)).toHaveBeenCalledWith('artifact-1');
      // The token lives in the URL fragment; keeping it out of the address bar
      // (so it never lands in history or a bookmark) is a stated property of
      // this flow, so assert the clear rather than only stubbing it away.
      expect(window.history.replaceState).toHaveBeenCalledWith(
        null,
        '',
        '/auth/callback',
      );
      expect(toast.default.error).not.toHaveBeenCalled();
      expect(toast.default.success).not.toHaveBeenCalled();
    });

    it('says the provider did not re-prompt when the server refused to mint', async () => {
      // error=reauth_not_fresh: the session is fine, only the action stayed
      // locked -- the message must be distinguishable from a failed sign-in.
      const toast = await import('react-hot-toast');
      const { stashOidcReauthArtifact } = await import('@/lib/stepUpToken');
      mockSearchParams = new URLSearchParams(
        'reauth=delete-account&error=reauth_not_fresh',
      );
      stubLocation('');
      render(<CallbackPage />);
      await waitFor(() => {
        expect(mockRouterPush).toHaveBeenCalledWith('/dashboard');
      });
      expect(vi.mocked(stashOidcReauthArtifact)).not.toHaveBeenCalled();
      expect(toast.default.error).toHaveBeenCalledWith(
        'Your identity provider did not ask you to sign in again, so the action was not confirmed. Try again, and complete the sign-in prompt when it appears.',
      );
      // Not the generic sign-in failure, and no redirect to /login.
      expect(mockRouterPush).not.toHaveBeenCalledWith('/login');
    });
  });
});
