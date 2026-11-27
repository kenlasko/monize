import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNumberFormat, getEffectiveLocale } from './useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } })
  ),
}));

describe('getEffectiveLocale', () => {
  it('returns an explicit number format verbatim', () => {
    expect(getEffectiveLocale('en-GB', 'fr')).toBe('en-GB');
    expect(getEffectiveLocale('de-DE', undefined)).toBe('de-DE');
  });

  it('falls back to the UI language when set to "browser"', () => {
    expect(getEffectiveLocale('browser', 'fr')).toBe('fr');
    expect(getEffectiveLocale('browser', 'en-GB')).toBe('en-GB');
  });

  it('returns undefined (browser default) for a browser/xx/unset language', () => {
    expect(getEffectiveLocale('browser', 'browser')).toBeUndefined();
    expect(getEffectiveLocale('browser', 'xx')).toBeUndefined();
    expect(getEffectiveLocale('browser', undefined)).toBeUndefined();
  });
});

describe('useNumberFormat with a "browser" UI language', () => {
  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  it('does not pass the "browser" sentinel to Intl', () => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({
        preferences: {
          numberFormat: 'browser',
          defaultCurrency: 'USD',
          language: 'browser',
        },
      }),
    );
    const { result } = renderHook(() => useNumberFormat());
    expect(() => result.current.formatCurrency(1234.56)).not.toThrow();
    expect(result.current.formatCurrency(1234.56)).toMatch(/1.?234/);
  });
});

