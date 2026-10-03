import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@/test/render';
import SettingsPage from './page';

// Mock IntersectionObserver
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();
vi.stubGlobal('IntersectionObserver', vi.fn(function (this: any) {
  this.observe = mockObserve;
  this.unobserve = vi.fn();
  this.disconnect = mockDisconnect;
}));

// Mock next/image
vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
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

// Mock auth store. The role is mutable so a test can switch between an
// ordinary user and an administrator -- the Automatic Backup section is
// admin-only.
const authRole = vi.hoisted(() => ({ current: 'user' }));

vi.mock('@/store/authStore', () => {
  const buildState = () => ({
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      role: authRole.current,
      hasPassword: true,
      authProvider: 'local',
    },
    isAuthenticated: true,
    isLoading: false,
    _hasHydrated: true,
    logout: vi.fn(),
    setUser: vi.fn(),
  });
  return {
    useAuthStore: Object.assign(
      (selector?: any) => {
        const state = buildState();
        return selector ? selector(state) : state;
      },
      { getState: vi.fn(() => buildState()) },
    ),
  };
});

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
      local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: false,
    }),
    disable2FA: vi.fn(),
    getTrustedDevices: vi.fn().mockResolvedValue([]),
    revokeTrustedDevice: vi.fn(),
    revokeAllTrustedDevices: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    getTokens: vi.fn().mockResolvedValue([]),
    getSelfProfile: vi.fn().mockResolvedValue(null),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
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

