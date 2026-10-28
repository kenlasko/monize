'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { useSavedPreference } from '@/hooks/useSavedPreference';
import { userSettingsApi } from '@/lib/user-settings';
import type { MapProvider } from '@/lib/contact-links';
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
import { DefaultViewsGroup } from '@/components/settings/DefaultViewsGroup';
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
    {
      value: 'browser',
      label: `Use browser timezone (auto-detected as ${browserTz})`,
    },
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

const TIME_FORMAT_OPTIONS = [
  { value: '24h', labelKey: 'timeFormatOptions.h24' },
  { value: '12h', labelKey: 'timeFormatOptions.h12' },
];

const QUOTE_PROVIDER_OPTIONS = [
  { value: 'yahoo', label: 'Yahoo Finance' },
  { value: 'msn', label: 'MSN Money' },
  { value: 'lse', label: 'LSE' },
  { value: 'deutsche_boerse', label: 'Deutsche Börse' },
];

/**
 * Map services an address link can open, in the order the dropdown shows them:
 * the platform hand-off first, since it is the default, then the services
 * alphabetically. The values mirror MAP_PROVIDERS in `@/lib/contact-links`,
 * which is what builds the URL.
 */
const MAP_PROVIDER_OPTIONS: { value: MapProvider; labelKey: string }[] = [
  { value: 'device', labelKey: 'mapProviderOptions.device' },
  { value: 'apple', labelKey: 'mapProviderOptions.apple' },
  { value: 'bing', labelKey: 'mapProviderOptions.bing' },
  { value: 'google', labelKey: 'mapProviderOptions.google' },
  { value: 'openstreetmap', labelKey: 'mapProviderOptions.openstreetmap' },
  { value: 'waze', labelKey: 'mapProviderOptions.waze' },
];

const RECENT_TRANSACTIONS_LIMIT_OPTIONS = [
  { value: '3', label: '3' },
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '15', label: '15' },
  { value: '20', label: '20' },
];

/**
 * The card's sixteen controls are split into groups, and the divider is what
 * makes the split visible: `space-y-6` alone separates a group from its own
 * rows by too little to read as a boundary. Matches the sub-section rule the
 * other settings cards draw (NotificationsSection, SecuritySection).
 */
const GROUP_HEADING_CLASS = 'text-base font-semibold text-gray-900 dark:text-gray-100 mb-3';
const GROUP_DIVIDER_CLASS = 'border-t border-gray-200 dark:border-gray-700 pt-6';

interface PreferencesSectionProps {
  preferences: UserPreferences;
  onPreferencesUpdated: (prefs: UserPreferences) => void;
}

