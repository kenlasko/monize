import { describe, it, expect, afterEach } from 'vitest';
import { clearCurrencyDecimals, registerCurrencyDecimals } from './currency-decimals';
import {
  getCurrencySymbol,
  resolveCurrencySymbol,
  formatCurrency,
  getDecimalPlacesForCurrency,
  roundToDecimals,
  roundToCents,
  roundToEntryPlaces,
  entryDecimalPlaces,
  MONEY_DECIMALS,
  MONEY_SCALE,
  FIAT_MONEY_DECIMALS,
  moneyDecimalsFor,
  moneyDecimalsForCurrency,
  sumMoney,
  loadedEntryAmount,
  awaitsRegisteredPlaces,
  roundMoney,
  withCurrencyCode,
  adaptiveFractionDigits,
  formatAmount,
  formatAmountWithCommas,
  parseAmount,
  filterCurrencyInput,
  filterCalculatorInput,
  hasCalculatorOperators,
  evaluateExpression,
  formatShareQuantity,
  formatSignedPercent,
  gainLossColor,
  balanceColor,
} from './format';

describe('getCurrencySymbol', () => {
  afterEach(() => {
    clearCurrencyDecimals();
  });

  it('returns $ for USD', () => {
    expect(getCurrencySymbol('USD')).toBe('$');
  });

  it('returns a registered non-ISO currency\'s stored symbol, else the code', () => {
    expect(getCurrencySymbol('BTC')).toBe('BTC');
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4, symbol: '\u20bf' }]);
    expect(getCurrencySymbol('BTC')).toBe('\u20bf');
    registerCurrencyDecimals([{ code: 'USD', decimalPlaces: 2, symbol: 'US$' }]);
    expect(getCurrencySymbol('USD')).toBe('$');
  });

  it('returns $ for CAD', () => {
    expect(getCurrencySymbol('CAD')).toBe('$');
  });

  it('returns a symbol for EUR', () => {
    const symbol = getCurrencySymbol('EUR');
    expect(symbol).toBeTruthy();
  });

  it('returns a symbol for GBP', () => {
    const symbol = getCurrencySymbol('GBP');
    expect(symbol).toBeTruthy();
  });

  it('returns $ for invalid currency code', () => {
    expect(getCurrencySymbol('INVALID')).toBe('$');
  });
});

describe('resolveCurrencySymbol', () => {
  it('uses an explicit stored symbol when present', () => {
    expect(resolveCurrencySymbol('CA$', 'CAD')).toBe('CA$');
  });

  it('falls back to the derived symbol when stored value is empty', () => {
    expect(resolveCurrencySymbol('', 'USD')).toBe('$');
  });

  it('falls back to the derived symbol when stored value is whitespace only', () => {
    expect(resolveCurrencySymbol('   ', 'USD')).toBe('$');
  });

  it('falls back to the derived symbol when stored value is null', () => {
    expect(resolveCurrencySymbol(null, 'USD')).toBe('$');
  });

  it('falls back to the derived symbol when stored value is undefined', () => {
    expect(resolveCurrencySymbol(undefined, 'USD')).toBe('$');
  });

  it('trims surrounding whitespace from a real stored symbol', () => {
    expect(resolveCurrencySymbol('  €  ', 'EUR')).toBe('€');
  });
});

describe('formatCurrency', () => {
  it('formats positive amount with USD', () => {
    const result = formatCurrency(1234.56, 'USD');
    expect(result).toContain('1,234.56');
  });

  it('formats negative amount', () => {
    const result = formatCurrency(-50.0, 'USD');
    expect(result).toContain('50.00');
  });

  it('formats zero amount', () => {
    const result = formatCurrency(0, 'USD');
    expect(result).toContain('0.00');
  });

  it('defaults to USD', () => {
    const result = formatCurrency(100);
    expect(result).toContain('100.00');
  });

  it('formats with 2 decimal places', () => {
    const result = formatCurrency(100.1, 'USD');
    expect(result).toContain('100.10');
  });

  it('formats JPY with no decimals', () => {
    const result = formatCurrency(1234, 'JPY');
    expect(result).toContain('1,234');
    expect(result).not.toContain('.');
  });

  it('formats BHD with 3 decimals', () => {
    const result = formatCurrency(1234.567, 'BHD');
    expect(result).toContain('1,234.567');
  });
});

