import { describe, it, expect } from 'vitest';
import { labelWithForeignCurrency } from './default-currency';

describe('labelWithForeignCurrency', () => {
  it('leaves the code off a label in the default currency', () => {
    expect(labelWithForeignCurrency('Chequing', 'CAD', 'CAD')).toBe('Chequing');
  });

  it('brackets the code of any other currency', () => {
    expect(labelWithForeignCurrency('US Savings', 'USD', 'CAD')).toBe('US Savings (USD)');
  });

  it('shows the code when no default is known', () => {
    expect(labelWithForeignCurrency('Chequing', 'CAD', undefined)).toBe('Chequing (CAD)');
  });

  it('adds nothing for a missing code', () => {
    expect(labelWithForeignCurrency('Chequing', '', 'CAD')).toBe('Chequing');
  });
});
