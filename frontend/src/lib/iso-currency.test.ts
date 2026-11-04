import { describe, it, expect } from 'vitest';
import { isKnownIsoCurrency } from './iso-currency';

describe('isKnownIsoCurrency', () => {
  it('accepts ISO 4217 codes in any case', () => {
    expect(isKnownIsoCurrency('EUR')).toBe(true);
    expect(isKnownIsoCurrency('cad')).toBe(true);
    expect(isKnownIsoCurrency(' USD ')).toBe(true);
    expect(isKnownIsoCurrency('KWD')).toBe(true);
  });

  it('rejects codes that are not ISO currencies', () => {
    expect(isKnownIsoCurrency('BTC')).toBe(false);
    expect(isKnownIsoCurrency('ETH')).toBe(false);
    expect(isKnownIsoCurrency('ZZZ')).toBe(false);
    expect(isKnownIsoCurrency('')).toBe(false);
  });
});
