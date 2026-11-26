import { describe, it, expect } from 'vitest';
import { isProvisionalAmount } from './provisional-amount';

describe('isProvisionalAmount', () => {
  it('is true only for a row flagged provisional', () => {
    expect(isProvisionalAmount({ amountIsProvisional: true })).toBe(true);
  });

  it('reads a confirmed row, an absent field and no row as not provisional', () => {
    expect(isProvisionalAmount({ amountIsProvisional: false })).toBe(false);
    expect(isProvisionalAmount({})).toBe(false);
    expect(isProvisionalAmount(null)).toBe(false);
    expect(isProvisionalAmount(undefined)).toBe(false);
  });
});
