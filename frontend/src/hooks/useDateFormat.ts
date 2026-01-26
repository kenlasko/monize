import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatDate as formatDateUtil } from '@/lib/utils';

/**
 * Hook to format dates according to user preferences.
 * Returns a formatDate function that uses the user's preferred date format.
 */
export function useDateFormat() {
  // Subscribe directly to dateFormat to ensure reactivity when it changes
  const dateFormat = usePreferencesStore((state) => state.preferences?.dateFormat) || 'browser';

  const formatDate = useCallback(
    (date: Date | string): string => {
      return formatDateUtil(date, dateFormat);
    },
    [dateFormat]
  );

  return { formatDate, dateFormat };
}
