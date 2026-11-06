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

  it('formats a registered coin at its eight places in en', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.01250000');
    expect(plain(result.current.formatCurrency(0.000025, 'BTC'))).toBe('BTC 0.00002500');
  });

  it('formats a registered coin at its eight places in de-DE', () => {
    numberFormat = 'de-DE';
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('0,01250000 BTC');
  });

  it('formats a coin registered at four at its four places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.0125');
  });

  it('lets an explicit count win over the registry', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC', 2))).toBe('BTC 0.01');
  });

  it('applies the registry to a non-ISO default currency when no code is passed', () => {
    defaultCurrency = 'BTC';
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125))).toBe('BTC 0.01250000');
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
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrencyPrecise(0.0125, 'BTC'))).toBe('BTC 0.01250000');
    expect(plain(result.current.formatCurrencyPrecise(0.000025, 'BTC'))).toBe('BTC 0.00002500');
  });

  it('expands formatCurrencyPrecise below a registered coin\'s places up to eight, not six', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }, { code: 'XBT', decimalPlaces: 2 }]);
    const { result } = renderHook(() => useNumberFormat());
    // Below the base precision it still expands rather than reading zero.
    expect(plain(result.current.formatCurrencyPrecise(0.00001234, 'BTC'))).toBe('BTC 0.0000123');
    // Six places read "XBT 0.000000" for one satoshi.
    expect(plain(result.current.formatCurrencyPrecise(0.00000001, 'XBT'))).toBe('XBT 0.00000001');
  });

  it('keeps formatCurrencyPrecise\'s six-place ceiling for fiat', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrencyPrecise(0.000318, 'GBP'))).toBe('£0.000318');
    expect(plain(result.current.formatCurrencyPrecise(0.00000001, 'GBP'))).toBe('£0.000000');
    expect(plain(result.current.formatCurrencyPrecise(1234.5, 'CAD'))).toBe('$1,234.50');
  });

  it('redraws a mounted consumer when the registry fills', () => {
    const { result } = renderHook(() => useNumberFormat());
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.01');
    act(() => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    });
    expect(plain(result.current.formatCurrency(0.0125, 'BTC'))).toBe('BTC 0.01250000');
  });

  describe('a registered symbol', () => {
    const BTC = { code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' };

    it('replaces the code Intl writes, laid out as en lays out a symbol', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      expect(result.current.formatCurrency(0.007, 'BTC')).toBe('\u20bf0.00700000');
      expect(result.current.formatCurrency(-0.0051, 'BTC')).toBe('-\u20bf0.00510000');
      expect(result.current.formatCurrency(-0.000025, 'BTC')).toBe('-\u20bf0.00002500');
      expect(result.current.formatCurrencyPrecise(0.007, 'BTC')).toBe('\u20bf0.00700000');
      expect(result.current.formatCurrencyCompact(12.6, 'BTC')).toBe('\u20bf12.60000000');
    });

    it('replaces the code Intl writes, laid out as de-DE lays out a symbol', () => {
      numberFormat = 'de-DE';
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      expect(plain(result.current.formatCurrency(1234.007, 'BTC'))).toBe('1.234,00700000 \u20bf');
      expect(plain(result.current.formatCurrencyPrecise(0.007, 'BTC'))).toBe('0,00700000 \u20bf');
      expect(plain(result.current.formatCurrencyCompact(12.6, 'BTC'))).toBe('12,60000000 \u20bf');
    });

    it('keeps the code for a registered currency without a symbol', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '' }]);
      const { result } = renderHook(() => useNumberFormat());
      expect(plain(result.current.formatCurrency(0.007, 'BTC'))).toBe('BTC 0.00700000');
      expect(plain(result.current.formatCurrencyCompact(12.6, 'BTC'))).toBe('BTC 12.60000000');
    });

    it('keeps the code for a registered currency without a symbol in de-DE', () => {
      numberFormat = 'de-DE';
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      const { result } = renderHook(() => useNumberFormat());
      expect(plain(result.current.formatCurrency(0.007, 'BTC'))).toBe('0,00700000 BTC');
    });

    it('keeps the code for an unregistered currency', () => {
      const { result } = renderHook(() => useNumberFormat());
      expect(plain(result.current.formatCurrency(0.007, 'BTC'))).toBe('BTC 0.01');
      expect(plain(result.current.formatCurrencyCompact(12.6, 'BTC'))).toBe('BTC 13');
    });

    it('spaces a letter symbol from the figure', () => {
      registerCurrencyDecimals([{ code: 'XBT', decimalPlaces: 2, symbol: 'Xb' }]);
      const { result } = renderHook(() => useNumberFormat());
      expect(plain(result.current.formatCurrency(5, 'XBT'))).toBe('Xb 5.00');
    });

    it('leaves an ISO currency exactly as Intl writes it', () => {
      registerCurrencyDecimals([BTC, { code: 'USD', decimalPlaces: 2, symbol: 'US$' }]);
      const { result } = renderHook(() => useNumberFormat());
      expect(result.current.formatCurrency(1234.5, 'USD')).toBe('$1,234.50');
      expect(plain(result.current.formatCurrency(1234.5, 'CHF'))).toBe('CHF 1,234.50');
      expect(result.current.formatCurrencyAxis(1500, 'USD')).toBe('$1.5K');
      expect(result.current.formatCurrencyFlag(1500, 'USD')).toBe('$1.50K');
    });

    it('writes a registered coin\'s axis ticks and flags at its own places below one', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      expect(result.current.formatCurrencyAxis(0.007, 'BTC')).toBe('\u20bf0.007');
      expect(result.current.formatCurrencyAxis(0.000025, 'BTC')).toBe('\u20bf0.000025');
      expect(result.current.formatCurrencyAxis(1500, 'BTC')).toBe('\u20bf1.5K');
      expect(result.current.formatCurrencyFlag(0.007, 'BTC')).toBe('\u20bf0.00700000');
      expect(result.current.formatCurrencyFlag(1500, 'BTC')).toBe('\u20bf1.50K');
      expect(result.current.formatCurrencyTight(12, 'BTC')).toBe('\u20bf12.00000000');
    });

    it('keeps a registered coin\'s places below one in the compact and tight figures', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      // At zero fraction digits both read "\u20bf0".
      expect(result.current.formatCurrencyCompact(0.0125, 'BTC')).toBe('\u20bf0.01250000');
      expect(result.current.formatCurrencyTight(0.0125, 'BTC')).toBe('\u20bf0.01250000');
      expect(result.current.formatCurrencyCompact(-0.007, 'BTC')).toBe('-\u20bf0.00700000');
      expect(result.current.formatCurrencyCompact(0.000025, 'BTC')).toBe('\u20bf0.00002500');
      expect(result.current.formatCurrencyTight(-0.000025, 'BTC')).toBe('-\u20bf0.00002500');
    });

    it('keeps a registered coin\'s places from one to 999 in the compact and tight figures', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      // At zero fraction digits both read "\u20bf2": half the wallet gone.
      expect(result.current.formatCurrencyCompact(2.49, 'BTC')).toBe('\u20bf2.49000000');
      expect(result.current.formatCurrencyTight(2.49, 'BTC')).toBe('\u20bf2.49000000');
      expect(result.current.formatCurrencyCompact(12.3456, 'BTC')).toBe('\u20bf12.34560000');
      expect(result.current.formatCurrencyCompact(-999.5, 'BTC')).toBe('-\u20bf999.50000000');
      expect(result.current.formatCurrencyTight(999.5, 'BTC')).toBe('\u20bf999.50000000');
    });

    it('writes a registered coin of a thousand or more as fiat is written', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      expect(result.current.formatCurrencyTight(1500, 'BTC')).toBe('\u20bf1.5K');
      expect(result.current.formatCurrencyTight(1000, 'BTC')).toBe('\u20bf1K');
      // The compact figure has no K/M notation for fiat either ("$1,235").
      expect(result.current.formatCurrencyCompact(1500, 'BTC')).toBe('\u20bf1,500');
      expect(result.current.formatCurrencyCompact(-1234.5, 'BTC')).toBe('-\u20bf1,235');
    });

    it('leaves a fiat compact and tight figure unchanged', () => {
      registerCurrencyDecimals([BTC]);
      const { result } = renderHook(() => useNumberFormat());
      expect(result.current.formatCurrencyCompact(1234.5, 'CAD')).toBe('$1,235');
      expect(result.current.formatCurrencyCompact(0.5, 'USD')).toBe('$1');
      expect(result.current.formatCurrencyTight(0.4, 'USD')).toBe('$0');
      expect(result.current.formatCurrencyTight(344.33, 'USD')).toBe('$344');
    });
  });
});