describe('getDecimalPlacesForCurrency', () => {
  afterEach(() => {
    clearCurrencyDecimals();
  });

  it('answers a registered currency from its row before Intl', () => {
    expect(getDecimalPlacesForCurrency('BTC')).toBe(2);
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 4 }]);
    expect(getDecimalPlacesForCurrency('BTC')).toBe(4);
  });

  it('keeps an ISO currency at Intl\'s places even when its row is registered', () => {
    registerCurrencyDecimals([{ code: 'JPY', decimalPlaces: 2 }]);
    expect(getDecimalPlacesForCurrency('JPY')).toBe(0);
  });

  it('returns 2 for USD', () => {
    expect(getDecimalPlacesForCurrency('USD')).toBe(2);
  });

  it('returns 0 for JPY', () => {
    expect(getDecimalPlacesForCurrency('JPY')).toBe(0);
  });

  it('returns 3 for BHD', () => {
    expect(getDecimalPlacesForCurrency('BHD')).toBe(3);
  });

  it('returns 2 for invalid currency', () => {
    expect(getDecimalPlacesForCurrency('INVALID')).toBe(2);
  });
});

describe('roundToDecimals', () => {
  it('rounds to 0 decimals', () => {
    expect(roundToDecimals(10.6, 0)).toBe(11);
  });

  it('rounds to 2 decimals', () => {
    expect(roundToDecimals(10.125, 2)).toBe(10.13);
  });

  it('rounds to 3 decimals', () => {
    expect(roundToDecimals(10.1235, 3)).toBe(10.124);
  });

  it('rounds negative midpoints away from zero', () => {
    expect(roundToDecimals(-10.125, 2)).toBe(-10.13);
    expect(roundToDecimals(-10.124, 2)).toBe(-10.12);
  });

  it('handles IEEE 754 midpoint errors (the 159.735 bug)', () => {
    // 10 * 15.9735 = 159.735 mathematically, but IEEE 754 stores it as
    // 159.73499..., causing naive Math.round(x * 100) / 100 to give 159.73
    const total = 10 * 15.9735;
    expect(roundToDecimals(total, 2)).toBe(159.74);
  });

  it('handles other common IEEE 754 midpoint cases', () => {
    expect(roundToDecimals(1.005, 2)).toBe(1.01);
    expect(roundToDecimals(2.675, 2)).toBe(2.68);
    expect(roundToDecimals(1.255, 2)).toBe(1.26);
  });

  it('handles edge cases', () => {
    expect(roundToDecimals(0, 2)).toBe(0);
    expect(roundToDecimals(5, 2)).toBe(5);
    expect(roundToDecimals(Infinity, 2)).toBe(Infinity);
    expect(roundToDecimals(NaN, 2)).toBeNaN();
  });

  it('rounds tiny near-zero residuals to 0 instead of NaN', () => {
    // String(n) is exponential below 1e-6 (e.g. "6.25e-7"). The old shift
    // built "6.25e-7e2" -> Number() -> NaN, so a projected balance that
    // cancelled to ~0 rendered as "$NaN".
    expect(roundToDecimals(6.250002115848474e-7, 2)).toBe(0);
    expect(roundToDecimals(-6.250002115848474e-7, 2)).toBe(0);
    expect(roundToDecimals(9.999894245993346e-10, 2)).toBe(0);
    expect(Object.is(roundToDecimals(-5.6e-13, 2), 0)).toBe(true);
  });

  it('keeps sub-1e-6 precision when decimalPlaces is large enough', () => {
    expect(roundToDecimals(1e-7, 8)).toBe(1e-7);
    expect(roundToDecimals(1.23e-7, 9)).toBe(1.23e-7);
  });
});

