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
  showWhatsNew: true,
  lockReconciledTransactions: false,
  payeeContactLookupEnabled: false,
  language: 'en',
  defaultMapProvider: 'device',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

describe('PreferencesSection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the reporting-basis control until accrual accounting is enabled', async () => {
    await act(async () => { render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />); });
    expect(screen.queryByLabelText('Default reporting basis')).not.toBeInTheDocument();
  });

  it('defaults reporting to cash and saves the single user-level accrual preference', async () => {
    vi.mocked(userSettingsApi.updatePreferences).mockResolvedValue({ ...mockPreferences, accrualEnabled: true, reportingBasis: 'accrual' });
    await act(async () => { render(<PreferencesSection preferences={{ ...mockPreferences, accrualEnabled: true }} onPreferencesUpdated={mockOnPreferencesUpdated} />); });
    const control = screen.getByLabelText('Default reporting basis');
    expect(control).toHaveValue('cash');
    await act(async () => { fireEvent.change(control, { target: { value: 'accrual' } }); });
    expect(userSettingsApi.updatePreferences).toHaveBeenLastCalledWith({ reportingBasis: 'accrual' });
    expect(mockOnPreferencesUpdated).toHaveBeenLastCalledWith(expect.objectContaining({ reportingBasis: 'accrual' }));
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
    // Every control here persists on change, so there is no Save button and
    // no half-saved state between a change and a click.
    expect(screen.queryByRole('button', { name: 'Save Preferences' })).toBeNull();
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

  it('saves a change as it is made, and says so', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalled();
      expect(toast.success).toHaveBeenCalledWith('Preferences saved');
    });
  });

  /**
   * An optimistic write has to be able to undo itself: the control moved before
   * the server agreed, so a refusal that left it showing the new value would
   * report a preference the account does not hold.
   */
  it('puts the control back and says so when the save fails', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    const weekStart = screen.getByLabelText('Week starts on') as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(weekStart, { target: { value: '0' } });
    });
    await act(async () => {}); // drain the rejection handler

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to save preferences');
    });
    await waitFor(() => expect(weekStart.value).toBe('1'));
  });

  it('sends updated recent-transactions limit when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Recent transactions in quick-fill'), {
      target: { value: '10' },
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ recentTransactionsLimit: 10 }),
      );
    });
  });

  describe('the strict reconciled lock', () => {
    it('renders the toggle off for a user who has not enabled it', async () => {
      render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

      await waitFor(() => {
        expect(screen.getByText('Lock reconciled transactions')).toBeInTheDocument();
      });
      expect(
        screen.getByRole('switch', { name: 'Lock reconciled transactions' }),
      ).toHaveAttribute('aria-checked', 'false');
    });

    it('sends the flag when it is turned on and saved', async () => {
      (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

      render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

      fireEvent.click(screen.getByRole('switch', { name: 'Lock reconciled transactions' }));

      await waitFor(() => {
        expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
          expect.objectContaining({ lockReconciledTransactions: true }),
        );
      });
    });

    it('sends the chosen map provider when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(
      <PreferencesSection
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />,
    );

    fireEvent.change(screen.getByLabelText('Map provider for addresses'), {
      target: { value: 'google' },
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ defaultMapProvider: 'google' }),
      );
    });
  });

  /**
   * These two replace a pair that pinned properties of the bulk payload: that
   * it resent every field it owned, and that a field left out of it would be
   * reset on the next unrelated save. A per-field PATCH cannot have that
   * defect -- it carries the one field that changed -- so what is worth pinning
   * is the property that replaced it.
   */
  it('sends the changed field and nothing else', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(
      <PreferencesSection
        preferences={{ ...mockPreferences, defaultMapProvider: 'waze' }}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />,
    );

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });

    await waitFor(() => expect(userSettingsApi.updatePreferences).toHaveBeenCalled());
    expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ weekStartsOn: 0 });
  });

  it('writes nothing while the reader only looks', async () => {
      (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);
      const locked = { ...mockPreferences, lockReconciledTransactions: true };

      render(<PreferencesSection preferences={locked} onPreferencesUpdated={mockOnPreferencesUpdated} />);

      await waitFor(() =>
        expect(screen.getByText('Lock reconciled transactions')).toBeInTheDocument(),
      );
      expect(userSettingsApi.updatePreferences).not.toHaveBeenCalled();
    });

  // A control re-emitting the value it already holds is not an edit, and a
  // request per non-edit is a toast per non-edit too.
  it('writes nothing when a control re-emits the value it already holds', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '1' } });
    });

    expect(userSettingsApi.updatePreferences).not.toHaveBeenCalled();
  });
  });

  /**
   * The Portfolio Value chart's 1D / 1W / MTD change was briefly configurable
   * here (`portfolio_change_baseline`, migration 152, dropped by 153). It is
   * now always the prior trading close -- the answer every quote source gives
   * for a daily move -- so there is no control, and nothing is sent for it.
   */
  it('no longer offers a portfolio-change baseline control', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockPreferences,
    );

    render(
      <PreferencesSection
        preferences={mockPreferences}
        onPreferencesUpdated={mockOnPreferencesUpdated}
      />,
    );

    expect(screen.queryByLabelText('Portfolio change measured from')).toBeNull();

    // Nothing sends it either -- driven from a change now that there is no
    // bulk save to inspect.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });
    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalled();
    });
    expect(userSettingsApi.updatePreferences).not.toHaveBeenCalledWith(
      expect.objectContaining({ portfolioChangeBaseline: expect.anything() }),
    );
  });

  it('sends updated date format when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Date Format'), { target: { value: 'MM/DD/YYYY' } });

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

  // The selector owns the write, so the section must not send it a second time
  // alongside a field of its own.
  it('never sends theme alongside another field', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });

    await waitFor(() => expect(userSettingsApi.updatePreferences).toHaveBeenCalled());
    expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
      expect.not.objectContaining({ theme: expect.anything() }),
    );
  });

  it('persists the colour theme immediately on change, without waiting for save', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /latte/i }));
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith({ colorTheme: 'latte' });
    });
  });

  it('never sends colorTheme alongside another field', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });

    await waitFor(() => expect(userSettingsApi.updatePreferences).toHaveBeenCalled());
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

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ weekStartsOn: 0 })
      );
    });
  });

  it('calls onPreferencesUpdated with updated preferences on successful save', async () => {
    const updatedPrefs = { ...mockPreferences, theme: 'dark' as const };
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(updatedPrefs);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Week starts on'), { target: { value: '0' } });
    });

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

  it('saves a preferred exchange as it is picked', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    const first = screen.getAllByPlaceholderText(/Priority/)[0];
    await act(async () => {
      fireEvent.focus(first);
      fireEvent.change(first, { target: { value: 'London' } });
    });
    const option = await screen.findByText(/London Stock Exchange/i);
    await act(async () => {
      fireEvent.click(option);
    });

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ preferredExchanges: expect.arrayContaining(['LSE']) }),
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

  /**
   * The section is one card of sixteen controls, and the ONLY thing holding
   * their order and their grouping is the JSX. Every other test in this file
   * asserts by accessible label, so all thirty-six stayed green through the
   * reorder that introduced these -- which is the finding, not the pass.
   * These read the rendered order back out of the DOM.
   */
  describe('control order and grouping', () => {
    // Group headings interleaved with the labels of the controls under them,
    // in the order the card must render. Time Format is deliberately absent:
    // it is gated on Show Create Date and has its own case below.
    const EXPECTED_ORDER = [
      'Language & Region',
      'Language',
      'Default Currency',
      'Appearance',
      'Theme',
      'Colour theme',
      'Dates & Numbers',
      'Date Format',
      'Number Format',
      'Timezone',
      'Week starts on',
      'Show Create Date in transaction forms',
      'Investments',
      'Default Stock Quote Provider',
      'Preferred Exchanges (for security lookups)',
      'Transactions',
      'Recent transactions in quick-fill',
      'Lock reconciled transactions',
      'Application',
      'Map provider for addresses',
      "Show What's New after an upgrade",
    ];

    const KNOWN_TEXTS = new Set([...EXPECTED_ORDER, 'Time Format']);

    /**
     * The labels and group headings the card renders, in document order.
     * Walks every element and takes the first one whose own text is exactly a
     * known label -- the controls use three different label elements (`label`
     * for Select/Combobox, a `span` for the colour-theme radiogroup, `h3` for
     * the group headings), so matching on text is what keeps this independent
     * of which element each one happens to use.
     */
    function readRenderedOrder(container: HTMLElement): string[] {
      const seen = new Set<string>();
      const order: string[] = [];
      for (const el of Array.from(container.querySelectorAll<HTMLElement>('*'))) {
        const text = el.textContent?.trim() ?? '';
        if (KNOWN_TEXTS.has(text) && !seen.has(text)) {
          seen.add(text);
          order.push(text);
        }
      }
      return order;
    }

    it('renders every control under its own group heading, in order', async () => {
      const { container } = render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Map provider for addresses')).toBeInTheDocument();
      });

      expect(readRenderedOrder(container)).toEqual(EXPECTED_ORDER);
    });

    it('renders the seven group headings as headings, in order', async () => {
      const { container } = render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Application')).toBeInTheDocument();
      });

      const headings = Array.from(container.querySelectorAll('h3')).map((h) =>
        h.textContent?.trim(),
      );
      expect(headings).toEqual([
        'Language & Region',
        'Appearance',
        'Dates & Numbers',
        'Investments',
        'Transactions',
        'Default Views',
        'Application',
      ]);
    });

    it('separates the groups with a rule, except the first', async () => {
      const { container } = render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText('Application')).toBeInTheDocument();
      });

      // The wrapper of each group is its heading's parent. The first group
      // opens the card, where a rule would read as a second heading under
      // "Preferences"; every group after it is separated by one.
      const wrappers = Array.from(container.querySelectorAll('h3')).map((h) => h.parentElement!);
      expect(wrappers).toHaveLength(7);
      expect(wrappers[0].className).not.toMatch(/border-t/);
      for (const wrapper of wrappers.slice(1)) {
        expect(wrapper.className).toMatch(/border-t/);
        // A rule invisible in dark mode is not a rule.
        expect(wrapper.className).toMatch(/dark:border-/);
      }
    });

    it('hides Time Format until Show Create Date is on, then shows it directly beneath', async () => {
      const { container } = render(
        <PreferencesSection
          preferences={mockPreferences}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(
          screen.getByText('Show Create Date in transaction forms'),
        ).toBeInTheDocument();
      });
      expect(screen.queryByText('Time Format')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(
          screen.getByRole('switch', { name: 'Show Create Date in transaction forms' }),
        );
      });

      const order = readRenderedOrder(container);
      const toggleIndex = order.indexOf('Show Create Date in transaction forms');
      expect(order[toggleIndex + 1]).toBe('Time Format');
      // Still inside Dates & Numbers -- the next heading after it is Investments.
      expect(order[toggleIndex + 2]).toBe('Investments');
    });

    it('localizes the Time Format options rather than hardcoding English', async () => {
      render(
        <PreferencesSection
          preferences={{ ...mockPreferences, showCreatedAt: true }}
          onPreferencesUpdated={mockOnPreferencesUpdated}
        />,
      );

      await waitFor(() => {
        expect(screen.getByLabelText('Time Format')).toBeInTheDocument();
      });

      const select = screen.getByLabelText('Time Format') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.text)).toEqual([
        '24-hour (14:30)',
        '12-hour (2:30 PM)',
      ]);
    });
  });
});
