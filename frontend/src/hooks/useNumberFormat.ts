import { useCallback } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { roundToDecimals, adaptiveFractionDigits } from '@/lib/format';

/**
 * Get the effective locale for number formatting.
 *
 * - An explicit `numberFormat` (e.g. 'en-GB', 'de-DE') always wins so a user
 *   can pick German number grouping with an English UI.
 * - When `numberFormat === 'browser'`, fall back to the user's UI `language`
 *   so freshly defaulted users see numbers in the same locale as their UI.
 * - A `language` of 'browser' (follow the browser) or 'xx' (pseudo-locale) is
 *   not a real Intl locale, so we hand off to the browser default instead.
 * - Returning undefined hands off to the browser default.
 */
function getEffectiveLocale(
  numberFormat: string,
  language: string | undefined,
): string | undefined {
  if (numberFormat !== 'browser') return numberFormat;
  return language && language !== 'xx' && language !== 'browser'
    ? language
    : undefined;
}

/**
 * Module-level cache for Intl.NumberFormat instances. These objects are
 * relatively expensive to construct (each one builds a locale-specific
 * formatter), and the hook callbacks below are invoked once per cell per
 * row per render in tables -- creating a fresh instance every time was
 * showing up in profiler traces. Cache keys are (locale + JSON(options))
 * so distinct currencies and option sets don't collide. The cache is
 * unbounded; in practice the keyspace stays small (a handful of
 * locale/currency/option combinations per user session).
 */
const formatterCache = new Map<string, Intl.NumberFormat>();

function getNumberFormat(
  locale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    formatterCache.set(key, formatter);
  }
  return formatter;
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
  const language = usePreferencesStore((state) => state.preferences?.language);

  const formatCurrency = useCallback(
    (amount: number, currencyCode?: string, fractionDigits?: number): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      const options: Intl.NumberFormatOptions = {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      };
      if (fractionDigits !== undefined) {
        options.minimumFractionDigits = fractionDigits;
        options.maximumFractionDigits = fractionDigits;
      }
      const formatter = getNumberFormat(locale, options);
      // Pre-round to the target decimal places to avoid IEEE 754
      // midpoint errors (e.g., 159.735 stored as 159.73499... rounding to
      // 159.73 instead of 159.74).
      const decimals = fractionDigits ?? formatter.resolvedOptions().minimumFractionDigits ?? 2;
      return formatter.format(roundToDecimals(amount, decimals));
    },
    [numberFormat, defaultCurrency, language]
  );

  /**
   * Currency format that expands precision for tiny values so a sub-penny
   * amount (e.g. a 0.000342 GBP price or daily change) doesn't render as
   * "0.00". Values that already show a figure at the base precision are
   * formatted identically to formatCurrency.
   *
   * `minFractionDigits` raises the base precision for columns that already
   * display more than the currency's natural decimals (e.g. per-share price
   * columns shown at 4dp); expansion then only kicks in when even that would
   * round to zero.
   */
  const formatCurrencyPrecise = useCallback(
    (amount: number, currencyCode?: string, minFractionDigits?: number): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      const currencyDigits =
        getNumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
        }).resolvedOptions().minimumFractionDigits ?? 2;
      const baseDigits = Math.max(currencyDigits, minFractionDigits ?? 0);
      return formatCurrency(amount, currency, adaptiveFractionDigits(amount, baseDigits));
    },
    [numberFormat, defaultCurrency, language, formatCurrency]
  );

  const formatCurrencyCompact = useCallback(
    (amount: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      }).format(amount);
    },
    [numberFormat, defaultCurrency, language]
  );

  /** Compact currency format for chart axis labels (e.g., "$5K", "€1.5M").
   *  Compatible with Recharts tickFormatter which passes (value, index). */
  const formatCurrencyAxis = useCallback(
    (value: number, currencyCodeOrIndex?: string | number): string => {
      const currency = typeof currencyCodeOrIndex === 'string' ? currencyCodeOrIndex : defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 1,
      }).format(value);
    },
    [numberFormat, defaultCurrency, language]
  );

  const formatNumber = useCallback(
    (value: number, decimals: number = 2): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value);
    },
    [numberFormat, language]
  );

  const formatPercent = useCallback(
    (value: number, decimals: number = 2): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(value / 100); // Intl.NumberFormat expects decimal (0.5 = 50%)
    },
    [numberFormat, language]
  );

  /**
   * Locale-aware signed percentage with an explicit leading sign
   * (e.g. "+12.50%", "-3.40%"). Honours the user's number-format locale for
   * grouping/decimal separators. Replaces the inline
   * `${v >= 0 ? '+' : ''}${v.toFixed(n)}%` idiom in the report/holdings views.
   * Non-finite input renders a sign-less zero so a broken datum never shows
   * "NaN%".
   */
  const formatSignedPercent = useCallback(
    (value: number, decimals: number = 2): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      const magnitudeFormat = getNumberFormat(locale, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      if (!isFinite(value)) {
        return `${magnitudeFormat.format(0)}%`;
      }
      const rounded = roundToDecimals(value, decimals);
      // Normalize -0 so a tiny negative that rounds to zero renders "+0.00%"
      // rather than "+-0.00%" (Intl formats -0 with a leading minus).
      const normalized = Object.is(rounded, -0) ? 0 : rounded;
      const sign = normalized >= 0 ? '+' : '';
      return `${sign}${magnitudeFormat.format(normalized)}%`;
    },
    [numberFormat, language]
  );

  /**
   * Locale-aware share/quantity formatter: up to 4 decimal places with
   * trailing zeros trimmed (minimumFractionDigits 0). Replaces the inline
   * `new Intl.NumberFormat(locale, { ..., maximumFractionDigits: 4 })` copies
   * in the holdings/transaction lists.
   */
  const formatQuantity = useCallback(
    (value: number): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 4,
      }).format(value);
    },
    [numberFormat, language]
  );

  /** Compact currency for chart labels: K with 1dp, M/B/T with 2dp (e.g., "$123.5K", "$1.23M"). */
  const formatCurrencyLabel = useCallback(
    (value: number): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      const abs = Math.abs(value);
      let divisor: number, suffix: string, decimals: number;
      if (abs >= 1e12) { divisor = 1e12; suffix = 'T'; decimals = 2; }
      else if (abs >= 1e9) { divisor = 1e9; suffix = 'B'; decimals = 2; }
      else if (abs >= 1e6) { divisor = 1e6; suffix = 'M'; decimals = 2; }
      else if (abs >= 1e3) { divisor = 1e3; suffix = 'K'; decimals = 1; }
      else { divisor = 1; suffix = ''; decimals = 0; }

      const scaled = value / divisor;
      const formatted = getNumberFormat(locale, {
        style: 'currency',
        currency: defaultCurrency,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(scaled);
      return formatted + suffix;
    },
    [numberFormat, defaultCurrency, language]
  );

  /** Compact currency for chart flag/callout bubbles: same K/M/B/T notation
   *  as the axis ticks but with exactly 2 decimal places (e.g., "$1.50K",
   *  "$2.34M") so the highlighted high/low values read more precisely than
   *  the surrounding axis labels. */
  const formatCurrencyFlag = useCallback(
    (value: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value);
    },
    [numberFormat, defaultCurrency, language]
  );

  return { formatCurrency, formatCurrencyPrecise, formatCurrencyCompact, formatCurrencyAxis, formatCurrencyFlag, formatCurrencyLabel, formatNumber, formatPercent, formatSignedPercent, formatQuantity, defaultCurrency, numberFormat };
}
