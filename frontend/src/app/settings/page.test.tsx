import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import SettingsPage from './page';

// Mock next/image
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  default: (props: any) => <img {...props} />,
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
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, authProvider: 'local' },
        isAuthenticated: true,
        isLoading: false,
        _hasHydrated: true,
        logout: vi.fn(),
        setUser: vi.fn(),
      };
      return selector ? selector(state) : state;
    },
    {
      getState: vi.fn(() => ({
        user: { id: 'test-user-id', email: 'test@example.com', firstName: 'Test', lastName: 'User', role: 'user', hasPassword: true, authProvider: 'local' },
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
      preferences: { twoFactorEnabled: false, theme: 'system', defaultCurrency: 'USD' },
      isLoaded: true,
      _hasHydrated: true,
      updatePreferences: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// Mock theme context
vi.mock('@/contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({
    theme: 'system',
    resolvedTheme: 'light',
    setTheme: vi.fn(),
  }),
}));

// Mock auth API
vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({
      local: true, oidc: false, registration: true, smtp: false, force2fa: false,
    }),
    disable2FA: vi.fn(),
    getTrustedDevices: vi.fn().mockResolvedValue([]),
    revokeTrustedDevice: vi.fn(),
    revokeAllTrustedDevices: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock user settings API
vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    getProfile: vi.fn().mockResolvedValue({
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      authProvider: 'local',
      hasPassword: true,
      role: 'user',
      isActive: true,
      mustChangePassword: false,
    }),
    getPreferences: vi.fn().mockResolvedValue({
      dateFormat: 'browser',
      numberFormat: 'browser',
      timezone: 'browser',
      theme: 'system',
      defaultCurrency: 'USD',
      notificationEmail: true,
      twoFactorEnabled: false,
    }),
    updateProfile: vi.fn(),
    updatePreferences: vi.fn(),
    changePassword: vi.fn(),
    deleteAccount: vi.fn(),
    getSmtpStatus: vi.fn().mockResolvedValue({ configured: false }),
    sendTestEmail: vi.fn(),
  },
}));

// Mock exchange-rates API (settings page loads currencies dynamically)
vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([
      { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2, isActive: true },
      { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', decimalPlaces: 2, isActive: true },
      { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2, isActive: true },
    ]),
  },
}));

// Mock AppHeader
vi.mock('@/components/layout/AppHeader', () => ({
  AppHeader: () => <div data-testid="app-header">AppHeader</div>,
}));

// Mock Modal
vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) => isOpen ? <div data-testid="modal">{children}</div> : null,
}));

// Mock TwoFactorSetup
vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: () => <div data-testid="two-factor-setup">TwoFactorSetup</div>,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Settings heading after loading', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
  });

  it('renders the Profile section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Profile')).toBeInTheDocument();
    });
  });

  it('renders the Preferences section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Preferences')).toBeInTheDocument();
    });
  });

  it('renders the Danger Zone section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Danger Zone')).toBeInTheDocument();
    });
  });

  it('renders the Delete Account button', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete account/i })).toBeInTheDocument();
    });
  });
});
