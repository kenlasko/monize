import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';

/**
 * Get the effective locale for number formatting.
 * If 'browser' is selected, returns undefined to let Intl use the browser's locale.
 */
function getEffectiveLocale(numberFormat: string): string | undefined {
  if (numberFormat === 'browser') {
    return undefined; // Intl will use browser default
  }
  return numberFormat;
}

/**
 * Hook to format numbers according to user preferences.
 * Returns formatCurrency and formatNumber functions that use the user's preferred number format.
 */
export function useNumberFormat() {
  // Subscribe directly to numberFormat to ensure reactivity when it changes
  const numberFormat = usePreferencesStore((state) => state.preferences?.numberFormat) || 'browser';

  const formatCurrency = useCallback(
    (amount: number, currencyCode: string = 'CAD'): string => {
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    },
    [numberFormat]
  );

  const formatCurrencyCompact = useCallback(
    (amount: number, currencyCode: string = 'CAD'): string => {
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: currencyCode,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount);
    },
    [numberFormat]
  );

  const formatNumber = useCallback(
    (value: number, decimals: number = 2): string => {
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
    },
    [numberFormat]
  );

  const formatPercent = useCallback(
    (value: number, decimals: number = 2): string => {
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value / 100); // Intl.NumberFormat expects decimal (0.5 = 50%)
    },
    [numberFormat]
  );

  return { formatCurrency, formatCurrencyCompact, formatNumber, formatPercent, numberFormat };
}
