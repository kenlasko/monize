import { useCallback, useSyncExternalStore } from 'react';
import { usePreferencesStore } from '@/store/preferencesStore';
import { roundToDecimals, adaptiveFractionDigits } from '@/lib/format';
import { scaleBytes } from '@/lib/bytes';
import { preferredCurrency } from '@/lib/default-currency';
import { getNumberSeparators } from '@/lib/number-parse';
import {
  currencyDecimalsVersion,
  decimalPlacesForCurrency,
  subscribeCurrencyDecimals,
} from '@/lib/currency-decimals';

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
export function getEffectiveLocale(
  numberFormat: string,
  language: string | undefined,
): string | undefined {
  if (numberFormat !== 'browser') return numberFormat;
  return language && language !== 'xx' && language !== 'browser'
    ? language
    : undefined;
}

/**
 * Decimal places a share quantity is displayed at. Deliberately not money's
 * four and not `formatQuantity`'s four either: fractional-share brokers and
 * crypto-style units leave residual positions several orders below a cent, and
 * a holdings column that rounds them away reads as flat zero. Mirrors the
 * precision of the pure `formatShareQuantity` helper in `@/lib/format`.
 */
export const SHARE_QUANTITY_MAX_FRACTION_DIGITS = 8;

/**
 * The formatters a pure (non-React) helper needs to render a figure in the
 * reader's number locale.
 *
 * A module that is not a component cannot call `useNumberFormat()`, and the two
 * things it would otherwise reach for are both wrong: `toFixed` is a `.` in
 * every locale, and `toLocaleString()` follows the *browser*, which is exactly
 * what an explicit `numberFormat` preference exists to override. So the calling
 * component passes these down. Structurally satisfied by the hook's own return
 * value, so a caller can hand over what it already destructured.
 */
export interface NumberFormatters {
  formatCurrency: (value: number, currencyCode?: string) => string;
  formatNumber: (value: number, decimals?: number) => string;
  formatPercent: (value: number, decimals?: number) => string;
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

/**
 * Cache of "can `Intl` build a formatter for this tag", so the probe runs once
 * per distinct preference value rather than once per figure.
 */
const localeUsable = new Map<string, boolean>();

/**
 * The locale itself, or `undefined` (the browser default) when `Intl` cannot use
 * it.
 *
 * `Intl.NumberFormat` throws `RangeError` on a structurally invalid tag, and
 * `en_US` -- the underscore form half the world writes -- is one. Nothing
 * validates `numberFormat` on the way in, and this call sits inside render, so
 * one such stored value took the whole screen down rather than one figure.
 * Falling back to the browser is the honest answer here: the preference is
 * unreadable, and the browser is what an absent preference already means.
 * (The server's counterpart lands on `DEFAULT_LOCALE` instead, because it has no
 * browser to fall back to.)
 */
function usableLocale(locale: string | undefined): string | undefined {
  if (locale === undefined) return undefined;
  const cached = localeUsable.get(locale);
  if (cached !== undefined) return cached ? locale : undefined;
  let usable = true;
  try {
    new Intl.NumberFormat(locale);
  } catch {
    usable = false;
  }
  localeUsable.set(locale, usable);
  return usable ? locale : undefined;
}

function getNumberFormat(
  rawLocale: string | undefined,
  options: Intl.NumberFormatOptions,
): Intl.NumberFormat {
  const locale = usableLocale(rawLocale);
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
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((state) => state.preferences?.defaultCurrency),
  );
  const language = usePreferencesStore((state) => state.preferences?.language);

  // The user's effective number locale and its separators, so number INPUT
  // fields can parse and format in the same convention numbers are displayed
  // in (a Polish user types and pastes "1200,99", not "1200.99").
  const numberLocale = getEffectiveLocale(numberFormat, language);
  const numberSeparators = getNumberSeparators(numberLocale);

  // The currency decimals registry (`lib/currency-decimals.ts`) fills after the
  // first render; subscribing gives the formatters below a new identity when it
  // does, so a figure drawn before the list arrived is redrawn at its places.
  const currencyDecimals = useSyncExternalStore(
    subscribeCurrencyDecimals,
    currencyDecimalsVersion,
    currencyDecimalsVersion,
  );

