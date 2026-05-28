import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { roundToDecimals, adaptiveFractionDigits } from '@/lib/format';

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
    (amount: number, currencyCode?: string, fractionDigits?: number): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      const options: Intl.NumberFormatOptions = {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      };
      if (fractionDigits !== undefined) {
        options.minimumFractionDigits = fractionDigits;
        options.maximumFractionDigits = fractionDigits;
      }
      const formatter = new Intl.NumberFormat(locale, options);
      // Pre-round to the target decimal places to avoid IEEE 754
      // midpoint errors (e.g., 159.735 stored as 159.73499... rounding to
      // 159.73 instead of 159.74).
      const decimals = fractionDigits ?? formatter.resolvedOptions().minimumFractionDigits ?? 2;
      return formatter.format(roundToDecimals(amount, decimals));
    },
    [numberFormat, defaultCurrency]
  );

  /**
   * Currency format that expands precision for tiny values so a sub-penny
   * amount (e.g. a 0.000342 GBP price or daily change) doesn't render as
   * "0.00". Values that already show a figure at the currency's natural
   * precision are formatted identically to formatCurrency.
   */
  const formatCurrencyPrecise = useCallback(
    (amount: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      const baseDigits =
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
        }).resolvedOptions().minimumFractionDigits ?? 2;
      return formatCurrency(amount, currency, adaptiveFractionDigits(amount, baseDigits));
    },
    [numberFormat, defaultCurrency, formatCurrency]
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

  /** Compact currency for chart labels: K with 1dp, M/B/T with 2dp (e.g., "$123.5K", "$1.23M"). */
  const formatCurrencyLabel = useCallback(
    (value: number): string => {
      const locale = getEffectiveLocale(numberFormat);
      const abs = Math.abs(value);
      let divisor: number, suffix: string, decimals: number;
      if (abs >= 1e12) { divisor = 1e12; suffix = 'T'; decimals = 2; }
      else if (abs >= 1e9) { divisor = 1e9; suffix = 'B'; decimals = 2; }
      else if (abs >= 1e6) { divisor = 1e6; suffix = 'M'; decimals = 2; }
      else if (abs >= 1e3) { divisor = 1e3; suffix = 'K'; decimals = 1; }
      else { divisor = 1; suffix = ''; decimals = 0; }

      const scaled = value / divisor;
      const formatted = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: defaultCurrency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(scaled);
      return formatted + suffix;
    },
    [numberFormat, defaultCurrency]
  );

  /** Compact currency for chart flag/callout bubbles: same K/M/B/T notation
   *  as the axis ticks but with exactly 2 decimal places (e.g., "$1.50K",
   *  "$2.34M") so the highlighted high/low values read more precisely than
   *  the surrounding axis labels. */
  const formatCurrencyFlag = useCallback(
    (value: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat);
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    },
    [numberFormat, defaultCurrency]
  );

  return { formatCurrency, formatCurrencyPrecise, formatCurrencyCompact, formatCurrencyAxis, formatCurrencyFlag, formatCurrencyLabel, formatNumber, formatPercent, defaultCurrency, numberFormat };
}
