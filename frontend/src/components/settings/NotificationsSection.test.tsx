import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { NotificationsSection } from './NotificationsSection';
import { UserPreferences } from '@/types/auth';

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn(),
    sendTestEmail: vi.fn(),
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ updatePreferences: vi.fn() })),
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import toast from 'react-hot-toast';

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
  weekStartsOn: 1,
  budgetDigestEnabled: true,
  budgetDigestDay: 'MONDAY',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('NotificationsSection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the notifications heading', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('shows SMTP not configured message when smtp is not configured', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={false}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText(/SMTP has not been configured/)).toBeInTheDocument();
    expect(screen.queryByText('Email Notifications')).not.toBeInTheDocument();
  });

  it('shows email notification toggle when SMTP is configured', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Email Notifications')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(1);
  });

  it('toggles notification on switch click', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    // When notifications are off, only one switch is visible
    fireEvent.click(screen.getAllByRole('switch')[0]);

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ notificationEmail: true });
      expect(toast.success).toHaveBeenCalledWith('Email notifications enabled');
    });
  });

  it('shows Send Test Email button', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeInTheDocument();
  });

  it('disables Send Test Email when notifications are off', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeDisabled();
  });

  it('reverts toggle and shows error toast when toggle API call fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );

    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    const toggle = screen.getAllByRole('switch')[0];
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update notification preference');
    });

    // The toggle should revert back to false
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('shows disabled message toast when toggling notifications off', async () => {
    const updatedPrefs = { ...mockPreferences, notificationEmail: false };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    // First switch is the main email notifications toggle
    const toggle = screen.getAllByRole('switch')[0];
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ notificationEmail: false });
      expect(toast.success).toHaveBeenCalledWith('Email notifications disabled');
    });
  });

  it('sends test email successfully and shows success toast', async () => {
    (userSettingsApi.sendTestEmail as ReturnType<typeof vi.fn>).mockResolvedValue({});

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' }));

    await waitFor(() => {
      expect(userSettingsApi.sendTestEmail).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Test email sent! Check your inbox.');
    });
  });

  it('shows error toast when send test email fails', async () => {
    (userSettingsApi.sendTestEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SMTP error')
    );

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to send test email');
    });
  });

  it('shows Sending... text while test email is in progress', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (userSettingsApi.sendTestEmail as ReturnType<typeof vi.fn>).mockReturnValue(pendingPromise);

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sending...' })).toBeInTheDocument();
    });

    resolvePromise!({});

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeInTheDocument();
    });
  });

  it('calls onPreferencesUpdated when toggle succeeds', async () => {
    const updatedPrefs = { ...mockPreferences, notificationEmail: true };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getAllByRole('switch')[0]);

    await waitFor(() => {
      expect(mockOnPreferencesUpdated).toHaveBeenCalledWith(updatedPrefs);
    });
  });

  it('shows budget digest toggle when email notifications are enabled', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByText('Budget Notifications')).toBeInTheDocument();
    expect(screen.getByText('Weekly Budget Digest')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle budget digest')).toBeInTheDocument();
  });

  it('hides budget digest section when email notifications are disabled', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={false}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.queryByText('Budget Notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly Budget Digest')).not.toBeInTheDocument();
  });

  it('shows digest day selector when budget digest is enabled', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={{ ...mockPreferences, budgetDigestEnabled: true }}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.getByLabelText('Budget digest day')).toBeInTheDocument();
  });

  it('hides digest day selector when budget digest is disabled', () => {
    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={{ ...mockPreferences, budgetDigestEnabled: false }}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    expect(screen.queryByLabelText('Budget digest day')).not.toBeInTheDocument();
  });

  it('toggles budget digest', async () => {
    const updatedPrefs = { ...mockPreferences, budgetDigestEnabled: false };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={{ ...mockPreferences, budgetDigestEnabled: true }}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.click(screen.getByLabelText('Toggle budget digest'));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ budgetDigestEnabled: false });
      expect(toast.success).toHaveBeenCalledWith('Budget digest disabled');
    });
  });

  it('changes digest day', async () => {
    const updatedPrefs = { ...mockPreferences, budgetDigestDay: 'FRIDAY' as const };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(
      <NotificationsSection
        initialNotificationEmail={true}
        smtpConfigured={true}
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />
    );

    fireEvent.change(screen.getByLabelText('Budget digest day'), { target: { value: 'FRIDAY' } });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ budgetDigestDay: 'FRIDAY' });
      expect(toast.success).toHaveBeenCalledWith('Budget digest day set to Friday');
    });
  });
});
