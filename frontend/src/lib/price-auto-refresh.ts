import { getMarketState, type MarketSession } from '@/lib/market-hours';
import type { Security } from '@/types/investment';

/**
 * Which securities the open site refreshes on its own, and how often.
 *
 * A security is asked for only while its own market trades: a coin always
 * (it trades every hour of every day), any other security while the session
 * its provider reported is open. A security with no session on record (a
 * provider that reports none: MSN, the London Stock Exchange, Deutsche Börse,
 * a web page; or one never refreshed yet) is asked for during the New York
 * regular session, the window the automatic refresh used for every security
 * before sessions were recorded. Guessing its hours from the exchange code
 * instead would be a confident wrong answer (`market-hours.ts`).
 */

/** How long the open site waits between two automatic refreshes. */
export const AUTO_PRICE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** The New York Stock Exchange's regular session, for a security with none on record. */
const US_REGULAR_SESSION: MarketSession = {
  timezone: 'America/New_York',
  openTime: '09:30:00',
  closeTime: '16:00:00',
};

type TradingFields = Pick<
  Security,
  'securityType' | 'marketTimezone' | 'marketOpenTime' | 'marketCloseTime'
>;

/** Whether the security's market is trading at `now`, for the automatic refresh. */
export function isTradingNow(security: TradingFields, now: Date): boolean {
  if (security.securityType === 'CRYPTO') return true;
  const state = getMarketState(
    {
      timezone: security.marketTimezone,
      openTime: security.marketOpenTime,
      closeTime: security.marketCloseTime,
    },
    now,
  );
  if (state !== 'unknown') return state === 'open';
  return getMarketState(US_REGULAR_SESSION, now) === 'open';
}

/**
 * The ids an automatic refresh asks for at `now`.
 *
 * Only an active security without "Disable Automatic Updates"
 * (`skipPriceUpdates`, the backend's `isRefreshEligible`), and never one
 * linked to a bond program: its refresh fetches the issuer's current offer,
 * which only a person may ask for (INV-BOND-008), and its price is the bond
 * engine's daily recompute, which no market session moves.
 */
export function autoRefreshSecurityIds(
  securities: readonly Security[],
  now: Date,
): string[] {
  return securities
    .filter(
      (s) =>
        s.isActive &&
        !s.skipPriceUpdates &&
        !s.bondProgramId &&
        isTradingNow(s, now),
    )
    .map((s) => s.id);
}