describe('useNumberFormat', () => {
  it('returns formatting functions', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(typeof result.current.formatCurrency).toBe('function');
    expect(typeof result.current.formatNumber).toBe('function');
    expect(typeof result.current.formatPercent).toBe('function');
    expect(typeof result.current.formatCurrencyCompact).toBe('function');
    expect(typeof result.current.formatCurrencyAxis).toBe('function');
    expect(typeof result.current.formatCurrencyLabel).toBe('function');
  });

  it('formatCurrency formats with default currency', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(1234.56);
    expect(formatted).toContain('1,234.56');
  });

  it('formatCurrency uses custom currency', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(1000, 'EUR');
    expect(formatted).toContain('1,000.00');
  });

  it('formatCurrencyPrecise matches formatCurrency for normal values', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyPrecise(1234.56)).toBe(
      result.current.formatCurrency(1234.56),
    );
  });

  it('formatCurrencyPrecise expands precision for sub-penny values', () => {
    const { result } = renderHook(() => useNumberFormat());
    // Would render as $0.00 with the default 2dp formatter.
    expect(result.current.formatCurrency(0.000318)).toContain('0.00');
    const precise = result.current.formatCurrencyPrecise(0.000318);
    expect(precise).toContain('0.000318');
    expect(precise).not.toMatch(/0\.00($|[^0])/);
  });

  it('formatCurrencyPrecise honours a higher base precision via minFractionDigits', () => {
    const { result } = renderHook(() => useNumberFormat());
    // A 4dp price column keeps 4 decimals for a normal value...
    expect(result.current.formatCurrencyPrecise(12.3456, 'USD', 4)).toContain('12.3456');
    // ...and only expands when even 4dp would read as zero.
    const tiny = result.current.formatCurrencyPrecise(0.00001, 'USD', 4);
    expect(tiny).toContain('0.00001');
  });

  it('formatCurrencyCompact omits decimals', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyCompact(1234);
    expect(formatted).toContain('1,234');
    expect(formatted).not.toContain('.00');
  });

  it('formatCurrencyCompact never shows a nonzero amount as zero', () => {
    const { result } = renderHook(() => useNumberFormat());
    const compact = result.current.formatCurrencyCompact;
    // Nonzero at the currency's places: keeps them, both signs alike.
    expect(compact(0.01, 'USD')).toBe('$0.01');
    expect(compact(-0.01, 'USD')).toBe('-$0.01');
    expect(compact(0.4, 'USD')).toBe('$0.40');
    expect(compact(-0.4, 'USD')).toBe('-$0.40');
    expect(compact(0.4999, 'USD')).toBe('$0.50');
    // Zero at the currency's places: an unsigned zero.
    expect(compact(0.004, 'USD')).toBe('$0');
    expect(compact(-0.004, 'USD')).toBe('$0');
    expect(compact(0, 'USD')).toBe('$0');
    // Half a unit or more: whole units, as before.
    expect(compact(0.5, 'USD')).toBe('$1');
    expect(compact(-0.6, 'USD')).toBe('-$1');
    expect(compact(1234.49, 'USD')).toBe('$1,234');
    // A zero-decimal currency has nothing smaller to show.
    expect(compact(0.4, 'JPY')).toBe('¥0');
  });

  it('formatCurrencyTight never shows a nonzero amount as zero', () => {
    const { result } = renderHook(() => useNumberFormat());
    const tight = result.current.formatCurrencyTight;
    expect(tight(0.01, 'USD')).toBe('$0.01');
    expect(tight(-0.01, 'USD')).toBe('-$0.01');
    expect(tight(-0.4, 'USD')).toBe('-$0.40');
    expect(tight(-0.004, 'USD')).toBe('$0');
    // Unchanged above half a unit and in the compact range.
    expect(tight(344.3, 'USD')).toBe('$344');
    expect(tight(13344.33, 'USD')).toBe('$13.3K');
  });

  it('formatCurrencyLabel never shows a nonzero amount as zero', () => {
    const { result } = renderHook(() => useNumberFormat());
    const label = result.current.formatCurrencyLabel;
    expect(label(0.01)).toBe('$0.01');
    expect(label(-0.01)).toBe('-$0.01');
    expect(label(-0.4)).toBe('-$0.40');
    expect(label(-0.004)).toBe('$0');
    // Unchanged above half a unit and in the K range.
    expect(label(344.3)).toBe('$344');
    expect(label(123456)).toBe('$123.5K');
  });

  it('formatNumber formats with specified decimals', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatNumber(1234.5678, 2)).toBe('1,234.57');
  });

  it('formatPercent divides by 100 for Intl', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatPercent(50);
    expect(formatted).toContain('50');
    expect(formatted).toContain('%');
  });

  it('formatCurrencyLabel uses compact suffix', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyLabel(1500);
    expect(formatted).toContain('K');
  });

  it('returns defaultCurrency and numberFormat', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.defaultCurrency).toBe('USD');
    expect(result.current.numberFormat).toBe('en-US');
  });

  it('formatCurrency rounds IEEE 754 midpoint values up correctly', () => {
    // 3 * 53.245 = 159.73499999... in IEEE 754 without pre-rounding,
    // which would incorrectly round down to 159.73.
    // With roundToDecimals applied before formatting, it should be 159.74.
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(159.735);
    // 159.735 pre-rounded to 2dp via roundToDecimals should yield 159.74
    expect(formatted).toContain('159.74');
    expect(formatted).not.toContain('159.73');
  });

  it('formatCurrency handles zero correctly', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(0);
    expect(formatted).toContain('0.00');
  });

  it('formatCurrency uses custom fractionDigits', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(12.3456, undefined, 4);
    expect(formatted).toContain('12.3456');
  });

  it('formatCurrency with fractionDigits rounds correctly', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrency(9.99999, 'USD', 4);
    expect(formatted).toContain('10.0000');
  });

  it('formatCurrencyAxis treats numeric second arg as index (uses default currency)', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyAxis(5000, 0);
    expect(formatted).toMatch(/[KMB]/);
  });

  it('formatCurrencyAxis uses provided currency when string', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyAxis(5000, 'EUR');
    expect(formatted).toBeTruthy();
  });

  it('formatCurrencyTight drops the decimals below a thousand and scales above it', () => {
    // The figure a calendar day on a phone has room for: no cents at three
    // figures, and K/M rather than a number that overflows its column.
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyTight(344.33)).toBe('$344');
    expect(result.current.formatCurrencyTight(13344.33)).toBe('$13.3K');
    expect(result.current.formatCurrencyTight(2_500_000)).toBe('$2.5M');
  });

  it('formatCurrencyTight keeps a negative balance negative, and honours the currency', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyTight(-13344.33)).toBe('-$13.3K');
    expect(result.current.formatCurrencyTight(1500, 'EUR')).toBe('€1.5K');
  });

  it('formatCurrencyTight renders a zero balance as zero, not as unknown', () => {
    // An account holding nothing holds zero: the tight figure is the only thing
    // a phone cell prints, so it has to say so.
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyTight(0)).toBe('$0');
  });

  it('formatCurrencyLabel produces M suffix for millions', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyLabel(2_500_000)).toContain('M');
  });

  it('formatCurrencyLabel produces B suffix for billions', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyLabel(3_000_000_000)).toContain('B');
  });

  it('formatCurrencyLabel produces T suffix for trillions', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatCurrencyLabel(2_000_000_000_000)).toContain('T');
  });

  it('formatCurrencyLabel has no suffix for small values', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyLabel(50);
    expect(formatted).not.toMatch(/[KMBT]/);
  });

  it('formatSignedPercent adds a leading + for non-negative values', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatSignedPercent(12.5)).toBe('+12.50%');
    expect(result.current.formatSignedPercent(0)).toBe('+0.00%');
  });

  it('formatSignedPercent keeps the minus sign for negatives', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatSignedPercent(-3.4)).toBe('-3.40%');
  });

  it('formatSignedPercent renders a tiny negative that rounds to zero as +0.00%, not +-0.00%', () => {
    const { result } = renderHook(() => useNumberFormat());
    // -0.001 rounds to -0; without -0 normalization Intl emits "-0.00" and the
    // leading "+" produces the malformed "+-0.00%".
    expect(result.current.formatSignedPercent(-0.001)).toBe('+0.00%');
    expect(result.current.formatSignedPercent(-0.004, 2)).toBe('+0.00%');
  });

  it('formatSignedPercent honours the decimals argument', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatSignedPercent(7.123, 1)).toBe('+7.1%');
  });

  it('formatSignedPercent renders a sign-less zero for non-finite input', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatSignedPercent(NaN)).toBe('0.00%');
  });

  it('formatQuantity trims trailing zeros up to 4dp', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatQuantity(100)).toBe('100');
    expect(result.current.formatQuantity(1.5)).toBe('1.5');
    expect(result.current.formatQuantity(1.23456)).toBe('1.2346');
  });

  it('formatQuantity adds thousands separators', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatQuantity(1234.5)).toBe('1,234.5');
  });

  it('formatPrice trims trailing zeros up to 6dp', () => {
    const { result } = renderHook(() => useNumberFormat());
    // A whole-cent price reads as an integer, not "123.000000", and Intl does
    // the trimming so a comma-decimal locale never leaves a dangling separator.
    expect(result.current.formatPrice(123)).toBe('123');
    expect(result.current.formatPrice(123.45)).toBe('123.45');
    // Six decimals survive; a seventh rounds into the sixth.
    expect(result.current.formatPrice(1.234567)).toBe('1.234567');
    expect(result.current.formatPrice(1.2345678)).toBe('1.234568');
  });

  it('formatPrice adds thousands separators', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatPrice(1234.5)).toBe('1,234.5');
  });
});

