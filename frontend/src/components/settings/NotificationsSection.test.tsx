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
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  defaultCurrency: 'CAD',
  notificationEmail: false,
  twoFactorEnabled: false,
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
    expect(screen.getByRole('switch')).toBeInTheDocument();
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

    fireEvent.click(screen.getByRole('switch'));

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
});
