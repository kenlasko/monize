import { describe, expect, it } from 'vitest';
import { accountCarriesBalance } from './account-carries-balance';

describe('accountCarriesBalance', () => {
  it.each([
    [false, 0, true],
    [false, 125.5, true],
    [true, 250, true],
    [true, -42.1, true],
    [true, 0, false],
  ])('isClosed=%s currentBalance=%s -> %s', (isClosed, currentBalance, expected) => {
    expect(accountCarriesBalance({ isClosed, currentBalance })).toBe(expected);
  });

  it('reads a balance the API delivered as a decimal string', () => {
    expect(
      accountCarriesBalance({ isClosed: true, currentBalance: '0.0000' as unknown as number }),
    ).toBe(false);
    expect(
      accountCarriesBalance({ isClosed: true, currentBalance: '-0.0100' as unknown as number }),
    ).toBe(true);
  });
});