describe('formatPrice in a comma-decimal locale', () => {
  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  it('leaves no dangling separator when the decimal mark is a comma', () => {
    // formatPrice exists specifically so a comma-decimal locale never trails a
    // separator. The old `formatNumber(...).replace(/0+$/,'').replace(/\.$/,'')`
    // produced "1.000," in German: stripping trailing zeros left "1.000," and
    // the `/\.$/` strip never matched the comma. Intl does the trimming, so a
    // whole number renders clean and a fractional one keeps its comma mark.
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'de-DE', defaultCurrency: 'EUR' } }),
    );
    const { result } = renderHook(() => useNumberFormat());
    expect(result.current.formatPrice(1000)).toBe('1.000');
    expect(result.current.formatPrice(123.45)).toBe('123,45');
    expect(result.current.formatPrice(1234.5)).toBe('1.234,5');
  });
});

describe('useNumberFormat with browser locale', () => {
  it('treats "browser" numberFormat as undefined locale', async () => {
    vi.resetModules();
    vi.doMock('@/store/preferencesStore', () => ({
      usePreferencesStore: (selector: any) =>
        selector({ preferences: { numberFormat: 'browser', defaultCurrency: 'USD' } }),
    }));
    const { useNumberFormat: hook } = await import('./useNumberFormat');
    const { result } = renderHook(() => hook());
    expect(typeof result.current.formatNumber(1234)).toBe('string');
    expect(typeof result.current.formatPercent(10)).toBe('string');
    expect(typeof result.current.formatCurrency(100)).toBe('string');
  });
});

