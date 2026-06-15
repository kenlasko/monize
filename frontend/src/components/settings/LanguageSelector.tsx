'use client';

import { useTransition } from 'react';
import { createTranslator, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Cookies from 'js-cookie';
import toast from 'react-hot-toast';
import { Select } from '@/components/ui/Select';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getErrorMessage } from '@/lib/errors';
import {
  LOCALE_COOKIE,
  SUPPORTED_LOCALES,
  detectBrowserLocale,
  getLocaleLabel,
} from '@/i18n/config';
import { loadNamespaceMessages } from '@/i18n/messages';

/**
 * The confirmation toast must be readable by the user who just switched, so
 * it is rendered in the *target* locale -- the surrounding UI still shows the
 * old language until router.refresh() delivers the new catalogs.
 */
async function savedMessageIn(locale: string, fallback: string): Promise<string> {
  try {
    const settings = await loadNamespaceMessages(locale, 'settings');
    const tNext = createTranslator({
      locale,
      messages: { settings } as Parameters<typeof createTranslator>[0]['messages'],
      namespace: 'settings.language',
    });
    return tNext('saved');
  } catch {
    return fallback;
  }
}

interface LanguageSelectorProps {
  value: string;
  onChange: (language: string) => void;
}

export function LanguageSelector({ value, onChange }: LanguageSelectorProps) {
  const t = useTranslations('settings.language');
  const router = useRouter();
  const [isSaving, startTransition] = useTransition();
  const updatePreferencesStore = usePreferencesStore((state) => state.updatePreferences);

  const browserLocale = detectBrowserLocale();
  const options = [
    {
      value: 'browser',
      label: t('browserOption', { locale: getLocaleLabel(browserLocale) }),
    },
    ...SUPPORTED_LOCALES.map((l) => ({ value: l.code, label: l.label })),
  ];

  const handleChange = (next: string) => {
    onChange(next);
    // 'browser' follows the browser's language: persist the sentinel but drive
    // the active locale (cookie + confirmation toast) with the detected locale.
    const effective = next === 'browser' ? browserLocale : next;
    Cookies.set(LOCALE_COOKIE, effective, { sameSite: 'lax', expires: 365 });

    startTransition(async () => {
      try {
        const updated = await userSettingsApi.updatePreferences({ language: next });
        updatePreferencesStore(updated);
        toast.success(await savedMessageIn(effective, t('saved')));
        router.refresh();
      } catch (error) {
        toast.error(getErrorMessage(error, t('saveFailed')));
      }
    });
  };

  return (
    <div>
      <Select
        label={t('label')}
        options={options}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isSaving}
      />
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('helpText')}</p>
    </div>
  );
}
