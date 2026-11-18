import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@/test/render';
import SettingsPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings',
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/layout/PageLayout', () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/layout/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

vi.mock('@/components/ui/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading">loading</div>,
}));

// Render a minimal SecuritySection so the delegate branch is exercised
// without dragging in its full dependency tree.
vi.mock('@/components/settings/SecuritySection', () => ({
  SecuritySection: ({
    user,
    preferences,
    onPreferencesUpdated,
  }: {
    user: { email: string };
    preferences: { twoFactorEnabled: boolean };
    onPreferencesUpdated: (p: { twoFactorEnabled?: boolean }) => void;
  }) => (
    <div data-testid="security">
      <div data-testid="user-email">{user.email}</div>
      <div data-testid="tfa">{preferences.twoFactorEnabled ? 'on' : 'off'}</div>
      <button
        data-testid="toggle-tfa"
        onClick={() => onPreferencesUpdated({ twoFactorEnabled: true })}
      >
        toggle
      </button>
    </div>
  ),
}));

// Settings page imports many owner-only sections. Stub them so the
// delegate render path doesn't reach into them; they should never render
// for a delegate but mocking is defensive.
vi.mock('@/components/settings/ProfileSection', () => ({
  ProfileSection: () => <div data-testid="profile" />,
}));
vi.mock('@/components/settings/PreferencesSection', () => ({
  PreferencesSection: () => <div data-testid="prefs" />,
}));
vi.mock('@/components/settings/NotificationsSection', () => ({
  NotificationsSection: () => <div data-testid="notifs" />,
}));
vi.mock('@/components/settings/DangerZoneSection', () => ({
  DangerZoneSection: () => <div data-testid="danger" />,
}));
vi.mock('@/components/settings/BackupRestoreSection', () => ({
  BackupRestoreSection: () => <div data-testid="backup" />,
}));
vi.mock('@/components/settings/ApiAccessSection', () => ({
  ApiAccessSection: () => <div data-testid="api-access" />,
}));
vi.mock('@/components/settings/ConnectedAppsSection', () => ({
  ConnectedAppsSection: () => <div data-testid="connected-apps" />,
}));
vi.mock('@/components/settings/SettingsNav', () => ({
  SettingsNav: () => <nav data-testid="nav" />,
}));

vi.mock('@/store/demoStore', () => ({
  useDemoStore: (selector: any) => selector({ isDemoMode: false, setDemoMode: vi.fn() }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: any) =>
    selector({ actingAsUserId: 'owner-1' }),
}));

const mocks = vi.hoisted(() => ({
  getSelfProfile: vi.fn(),
  get2FAStatus: vi.fn(),
  getAuthMethods: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getSelfProfile: mocks.getSelfProfile,
    get2FAStatus: mocks.get2FAStatus,
    getAuthMethods: mocks.getAuthMethods,
  },
}));

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    getProfile: vi.fn(),
    getPreferences: vi.fn(),
    getSmtpStatus: vi.fn(),
  },
}));

describe('SettingsPage - acting delegate (Security-only view)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSelfProfile.mockResolvedValue({
      id: 'delegate-1',
      email: 'delegate@example.com',
      firstName: 'Del',
      authProvider: 'local',
      hasPassword: true,
    });
    mocks.get2FAStatus.mockResolvedValue({ enabled: false });
    mocks.getAuthMethods.mockResolvedValue({
      local: true,
      oidc: false,
      registration: true,
      smtp: false,
      force2fa: false,
      demo: false,
    });
  });

  it('renders only the Security section with the delegate own email', async () => {
    await act(async () => {
      render(<SettingsPage />);
    });

    await waitFor(() => {
      expect(screen.getByTestId('security')).toBeInTheDocument();
    });

    expect(mocks.getSelfProfile).toHaveBeenCalled();
    expect(mocks.get2FAStatus).toHaveBeenCalled();
    // Delegate's own profile is used, not the owner's.
    expect(screen.getByTestId('user-email')).toHaveTextContent(
      'delegate@example.com',
    );
    // Other settings sections must not render for a delegate.
    expect(screen.queryByTestId('profile')).not.toBeInTheDocument();
    expect(screen.queryByTestId('prefs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('notifs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('danger')).not.toBeInTheDocument();
    expect(screen.queryByTestId('backup')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav')).not.toBeInTheDocument();
  });

  it('uses the actor 2FA-status flag (not the owner preferences)', async () => {
    mocks.get2FAStatus.mockResolvedValue({ enabled: true });
    await act(async () => {
      render(<SettingsPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId('tfa')).toHaveTextContent('on'),
    );
  });

  it('keeps local 2FA state in sync via onPreferencesUpdated', async () => {
    await act(async () => {
      render(<SettingsPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId('tfa')).toHaveTextContent('off'),
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('toggle-tfa'));
    });

    await waitFor(() =>
      expect(screen.getByTestId('tfa')).toHaveTextContent('on'),
    );
  });

  it('shows an error fallback when the profile fetch fails', async () => {
    mocks.getSelfProfile.mockRejectedValue(new Error('boom'));
    await act(async () => {
      render(<SettingsPage />);
    });
    await act(async () => {});

    await waitFor(() =>
      expect(
        screen.getByText(/Unable to load your security settings/i),
      ).toBeInTheDocument(),
    );
  });
});