describe('formatShareQuantity', () => {
  /** Render the hook with an explicit preference pair, as a real user has. */
  const withPreferences = (numberFormat: string, language?: string) => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({
        preferences: { numberFormat, defaultCurrency: 'USD', language },
      }),
    );
    return renderHook(() => useNumberFormat()).result;
  };

  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  it('uses the configured locale, not the browser (issue #1316)', () => {
    // The Securities list showed `755.8342` for a Polish user because it went
    // through the pure `formatShareQuantity`, which renders via `toFixed`.
    expect(withPreferences('pl-PL', 'pl').current.formatShareQuantity(755.8342)).toBe(
      '755,8342',
    );
    expect(withPreferences('en-US', 'pl').current.formatShareQuantity(755.8342)).toBe(
      '755.8342',
    );
  });

  it('keeps a tiny residual position visible', () => {
    // Eight decimals, not `formatQuantity`'s four: a residual holding is exactly
    // what this column exists to expose, and rounding it away is silent.
    const pl = withPreferences('pl-PL', 'pl').current;
    expect(pl.formatShareQuantity(0.0003)).toBe('0,0003');
    expect(pl.formatShareQuantity(0.00000001)).toBe('0,00000001');
  });

  it('trims trailing zeros', () => {
    const en = withPreferences('en-US', 'en').current;
    expect(en.formatShareQuantity(100)).toBe('100');
    expect(en.formatShareQuantity(12.5)).toBe('12.5');
  });

  it('groups thousands in the reader\'s convention', () => {
    expect(withPreferences('en-US', 'en').current.formatShareQuantity(12345)).toBe(
      '12,345',
    );
    // Polish groups with a (narrow) no-break space; assert the shape rather than
    // the exact code point, which moves between ICU versions.
    expect(
      withPreferences('pl-PL', 'pl').current.formatShareQuantity(12345),
    ).toMatch(/^12[\s\u00a0\u202f]345$/);
  });

  it('renders a nullish or NaN quantity as zero, never blank or NaN', () => {
    const en = withPreferences('en-US', 'en').current;
    expect(en.formatShareQuantity(null)).toBe('0');
    expect(en.formatShareQuantity(undefined)).toBe('0');
    expect(en.formatShareQuantity(NaN)).toBe('0');
  });

  it('normalizes a negative residue that rounds to zero', () => {
    // Intl formats -0 with a leading minus; a -4.77e-15 share residue is zero,
    // not a short position.
    const en = withPreferences('en-US', 'en').current;
    expect(en.formatShareQuantity(-0)).toBe('0');
    expect(en.formatShareQuantity(-4.77e-15)).toBe('0');
    expect(en.formatShareQuantity(-0.000000001)).toBe('0');
    // A real negative survives.
    expect(en.formatShareQuantity(-0.5)).toBe('-0.5');
  });

  it('follows the UI language when numberFormat is "browser"', () => {
    expect(
      withPreferences('browser', 'pl').current.formatShareQuantity(755.8342),
    ).toBe('755,8342');
  });
});