describe('roundMoney', () => {
  it('rounds to money precision (4dp)', () => {
    expect(roundMoney(1.23456)).toBe(1.2346);
    expect(roundMoney(1.23454)).toBe(1.2345);
    expect(roundMoney(99.99999)).toBe(100);
    expect(roundMoney(100)).toBe(100);
  });

  it('rounds a midpoint half away from zero, as the backend roundMoney does', () => {
    // 159.73545 * 10000 is 1597354.4999999998 in binary, so the plain
    // Math.round(x * 10000) / 10000 the removed copies used gave 159.7354.
    expect(roundMoney(159.73545)).toBe(159.7355);
    expect(roundMoney(-159.73545)).toBe(-159.7355);
    expect(roundMoney(1.49995)).toBe(1.5);
  });
});

describe('withCurrencyCode', () => {
  it('appends the code when the currency is not the reader\'s', () => {
    expect(withCurrencyCode('$1,300.00', 'USD', 'CAD')).toBe('$1,300.00 USD');
  });

  it('leaves an amount in the reader\'s own currency alone', () => {
    expect(withCurrencyCode('$1,300.00', 'CAD', 'CAD')).toBe('$1,300.00');
  });

  it('leaves an amount with no currency code alone', () => {
    expect(withCurrencyCode('$1,300.00', '', 'CAD')).toBe('$1,300.00');
  });

  it('does not name a non-ISO code twice when Intl already wrote it', () => {
    // An unregistered coin: Intl uses the code as the symbol.
    expect(withCurrencyCode('BTC\u00a00.01', 'BTC', 'CAD')).toBe('BTC\u00a00.01');
    // de-DE puts it after the figure.
    expect(withCurrencyCode('0,0070\u00a0BTC', 'BTC', 'EUR')).toBe('0,0070\u00a0BTC');
    expect(withCurrencyCode('-BTC\u00a00.0051', 'BTC', 'CAD')).toBe('-BTC\u00a00.0051');
  });

  it('appends a non-ISO code that the figure carries only as a symbol', () => {
    expect(withCurrencyCode('\u20bf0.0070', 'BTC', 'CAD')).toBe('\u20bf0.0070 BTC');
    expect(withCurrencyCode('0,0070\u00a0\u20bf', 'BTC', 'EUR')).toBe('0,0070\u00a0\u20bf BTC');
  });

  it('matches the code only as a whole token', () => {
    expect(withCurrencyCode('WBTC\u00a01.00', 'BTC', 'CAD')).toBe('WBTC\u00a01.00 BTC');
  });

  it('still appends an ISO code the figure already shows, so no fiat figure changes', () => {
    expect(withCurrencyCode('CHF\u00a01,300.00', 'CHF', 'CAD')).toBe('CHF\u00a01,300.00 CHF');
  });
});

describe('roundToCents', () => {
  it('rounds to 2 decimal places', () => {
    expect(roundToCents(10.125)).toBe(10.13);
  });

  it('handles floating point addition correctly', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS
    expect(roundToCents(0.1 + 0.2)).toBe(0.3);
  });

  it('preserves exact values', () => {
    expect(roundToCents(10.5)).toBe(10.5);
  });

  it('rounds negative midpoints away from zero', () => {
    expect(roundToCents(-10.125)).toBe(-10.13);
  });

  it('handles zero', () => {
    expect(roundToCents(0)).toBe(0);
  });

  it('rounds a balance that cancels to ~0 down to exactly 0', () => {
    // Funding cash exactly covers an investment BUY: 2000 + -(qty*price)
    // lands on a tiny float residual, which must read as $0.00 not $NaN.
    expect(roundToCents(2000 + -2000.000000625)).toBe(0);
    expect(roundToCents(5000 - 5000.0000088)).toBe(0);
  });
});

