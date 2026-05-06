'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useTheme } from '@/contexts/ThemeContext';
import { UserPreferences, UpdatePreferencesData } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { investmentsApi } from '@/lib/investments';
import { Combobox } from '@/components/ui/Combobox';
import { DATE_FORMAT_OPTIONS, EXCHANGE_OPTIONS } from '@/lib/constants';

const NUMBER_FORMAT_OPTIONS = [
  { value: 'browser', label: 'Use browser locale (auto-detect)' },
  { value: 'en-US', label: 'English (US) - 1,234.56' },
  { value: 'en-GB', label: 'English (UK) - 1,234.56' },
  { value: 'de-DE', label: 'German - 1.234,56' },
  { value: 'fr-FR', label: 'French - 1 234,56' },
];

function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function buildTimezoneOptions(): { value: string; label: string }[] {
  const browserTz = getBrowserTimezone();
  const options: { value: string; label: string }[] = [
    { value: 'browser', label: `Use browser timezone (auto-detected as ${browserTz})` },
    { value: 'UTC', label: 'UTC' },
  ];

  const allTimezones = Intl.supportedValuesOf('timeZone').filter((tz) => tz !== 'UTC');

  for (const tz of allTimezones) {
    // Format: "America/New_York" -> "America/New York"
    const label = tz.replaceAll('_', ' ');
    options.push({ value: tz, label });
  }

  return options;
}

const TIMEZONE_OPTIONS = buildTimezoneOptions();

const WEEK_STARTS_ON_OPTIONS = [
  { value: '0', label: 'Sunday' },
  { value: '1', label: 'Monday' },
  { value: '2', label: 'Tuesday' },
  { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' },
  { value: '5', label: 'Friday' },
  { value: '6', label: 'Saturday' },
];

const THEME_OPTIONS = [
  { value: 'system', label: 'System (follow device setting)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const QUOTE_PROVIDER_OPTIONS = [
  { value: 'yahoo', label: 'Yahoo Finance' },
  { value: 'msn', label: 'MSN Money' },
];

const RECENT_TRANSACTIONS_LIMIT_OPTIONS = [
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: '20', label: '20' },
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
  const [weekStartsOn, setWeekStartsOn] = useState(preferences.weekStartsOn ?? 1);
  const [showCreatedAt, setShowCreatedAt] = useState(preferences.showCreatedAt ?? false);
  const [timeFormat, setTimeFormat] = useState<'24h' | '12h'>(preferences.timeFormat ?? '24h');
  const [preferredExchanges, setPreferredExchanges] = useState<string[]>(
    preferences.preferredExchanges ?? [],
  );
  const [defaultQuoteProvider, setDefaultQuoteProvider] = useState<'yahoo' | 'msn'>(
    preferences.defaultQuoteProvider ?? 'yahoo',
  );
  const [recentTransactionsLimit, setRecentTransactionsLimit] = useState(
    preferences.recentTransactionsLimit ?? 5,
  );
  const [isUpdatingPreferences, setIsUpdatingPreferences] = useState(false);

  const [availableCurrencies, setAvailableCurrencies] = useState<CurrencyInfo[]>([]);
  const [msnReady, setMsnReady] = useState<boolean | null>(null);

  useEffect(() => {
    exchangeRatesApi.getCurrencies().then(setAvailableCurrencies).catch(() => {});
  }, []);

  useEffect(() => {
    investmentsApi
      .getProviderStatus()
      .then((status) => setMsnReady(status.msn.ready))
      .catch(() => setMsnReady(null));
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
        weekStartsOn,
        showCreatedAt,
        timeFormat,
        preferredExchanges: preferredExchanges.filter(Boolean),
        defaultQuoteProvider,
        recentTransactionsLimit,
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

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Preferred Exchanges (for security lookups)
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            Select up to 3 exchanges in priority order. These will be preferred when looking up securities.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <Combobox
                key={i}
                options={EXCHANGE_OPTIONS
                  .filter(
                    (opt) =>
                      !preferredExchanges.includes(opt.value) ||
                      preferredExchanges[i] === opt.value,
                  )
                  .sort((a, b) => a.label.localeCompare(b.label))}
                value={preferredExchanges[i] || ''}
                onChange={(value) => {
                  const updated = [...preferredExchanges];
                  if (value) {
                    updated[i] = value;
                  } else {
                    updated.splice(i, 1);
                  }
                  setPreferredExchanges(updated.filter(Boolean));
                }}
                placeholder={`Priority ${i + 1}`}
                alwaysShowSubtitle
              />
            ))}
          </div>
        </div>

        <div>
          <Select
            label="Default Stock Quote Provider"
            options={QUOTE_PROVIDER_OPTIONS}
            value={defaultQuoteProvider}
            onChange={(e) => setDefaultQuoteProvider(e.target.value as 'yahoo' | 'msn')}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Used when a security has no provider override. If the chosen provider fails, Monize automatically tries the other.
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Note: MSN Money does not provide intraday quote data, so the 1D / 1W / 1M ranges on the Portfolio Value Over Time chart are unavailable for MSN-tracked holdings.
          </p>
          {defaultQuoteProvider === 'msn' && msnReady === false && (
            <p
              role="alert"
              className="text-sm text-red-600 dark:text-red-400 mt-2"
              data-testid="msn-not-configured-error"
            >
              MSN is selected as the default quote provider, but{' '}
              <code>MSN_API_KEY</code> is not configured on the server. MSN
              quotes will fail until an administrator sets the env var and
              restarts the backend.
            </p>
          )}
        </div>

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

        <Combobox
          label="Timezone"
          options={TIMEZONE_OPTIONS}
          value={timezone}
          onChange={(value) => setTimezone(value)}
          placeholder="Search timezones..."
        />

        <Select
          label="Week starts on"
          options={WEEK_STARTS_ON_OPTIONS}
          value={String(weekStartsOn)}
          onChange={(e) => setWeekStartsOn(Number(e.target.value))}
        />

        <label
          htmlFor="showCreatedAt"
          className="flex items-center gap-2 cursor-pointer"
        >
          <ToggleSwitch
            checked={showCreatedAt}
            onChange={setShowCreatedAt}
            label="Show Create Date in transaction forms"
          />
          <span className="text-sm text-gray-900 dark:text-gray-100">
            Show Create Date in transaction forms
          </span>
        </label>

        {showCreatedAt && (
          <Select
            label="Time Format"
            options={[
              { value: '24h', label: '24-hour (14:30)' },
              { value: '12h', label: '12-hour (2:30 PM)' },
            ]}
            value={timeFormat}
            onChange={(e) => setTimeFormat(e.target.value as '24h' | '12h')}
          />
        )}

        <div>
          <Select
            label="Recent transactions in quick-fill"
            options={RECENT_TRANSACTIONS_LIMIT_OPTIONS}
            value={String(recentTransactionsLimit)}
            onChange={(e) => setRecentTransactionsLimit(Number(e.target.value))}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Number of entries shown in the history button popover next to the Payee field on transaction forms.
          </p>
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={handleUpdatePreferences} disabled={isUpdatingPreferences}>
          {isUpdatingPreferences ? 'Saving...' : 'Save Preferences'}
        </Button>
      </div>
    </div>
  );
}
