import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatDate as formatDateUtil, formatMonth as formatMonthUtil } from '@/lib/utils';

/**
 * Hook to format dates according to user preferences.
 * Returns a formatDate function that uses the user's preferred date format,
 * plus a formatMonth function for year-month (YYYY-MM) values.
 * When dateFormat is 'browser', the user's UI language is used as the locale
 * (so freshly defaulted users see dates in the same locale as their UI).
 */
export function useDateFormat() {
  // Subscribe directly to dateFormat to ensure reactivity when it changes
  const dateFormat = usePreferencesStore((state) => state.preferences?.dateFormat) || 'browser';
  const language = usePreferencesStore((state) => state.preferences?.language);

  const formatDate = useCallback(
    (date: Date | string): string => {
      const locale =
        language && language !== 'xx' && language !== 'browser' ? language : undefined;
      return formatDateUtil(date, dateFormat, locale);
    },
    [dateFormat, language]
  );

  const formatMonth = useCallback(
    (month: string): string => {
      const locale =
        language && language !== 'xx' && language !== 'browser' ? language : undefined;
      return formatMonthUtil(month, dateFormat, locale);
    },
    [dateFormat, language]
  );

  return { formatDate, formatMonth, dateFormat };
}
