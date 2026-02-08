import { describe, it, expect } from 'vitest';
import {
  getCurrencySymbol,
  formatCurrency,
  roundToCents,
  formatAmount,
  formatAmountWithCommas,
  parseAmount,
  filterCurrencyInput,
  filterCalculatorInput,
  hasCalculatorOperators,
  evaluateExpression,
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

  it('handles negative values', () => {
    expect(roundToCents(-10.125)).toBe(-10.12);
  });

  it('handles zero', () => {
    expect(roundToCents(0)).toBe(0);
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
});

describe('formatAmountWithCommas', () => {
  it('adds comma separators', () => {
    expect(formatAmountWithCommas(1234567.89)).toBe('1,234,567.89');
  });

  it('returns empty string for undefined', () => {
    expect(formatAmountWithCommas(undefined)).toBe('');
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
});
