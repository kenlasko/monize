import { describe, expect, it } from 'vitest';
import { splitMoneyFigure } from './money-parts';

const join = (p: ReturnType<typeof splitMoneyFigure>) =>
  p.sign + p.prefix + p.whole + p.fraction + p.suffix;

describe('splitMoneyFigure', () => {
  it.each([
    ['$453,227.01', '.', { sign: '', prefix: '$', whole: '453,227', fraction: '.01', suffix: '' }],
    ['-$637.54', '.', { sign: '-', prefix: '$', whole: '637', fraction: '.54', suffix: '' }],
    ['−CA$1,000.00', '.', { sign: '−', prefix: 'CA$', whole: '1,000', fraction: '.00', suffix: '' }],
    ['1.234,56 €', ',', { sign: '', prefix: '', whole: '1.234', fraction: ',56', suffix: ' €' }],
    ['($12.50)', '.', { sign: '(', prefix: '$', whole: '12', fraction: '.50', suffix: ')' }],
    ['¥1,200', '.', { sign: '', prefix: '¥', whole: '1,200', fraction: '', suffix: '' }],
    ['₿0.0070', '.', { sign: '', prefix: '₿', whole: '0', fraction: '.0070', suffix: '' }],
  ])('splits %s', (input, decimal, expected) => {
    const parts = splitMoneyFigure(input, decimal);
    expect(parts).toEqual(expected);
    expect(join(parts)).toBe(input);
  });

  it('keeps a sign written after the symbol in the prefix, so the order survives', () => {
    const parts = splitMoneyFigure('$-5.00', '.');
    expect(parts.sign).toBe('');
    expect(parts.prefix).toBe('$-');
    expect(join(parts)).toBe('$-5.00');
  });

  it('does not take a group separator for the decimal one', () => {
    const parts = splitMoneyFigure('₹12,34,567', '.');
    expect(parts.whole).toBe('12,34,567');
    expect(parts.fraction).toBe('');
  });

  it('returns a figure without digits whole, as prefix', () => {
    expect(join(splitMoneyFigure('—', '.'))).toBe('—');
  });
});