export function PreferencesSection({ preferences, onPreferencesUpdated }: PreferencesSectionProps) {
  const t = useTranslations('settings.preferences');
  const tc = useTranslations('common');
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);

  /**
   * Persist one preference the moment it changes, optimistically.
   *
   * Every control on this screen used to save through one "Save Preferences"
   * button EXCEPT language, theme and colour theme, which persisted on change
   * -- so the same screen had two contracts and no way to tell which a given
   * control followed. This is the one they all follow now.
   *
   * The revert is the caller's own setter closed over the value the field held
   * before the change: an optimistic update that fails has to put back what was
   * there, and only the caller knows what that was.
   */
  const commitPreference = useCallback(
    (patch: UpdatePreferencesData, revert: () => void) => {
      void (async () => {
        try {
          const updated = await userSettingsApi.updatePreferences(patch);
          onPreferencesUpdated(updated);
          updatePreferencesStore(updated);
          toast.success(t('toasts.saved'));
        } catch (error) {
          revert();
          toast.error(getErrorMessage(error, t('toasts.saveFailed')));
        }
      })();
    },
    [onPreferencesUpdated, updatePreferencesStore, t],
  );

  const reportingBasis = useSavedPreference(
    'reportingBasis',
    preferences.reportingBasis ?? 'cash',
    commitPreference,
  );
  const accrualEnabled = useSavedPreference(
    'accrualEnabled',
    preferences.accrualEnabled ?? false,
    commitPreference,
  );
  const dateFormat = useSavedPreference('dateFormat', preferences.dateFormat, commitPreference);
  const numberFormat = useSavedPreference(
    'numberFormat',
    preferences.numberFormat,
    commitPreference,
  );
  const timezone = useSavedPreference('timezone', preferences.timezone, commitPreference);
  const defaultCurrency = useSavedPreference(
    'defaultCurrency',
    preferences.defaultCurrency,
    commitPreference,
  );
  const weekStartsOn = useSavedPreference(
    'weekStartsOn',
    preferences.weekStartsOn ?? 1,
    commitPreference,
  );
  const showCreatedAt = useSavedPreference(
    'showCreatedAt',
    preferences.showCreatedAt ?? false,
    commitPreference,
  );
  const showWhatsNew = useSavedPreference(
    'showWhatsNew',
    preferences.showWhatsNew ?? true,
    commitPreference,
  );
  const lockReconciledTransactions = useSavedPreference(
    'lockReconciledTransactions',
    preferences.lockReconciledTransactions ?? false,
    commitPreference,
  );
  const timeFormat = useSavedPreference<'timeFormat', '24h' | '12h'>(
    'timeFormat',
    preferences.timeFormat ?? '24h',
    commitPreference,
  );
  const preferredExchanges = useSavedPreference<'preferredExchanges', string[]>(
    'preferredExchanges',
    preferences.preferredExchanges ?? [],
    commitPreference,
  );
  const defaultQuoteProvider = useSavedPreference<
    'defaultQuoteProvider',
    'yahoo' | 'msn' | 'lse' | 'deutsche_boerse'
  >('defaultQuoteProvider', preferences.defaultQuoteProvider ?? 'yahoo', commitPreference);
  const recentTransactionsLimit = useSavedPreference(
    'recentTransactionsLimit',
    preferences.recentTransactionsLimit ?? 5,
    commitPreference,
  );
  const defaultMapProvider = useSavedPreference<'defaultMapProvider', MapProvider>(
    'defaultMapProvider',
    preferences.defaultMapProvider ?? 'device',
    commitPreference,
  );

  // Theme, colour theme and language persist themselves inside their own
  // selectors (each has work to do beyond the write -- applying the palette,
  // switching the active locale), so these three hold display state only.
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>(preferences.theme);
  const [colorTheme, setColorTheme] = useState<ColorTheme>(preferences.colorTheme ?? 'default');
  const [language, setLanguage] = useState(preferences.language ?? 'en');

  const [availableCurrencies, setAvailableCurrencies] = useState<CurrencyInfo[]>([]);
  const [msnReady, setMsnReady] = useState<boolean | null>(null);

  useEffect(() => {
    exchangeRatesApi
      .getCurrencies()
      .then(setAvailableCurrencies)
      .catch(() => {});
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

  const browserLocale = getEffectiveLocale('browser', language);
  const numberFormatSample = new Intl.NumberFormat(browserLocale).format(1234.56);
  const dateFormatOptions = getDateFormatOptions(tc, browserLocale);

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg p-6 mb-6">
      <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        {t('heading')}
      </h2>

      <div className="space-y-6">
        <div>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.languageRegion')}</h3>
          <div className="space-y-4">
            <LanguageSelector value={language} onChange={setLanguage} />

            <Select
              label={t('defaultCurrencyLabel')}
              options={currencyOptions}
              value={defaultCurrency.value}
              onChange={(e) => defaultCurrency.set(e.target.value)}
            />
          </div>
        </div>

        <div className={GROUP_DIVIDER_CLASS}>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.appearance')}</h3>
          <div className="space-y-4">
            <ThemeSelector value={theme} onChange={setTheme} />

            <ColorThemeSelector value={colorTheme} onChange={setColorTheme} />
          </div>
        </div>

        <div className={GROUP_DIVIDER_CLASS}>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.datesNumbers')}</h3>
          <div className="space-y-4">
            <Select
              label={t('dateFormatLabel')}
              options={dateFormatOptions}
              value={dateFormat.value}
              onChange={(e) => dateFormat.set(e.target.value)}
            />

            <Select
              label={t('numberFormatLabel')}
              options={NUMBER_FORMAT_OPTIONS.map((o) => ({
                value: o.value,
                label:
                  o.value === 'browser'
                    ? t('numberFormatOptions.browser', {
                        sample: numberFormatSample,
                      })
                    : t(o.labelKey),
              }))}
              value={numberFormat.value}
              onChange={(e) => numberFormat.set(e.target.value)}
            />

            <Combobox
              label={t('timezoneLabel')}
              options={[
                {
                  value: 'browser',
                  label: t('timezoneBrowserOption', {
                    tz: getBrowserTimezone(),
                  }),
                },
                ...TIMEZONE_OPTIONS.slice(1),
              ]}
              value={timezone.value}
              onChange={(value) => timezone.set(value)}
              placeholder={t('timezonePlaceholder')}
            />

            <Select
              label={t('weekStartsOnLabel')}
              options={WEEK_STARTS_ON_OPTIONS.map((o) => ({
                value: o.value,
                label: t(o.labelKey),
              }))}
              value={String(weekStartsOn.value)}
              onChange={(e) => weekStartsOn.set(Number(e.target.value))}
            />

            <div className="flex items-center">
              <label htmlFor="showCreatedAt" className="flex items-center gap-2 cursor-pointer">
                <ToggleSwitch
                  checked={showCreatedAt.value}
                  onChange={showCreatedAt.set}
                  label={t('showCreatedAtLabel')}
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">
                  {t('showCreatedAtLabel')}
                </span>
              </label>
              <InfoTooltip text={t('showCreatedAtTooltip')} />
            </div>

            {showCreatedAt.value && (
              <Select
                label={t('timeFormatLabel')}
                options={TIME_FORMAT_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.labelKey),
                }))}
                value={timeFormat.value}
                onChange={(e) => timeFormat.set(e.target.value as '24h' | '12h')}
              />
            )}
          </div>
        </div>

        <div className={GROUP_DIVIDER_CLASS}>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.investments')}</h3>
          <div className="space-y-4">
            <div>
              <Select
                label={t('defaultQuoteProviderLabel')}
                options={QUOTE_PROVIDER_OPTIONS}
                value={defaultQuoteProvider.value}
                onChange={(e) =>
                  defaultQuoteProvider.set(
                    e.target.value as 'yahoo' | 'msn' | 'lse' | 'deutsche_boerse',
                  )
                }
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('defaultQuoteProviderHelp')}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('msnNoIntradayNote')}
              </p>
              {defaultQuoteProvider.value === 'msn' && msnReady === false && (
                <p
                  role="alert"
                  className="text-sm text-red-600 dark:text-red-400 mt-2"
                  data-testid="msn-not-configured-error"
                >
                  {t('msnNotConfigured')}
                </p>
              )}
            </div>

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
                    options={EXCHANGE_OPTIONS.filter(
                      (opt) =>
                        !preferredExchanges.value.includes(opt.value) ||
                        preferredExchanges.value[i] === opt.value,
                    ).sort((a, b) => a.label.localeCompare(b.label))}
                    value={preferredExchanges.value[i] || ''}
                    onChange={(value) => {
                      const updated = [...preferredExchanges.value];
                      if (value) {
                        updated[i] = value;
                      } else {
                        updated.splice(i, 1);
                      }
                      preferredExchanges.set(updated.filter(Boolean));
                    }}
                    placeholder={t('exchangePriorityPlaceholder', { n: i + 1 })}
                    alwaysShowSubtitle
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={GROUP_DIVIDER_CLASS}>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.transactions')}</h3>
          <div className="space-y-4">
            <div className="flex items-center">
              <label htmlFor="accrualEnabled" className="flex items-center gap-2 cursor-pointer">
                <ToggleSwitch
                  checked={accrualEnabled.value}
                  onChange={accrualEnabled.set}
                  label={t('accrualEnabledLabel')}
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">
                  {t('accrualEnabledLabel')}
                </span>
              </label>
              <InfoTooltip text={t('accrualEnabledTooltip')} />
            </div>

            {accrualEnabled.value && (
              <>
                <Select
                  label={t('reportingBasisLabel')}
                  value={reportingBasis.value}
                  options={[
                    { value: 'accrual', label: t('reportingAccrual') },
                    { value: 'cash', label: t('reportingCash') },
                  ]}
                  onChange={(event) => reportingBasis.set(event.target.value as 'cash' | 'accrual')}
                />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('reportingBasisHelp')}
                </p>
              </>
            )}
            <div>
              <Select
                label={t('recentTransactionsLabel')}
                options={RECENT_TRANSACTIONS_LIMIT_OPTIONS}
                value={String(recentTransactionsLimit.value)}
                onChange={(e) => recentTransactionsLimit.set(Number(e.target.value))}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('recentTransactionsHelp')}
              </p>
            </div>

            <div className="flex items-center">
              <label
                htmlFor="lockReconciledTransactions"
                className="flex items-center gap-2 cursor-pointer"
              >
                <ToggleSwitch
                  checked={lockReconciledTransactions.value}
                  onChange={lockReconciledTransactions.set}
                  label={t('lockReconciledLabel')}
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">
                  {t('lockReconciledLabel')}
                </span>
              </label>
              <InfoTooltip text={t('lockReconciledTooltip')} />
            </div>
          </div>
        </div>

        <DefaultViewsGroup
          className={GROUP_DIVIDER_CLASS}
          initial={preferences.viewDefaults}
          initialHiddenColumns={preferences.hiddenTableColumns}
          commit={commitPreference}
        />

        <div className={GROUP_DIVIDER_CLASS}>
          <h3 className={GROUP_HEADING_CLASS}>{t('groups.application')}</h3>
          <div className="space-y-4">
            <div>
              <Select
                label={t('mapProviderLabel')}
                options={MAP_PROVIDER_OPTIONS.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={defaultMapProvider.value}
                onChange={(e) => defaultMapProvider.set(e.target.value as MapProvider)}
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t('mapProviderHelp')}
              </p>
            </div>

            <div {...tourAnchor(TOUR_ANCHORS.settingsWhatsNewToggle)} className="flex items-center">
              <label htmlFor="showWhatsNew" className="flex items-center gap-2 cursor-pointer">
                <ToggleSwitch
                  checked={showWhatsNew.value}
                  onChange={showWhatsNew.set}
                  label={t('showWhatsNewLabel')}
                />
                <span className="text-sm text-gray-900 dark:text-gray-100">
                  {t('showWhatsNewLabel')}
                </span>
              </label>
              <InfoTooltip text={t('showWhatsNewTooltip')} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