describe('roundToEntryPlaces', () => {
  afterEach(() => {
    clearCurrencyDecimals();
  });

  it('keeps a registered coin at its stored places', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8, symbol: '₿' }]);
    expect(roundToEntryPlaces(0.0051, 'BTC')).toBe(0.0051);
    expect(roundToEntryPlaces(-0.000025, 'btc')).toBe(-0.000025);
    expect(roundToEntryPlaces(-0.000000015, 'btc')).toBe(-0.00000002);
  });

  it('rounds a fiat amount exactly as roundToCents does', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    for (const value of [10.125, -10.125, 0.1 + 0.2, 0.0051, 1170.6458]) {
      expect(roundToEntryPlaces(value, 'CAD')).toBe(roundToCents(value));
      expect(roundToEntryPlaces(value, 'JPY')).toBe(roundToCents(value));
    }
  });

  it('keeps a coin the registry does not hold yet at the column scale, and a missing code at cents', () => {
    // Two would be a guess: `GET /currencies` has not answered (or failed),
    // and a 0.0051 BTC amount rounded at it saved 0.01.
    expect(roundToEntryPlaces(0.0051, 'BTC')).toBe(0.0051);
    expect(roundToEntryPlaces(0.000025, 'BTC')).toBe(0.000025);
    expect(roundToEntryPlaces(0.000000015, 'BTC')).toBe(0.00000002);
    expect(roundToEntryPlaces(0.0051, undefined)).toBe(0.01);
  });

  it('loads a coin the registry does not hold yet at the column scale', () => {
    expect(awaitsRegisteredPlaces('BTC')).toBe(true);
    expect(loadedEntryAmount(-0.0051, 'BTC')).toBe(-0.0051);
    expect(loadedEntryAmount(-0.000025, 'BTC')).toBe(-0.000025);
    expect(loadedEntryAmount(-0.000000015, 'BTC')).toBe(-0.00000002);
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 3 }]);
    expect(awaitsRegisteredPlaces('BTC')).toBe(false);
    expect(loadedEntryAmount(-0.0051, 'BTC')).toBe(-0.005);
  });

  it('loads an ISO or missing code at two places, as cents always did', () => {
    for (const code of ['CAD', 'JPY', null, undefined]) {
      expect(awaitsRegisteredPlaces(code)).toBe(false);
      expect(loadedEntryAmount(10.125, code)).toBe(10.13);
    }
  });

  it('answers the places it rounds at: a coin\'s own, otherwise two, never Intl\'s', () => {
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 8 }]);
    expect(entryDecimalPlaces('BTC')).toBe(8);
    expect(entryDecimalPlaces('CAD')).toBe(2);
    expect(entryDecimalPlaces('JPY')).toBe(2);
    expect(entryDecimalPlaces(null)).toBe(2);
  });

  it('answers the column scale for a coin the registry does not hold yet, and two for any ISO code', () => {
    expect(entryDecimalPlaces('BTC')).toBe(MONEY_SCALE);
    expect(entryDecimalPlaces('CAD')).toBe(2);
    expect(entryDecimalPlaces('JPY')).toBe(2);
    expect(entryDecimalPlaces('')).toBe(2);
    expect(entryDecimalPlaces(undefined)).toBe(2);
    registerCurrencyDecimals([{ code: 'BTC', decimalPlaces: 3 }]);
    expect(entryDecimalPlaces('BTC')).toBe(3);
  });
});

