import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { PreferencesSection } from './PreferencesSection';
import { UserPreferences } from '@/types/auth';

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

    fireEvent.change(screen.getByLabelText('Timezone'), { target: { value: 'America/New_York' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'America/New_York' })
      );
    });
  });

  it('sends updated default currency when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Default Currency')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText('Default Currency'), { target: { value: 'USD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ defaultCurrency: 'USD' })
      );
    });
  });

  it('sends updated theme when changed and saved', async () => {
    (userSettingsApi.updatePreferences as ReturnType<typeof vi.fn>).mockResolvedValue(mockPreferences);

    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'dark' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }));

    await waitFor(() => {
      expect(userSettingsApi.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' })
      );
    });
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
});
