import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNumberFormat } from './useNumberFormat';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: any) =>
    selector({ preferences: { numberFormat: 'en-US', defaultCurrency: 'USD' } })
  ),
}));

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

  it('formatCurrencyCompact omits decimals', () => {
    const { result } = renderHook(() => useNumberFormat());
    const formatted = result.current.formatCurrencyCompact(1234);
    expect(formatted).toContain('1,234');
    expect(formatted).not.toContain('.00');
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