describe('money precision', () => {
  afterEach(() => {
    clearCurrencyDecimals();
  });

  it('names the column scale and the fiat precision, and keeps the old name as the fiat one', () => {
    expect(MONEY_SCALE).toBe(8);
    expect(FIAT_MONEY_DECIMALS).toBe(4);
    expect(MONEY_DECIMALS).toBe(FIAT_MONEY_DECIMALS);
  });

  it.each([
    [null, 4],
    [undefined, 4],
    [0, 4],
    [2, 4],
    [3, 4],
    [4, 4],
    [5, 5],
    [6, 6],
    [8, 8],
    [18, 8],
  ] as const)('moneyDecimalsFor(%s) is %i', (places, expected) => {
    expect(moneyDecimalsFor(places)).toBe(expected);
  });

  it('answers a currency\'s money precision from the registry', () => {
    expect(moneyDecimalsForCurrency('CAD')).toBe(4);
    expect(moneyDecimalsForCurrency('JPY')).toBe(4);
    expect(moneyDecimalsForCurrency(null)).toBe(4);
    // A coin the registry does not hold yet: the column scale, lossless.
    expect(moneyDecimalsForCurrency('BTC')).toBe(8);
    registerCurrencyDecimals([
      { code: 'BTC', decimalPlaces: 8 },
      { code: 'SIX', decimalPlaces: 6 },
      { code: 'TWO', decimalPlaces: 2 },
    ]);
    expect(moneyDecimalsForCurrency('BTC')).toBe(8);
    expect(moneyDecimalsForCurrency('SIX')).toBe(6);
    expect(moneyDecimalsForCurrency('TWO')).toBe(4);
  });

  it('rounds a large value at eight places on its decimal string, not a nudged float', () => {
    // The one-ULP midpoint nudge is a hundredth of a unit at eight places above
    // ~4.5e5 (and a whole unit above ~4.5e7), so a large value is rounded on its
    // decimal string instead.
    expect(roundMoney(21000000, 8)).toBe(21000000);
    expect(roundMoney(20999999.99999999, 8)).toBe(20999999.99999999);
    expect(roundToDecimals(123456789.12345678, 8)).toBe(123456789.12345678);
    expect(roundMoney(20999999.999999995, 8)).toBe(21000000);
    expect(roundMoney(-20999999.999999995, 8)).toBe(-21000000);
    // Fiat at four places keeps the nudged path below 4.5 billion.
    expect(roundMoney(10 * 15.9735, 2)).toBe(159.74);
  });

  it('does not carry a value just under a midpoint high in the 1e6 to 4.5e6 band at eight places', () => {
    // The shortest decimal string rounds to ...93; a nudge of 0.05 to 0.1 unit
    // used to carry it to ...94. Mirrors the backend spec.
    expect(roundMoney(3422512.090132934, 8)).toBe(3422512.09013293);
    expect(roundMoney(-3422512.090132934, 8)).toBe(-3422512.09013293);
    expect(roundMoney(3422512.090132935, 8)).toBe(3422512.09013294);
  });

  it('rounds at the precision it is given', () => {
    expect(roundMoney(0.000025004, 8)).toBe(0.000025);
    expect(roundMoney(0.000000015, 8)).toBe(0.00000002);
    expect(roundMoney(-0.000000015, 8)).toBe(-0.00000002);
    expect(roundMoney(0.000025, 4)).toBe(0);
  });
});

