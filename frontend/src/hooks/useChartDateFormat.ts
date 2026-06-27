import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { formatChartDate, type ChartDatePattern } from '@/lib/utils';

/**
 * Hook returning a locale-aware date formatter for chart axes, tooltips, and
 * series labels. Month markers are rendered in the user's UI language rather
 * than always in English. The pseudo-locale ('xx') and unset/'browser'
 * language fall back to the runtime default, mirroring `useDateFormat`.
 */
export function useChartDateFormat() {
  const language = usePreferencesStore((state) => state.preferences?.language);
  const locale =
    language && language !== 'xx' && language !== 'browser' ? language : undefined;

  return useCallback(
    (date: Date | string, pattern: ChartDatePattern) =>
      formatChartDate(date, pattern, locale),
    [locale],
  );
}
