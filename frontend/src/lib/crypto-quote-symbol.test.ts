import { describe, it, expect } from 'vitest';
import { quoteSymbolFiat } from './crypto-quote-symbol';

describe('quoteSymbolFiat', () => {
  it('reads the fiat leg of a coin pair', () => {
    expect(quoteSymbolFiat('BTC-EUR')).toBe('EUR');
    expect(quoteSymbolFiat('btc-cad')).toBe('CAD');
    expect(quoteSymbolFiat(' DOGE-USD ')).toBe('USD');
  });

  it('takes the leg after the last hyphen of a multi-part ticker', () => {
    expect(quoteSymbolFiat('USDC-X-USD')).toBe('USD');
  });

  it('is null for a symbol without a fiat leg', () => {
    expect(quoteSymbolFiat('BTC')).toBeNull();
    expect(quoteSymbolFiat('BTC-')).toBeNull();
    expect(quoteSymbolFiat('-EUR')).toBeNull();
    expect(quoteSymbolFiat('BTC-EURO')).toBeNull();
    expect(quoteSymbolFiat('')).toBeNull();
    expect(quoteSymbolFiat(null)).toBeNull();
  });

  it('is null when the last leg is not an ISO currency', () => {
    expect(quoteSymbolFiat('ETH-BTC')).toBeNull();
  });
});