describe('sumMoney', () => {
  it('sums at the fiat four places by default, without float drift', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([10.0001, 20.0002])).toBe(30.0003);
    expect(sumMoney([])).toBe(0);
    expect(sumMoney([-1.5, 1.5])).toBe(0);
    expect(Object.is(sumMoney([-0.00001]), 0)).toBe(true);
    expect(sumMoney([1170.6458, -0.0058, 29.36])).toBe(1200);
  });

  it('rounds each value to the precision before summing, half away from zero', () => {
    expect(sumMoney([0.00005])).toBe(0.0001);
    expect(sumMoney([-0.00005])).toBe(-0.0001);
    expect(sumMoney([0.000049])).toBe(0);
  });

  it('is exact at eight places where a float scale is not', () => {
    expect(sumMoney([20999999.99999999, 0.00000001], 8)).toBe(21000000);
    expect(sumMoney([-0.005, -0.000025], 8)).toBe(-0.005025);
    expect(sumMoney([0.1, 0.2], 8)).toBe(0.3);
  });

  it('carries a sum beyond 2^53 units at eight places exactly', () => {
    // 1e9 units at eight places is 1e17 integer units, past 2^53.
    const values = Array.from({ length: 10 }, () => 100000000.00000001);
    expect(sumMoney(values, 8)).toBe(1000000000.0000001);
    expect(sumMoney([1e9, 0.00000001, -0.00000001], 8)).toBe(1e9);
    expect(sumMoney([123456789.12345678, 876543210.87654322], 8)).toBe(1000000000);
  });

  it('reads a value in exponent form', () => {
    expect(sumMoney([1e-7, 2e-8], 8)).toBe(0.00000012);
    expect(sumMoney([1e21, 1], 4)).toBe(1e21 + 1);
  });

  it('is non-finite when a value is', () => {
    expect(sumMoney([1, Number.NaN])).toBeNaN();
    expect(sumMoney([1, Number.POSITIVE_INFINITY])).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('formatAmount', () => {
  it('formats a number to 2 decimal places', () => {
    expect(formatAmount(10.5)).toBe('10.50');
  });

  it('returns empty string for undefined', () => {
    expect(formatAmount(undefined)).toBe('');
  });

  it('returns empty string for null', () => {
    expect(formatAmount(null)).toBe('');
  });

  it('returns empty string for NaN', () => {
    expect(formatAmount(NaN)).toBe('');
  });

  it('formats with 0 decimal places', () => {
    expect(formatAmount(10.5, 0)).toBe('11');
  });

  it('formats with 3 decimal places', () => {
    expect(formatAmount(10.5, 3)).toBe('10.500');
  });
});

describe('formatShareQuantity', () => {
  it('formats whole share counts without decimals', () => {
    expect(formatShareQuantity(100)).toBe('100');
  });

  it('keeps tiny residual quantities visible', () => {
    expect(formatShareQuantity(0.0003)).toBe('0.0003');
    expect(formatShareQuantity(0.00000001)).toBe('0.00000001');
  });

  it('trims trailing zeros', () => {
    expect(formatShareQuantity(12.5)).toBe('12.5');
    expect(formatShareQuantity(12.34)).toBe('12.34');
  });

  it('handles negatives', () => {
    expect(formatShareQuantity(-0.5)).toBe('-0.5');
  });

  it('returns 0 for zero, null, undefined and NaN', () => {
    expect(formatShareQuantity(0)).toBe('0');
    expect(formatShareQuantity(null)).toBe('0');
    expect(formatShareQuantity(undefined)).toBe('0');
    expect(formatShareQuantity(NaN)).toBe('0');
  });

  it('normalizes negative zero and tiny negative residues to 0', () => {
    expect(formatShareQuantity(-0)).toBe('0');
    // A floating-point residue left after fully zeroing a holding.
    expect(formatShareQuantity(-4.77e-15)).toBe('0');
    expect(formatShareQuantity(-0.000000001)).toBe('0');
  });
});

describe('formatAmountWithCommas', () => {
  it('adds comma separators', () => {
    expect(formatAmountWithCommas(1234567.89)).toBe('1,234,567.89');
  });

  it('returns empty string for undefined', () => {
    expect(formatAmountWithCommas(undefined)).toBe('');
  });

  it('formats with 0 decimal places', () => {
    expect(formatAmountWithCommas(1234567, 0)).toBe('1,234,567');
  });

  it('formats with 3 decimal places', () => {
    expect(formatAmountWithCommas(1234.5, 3)).toBe('1,234.500');
  });
});

describe('parseAmount', () => {
  it('parses valid number string', () => {
    expect(parseAmount('123.45')).toBe(123.45);
  });

  it('strips non-numeric characters', () => {
    expect(parseAmount('$1,234.56')).toBe(1234.56);
  });

  it('handles negative numbers', () => {
    expect(parseAmount('-50.00')).toBe(-50.0);
  });

  it('returns undefined for empty string', () => {
    expect(parseAmount('')).toBeUndefined();
  });

  it('returns undefined for just minus sign', () => {
    expect(parseAmount('-')).toBeUndefined();
  });

  it('returns undefined for just decimal point', () => {
    expect(parseAmount('.')).toBeUndefined();
  });

  it('rounds result to cents', () => {
    expect(parseAmount('10.125')).toBe(10.13);
  });
});

describe('filterCurrencyInput', () => {
  it('strips commas', () => {
    expect(filterCurrencyInput('1,234.56')).toBe('1234.56');
  });

  it('strips letters', () => {
    expect(filterCurrencyInput('abc123')).toBe('123');
  });

  it('preserves minus and decimal', () => {
    expect(filterCurrencyInput('-100.50')).toBe('-100.50');
  });
});

describe('filterCalculatorInput', () => {
  it('allows arithmetic operators', () => {
    expect(filterCalculatorInput('10+20*3')).toBe('10+20*3');
  });

  it('normalizes multiplication symbols', () => {
    expect(filterCalculatorInput('10x5')).toBe('10*5');
  });

  it('normalizes division symbol', () => {
    expect(filterCalculatorInput('100÷5')).toContain('/');
  });
});

describe('hasCalculatorOperators', () => {
  it('returns true for expressions with operators', () => {
    expect(hasCalculatorOperators('10+20')).toBe(true);
    expect(hasCalculatorOperators('10*5')).toBe(true);
  });

  it('returns false for plain numbers', () => {
    expect(hasCalculatorOperators('123.45')).toBe(false);
  });

  it('returns false for negative numbers (leading minus)', () => {
    expect(hasCalculatorOperators('-50')).toBe(false);
  });
});

describe('evaluateExpression', () => {
  it('evaluates basic addition', () => {
    expect(evaluateExpression('10+20')).toBe(30);
  });

  it('evaluates subtraction', () => {
    expect(evaluateExpression('100-30')).toBe(70);
  });

  it('evaluates multiplication', () => {
    expect(evaluateExpression('10*5')).toBe(50);
  });

  it('evaluates division', () => {
    expect(evaluateExpression('100/4')).toBe(25);
  });

  it('evaluates parentheses', () => {
    expect(evaluateExpression('(10+20)*3')).toBe(90);
  });

  it('rounds result to cents', () => {
    expect(evaluateExpression('10/3')).toBe(3.33);
  });

  it('returns undefined for empty input', () => {
    expect(evaluateExpression('')).toBeUndefined();
  });

  it('returns undefined for invalid expression', () => {
    expect(evaluateExpression('abc')).toBeUndefined();
  });

  it('returns undefined for division by zero', () => {
    expect(evaluateExpression('1/0')).toBeUndefined();
  });

  it('returns undefined for unbalanced parentheses', () => {
    expect(evaluateExpression('(10+20')).toBeUndefined();
    expect(evaluateExpression('10+20)')).toBeUndefined();
  });

  it('handles multiplication symbol normalization', () => {
    expect(evaluateExpression('10x5')).toBe(50);
  });

  it('strips commas before evaluation', () => {
    expect(evaluateExpression('1,000+500')).toBe(1500);
  });

  it('handles negative numbers', () => {
    expect(evaluateExpression('-50')).toBe(-50);
    expect(evaluateExpression('-10+20')).toBe(10);
  });

  it('handles nested parentheses', () => {
    expect(evaluateExpression('((2+3)*4)')).toBe(20);
  });

  it('handles unary minus in parentheses', () => {
    expect(evaluateExpression('(-5)*2')).toBe(-10);
  });

  it('returns undefined for code injection attempts', () => {
    expect(evaluateExpression('alert(1)')).toBeUndefined();
    expect(evaluateExpression('process.exit()')).toBeUndefined();
    expect(evaluateExpression('require("fs")')).toBeUndefined();
    expect(evaluateExpression('constructor.constructor("return this")()')).toBeUndefined();
  });

  it('returns undefined for property access attempts', () => {
    expect(evaluateExpression('this.constructor')).toBeUndefined();
    expect(evaluateExpression('[].constructor')).toBeUndefined();
  });

  it('respects operator precedence', () => {
    expect(evaluateExpression('2+3*4')).toBe(14);
    expect(evaluateExpression('10-2*3')).toBe(4);
  });

  it('handles unary plus', () => {
    expect(evaluateExpression('+5')).toBe(5);
    expect(evaluateExpression('+10+20')).toBe(30);
  });

  it('returns undefined for non-finite result', () => {
    // 10^309 exceeds Number.MAX_VALUE, parseFloat returns Infinity
    expect(evaluateExpression('1' + '0'.repeat(309))).toBeUndefined();
  });
});

describe('parseAmount – additional edge cases', () => {
  it('returns undefined when filtered string produces NaN (e.g. multiple dots)', () => {
    // '..' passes the empty/'.'/ '-' checks but parseFloat('..') = NaN
    expect(parseAmount('..')).toBeUndefined();
    expect(parseAmount('..5')).toBeUndefined();
  });
});

describe('adaptiveFractionDigits', () => {
  it('keeps the base precision for values that show a figure at 2dp', () => {
    expect(adaptiveFractionDigits(1234.56)).toBe(2);
    expect(adaptiveFractionDigits(0.01)).toBe(2);
    expect(adaptiveFractionDigits(0.005)).toBe(2); // rounds to 0.01
  });

  it('keeps the base precision for zero', () => {
    expect(adaptiveFractionDigits(0)).toBe(2);
  });

  it('expands precision for sub-penny values that would read as 0.00', () => {
    // 0.000318 GBP (0.0318 GBX) -> 6 places reveals the real figure.
    expect(adaptiveFractionDigits(0.000318)).toBe(6);
    expect(adaptiveFractionDigits(0.000342)).toBe(6);
    expect(adaptiveFractionDigits(0.0042)).toBe(5);
  });

  it('handles negative values by magnitude', () => {
    expect(adaptiveFractionDigits(-0.000318)).toBe(6);
  });

  it('caps at maxDigits', () => {
    expect(adaptiveFractionDigits(0.00000001)).toBe(6);
    expect(adaptiveFractionDigits(0.00000001, 2, 8)).toBe(8);
  });

  it('respects a non-2 base precision (e.g. JPY=0)', () => {
    expect(adaptiveFractionDigits(123, 0)).toBe(0); // already non-zero at 0dp
    expect(adaptiveFractionDigits(0.4, 0)).toBe(3); // expands to ~3 significant figures
  });
});

describe('formatSignedPercent', () => {
  it('adds a leading + for positive values', () => {
    expect(formatSignedPercent(12.5)).toBe('+12.50%');
  });

  it('keeps the minus sign for negative values', () => {
    expect(formatSignedPercent(-3.4)).toBe('-3.40%');
  });

  it('treats zero as positive (+0.00%)', () => {
    expect(formatSignedPercent(0)).toBe('+0.00%');
  });

  it('honours the decimals option', () => {
    expect(formatSignedPercent(7.1234, { decimals: 1 })).toBe('+7.1%');
    expect(formatSignedPercent(7.1, { decimals: 0 })).toBe('+7%');
  });

  it('multiplies fractions when alreadyPercent is false', () => {
    expect(formatSignedPercent(0.125, { alreadyPercent: false })).toBe('+12.50%');
    expect(formatSignedPercent(-0.05, { alreadyPercent: false })).toBe('-5.00%');
  });

  it('renders a sign-less 0 for non-finite input', () => {
    expect(formatSignedPercent(NaN)).toBe('0.00%');
    expect(formatSignedPercent(Infinity)).toBe('0.00%');
  });

  it('rounds half away from zero before formatting', () => {
    expect(formatSignedPercent(2.345, { decimals: 2 })).toBe('+2.35%');
  });
});

describe('gainLossColor', () => {
  it('returns green classes for non-negative values', () => {
    expect(gainLossColor(0)).toBe('text-green-600 dark:text-green-400');
    expect(gainLossColor(10)).toBe('text-green-600 dark:text-green-400');
  });

  it('returns red classes for negative values', () => {
    expect(gainLossColor(-1)).toBe('text-red-600 dark:text-red-400');
  });
});

describe('balanceColor', () => {
  it('returns neutral body classes for non-negative balances', () => {
    expect(balanceColor(0)).toBe('text-gray-900 dark:text-gray-100');
    expect(balanceColor(250)).toBe('text-gray-900 dark:text-gray-100');
  });

  it('returns red classes for negative balances', () => {
    expect(balanceColor(-0.01)).toBe('text-red-600 dark:text-red-400');
    expect(balanceColor(-1500)).toBe('text-red-600 dark:text-red-400');
  });
});
