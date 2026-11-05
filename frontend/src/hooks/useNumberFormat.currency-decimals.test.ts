import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useNumberFormat } from './useNumberFormat';
import { clearCurrencyDecimals, registerCurrencyDecimals } from '@/lib/currency-decimals';

let numberFormat = 'en';
let defaultCurrency = 'CAD';

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn((selector: (state: unknown) => unknown) =>
    selector({ preferences: { numberFormat, defaultCurrency, language: 'en' } }),
  ),
}));

/** Intl separates the code from the figure with a no-break space. */
const plain = (text: string) => text.replace(/ /g, ' ');

describe('useNumberFormat and the currency decimals registry', () => {
  beforeEach(() => {
    clearCurrencyDecimals();
    numberFormat = 'en';
    defaultCurrency = 'CAD';
  });

  it('formats an unregistered coin at Intl\'s two places', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.01');
  });

  it('formats a registered coin at its four places in en', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.0125');
  });

  it('formats a registered coin at its four places in de-DE', () => {
    numberFormat = 'de-DE';
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('0,0125 BTC');
  });

  it('lets an explicit count win over the registry', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC', 2))).toBe('BTC 0.01');
  });

  it('applies the registry to a non-ISO default currency when no code is passed', () => {
    defaultCurrency = 'BTC';
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125))).toBe('BTC 0.0125');
  });

  it('keeps an ISO currency at Intl\'s places whatever its row says', () => {
    registerCurrencyDecimals([
      { code: 'JPY', decimalPlaces: 2 },
      { code: 'CAD', decimalPlaces: 0 },
    ]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(1234.56, 'JPY'))).toBe('¥1,235');
    expect(plain(result.current.formatCurrency(1234.56))).toBe('$1,234.56');
    expect(plain(result.current.formatCurrencyPrecise(1234.56, 'JPY'))).toBe('¥1,235');
  });

  it('starts formatCurrencyPrecise from the registered places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrencyPrecise(0.0125, 'BTC'))).toBe('BTC 0.0125');
    // Below the base precision it still expands rather than reading zero.
    expect(plain(result.current.formatCurrencyPrecise(0.00001234, 'BTC'))).toMatch(/^BTC 0\.000012/);
  });

  it('redraws a mounted consumer when the registry fills', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.01');
    act(() => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    });
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.0125');
  });
});
