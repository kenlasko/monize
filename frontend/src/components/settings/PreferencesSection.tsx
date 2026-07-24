'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { UserPreferences, UpdatePreferencesData } from '@/types/auth';
import { getErrorMessage } from '@/lib/errors';
import { exchangeRatesApi, CurrencyInfo } from '@/lib/exchange-rates';
import { investmentsApi } from '@/lib/investments';
import { Combobox } from '@/components/ui/Combobox';
import { getDateFormatOptions, EXCHANGE_OPTIONS } from '@/lib/constants';
import { getEffectiveLocale } from '@/hooks/useNumberFormat';
import { LanguageSelector } from '@/components/settings/LanguageSelector';
import { ThemeSelector } from '@/components/settings/ThemeSelector';
import { ColorThemeSelector } from '@/components/settings/ColorThemeSelector';
import { ColorTheme } from '@/lib/color-themes';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

const NUMBER_FORMAT_OPTIONS = [
  { value: 'browser', labelKey: 'numberFormatOptions.browser' },
  { value: 'en-US', labelKey: 'numberFormatOptions.enUS' },
  { value: 'en-GB', labelKey: 'numberFormatOptions.enGB' },
  { value: 'de-DE', labelKey: 'numberFormatOptions.deDE' },
  { value: 'fr-FR', labelKey: 'numberFormatOptions.frFR' },
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
  { value: '0', labelKey: 'weekDays.sunday' },
  { value: '1', labelKey: 'weekDays.monday' },
  { value: '2', labelKey: 'weekDays.tuesday' },
  { value: '3', labelKey: 'weekDays.wednesday' },
  { value: '4', labelKey: 'weekDays.thursday' },
  { value: '5', labelKey: 'weekDays.friday' },
  { value: '6', labelKey: 'weekDays.saturday' },
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
  const t = useTranslations('settings.preferences');
  const tc = useTranslations('common');
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);

  const [dateFormat, setDateFormat] = useState(preferences.dateFormat);
  const [numberFormat, setNumberFormat] = useState(preferences.numberFormat);
  const [timezone, setTimezone] = useState(preferences.timezone);
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(preferences.theme);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(preferences.colorTheme ?? 'default');
  const [defaultCurrency, setDefaultCurrency] = useState(preferences.defaultCurrency);
  const [weekStartsOn, setWeekStartsOn] = useState(preferences.weekStartsOn ?? 1);
  const [showCreatedAt, setShowCreatedAt] = useState(preferences.showCreatedAt ?? false);
  const [showWhatsNew, setShowWhatsNew] = useState(preferences.showWhatsNew ?? true);
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
  const [language, setLanguage] = useState(preferences.language ?? 'en');
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
      // Theme and colour theme are applied and persisted immediately by
      // ThemeSelector / ColorThemeSelector (like language), so they are
      // intentionally omitted from this bulk save.
      const data: UpdatePreferencesData = {
        dateFormat,
        numberFormat,
        timezone,
        defaultCurrency,
        weekStartsOn,
        showCreatedAt,
        showWhatsNew,
        timeFormat,
        preferredExchanges: preferredExchanges.filter(Boolean),
        defaultQuoteProvider,
        recentTransactionsLimit,
      };

      const updated = await userSettingsApi.updatePreferences(data);
      onPreferencesUpdated(updated);
      updatePreferencesStore(updated);
      toast.success(t('toasts.saved'));
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.saveFailed')));
    } finally {
      setIsUpdatingPreferences(false);
    }
  };

  const browserLocale = getEffectiveLocale('browser', language);
  const numberFormatSample = new Intl.NumberFormat(browserLocale).format(1234.56);
  const dateFormatOptions = getDateFormatOptions(tc, browserLocale);

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('heading')}</h2>

      <div className="space-y-4">
        <LanguageSelector value={language} onChange={setLanguage} />

        <ThemeSelector value={theme} onChange={setTheme} />

        <ColorThemeSelector value={colorTheme} onChange={setColorTheme} />

        <Select
          label={t('defaultCurrencyLabel')}
          options={currencyOptions}
          value={defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
        />

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            {t('preferredExchangesLabel')}
          </label>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('preferredExchangesHelp')}
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
                placeholder={t('exchangePriorityPlaceholder', { n: i + 1 })}
                alwaysShowSubtitle
              />
            ))}
          </div>
        </div>

        <div>
          <Select
            label={t('defaultQuoteProviderLabel')}
            options={QUOTE_PROVIDER_OPTIONS}
            value={defaultQuoteProvider}
            onChange={(e) => setDefaultQuoteProvider(e.target.value as 'yahoo' | 'msn')}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('defaultQuoteProviderHelp')}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('msnNoIntradayNote')}
          </p>
          {defaultQuoteProvider === 'msn' && msnReady === false && (
            <p
              role="alert"
              className="text-sm text-red-600 dark:text-red-400 mt-2"
              data-testid="msn-not-configured-error"
            >
              {t('msnNotConfigured')}
            </p>
          )}
        </div>

        <Select
          label={t('dateFormatLabel')}
          options={dateFormatOptions}
          value={dateFormat}
          onChange={(e) => setDateFormat(e.target.value)}
        />

        <Select
          label={t('numberFormatLabel')}
          options={NUMBER_FORMAT_OPTIONS.map((o) => ({
            value: o.value,
            label:
              o.value === 'browser'
                ? t('numberFormatOptions.browser', { sample: numberFormatSample })
                : t(o.labelKey),
          }))}
          value={numberFormat}
          onChange={(e) => setNumberFormat(e.target.value)}
        />

        <Combobox
          label={t('timezoneLabel')}
          options={[{ value: 'browser', label: t('timezoneBrowserOption', { tz: getBrowserTimezone() }) }, ...TIMEZONE_OPTIONS.slice(1)]}
          value={timezone}
          onChange={(value) => setTimezone(value)}
          placeholder={t('timezonePlaceholder')}
        />

        <Select
          label={t('weekStartsOnLabel')}
          options={WEEK_STARTS_ON_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          value={String(weekStartsOn)}
          onChange={(e) => setWeekStartsOn(Number(e.target.value))}
        />

        <div className="flex items-center">
          <label
            htmlFor="showCreatedAt"
            className="flex items-center gap-2 cursor-pointer"
          >
            <ToggleSwitch
              checked={showCreatedAt}
              onChange={setShowCreatedAt}
              label={t('showCreatedAtLabel')}
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {t('showCreatedAtLabel')}
            </span>
          </label>
          <InfoTooltip text={t('showCreatedAtTooltip')} />
        </div>

        {showCreatedAt && (
          <Select
            label={t('timeFormatLabel')}
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
            label={t('recentTransactionsLabel')}
            options={RECENT_TRANSACTIONS_LIMIT_OPTIONS}
            value={String(recentTransactionsLimit)}
            onChange={(e) => setRecentTransactionsLimit(Number(e.target.value))}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('recentTransactionsHelp')}
          </p>
        </div>

        <div
          {...tourAnchor(TOUR_ANCHORS.settingsWhatsNewToggle)}
          className="flex items-center"
        >
          <label
            htmlFor="showWhatsNew"
            className="flex items-center gap-2 cursor-pointer"
          >
            <ToggleSwitch
              checked={showWhatsNew}
              onChange={setShowWhatsNew}
              label={t('showWhatsNewLabel')}
            />
            <span className="text-sm text-gray-900 dark:text-gray-100">
              {t('showWhatsNewLabel')}
            </span>
          </label>
          <InfoTooltip text={t('showWhatsNewTooltip')} />
        </div>
      </div>

      <div className="mt-6 flex justify-end">
        <Button onClick={handleUpdatePreferences} disabled={isUpdatingPreferences}>
          {isUpdatingPreferences ? t('savingButton') : t('saveButton')}
        </Button>
      </div>
    </div>
  );
}
