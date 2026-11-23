import { describe, it, expect } from 'vitest';
import { autoRefreshSecurityIds, isTradingNow } from './price-auto-refresh';
import type { Security } from '@/types/investment';

const sec = (id: string, overrides: Partial<Security> = {}): Security =>
  ({
    id,
    symbol: id.toUpperCase(),
    name: id,
    securityType: 'STOCK',
    exchange: 'NYSE',
    currencyCode: 'USD',
    isActive: true,
    skipPriceUpdates: false,
    bondProgramId: null,
    marketTimezone: null,
    marketOpenTime: null,
    marketCloseTime: null,
    ...overrides,
  }) as Security;

const NYSE_SESSION = {
  marketTimezone: 'America/New_York',
  marketOpenTime: '09:30:00',
  marketCloseTime: '16:00:00',
};
const LSE_SESSION = {
  marketTimezone: 'Europe/London',
  marketOpenTime: '08:00:00',
  marketCloseTime: '16:30:00',
};

/** 2026-07-30 is a Thursday; the times are UTC. */
const thursday = (utc: string) => new Date(`2026-07-30T${utc}Z`);
/** 2026-08-01, a Saturday. */
const saturday = (utc: string) => new Date(`2026-08-01T${utc}Z`);

describe('isTradingNow', () => {
  it('follows the session the provider reported, in its own zone', () => {
    // 09:00 UTC is 10:00 London and 05:00 New York.
    expect(isTradingNow(sec('l', LSE_SESSION), thursday('09:00:00'))).toBe(true);
    expect(isTradingNow(sec('n', NYSE_SESSION), thursday('09:00:00'))).toBe(false);
    // 18:00 UTC is 14:00 New York and 19:00 London.
    expect(isTradingNow(sec('n', NYSE_SESSION), thursday('18:00:00'))).toBe(true);
    expect(isTradingNow(sec('l', LSE_SESSION), thursday('18:00:00'))).toBe(false);
  });

  it('is never trading at the weekend for a session-bound market', () => {
    expect(isTradingNow(sec('n', NYSE_SESSION), saturday('15:00:00'))).toBe(false);
  });

  it('is always trading for a coin: every hour, every day', () => {
    // Yahoo reports a coin's session as the UTC day, which the weekday rule
    // in getMarketState would call closed on a Saturday.
    const coin = sec('btc', {
      securityType: 'CRYPTO',
      marketTimezone: 'UTC',
      marketOpenTime: '00:00:00',
      marketCloseTime: '23:59:00',
    });
    expect(isTradingNow(coin, saturday('03:00:00'))).toBe(true);
    expect(isTradingNow(coin, thursday('23:59:30'))).toBe(true);
    expect(isTradingNow(sec('eth', { securityType: 'CRYPTO' }), saturday('12:00:00'))).toBe(true);
  });

  it('falls back to the New York regular session when no session is on record', () => {
    // 14:00 UTC is 10:00 New York; 13:00 UTC is 09:00, before the open.
    expect(isTradingNow(sec('msn'), thursday('14:00:00'))).toBe(true);
    expect(isTradingNow(sec('msn'), thursday('13:00:00'))).toBe(false);
    expect(isTradingNow(sec('msn'), thursday('20:00:00'))).toBe(false);
    expect(isTradingNow(sec('msn'), saturday('15:00:00'))).toBe(false);
  });
});

describe('autoRefreshSecurityIds', () => {
  it('asks only for the securities whose market is trading now', () => {
    const ids = autoRefreshSecurityIds(
      [
        sec('nyse', NYSE_SESSION),
        sec('lse', LSE_SESSION),
        sec('btc', { securityType: 'CRYPTO' }),
      ],
      // 10:00 London, 05:00 New York.
      thursday('09:00:00'),
    );
    expect(ids).toEqual(['lse', 'btc']);
  });

  it('asks only for coins at the weekend', () => {
    const ids = autoRefreshSecurityIds(
      [sec('nyse', NYSE_SESSION), sec('msn'), sec('btc', { securityType: 'CRYPTO' })],
      saturday('15:00:00'),
    );
    expect(ids).toEqual(['btc']);
  });

  it('leaves out inactive and update-disabled securities', () => {
    const ids = autoRefreshSecurityIds(
      [
        sec('on', { securityType: 'CRYPTO' }),
        sec('inactive', { securityType: 'CRYPTO', isActive: false }),
        sec('disabled', { securityType: 'CRYPTO', skipPriceUpdates: true }),
      ],
      thursday('14:00:00'),
    );
    expect(ids).toEqual(['on']);
  });

  it('never asks for a bond-linked security (INV-BOND-008)', () => {
    // Its refresh fetches the issuer's current offer, which only a person may
    // ask for, and no market session moves the engine's price.
    const ids = autoRefreshSecurityIds(
      [sec('stock', NYSE_SESSION), sec('edo', { securityType: 'BOND', bondProgramId: 'p-1' })],
      thursday('14:00:00'),
    );
    expect(ids).toEqual(['stock']);
  });
});
