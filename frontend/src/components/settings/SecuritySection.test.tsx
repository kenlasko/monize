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
    revokeAllTrustedDevices: vi.fn().mockResolvedValue({ count: 0 }),
    revokeTrustedDevice: vi.fn().mockResolvedValue({}),
    disable2FA: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ updatePreferences: vi.fn() })),
}));

vi.mock('@/components/auth/TwoFactorSetup', () => ({
  TwoFactorSetup: ({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) => (
    <div data-testid="two-factor-setup">
      2FA Setup
      <button data-testid="2fa-complete" onClick={onComplete}>Complete</button>
      <button data-testid="2fa-skip" onClick={onSkip}>Skip</button>
    </div>
  ),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import { authApi } from '@/lib/auth';
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
  userId: 'user-1',
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  defaultCurrency: 'CAD',
  notificationEmail: false,
  notificationBrowser: false,
  twoFactorEnabled: false,
  gettingStartedDismissed: false,
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
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

  // --- Password change form renders with current/new/confirm fields ---
  it('renders password change form with correct input types', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    const currentPw = screen.getByLabelText('Current Password');
    const newPw = screen.getByLabelText('New Password');
    const confirmPw = screen.getByLabelText('Confirm New Password');

    expect(currentPw).toHaveAttribute('type', 'password');
    expect(newPw).toHaveAttribute('type', 'password');
    expect(confirmPw).toHaveAttribute('type', 'password');
  });

  it('renders password inputs with correct placeholders', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByPlaceholderText('Enter current password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Enter new password (min. 8 characters)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Confirm new password')).toBeInTheDocument();
  });

  // --- Password change submission ---
  it('submits password change successfully', async () => {
    (userSettingsApi.changePassword as any).mockResolvedValueOnce({});

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
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpass123' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => {
      expect(userSettingsApi.changePassword).toHaveBeenCalledWith({
        currentPassword: 'oldpass123',
        newPassword: 'newpass123',
      });
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Password changed successfully');
    });
  });

  it('shows minimum length error for short password', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.change(screen.getByLabelText('Current Password'), { target: { value: 'oldpass123' } });
    fireEvent.change(screen.getByLabelText('New Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'short' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Password must be at least 8 characters');
    });
  });

  // --- Error handling for password change ---
  it('shows error toast when password change API fails', async () => {
    (userSettingsApi.changePassword as any).mockRejectedValueOnce(new Error('API error'));

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
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpass123' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to change password');
    });
  });

  it('clears password fields after successful change', async () => {
    (userSettingsApi.changePassword as any).mockResolvedValueOnce({});

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
    fireEvent.change(screen.getByLabelText('Confirm New Password'), { target: { value: 'newpass123' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Change Password' }));

    await waitFor(() => {
      expect((screen.getByLabelText('Current Password') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('New Password') as HTMLInputElement).value).toBe('');
      expect((screen.getByLabelText('Confirm New Password') as HTMLInputElement).value).toBe('');
    });
  });

  // --- 2FA setup button (when not enabled) ---
  it('shows Enable 2FA button when 2FA is not enabled', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByRole('button', { name: 'Enable 2FA' })).toBeInTheDocument();
    expect(screen.getByText('Add an extra layer of security to your account.')).toBeInTheDocument();
  });

  it('opens 2FA setup modal when Enable 2FA is clicked', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    });
  });

  // --- 2FA disable button (when enabled) ---
  it('shows Disable 2FA button when 2FA is enabled and force2fa is false', () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByRole('button', { name: 'Disable 2FA' })).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('Your account is protected with TOTP verification.')).toBeInTheDocument();
  });

  it('shows "Required by administrator" instead of Disable button when force2fa is true', () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={true}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Required by administrator')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disable 2FA' })).not.toBeInTheDocument();
  });

  // --- 2FA verify code dialog ---
  it('opens disable 2FA modal when Disable 2FA is clicked', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByText('Disable Two-Factor Authentication')).toBeInTheDocument();
      expect(screen.getByText('Enter your current 6-digit code to confirm disabling 2FA.')).toBeInTheDocument();
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });
  });

  it('disables the confirm button when code is less than 6 digits', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByText('Disable Two-Factor Authentication')).toBeInTheDocument();
    });

    // Enter a short code
    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123' } });

    // The Disable 2FA button in the modal should be disabled
    const disableButtons = screen.getAllByRole('button', { name: /Disable 2FA/ });
    const modalDisableBtn = disableButtons[disableButtons.length - 1];
    expect(modalDisableBtn).toBeDisabled();
  });

  it('calls disable2FA API with correct code when confirmed', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    (authApi.disable2FA as any).mockResolvedValueOnce({});

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });

    // Find the Disable 2FA button in the modal (not the one in the main section)
    const disableButtons = screen.getAllByRole('button', { name: /Disable 2FA/ });
    const modalDisableBtn = disableButtons[disableButtons.length - 1];
    fireEvent.click(modalDisableBtn);

    await waitFor(() => {
      expect(authApi.disable2FA).toHaveBeenCalledWith('123456');
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Two-factor authentication disabled');
    });
  });

  it('closes disable 2FA modal when cancel is clicked', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByText('Disable Two-Factor Authentication')).toBeInTheDocument();
    });

    // Click cancel in the modal
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText('Disable Two-Factor Authentication')).not.toBeInTheDocument();
    });
  });

  // --- Trusted devices list rendering ---
  it('renders trusted devices list when devices are loaded', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: true,
      },
      {
        id: 'dev-2',
        deviceName: 'Firefox on macOS',
        ipAddress: '10.0.0.1',
        lastUsedAt: '2024-01-10T00:00:00Z',
        expiresAt: '2024-02-10T00:00:00Z',
        createdAt: '2024-01-05T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome on Windows')).toBeInTheDocument();
      expect(screen.getByText('Firefox on macOS')).toBeInTheDocument();
    });

    // Check "Current" badge
    expect(screen.getByText('Current')).toBeInTheDocument();

    // Check IP addresses
    expect(screen.getByText('IP: 192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('IP: 10.0.0.1')).toBeInTheDocument();
  });

  it('shows no trusted devices message when list is empty', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    (authApi.getTrustedDevices as any).mockResolvedValueOnce([]);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText(/No trusted devices/)).toBeInTheDocument();
    });
  });

  // --- Revoke single device button ---
  it('revokes a single device when Revoke button is clicked', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);
    (authApi.revokeTrustedDevice as any).mockResolvedValueOnce({});

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome on Windows')).toBeInTheDocument();
    });

    // Click the Revoke button next to the device
    const revokeButton = screen.getByRole('button', { name: 'Revoke' });
    fireEvent.click(revokeButton);

    await waitFor(() => {
      expect(authApi.revokeTrustedDevice).toHaveBeenCalledWith('dev-1');
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Device revoked');
    });
  });

  it('shows error toast when revoking a device fails', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);
    (authApi.revokeTrustedDevice as any).mockRejectedValueOnce(new Error('Revoke failed'));

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome on Windows')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to revoke device');
    });
  });

  // --- Revoke all devices button ---
  it('shows Revoke All button when there are trusted devices', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke All' })).toBeInTheDocument();
    });
  });

  it('opens revoke all confirmation modal', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke All' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke All' }));

    await waitFor(() => {
      expect(screen.getByText('Revoke All Trusted Devices')).toBeInTheDocument();
      expect(screen.getByText(/This will remove all trusted devices/)).toBeInTheDocument();
    });
  });

  it('revokes all devices when confirmed in modal', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
      {
        id: 'dev-2',
        deviceName: 'Firefox on macOS',
        ipAddress: '10.0.0.1',
        lastUsedAt: '2024-01-10T00:00:00Z',
        expiresAt: '2024-02-10T00:00:00Z',
        createdAt: '2024-01-05T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);
    (authApi.revokeAllTrustedDevices as any).mockResolvedValueOnce({ count: 2 });

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome on Windows')).toBeInTheDocument();
    });

    // Click the Revoke All button in the header
    const revokeAllButtons = screen.getAllByRole('button', { name: 'Revoke All' });
    fireEvent.click(revokeAllButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('Revoke All Trusted Devices')).toBeInTheDocument();
    });

    // Confirm in the modal - find the Revoke All button inside the modal
    const modalRevokeAll = screen.getAllByRole('button', { name: 'Revoke All' });
    // The last one is in the modal
    fireEvent.click(modalRevokeAll[modalRevokeAll.length - 1]);

    await waitFor(() => {
      expect(authApi.revokeAllTrustedDevices).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('2 device(s) revoked');
    });
  });

  it('closes revoke all modal when cancel is clicked', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke All' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke All' }));

    await waitFor(() => {
      expect(screen.getByText('Revoke All Trusted Devices')).toBeInTheDocument();
    });

    // Click cancel
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByText('Revoke All Trusted Devices')).not.toBeInTheDocument();
    });
  });

  it('shows error toast when revoking all devices fails', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: null,
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);
    (authApi.revokeAllTrustedDevices as any).mockRejectedValueOnce(new Error('Revoke all failed'));

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke All' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke All' }));

    await waitFor(() => {
      expect(screen.getByText('Revoke All Trusted Devices')).toBeInTheDocument();
    });

    const modalRevokeAll = screen.getAllByRole('button', { name: 'Revoke All' });
    fireEvent.click(modalRevokeAll[modalRevokeAll.length - 1]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to revoke devices');
    });
  });

  // --- SSO info banner ---
  it('shows SSO info banner for OIDC users', () => {
    const oidcUser = { ...mockUser, authProvider: 'oidc' as const };

    render(
      <SecuritySection
        user={oidcUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    const ssoElements = screen.getAllByText(/Single Sign-On \(SSO\)/);
    expect(ssoElements.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show SSO info banner for local users', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.queryByText(/Single Sign-On \(SSO\)/)).not.toBeInTheDocument();
  });

  // --- 2FA disable error handling ---
  it('shows error toast when disable 2FA API fails', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    (authApi.disable2FA as any).mockRejectedValueOnce(new Error('Invalid code'));

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '999999' } });

    const disableButtons = screen.getAllByRole('button', { name: /Disable 2FA/ });
    fireEvent.click(disableButtons[disableButtons.length - 1]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to disable 2FA');
    });
  });

  // --- Trusted devices not shown when 2FA disabled ---
  it('does not show trusted devices section when 2FA is not enabled', () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.queryByText('Trusted Devices')).not.toBeInTheDocument();
  });

  // --- 2FA Setup Modal onComplete callback ---
  it('enables 2FA and calls onPreferencesUpdated when setup is completed', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    // Open the 2FA setup modal
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    });

    // Click the Complete button in the mocked TwoFactorSetup
    fireEvent.click(screen.getByTestId('2fa-complete'));

    await waitFor(() => {
      expect(mockOnPreferencesUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: true })
      );
    });
  });

  // --- 2FA Setup Modal onSkip callback ---
  it('closes 2FA setup modal when skip is clicked', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    // Open the 2FA setup modal
    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    });

    // Click the Skip button in the mocked TwoFactorSetup
    fireEvent.click(screen.getByTestId('2fa-skip'));

    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-setup')).not.toBeInTheDocument();
    });

    // onPreferencesUpdated should not have been called since user skipped
    expect(mockOnPreferencesUpdated).not.toHaveBeenCalled();
  });

  // --- Trusted devices: device without IP address ---
  it('renders device without IP address correctly', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Safari on iPhone',
        ipAddress: null,
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('Safari on iPhone')).toBeInTheDocument();
    });

    // IP address should not be rendered when null
    expect(screen.queryByText(/IP:/)).not.toBeInTheDocument();
  });

  // --- Modal onClose callbacks (Escape key) ---
  it('closes 2FA setup modal via Escape key (onClose callback)', async () => {
    render(
      <SecuritySection
        user={mockUser}
        preferences={mockPreferences}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Enable 2FA' }));

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-setup')).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByTestId('two-factor-setup')).not.toBeInTheDocument();
    });
  });

  it('closes disable 2FA modal via Escape key and clears the code (onClose callback)', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: '123456' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('Disable Two-Factor Authentication')).not.toBeInTheDocument();
    });
  });

  it('closes revoke all modal via Escape key (onClose callback)', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };
    const mockDevices = [
      {
        id: 'dev-1',
        deviceName: 'Chrome on Windows',
        ipAddress: '192.168.1.1',
        lastUsedAt: '2024-01-15T00:00:00Z',
        expiresAt: '2024-02-15T00:00:00Z',
        createdAt: '2024-01-01T00:00:00Z',
        isCurrent: false,
      },
    ];

    (authApi.getTrustedDevices as any).mockResolvedValueOnce(mockDevices);

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Revoke All' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Revoke All' }));

    await waitFor(() => {
      expect(screen.getByText('Revoke All Trusted Devices')).toBeInTheDocument();
    });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByText('Revoke All Trusted Devices')).not.toBeInTheDocument();
    });
  });

  // --- Verification code only allows digits ---
  it('strips non-digit characters from the verification code input', async () => {
    const prefsWith2fa = { ...mockPreferences, twoFactorEnabled: true };

    render(
      <SecuritySection
        user={mockUser}
        preferences={prefsWith2fa}
        force2fa={false}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disable 2FA' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Verification Code')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Verification Code'), { target: { value: 'abc123' } });

    expect((screen.getByLabelText('Verification Code') as HTMLInputElement).value).toBe('123');
  });
});
