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
 * All currency functions default to the user's configured defaultCurrency preference.
 */
export function useNumberFormat() {
  // Subscribe directly to numberFormat and defaultCurrency to ensure reactivity when they change
  const numberFormat = usePreferencesStore((state) => state.preferences?.numberFormat) || 'browser';
  const defaultCurrency = usePreferencesStore((state) => state.preferences?.defaultCurrency) || 'CAD';

  const formatCurrency = useCallback(
    (amount: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(amount);
    },
    [numberFormat, defaultCurrency]
  );

  const formatCurrencyCompact = useCallback(
    (amount: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount);
    },
    [numberFormat, defaultCurrency]
  );

  /** Compact currency format for chart axis labels (e.g., "$5K", "€1.5M").
   *  Compatible with Recharts tickFormatter which passes (value, index). */
  const formatCurrencyAxis = useCallback(
    (value: number, currencyCodeOrIndex?: string | number): string => {
      const currency = typeof currencyCodeOrIndex === 'string' ? currencyCodeOrIndex : defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
      }).format(value);
    },
    [numberFormat, defaultCurrency]
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

  return { formatCurrency, formatCurrencyCompact, formatCurrencyAxis, formatNumber, formatPercent, defaultCurrency, numberFormat };
}
