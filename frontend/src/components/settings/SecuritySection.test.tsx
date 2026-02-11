import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { SecuritySection } from './SecuritySection';
import { User, UserPreferences } from '@/types/auth';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    changePassword: vi.fn(),
    updatePreferences: vi.fn(),
  },
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getTrustedDevices: vi.fn().mockResolvedValue([]),
    revokeAllTrustedDevices: vi.fn(),
    revokeTrustedDevice: vi.fn(),
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ updatePreferences: vi.fn() })),
}));

vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: () => <div data-testid="two-factor-setup">2FA Setup</div>,
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import toast from 'react-hot-toast';

const mockUser: User = {
  id: '1',
  email: 'test@example.com',
  firstName: 'John',
  lastName: 'Doe',
  authProvider: 'local',
  hasPassword: true,
  role: 'user',
  isActive: true,
  mustChangePassword: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

const mockPreferences: UserPreferences = {
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  defaultCurrency: 'CAD',
  notificationEmail: false,
  twoFactorEnabled: false,
};

describe('SecuritySection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the security heading and password change form', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('Change Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Current Password')).toBeInTheDocument();
    expect(screen.getByLabelText('New Password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm New Password')).toBeInTheDocument();
  });

  it('returns null when user has no password (OAuth only)', () => {
    const oauthUser = { ...mockUser, hasPassword: false };

    const { container } = render(
      <SecuritySection
        user={oauthUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(container.innerHTML).toBe('');
  });

  it('shows password mismatch error', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'newpass123' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'different' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('New passwords do not match');
    });
  });

  it('shows two-factor authentication section', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Two-Factor Authentication')).toBeInTheDocument();
  });

  it('shows trusted devices section when 2FA is enabled', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Trusted Devices')).toBeInTheDocument();
    });
  });
});
