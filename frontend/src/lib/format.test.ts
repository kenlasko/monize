import { describe, it, expect } from 'vitest';
import {
  getCurrencySymbol,
  formatCurrency,
  getDecimalPlacesForCurrency,
  roundToDecimals,
  roundToCents,
  adaptiveFractionDigits,
  formatAmount,
  formatAmountWithCommas,
  parseAmount,
  filterCurrencyInput,
  filterCalculatorInput,
  hasCalculatorOperators,
  evaluateExpression,
  formatRelativeTime,
  formatShareQuantity,
} from './format';

describe('getCurrencySymbol', () => {
  it('returns $ for USD', () => {
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

describe('formatRelativeTime', () => {
  it('returns "Never" for null', () => {
    expect(formatRelativeTime(null)).toBe('Never');
  });

  it('returns "Just now" for very recent times', () => {
    const now = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelativeTime(now)).toBe('Just now');
  });

  it('returns minutes-ago format for recent times', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatRelativeTime(fiveMinAgo)).toBe('5m ago');
  });

  it('returns hours-ago format for hours-old times', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago');
  });

  it('returns "Yesterday" for one-day-old times', () => {
    const yesterday = new Date(Date.now() - 24 * 3_600_000 - 1_000).toISOString();
    expect(formatRelativeTime(yesterday)).toBe('Yesterday');
  });

  it('returns d-ago for times within the last week', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago');
  });

  it('returns locale date for older times', () => {
    const monthAgo = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    const result = formatRelativeTime(monthAgo);
    // Should not match relative format
    expect(result).not.toMatch(/Just now|m ago|h ago|Yesterday|d ago/);
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
