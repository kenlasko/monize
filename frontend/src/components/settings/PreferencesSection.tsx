'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import { UserPreferences, UpdatePreferencesData } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';

const DATE_FORMAT_OPTIONS = [
  { value: 'browser', label: 'Use browser locale (auto-detect)' },
  { value: 'YYYY-MM-DD', label: 'YYYY-MM-DD (2024-12-31)' },
  { value: 'MM/DD/YYYY', label: 'MM/DD/YYYY (12/31/2024)' },
  { value: 'DD/MM/YYYY', label: 'DD/MM/YYYY (31/12/2024)' },
  { value: 'DD-MMM-YYYY', label: 'DD-MMM-YYYY (31-Dec-2024)' },
];

const NUMBER_FORMAT_OPTIONS = [
  { value: 'browser', label: 'Use browser locale (auto-detect)' },
  { value: 'en-US', label: 'English (US) - 1,234.56' },
  { value: 'en-GB', label: 'English (UK) - 1,234.56' },
  { value: 'de-DE', label: 'German - 1.234,56' },
  { value: 'fr-FR', label: 'French - 1 234,56' },
];

const TIMEZONE_OPTIONS = [
  { value: 'browser', label: 'Use browser timezone (auto-detect)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Toronto', label: 'Eastern Time (Canada)' },
  { value: 'America/Vancouver', label: 'Pacific Time (Canada)' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Paris', label: 'Paris' },
  { value: 'Europe/Berlin', label: 'Berlin' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Shanghai', label: 'Shanghai' },
  { value: 'Australia/Sydney', label: 'Sydney' },
];

const THEME_OPTIONS = [
  { value: 'system', label: 'System (follow device setting)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

interface PreferencesSectionProps {
  preferences: UserPreferences;
  onPreferencesUpdated: (prefs: UserPreferences) => void;
}

export function PreferencesSection({ preferences, onPreferencesUpdated }: PreferencesSectionProps) {
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);
  const { setTheme: setAppTheme } = useTheme();

  const [dateFormat, setDateFormat] = useState(preferences.dateFormat);
  const [numberFormat, setNumberFormat] = useState(preferences.numberFormat);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(preferences.theme);
  const [defaultCurrency, setDefaultCurrency] = useState(preferences.defaultCurrency);
  const [isUpdatingPreferences, setIsUpdatingPreferences] = useState(false);

  const [availableCurrencies, setAvailableCurrencies] = useState<CurrencyInfo[]>([]);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setAvailableCurrencies).catch(() => {});
  }, []);

  const currencyOptions = useMemo(() => {
    return availableCurrencies.map((c) => ({
      value: c.code,
      label: `${c.code} - ${c.name}`,
    }));
  }, [availableCurrencies]);

  const handleUpdatePreferences = async () => {
    setIsUpdatingPreferences(true);
    try {
      const data: UpdatePreferencesData = {
        dateFormat,
        numberFormat,
        timezone,
        theme,
        defaultCurrency,
      };

      const updated = await userSettingsApi.updatePreferences(data);
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      setAppTheme(theme);
      toast.success('Preferences saved');
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to save preferences'));
    } finally {
      setIsUpdatingPreferences(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Preferences</h2>

      <div className="space-y-4">
        <Select
          label="Theme"
          options={THEME_OPTIONS}
          value={theme}
          onChange={(e) => setTheme(e.target.value as 'light' | 'dark' | 'system')}
        />

        <Select
          label="Default Currency"
          options={currencyOptions}
          value={defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
        />

        <Select
          label="Date Format"
          options={DATE_FORMAT_OPTIONS}
          value={dateFormat}
          onChange={(e) => setDateFormat(e.target.value)}
        />

        <Select
          label="Number Format"
          options={NUMBER_FORMAT_OPTIONS}
          value={numberFormat}
          onChange={(e) => setNumberFormat(e.target.value)}
        />

        <Select
          label="Timezone"
          options={TIMEZONE_OPTIONS}
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
        />
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={handleUpdatePreferences} disabled={isUpdatingPreferences}>
          {isUpdatingPreferences ? 'Saving...' : 'Save Preferences'}
        </Button>
      </div>
    </div>
  );
}