  const formatCurrency = useCallback(
    (amount: number, currencyCode?: string, fractionDigits?: number): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      const options: Intl.NumberFormatOptions = {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
      };
      // An explicit count wins; then a non-ISO code's own row; then Intl.
      const digits = fractionDigits ?? decimalPlacesForCurrency(currency);
      if (digits !== undefined) {
        options.minimumFractionDigits = digits;
        options.maximumFractionDigits = digits;
      }
      const formatter = getNumberFormat(locale, options);
      // Pre-round to the target decimal places to avoid IEEE 754
      // midpoint errors (e.g., 159.735 stored as 159.73499... rounding to
      // 159.73 instead of 159.74).
      const decimals = digits ?? formatter.resolvedOptions().minimumFractionDigits ?? 2;
      return formatter.format(roundToDecimals(amount, decimals));
    },
    // `currencyDecimals` is read through `decimalPlacesForCurrency`; it is a
    // dependency so the callback changes identity when the registry does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [numberFormat, defaultCurrency, language, currencyDecimals]
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
        decimalPlacesForCurrency(currency) ??
        getNumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
        }).resolvedOptions().minimumFractionDigits ??
        2;
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

  /**
   * As much of a money figure as a narrow cell can hold: compact notation, and
   * no fraction digits at all below the first thousand.
   *
   * A calendar day on a phone is a column about fifty pixels wide, and a
   * balance rendered in full simply does not fit in one -- a figure that
   * overflows or wraps mid-number is not a figure a reader can use.
   * `formatCurrencyAxis` is the same compact notation for a chart tick, but it
   * keeps one fraction digit at every size, which reads as a broken cent on a
   * three-figure balance ("$344.3"). This is the figure for a cell: "$344",
   * "$13.3K", "$1.2M".
   */
  const formatCurrencyTight = useCallback(
    (amount: number, currencyCode?: string): string => {
      const currency = currencyCode || defaultCurrency;
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'currency',
        currency,
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: Math.abs(amount) < 1000 ? 0 : 1,
      }).format(amount);
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

  /**
   * A file size, in the reader's locale.
   *
   * `Intl`'s `style: 'unit'` localizes the abbreviation as well as the number,
   * so a French reader gets `1,4 ko` and a Russian one `1,4 кБ` without this
   * repo translating unit names into twenty-two catalogs. The scaling is
   * `scaleBytes`; this is only the rendering.
   */
  const formatBytes = useCallback(
    (bytes: number): string => {
      const { value, unit, decimals } = scaleBytes(bytes);
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'unit',
        unit,
        unitDisplay: 'short',
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
   * Locale-aware percentage that keeps the precision the value already carries:
   * 0 to `maxDecimals` fraction digits, trailing zeros trimmed. The sibling of
   * `formatQuantity` and `formatPrice`, for percentages.
   *
   * `formatPercent` takes a decimal count and is right where the surface has
   * decided one (a table column that must line up). This one is for the far
   * commoner `{value}%` shape, where the value arrives already rounded -- the
   * server rounds `percentUsed` to 2dp, so the same expression renders "80%",
   * "80.5%" and "80.55%" -- and pinning a count would either add zeros the
   * reader has not seen before or silently drop a digit. Migrating those to a
   * fixed `formatPercent` would have changed the figure, which is the one thing
   * a localization fix must not do.
   *
   * Four decimals because an interest rate is quoted to at most three or four;
   * a value carrying more than that is a rounding defect upstream, and it is
   * better to show it trimmed than to let the cap decide the design.
   */
  const formatPercentTrimmed = useCallback(
    (value: number, maxDecimals: number = 4): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        style: 'percent',
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals,
      }).format(value / 100); // Intl takes a fraction; call sites hold percent units
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

  /**
   * Locale-aware share quantity at full precision: up to 8 decimal places with
   * trailing zeros trimmed (minimumFractionDigits 0). The locale-aware sibling
   * of `formatShareQuantity` in `@/lib/format` -- and the one React must use,
   * because that pure helper renders through `toFixed`, which is `.` in every
   * locale.
   *
   * Eight, not `formatQuantity`'s four: a residual position of 0.0003 shares is
   * exactly the thing this column exists to make visible, and rounding it to
   * four (let alone two) is how an errant share count hides. Nullish and NaN
   * render "0" rather than an empty cell or "NaN", and a tiny negative residue
   * that rounds to zero (e.g. -4e-15) renders "0" rather than the "-0" Intl
   * produces for a negative zero.
   */
  const formatShareQuantity = useCallback(
    (value: number | undefined | null): string => {
      if (value === undefined || value === null || isNaN(value)) return '0';
      const locale = getEffectiveLocale(numberFormat, language);
      // roundToDecimals normalizes -0 to 0, so the sign never survives a
      // residue that rounds away.
      return getNumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: SHARE_QUANTITY_MAX_FRACTION_DIGITS,
      }).format(roundToDecimals(value, SHARE_QUANTITY_MAX_FRACTION_DIGITS));
    },
    [numberFormat, language]
  );

  /**
   * Locale-aware share/unit price: up to 6 decimal places with trailing zeros
   * trimmed (minimumFractionDigits 0), via Intl rather than a hand-rolled
   * trailing-zero regex. A price is not money -- it carries up to six decimals,
   * and a whole-cent price should read "123" not "123.000000". Sibling of
   * `formatQuantity`; use it for the "latest close" copy in the schedule
   * post/override dialogs so a comma-decimal locale never leaves a dangling
   * separator (`123,`).
   */
  const formatPrice = useCallback(
    (value: number): string => {
      const locale = getEffectiveLocale(numberFormat, language);
      return getNumberFormat(locale, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 6,
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

  return { formatCurrency, formatCurrencyPrecise, formatCurrencyCompact, formatCurrencyAxis, formatCurrencyTight, formatCurrencyFlag, formatCurrencyLabel, formatNumber, formatBytes, formatPercent, formatPercentTrimmed, formatSignedPercent, formatQuantity, formatShareQuantity, formatPrice, defaultCurrency, numberFormat, numberLocale, numberSeparators };
}
