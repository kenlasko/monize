import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, within } from '@testing-library/react';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { PreferencesSection } from './PreferencesSection';
import { UserPreferences } from '@/types/auth';

// jsdom does not implement scrollIntoView (needed by Combobox)
Element.prototype.scrollIntoView = vi.fn();

vi.mock('@/lib/user-settings', () => ({
  userSettingsApi: {
    updatePreferences: vi.fn(),
  },
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) => selector({ updatePreferences: vi.fn() })),
}));

vi.mock('@/lib/exchange-rates', () => ({
  exchangeRatesApi: {
    getCurrencies: vi.fn().mockResolvedValue([
      { code: 'CAD', name: 'Canadian Dollar' },
      { code: 'USD', name: 'US Dollar' },
    ]),
  },
  CurrencyInfo: {},
}));

vi.mock('@/lib/investments', () => ({
  investmentsApi: {
    getProviderStatus: vi.fn().mockResolvedValue({
      yahoo: { ready: true },
      msn: { ready: true },
    }),
  },
}));

vi.mock('@/lib/errors', () => ({
  getErrorMessage: vi.fn((_error: unknown, fallback: string) => fallback),
}));

import { userSettingsApi } from '@/lib/user-settings';
import { investmentsApi } from '@/lib/investments';
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
  notificationBrowser: false,
  twoFactorEnabled: false,
  gettingStartedDismissed: false,
  weekStartsOn: 1,
  budgetDigestEnabled: true,
  budgetDigestDay: 'MONDAY',
  showCreatedAt: false,
  timeFormat: '24h',
  favouriteReportIds: [],
  dashboardWidgets: [],
  preferredExchanges: [],
    defaultQuoteProvider: 'yahoo' as const,
    recentTransactionsLimit: 5,
  aiBubbleEnabled: false,
  language: 'en',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('PreferencesSection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the preferences heading and all selects', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByText('Preferences')).toBeInTheDocument();
    });
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Default Currency')).toBeInTheDocument();
    expect(screen.getByText('Date Format')).toBeInTheDocument();
    expect(screen.getByText('Number Format')).toBeInTheDocument();
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Preferences' })).toBeInTheDocument();
  });

  it('shows a help tooltip explaining the Show Create Date toggle', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByText('Show Create Date in transaction forms')).toBeInTheDocument();
    });
    expect(
      screen.getByLabelText(/the date and time a transaction was originally created/i),
    ).toBeInTheDocument();
  });

  it('shows theme options', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Theme')).toBeInTheDocument();
    });
  });

  it('calls updatePreferences and shows success toast on save', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Preferences saved');
    });
  });

  it('shows error toast when save fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save preferences');
    });
  });

  it('sends updated recent-transactions limit when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Recent transactions in quick-fill'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ recentTransactionsLimit: 10 }),
      );
    });
  });

  it('sends updated date format when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Date Format'), { target: { value: 'MM/DD/YYYY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ dateFormat: 'MM/DD/YYYY' })
      );
    });
  });

  it('sends updated number format when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Number Format'), { target: { value: 'de-DE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ numberFormat: 'de-DE' })
      );
    });
  });

  it('sends updated timezone when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    // Timezone is now a Combobox — find its input by the label text nearby
    const timezoneLabel = screen.getByText('Timezone');
    const timezoneInput = timezoneLabel.closest('.w-full')!.querySelector('input')!;
    fireEvent.focus(timezoneInput);

    // Wait for dropdown to appear, then select a timezone
    await waitFor(() => {
      expect(screen.getByText('America/New York')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('America/New York'));

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/New_York' })
      );
    });
  });

  it('shows auto-detected browser timezone in the browser option label', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    const timezoneLabel = screen.getByText('Timezone');
    const timezoneInput = timezoneLabel.closest('.w-full')!.querySelector('input')!;
    fireEvent.focus(timezoneInput);

    await waitFor(() => {
      // Scope to the timezone phrasing: the language selector's "use browser
      // locale" option also contains "auto-detected as".
      const browserOption = screen.getByText(/browser timezone \(auto-detected as/);
      expect(browserOption).toBeInTheDocument();
    });
  });

  it('shows the detected sample in the number-format browser option', async () => {
    await act(async () => {
      render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);
    });

    // The number-format browser option is the only "Use browser locale" entry
    // whose detected value is a number sample (the language option shows a name).
    const option = screen.getByText(/Use browser locale \(auto-detected as [\d.,\s]+\)/);
    expect(option).toBeInTheDocument();
  });

  it('shows the detected sample in the date-format browser option', async () => {
    await act(async () => {
      render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);
    });

    // Scope to the Date Format select so the date sample is unambiguous among
    // the other "auto-detected as" options (timezone, language, number format).
    const dateSelect = screen.getByLabelText('Date Format');
    const browserOption = within(dateSelect).getByText(/auto-detected as/);
    expect(browserOption).toBeInTheDocument();
  });

  it('allows searching for timezones by typing', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    const timezoneLabel = screen.getByText('Timezone');
    const timezoneInput = timezoneLabel.closest('.w-full')!.querySelector('input')!;
    await act(async () => { fireEvent.focus(timezoneInput); });

    // Wait for dropdown, then type to filter
    await new Promise(r => setTimeout(r, 150));
    await act(async () => { fireEvent.change(timezoneInput, { target: { value: 'Toronto' } }); });

    await waitFor(() => {
      expect(screen.getByText('America/Toronto')).toBeInTheDocument();
    });
  });

  it('sends updated default currency when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByText('USD - US Dollar')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Default Currency'), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ defaultCurrency: 'USD' })
      );
    });
  });

  it('persists the theme immediately on change, without waiting for save', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } });
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ theme: 'dark' });
    });
  });

  it('does not include theme in the bulk Save Preferences payload', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalled();
    });
    expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
      expect.not.objectContaining({ theme: expect.anything() }),
    );
  });

  it('persists the colour theme immediately on change, without waiting for save', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Colour theme'), { target: { value: 'latte' } });
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ colorTheme: 'latte' });
    });
  });

  it('does not include colorTheme in the bulk Save Preferences payload', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalled();
    });
    expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
      expect.not.objectContaining({ colorTheme: expect.anything() }),
    );
  });

  it('renders the Week starts on dropdown', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByText('Week starts on')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Week starts on')).toBeInTheDocument();
  });

  it('sends updated weekStartsOn when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ weekStartsOn: 0 })
      );
    });
  });

  it('shows Saving... text while preferences are being saved', async () => {
    let resolvePromise: (value: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockReturnValue(pendingPromise);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Saving...' })).toBeInTheDocument();
    });

    resolvePromise!(mockPreferences);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Save Preferences' })).toBeInTheDocument();
    });
  });

  it('calls onPreferencesUpdated with updated preferences on successful save', async () => {
    const updatedPrefs = { ...mockPreferences, theme: 'dark' as const };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(mockOnPreferencesUpdated).toHaveBeenCalledWith(updatedPrefs);
    });
  });

  it('renders the preferred exchanges section', async () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByText('Preferred Exchanges (for security lookups)')).toBeInTheDocument();
    });
    expect(screen.getByText(/Select up to 3 exchanges/)).toBeInTheDocument();
  });

  it('renders preferred exchanges from preferences', async () => {
    const prefsWithExchanges = {
      ...mockPreferences,
      preferredExchanges: ['LSE', 'ASX'],
    };

    render(<PreferencesSection preferences={prefsWithExchanges} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    // The Combobox should display the exchange labels
    await waitFor(() => {
      const inputs = screen.getAllByPlaceholderText(/Priority/);
      expect(inputs.length).toBe(3);
    });
  });

  it('sends preferredExchanges when saving', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ preferredExchanges: [] })
      );
    });
  });

  describe('MSN provider configuration warning', () => {
    it('does not show the warning when default provider is yahoo, even if MSN is unconfigured', async () => {
      (investmentsApi.getProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        yahoo: { ready: true },
        msn: { ready: false },
      });

      render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      // Wait for the status fetch to settle
      await waitFor(() => {
        expect(investmentsApi.getProviderStatus).toHaveBeenCalled();
      });

      expect(screen.queryByTestId('msn-not-configured-error')).not.toBeInTheDocument();
    });

    it('does not show the warning when default provider is MSN and the key is configured', async () => {
      (investmentsApi.getProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        yahoo: { ready: true },
        msn: { ready: true },
      });
      const msnPrefs = { ...mockPreferences, defaultQuoteProvider: 'msn' as const };

      render(
        <PreferencesSection
          preferences={msnPrefs}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(investmentsApi.getProviderStatus).toHaveBeenCalled();
      });

      expect(screen.queryByTestId('msn-not-configured-error')).not.toBeInTheDocument();
    });

    it('shows the warning when default provider is MSN and the key is missing', async () => {
      (investmentsApi.getProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        yahoo: { ready: true },
        msn: { ready: false },
      });
      const msnPrefs = { ...mockPreferences, defaultQuoteProvider: 'msn' as const };

      render(
        <PreferencesSection
          preferences={msnPrefs}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTestId('msn-not-configured-error')).toBeInTheDocument();
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/MSN_API_KEY/);
    });

    it('shows the warning after the user switches the default provider to MSN', async () => {
      (investmentsApi.getProviderStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        yahoo: { ready: true },
        msn: { ready: false },
      });

      render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(investmentsApi.getProviderStatus).toHaveBeenCalled();
      });
      expect(screen.queryByTestId('msn-not-configured-error')).not.toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Default Stock Quote Provider'), {
        target: { value: 'msn' },
      });

      await waitFor(() => {
        expect(screen.getByTestId('msn-not-configured-error')).toBeInTheDocument();
      });
    });

    it('does not show the warning when the status fetch fails', async () => {
      (investmentsApi.getProviderStatus as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('network'),
      );
      const msnPrefs = { ...mockPreferences, defaultQuoteProvider: 'msn' as const };

      render(
        <PreferencesSection
          preferences={msnPrefs}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(investmentsApi.getProviderStatus).toHaveBeenCalled();
      });

      expect(screen.queryByTestId('msn-not-configured-error')).not.toBeInTheDocument();
    });
  });
});
