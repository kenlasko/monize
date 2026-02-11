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
  dateFormat: 'YYYY-MM-DD',
  numberFormat: 'en-US',
  timezone: 'UTC',
  theme: 'system',
  defaultCurrency: 'CAD',
  notificationEmail: false,
  twoFactorEnabled: false,
};

describe('PreferencesSection', () => {
  const mockOnPreferencesUpdated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the preferences heading and all selects', () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    expect(screen.getByText('Preferences')).toBeInTheDocument();
    expect(screen.getByText('Theme')).toBeInTheDocument();
    expect(screen.getByText('Default Currency')).toBeInTheDocument();
    expect(screen.getByText('Date Format')).toBeInTheDocument();
    expect(screen.getByText('Number Format')).toBeInTheDocument();
    expect(screen.getByText('Timezone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Preferences' })).toBeInTheDocument();
  });

  it('shows theme options', () => {
    render(<PreferencesSection preferences={mockPreferences} onPreferencesUpdated={mockOnPreferencesUpdated} />);

    const themeSelect = screen.getByLabelText('Theme');
    expect(themeSelect).toBeInTheDocument();
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
});