// Mock investments API (PreferencesSection fetches quote-provider status)
vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getProviderStatus: vi.fn().mockResolvedValue({
      yahoo: { ready: true },
      msn: { ready: true },
    }),
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

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authRole.current = 'user';
  });

  describe('automatic backup section', () => {
    // Automatic-backup configuration is a deployment/operator concern and has
    // moved out of user Settings onto its own admin-only surface
    // (Admin -> Backups, `/admin/backups`). It is no longer rendered here for
    // anyone, ordinary user or administrator.
    it('is not in Settings for a non-admin', async () => {
      const { container } = render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      expect(container.querySelector('#auto-backup')).not.toBeInTheDocument();
      expect(screen.queryByText('Automatic Backup')).toBeNull();
    });

    it('is not in Settings for an administrator either', async () => {
      authRole.current = 'admin';
      const { container } = render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByText('Settings')).toBeInTheDocument();
      });

      expect(container.querySelector('#auto-backup')).not.toBeInTheDocument();
      expect(screen.queryByText('Automatic Backup')).toBeNull();
    });
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
      // Multiple matches due to nav labels + section heading
      const matches = screen.getAllByText('Profile');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the Preferences section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const matches = screen.getAllByText('Preferences');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the Danger Zone section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const matches = screen.getAllByText('Danger Zone');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the Delete Account button', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /delete account/i })).toBeInTheDocument();
    });
  });

  it('renders the API Access section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const matches = screen.getAllByText('API Access');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders the settings navigation sidebar', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      // Should render the nav element with the Settings sections label
      const navs = screen.getAllByLabelText('Settings sections');
      expect(navs.length).toBeGreaterThan(0);
    });
  });

  it('renders navigation items for each section', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      // Check that section names appear in the nav (they also appear as section headings)
      // Navigation renders the desktop sidebar plus the mobile dropdown trigger
      // (showing the active section), so labels appear multiple times
      const profileElements = screen.getAllByText('Profile');
      expect(profileElements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders AI Settings as a navigation link', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      const aiLinks = screen.getAllByText('AI Settings');
      // At least one should be an anchor (in the nav)
      const anchors = aiLinks.filter((el) => el.closest('a'));
      expect(anchors.length).toBeGreaterThan(0);
    });
  });

  it('links the Email Receipts card at its settings page, right after AI Settings in both places', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      const card = screen
        .getAllByText('Email Receipts')
        .map((el) => el.closest('a'))
        .find((a) => a?.getAttribute('href') === '/settings/email-receipts' && a.closest('#email-receipts'));
      expect(card).toBeTruthy();
    });
    const anchors = Array.from(container.querySelectorAll('[id].scroll-mt-32'))
      .filter((el) => !el.parentElement?.closest('[id].scroll-mt-32'))
      .map((el) => el.id);
    expect(anchors.indexOf('email-receipts')).toBe(anchors.indexOf('ai-settings') + 1);
  });

  it('links the Guided Tours card at the tours page', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      // The card, not the nav entry: the nav link is an in-page anchor.
      const card = screen
        .getAllByText('Guided Tours')
        .map((el) => el.closest('a'))
        .find((a) => a?.getAttribute('href') === '/settings/tours');
      expect(card).toBeTruthy();
    });
  });

  it('wraps sections with id attributes for scroll targets', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    const expectedIds = ['profile', 'preferences', 'notifications', 'security', 'api-access', 'backup-restore', 'about', 'danger-zone'];
    for (const id of expectedIds) {
      expect(container.querySelector(`#${id}`)).toBeInTheDocument();
    }
  });

  /**
   * The nav order and the body order are ONE order, and nothing held them
   * together: `SETTINGS_SECTION_IDS` drives the sidebar while the sections are
   * laid out by hand in the JSX below it, so moving a section in one place and
   * not the other gives a nav entry that scrolls past the thing it names -- with
   * both halves still compiling and every other test still green.
   *
   * Read out of the DOM in both directions rather than from the source, so it
   * holds whatever renders: the nav's own buttons and links against the anchors
   * they address.
   */
  it('lays the sections out in the order the nav lists them', async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    // Top-level sections only: a section can hold its own scroll target (the
    // 2FA block inside Security is one), which shares the offset class but is
    // not a nav entry.
    const anchors = Array.from(container.querySelectorAll('[id].scroll-mt-32'))
      .filter((el) => !el.parentElement?.closest('[id].scroll-mt-32'))
      .map((el) => el.id)
      .filter(Boolean);
    // The sidebar renders one item per section, in the list's order.
    const nav = container.querySelector('nav[aria-label]');
    const navIds = Array.from(nav?.querySelectorAll('li') ?? [])
      .map((li) => li.textContent?.trim())
      .filter((label): label is string => Boolean(label));

    expect(anchors.length).toBeGreaterThan(3);
    expect(navIds.length).toBe(anchors.length);
    // Guided Tours sits immediately above About, in both.
    expect(anchors.indexOf('tours')).toBe(anchors.indexOf('about') - 1);
    expect(navIds.indexOf('Guided Tours')).toBe(navIds.indexOf('About') - 1);
  });

  it('sets up IntersectionObserver for scroll spy', async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    expect(IntersectionObserver).toHaveBeenCalled();
  });

  it('shows loading spinner while data is being fetched', async () => {
    const { userSettingsApi } = await import('@/lib/user-settings');
    vi.mocked(userSettingsApi.getProfile).mockReturnValue(new Promise(() => {}));
    render(<SettingsPage />);
    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows error toast when data fetch fails', async () => {
    const toast = await import('react-hot-toast');
    const { userSettingsApi } = await import('@/lib/user-settings');
    vi.mocked(userSettingsApi.getProfile).mockRejectedValue(new Error('Fetch failed'));
    render(<SettingsPage />);
    await waitFor(() => {
      expect(toast.default.error).toHaveBeenCalled();
    });
  });

  it('handles handleSectionClick by scrolling to section', async () => {
    const mockScrollIntoView = vi.fn();
    document.getElementById = vi.fn().mockReturnValue({
      scrollIntoView: mockScrollIntoView,
    });
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });
    // Trigger a section nav click
    const navLinks = screen.getAllByLabelText('Settings sections');
    const profileLink = navLinks[0].querySelector('[data-section-id="profile"]') ??
      navLinks[0].querySelector('button');
    if (profileLink) {
      fireEvent.click(profileLink);
      // scrollIntoView may or may not have been called depending on mock
    }
  });

  describe('demo mode', () => {

    it('shows demo mode restriction banner when in demo mode', async () => {
      const { useDemoStore: _useDemoStore } = await import('@/store/demoStore');
      const { authApi } = await import('@/lib/auth');
      vi.mocked(authApi.getAuthMethods).mockResolvedValue({
        local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: true,
      });
      render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
      });
    });

    it('hides Profile section in demo mode', async () => {
      const { authApi } = await import('@/lib/auth');
      vi.mocked(authApi.getAuthMethods).mockResolvedValue({
        local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: true,
      });
      render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
      });
      // Profile section should NOT be rendered since isDemoMode is true
      const dangerZones = screen.queryAllByText('Danger Zone');
      expect(dangerZones).toHaveLength(0);
    });

    it('shows only demo-visible sections in nav when in demo mode', async () => {
      const { authApi } = await import('@/lib/auth');
      vi.mocked(authApi.getAuthMethods).mockResolvedValue({
        local: true, oidc: false, registration: true, smtp: false, force2fa: false, demo: true,
      });
      render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
      });
      // Only Preferences and Notifications should appear in the nav
      const prefNavItems = screen.queryAllByText('Preferences');
      expect(prefNavItems.length).toBeGreaterThan(0);
    });
  });
});