describe('an unusable stored numberFormat', () => {
  const withPreferences = (numberFormat: string, language?: string) => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({
        preferences: { numberFormat, defaultCurrency: 'USD', language },
      }),
    );
    return renderHook(() => useNumberFormat()).result;
  };

  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  it('renders through the browser default instead of throwing', () => {
    // `Intl.NumberFormat` throws RangeError on a structurally invalid tag, and
    // `en_US` -- the underscore form -- is one. This call sits inside render, so
    // a single bad stored value took the whole screen down rather than one
    // figure. Nothing validated the preference before this.
    const r = withPreferences('en_US', 'pl').current;
    expect(() => r.formatCurrency(1234.5, 'USD')).not.toThrow();
    expect(() => r.formatNumber(1234.5)).not.toThrow();
    expect(() => r.formatPercent(12.3)).not.toThrow();
    expect(() => r.formatPercentTrimmed(12.3)).not.toThrow();
    expect(() => r.formatShareQuantity(755.8342)).not.toThrow();
    expect(r.formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
  });

  it('falls back for an unusable UI language too', () => {
    const r = withPreferences('browser', 'pl_PL').current;
    expect(() => r.formatNumber(1234.5)).not.toThrow();
  });
});

describe('formatPercentTrimmed', () => {
  const withPreferences = (numberFormat: string, language?: string) => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({
        preferences: { numberFormat, defaultCurrency: 'USD', language },
      }),
    );
    return renderHook(() => useNumberFormat()).result;
  };

  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  it('keeps the precision the value already carries', () => {
    // The migration target for the `{value}%` shape. The server rounds
    // percentUsed to 2dp, so the same expression must still render "80%",
    // "80.5%" and "80.55%" -- a fixed decimal count would change all three.
    const en = withPreferences('en-US', 'en').current;
    expect(en.formatPercentTrimmed(80)).toBe('80%');
    expect(en.formatPercentTrimmed(80.5)).toBe('80.5%');
    expect(en.formatPercentTrimmed(80.55)).toBe('80.55%');
    expect(en.formatPercentTrimmed(0)).toBe('0%');
  });

  it('uses the configured locale', () => {
    const pl = withPreferences('pl-PL', 'pl').current;
    expect(pl.formatPercentTrimmed(80.55)).toBe('80,55%');
    expect(pl.formatPercentTrimmed(80)).toBe('80%');
  });

  it('caps at four decimals', () => {
    const en = withPreferences('en-US', 'en').current;
    expect(en.formatPercentTrimmed(33.333333)).toBe('33.3333%');
  });
});

describe('formatBytes across locales', () => {
  afterEach(() => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } }),
    );
  });

  const withLocale = (numberFormat: string) => {
    vi.mocked(usePreferencesStore).mockImplementation((selector: any) =>
      selector({ preferences: { numberFormat, defaultCurrency: 'USD' } }),
    );
    return renderHook(() => useNumberFormat()).result;
  };

  it('scales to the unit the size reads best in', () => {
    const result = withLocale('en-US');
    expect(result.current.formatBytes(512)).toBe('512 byte');
    expect(result.current.formatBytes(1536)).toBe('1.5 kB');
    expect(result.current.formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(result.current.formatBytes(2 * 1024 ** 3)).toBe('2.0 GB');
  });

  // The point of the whole change: a file size is a number a person reads, so
  // the decimal mark follows their preference. `toFixed` wrote a `.` for
  // everyone, so a Polish reader saw "1.4 MB" beside their own "1 234,56 zł".
  it('writes the decimal mark the reader uses', () => {
    expect(withLocale('pl-PL').current.formatBytes(1536)).toBe('1,5 kB');
    expect(withLocale('de-DE').current.formatBytes(1536)).toBe('1,5 kB');
  });

  // Intl localizes the unit as well, which is why this does not need the unit
  // abbreviations translated into twenty-two catalogs.
  it('localizes the unit abbreviation, not only the number', () => {
    // French separates the value from the unit with a NARROW NO-BREAK SPACE
    // (U+202F), not an ordinary one. Asserted as the real character rather than
    // normalised away: a test that compared against a plain space would be
    // asserting an output Intl does not produce.
    expect(withLocale('fr-FR').current.formatBytes(1536)).toBe('1,5\u202Fko');
    expect(withLocale('ru-RU').current.formatBytes(1536)).toBe('1,5 кБ');
  });

  it('renders a zero size as a measured zero, not as unknown', () => {
    expect(withLocale('en-US').current.formatBytes(0)).toBe('0 byte');
  });
});
