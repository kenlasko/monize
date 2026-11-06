import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearCurrencyDecimals,
  currencyDecimalsVersion,
  decimalPlacesForCurrency,
  registerCurrencyDecimals,
  currencySymbolFor,
  subscribeCurrencyDecimals,
  symbolForCurrency,
} from './currency-decimals';

describe('currency decimals registry', () => {
  beforeEach(() => {
    clearCurrencyDecimals();
  });

  it('answers undefined for a code it does not hold, so the caller falls back to Intl', () => {
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
    expect(decimalPlacesForCurrency('')).toBeUndefined();
    expect(decimalPlacesForCurrency(undefined)).toBeUndefined();
  });

  it('holds the places of each registered non-ISO currency, whatever the case of the code', () => {
    registerCurrencyDecimals([
      { code: 'BTC', decimalPlaces: 8 },
      { code: 'eth', decimalPlaces: 3 },
    ]);
    expect(decimalPlacesForCurrency('BTC')).toBe(8);
    expect(decimalPlacesForCurrency('btc')).toBe(8);
    expect(decimalPlacesForCurrency('ETH')).toBe(3);
  });

  it('never holds an ISO currency, so a stored row cannot change how fiat renders', () => {
    registerCurrencyDecimals([
      { code: 'JPY', decimalPlaces: 2 },
      { code: 'usd', decimalPlaces: 4 },
    ]);
    expect(decimalPlacesForCurrency('JPY')).toBeUndefined();
    expect(decimalPlacesForCurrency('USD')).toBeUndefined();
  });

  it('does not notify for a list of ISO currencies only', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCurrencyDecimals(listener);
    registerCurrencyDecimals([{ code: 'CAD', decimalPlaces: 0 }]);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('lets a later registration replace an earlier one and keeps the others', () => {
    registerCurrencyDecimals([
      { code: 'BTC', decimalPlaces: 2 },
      { code: 'ETH', decimalPlaces: 4 },
    ]);
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    expect(decimalPlacesForCurrency('BTC')).toBe(8);
    expect(decimalPlacesForCurrency('ETH')).toBe(4);
  });

  it('holds any whole number of places up to the eight a money column carries', () => {
    registerCurrencyDecimals([
      { code: 'AAA', decimalPlaces: 5 },
      { code: 'BBB', decimalPlaces: 6 },
      { code: 'CCC', decimalPlaces: 8 },
    ]);
    expect(decimalPlacesForCurrency('AAA')).toBe(5);
    expect(decimalPlacesForCurrency('BBB')).toBe(6);
    expect(decimalPlacesForCurrency('CCC')).toBe(8);
  });

  it('skips a row whose places are not a whole number from 0 to 8', () => {
    registerCurrencyDecimals([
      { code: 'AAA', decimalPlaces: 9 },
      { code: 'BBB', decimalPlaces: -1 },
      { code: 'CCC', decimalPlaces: 1.5 },
      { code: 'DDD', decimalPlaces: Number.NaN },
      { code: 'EEE', decimalPlaces: undefined as unknown as number },
    ]);
    for (const code of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
      expect(decimalPlacesForCurrency(code)).toBeUndefined();
    }
  });

  it('empties on clear', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    clearCurrencyDecimals();
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
  });

  it('notifies subscribers only when a value changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCurrencyDecimals(listener);
    const before = currencyDecimalsVersion();

    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(currencyDecimalsVersion()).not.toBe(before);

    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    expect(listener).toHaveBeenCalledTimes(1);

    clearCurrencyDecimals();
    expect(listener).toHaveBeenCalledTimes(2);
    clearCurrencyDecimals();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerCurrencyDecimals([{ code: 'ETH', decimalPlaces: 4 }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  describe('symbol', () => {
    it('holds the stored symbol of a registered non-ISO currency', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: ' \u20bf ' }]);
      expect(symbolForCurrency('BTC')).toBe('\u20bf');
      expect(symbolForCurrency('btc')).toBe('\u20bf');
    });

    it('holds no symbol for a blank one, or one that is the code itself', () => {
      registerCurrencyDecimals([
        { code: 'AAA', decimalPlaces: 4, symbol: '' },
        { code: 'BBB', decimalPlaces: 4, symbol: '   ' },
        { code: 'CCC', decimalPlaces: 4, symbol: 'ccc' },
        { code: 'DDD', decimalPlaces: 4, symbol: null },
        { code: 'EEE', decimalPlaces: 4 },
      ]);
      for (const code of ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']) {
        expect(symbolForCurrency(code)).toBeUndefined();
        expect(decimalPlacesForCurrency(code)).toBe(4);
      }
    });

    it('answers undefined for an unregistered code and for an ISO row', () => {
      registerCurrencyDecimals([{ code: 'USD', decimalPlaces: 2, symbol: 'US$' }]);
      expect(symbolForCurrency('USD')).toBeUndefined();
      expect(symbolForCurrency('BTC')).toBeUndefined();
      expect(symbolForCurrency(undefined)).toBeUndefined();
    });

    it('notifies when only the symbol changes', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      const listener = vi.fn();
      const unsubscribe = subscribeCurrencyDecimals(listener);
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(symbolForCurrency('BTC')).toBe('\u20bf');
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('empties with the places on clear', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
      clearCurrencyDecimals();
      expect(symbolForCurrency('BTC')).toBeUndefined();
    });
  });

  describe('currencySymbolFor', () => {
    it('answers a registered non-ISO currency\'s stored symbol', () => {
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '\u20bf' }]);
      expect(currencySymbolFor('BTC')).toBe('\u20bf');
    });

    it('answers the code Intl writes for a non-ISO currency without a registered symbol', () => {
      expect(currencySymbolFor('BTC')).toBe('BTC');
      registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
      expect(currencySymbolFor('BTC')).toBe('BTC');
    });

    it('answers Intl\'s narrow symbol for an ISO currency, whatever its row says', () => {
      registerCurrencyDecimals([{ code: 'USD', decimalPlaces: 2, symbol: 'US$' }]);
      expect(currencySymbolFor('USD')).toBe('$');
      expect(currencySymbolFor('EUR')).toBe('\u20ac');
      expect(currencySymbolFor('CHF')).toBe('CHF');
    });

    it('answers the fallback, by default the code, for a code Intl rejects', () => {
      expect(currencySymbolFor('INVALID')).toBe('INVALID');
      expect(currencySymbolFor('INVALID', '$')).toBe('$');
    });
  });
});
