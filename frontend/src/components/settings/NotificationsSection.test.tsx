import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@/test/render';
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

// The channel matrix mounts inside this section now (independent of the email
// switch), so its two mount fetches must resolve deterministically. An empty
// preferences list renders the matrix as null, which keeps these tests about the
// section's own controls; the matrix has its own suite.
vi.mock('@/lib/notification-preferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/notification-preferences')>()),
  notificationPreferencesApi: {
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
    getPortfolioAlert: vi.fn().mockResolvedValue({ movePercent: null }),
    setPortfolioAlert: vi.fn().mockResolvedValue({ movePercent: null }),
  },
}));

vi.mock('@/lib/push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/push')>()),
  pushApi: { listDevices: vi.fn().mockResolvedValue([]) },
}));

import { userSettingsApi } from '@/lib/user-settings';
import toast from 'react-hot-toast';

const mockPreferences: UserPreferences = {
  userId: 'user-1',
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  colorTheme: 'default',
  defaultCurrency: 'CAD',
  notificationEmail: false,
  twoFactorEnabled: false,
  gettingStartedDismissed: false,
  weekStartsOn: 1,
  budgetDigestEnabled: true,
  budgetDigestDay: 'MONDAY',
  showCreatedAt: false,
  timeFormat: '24h',
  favouriteReportIds: [],
  dashboardWidgets: [],
  dashboardWidgetConfig: {},
  hiddenTableColumns: {},
  preferredExchanges: [],
    defaultQuoteProvider: 'yahoo' as const,
    recentTransactionsLimit: 5,
  aiBubbleEnabled: false,
  aiTriviaEnabled: true,
  showWhatsNew: true,
  lockReconciledTransactions: false,
  payeeContactLookupEnabled: false,
  language: 'en',
  defaultMapProvider: 'device',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('NotificationsSection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The matrix fetches preferences and devices on mount, so the render is async
  // (the codebase pattern: one awaited-act render helper per file). The trailing
  // drain settles those mount promises before the test asserts or interacts.
  async function renderSection(props: {
    initialNotificationEmail: boolean;
    smtpConfigured: boolean;
    preferences?: UserPreferences;
  }) {
    await act(async () => {
      render(
        <NotificationsSection
          initialNotificationEmail={props.initialNotificationEmail}
          smtpConfigured={props.smtpConfigured}
          preferences={props.preferences ?? mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );
    });
    await act(async () => {});
  }

  it('renders the notifications heading', async () => {
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });
    expect(screen.getByText('Notifications')).toBeInTheDocument();
  });

  it('shows SMTP not configured message when smtp is not configured', async () => {
    await renderSection({ initialNotificationEmail: false, smtpConfigured: false });
    expect(screen.getByText(/SMTP has not been configured/)).toBeInTheDocument();
    expect(screen.queryByText('Email Notifications')).not.toBeInTheDocument();
  });

  it('shows email notification toggle when SMTP is configured', async () => {
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });
    expect(screen.getByText('Email Notifications')).toBeInTheDocument();
    expect(screen.getAllByRole('switch').length).toBeGreaterThanOrEqual(1);
  });

  it('toggles notification on switch click', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });

    // When notifications are off, the master email switch is the first one.
    await act(async () => fireEvent.click(screen.getAllByRole('switch')[0]));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ notificationEmail: true });
      expect(toast.success).toHaveBeenCalledWith('Email notifications enabled');
    });
  });

  it('shows Send Test Email button', async () => {
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });
    expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeInTheDocument();
  });

  it('disables Send Test Email when notifications are off', async () => {
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });
    expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeDisabled();
  });

  it('reverts toggle and shows error toast when toggle API call fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Network error')
    );
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });

    const toggle = screen.getAllByRole('switch')[0];
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    await act(async () => fireEvent.click(toggle));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to update notification preference');
    });

    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('shows disabled message toast when toggling notifications off', async () => {
    const updatedPrefs = { ...mockPreferences, notificationEmail: false };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });

    const toggle = screen.getAllByRole('switch')[0];
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await act(async () => fireEvent.click(toggle));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ notificationEmail: false });
      expect(toast.success).toHaveBeenCalledWith('Email notifications disabled');
    });
  });

  it('sends test email successfully and shows success toast', async () => {
    (userSettingsApi.sendTestEmail as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' })));

    await waitFor(() => {
      expect(userSettingsApi.sendTestEmail).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Test email sent! Check your inbox.');
    });
  });

  it('shows error toast when send test email fails', async () => {
    (userSettingsApi.sendTestEmail as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SMTP error')
    );
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' })));

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
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send Test Email' })));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sending...' })).toBeInTheDocument();
    });

    await act(async () => {
      resolvePromise!({});
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send Test Email' })).toBeInTheDocument();
    });
  });

  it('calls onPreferencesUpdated when toggle succeeds', async () => {
    const updatedPrefs = { ...mockPreferences, notificationEmail: true };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });

    await act(async () => fireEvent.click(screen.getAllByRole('switch')[0]));

    await waitFor(() => {
      expect(mockOnPreferencesUpdated).toHaveBeenCalledWith(updatedPrefs);
    });
  });

  it('shows budget digest toggle when email notifications are enabled', async () => {
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });
    expect(screen.getByText('Budget Notifications')).toBeInTheDocument();
    expect(screen.getByText('Weekly Budget Digest')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle budget digest')).toBeInTheDocument();
  });

  it('hides budget digest section when email notifications are disabled', async () => {
    await renderSection({ initialNotificationEmail: false, smtpConfigured: true });
    expect(screen.queryByText('Budget Notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly Budget Digest')).not.toBeInTheDocument();
  });

  it('shows digest day selector when budget digest is enabled', async () => {
    await renderSection({
      initialNotificationEmail: true,
      smtpConfigured: true,
      preferences: { ...mockPreferences, budgetDigestEnabled: true },
    });
    expect(screen.getByLabelText('Budget digest day')).toBeInTheDocument();
  });

  it('hides digest day selector when budget digest is disabled', async () => {
    await renderSection({
      initialNotificationEmail: true,
      smtpConfigured: true,
      preferences: { ...mockPreferences, budgetDigestEnabled: false },
    });
    expect(screen.queryByLabelText('Budget digest day')).not.toBeInTheDocument();
  });

  it('toggles budget digest', async () => {
    const updatedPrefs = { ...mockPreferences, budgetDigestEnabled: false };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);
    await renderSection({
      initialNotificationEmail: true,
      smtpConfigured: true,
      preferences: { ...mockPreferences, budgetDigestEnabled: true },
    });

    await act(async () => fireEvent.click(screen.getByLabelText('Toggle budget digest')));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ budgetDigestEnabled: false });
      expect(toast.success).toHaveBeenCalledWith('Budget digest disabled');
    });
  });

  it('changes digest day', async () => {
    const updatedPrefs = { ...mockPreferences, budgetDigestDay: 'FRIDAY' as const };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);
    await renderSection({ initialNotificationEmail: true, smtpConfigured: true });

    await act(async () =>
      fireEvent.change(screen.getByLabelText('Budget digest day'), { target: { value: 'FRIDAY' } }),
    );

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ budgetDigestDay: 'FRIDAY' });
      expect(toast.success).toHaveBeenCalledWith('Budget digest day set to Friday');
    });
  });
});
