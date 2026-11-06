import { describe, it, expect } from 'vitest';
import { buildCurrencySchema, CRYPTO_DEFAULT_DECIMAL_PLACES } from './currency-form-schema';

const t = (key: string) => key;
const schema = buildCurrencySchema(t);

const base = { code: 'BTC', name: 'Bitcoin', symbol: 'B', decimalPlaces: 8 };

function issues(input: Record<string, unknown>) {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}:${i.message}`);
}

describe('currency form schema', () => {
  it('accepts a coin with a pair, and one without a price symbol', () => {
    expect(issues({ ...base, kind: 'CRYPTO', quoteSymbol: 'BTC-EUR' })).toEqual([]);
    expect(issues({ ...base, kind: 'CRYPTO', quoteSymbol: 'btc-eur' })).toEqual([]);
    expect(issues({ ...base, kind: 'CRYPTO', quoteSymbol: '' })).toEqual([]);
  });

  it('defaults to a fiat currency without a price symbol', () => {
    const result = schema.safeParse({ code: 'EUR', name: 'Euro', symbol: 'E' });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ kind: 'FIAT', quoteSymbol: '', decimalPlaces: 2 });
  });

  it('refuses a price symbol on a fiat currency', () => {
    expect(issues({ ...base, kind: 'FIAT', quoteSymbol: 'BTC-EUR' })).toEqual([
      'quoteSymbol:validation.quoteSymbolRequiresCrypto',
    ]);
  });

  it('refuses a symbol that is not a <COIN>-<FIAT> pair', () => {
    for (const quoteSymbol of ['BTC', 'BTC-', 'BTC-EURO', 'ETH-BTC']) {
      expect(issues({ ...base, kind: 'CRYPTO', quoteSymbol })).toEqual([
        'quoteSymbol:validation.quoteSymbolNotAPair',
      ]);
    }
  });

  it('refuses a symbol longer than the column', () => {
    expect(issues({ ...base, kind: 'CRYPTO', quoteSymbol: 'ABCDEFGHIJKLMNOPQ-EUR' })).toContain(
      'quoteSymbol:validation.quoteSymbolMax',
    );
  });

  it('refuses an unknown kind and more than eight places', () => {
    expect(issues({ ...base, kind: 'TOKEN' }).some((i) => i.startsWith('kind:'))).toBe(true);
    expect(issues({ ...base, kind: 'CRYPTO', decimalPlaces: 9 }).some((i) => i.startsWith('decimalPlaces:'))).toBe(true);
  });

  it('accepts a coin at up to eight places', () => {
    for (const decimalPlaces of [5, 6, 8]) {
      expect(issues({ ...base, kind: 'CRYPTO', decimalPlaces }).some((i) => i.startsWith('decimalPlaces:'))).toBe(false);
    }
  });

  it('starts a coin at eight places', () => {
    expect(CRYPTO_DEFAULT_DECIMAL_PLACES).toBe(8);
  });
});
