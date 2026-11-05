import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearCurrencyDecimals,
  currencyDecimalsVersion,
  decimalPlacesForCurrency,
  registerCurrencyDecimals,
  subscribeCurrencyDecimals,
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
      { code: 'BTC', decimalPlaces: 4 },
      { code: 'eth', decimalPlaces: 3 },
    ]);
    expect(decimalPlacesForCurrency('BTC')).toBe(4);
    expect(decimalPlacesForCurrency('btc')).toBe(4);
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
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    expect(decimalPlacesForCurrency('BTC')).toBe(4);
    expect(decimalPlacesForCurrency('ETH')).toBe(4);
  });

  it('skips a row whose places are not a whole number from 0 to 4', () => {
    registerCurrencyDecimals([
      { code: 'AAA', decimalPlaces: 5 },
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
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    clearCurrencyDecimals();
    expect(decimalPlacesForCurrency('BTC')).toBeUndefined();
  });

  it('notifies subscribers only when a value changes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCurrencyDecimals(listener);
    const before = currencyDecimalsVersion();

    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(currencyDecimalsVersion()).not.toBe(before);

    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    expect(listener).toHaveBeenCalledTimes(1);

    clearCurrencyDecimals();
    expect(listener).toHaveBeenCalledTimes(2);
    clearCurrencyDecimals();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registerCurrencyDecimals([{ code: 'ETH', decimalPlaces: 4 }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
