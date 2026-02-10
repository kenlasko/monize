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
});
