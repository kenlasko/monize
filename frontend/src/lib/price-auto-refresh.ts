import { getMarketState, type MarketSession } from '@/lib/market-hours';
import type { QuoteProviderName, Security } from '@/types/investment';

/**
 * Which securities the open site refreshes on its own, and how often.
 *
 * A security is asked for only while its own market trades: a coin always
 * (it trades every hour of every day), any other security while the session
 * its provider reported is open. Only Yahoo reports one. A security priced by
 * an exchange's own feed (the London Stock Exchange, Deutsche Börse's Xetra)
 * trades during that exchange's session, which the provider names without
 * guessing. Anything else with no session on record (MSN, a web page, or a
 * security never refreshed yet) is asked for during the New York regular
 * session, the window the automatic refresh used for every security before
 * sessions were recorded. Guessing its hours from the exchange code instead
 * would be a confident wrong answer (`market-hours.ts`).
 */

/** How long the open site waits between two automatic refreshes. */
export const AUTO_PRICE_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/** The New York Stock Exchange's regular session, for a security with none on record. */
const US_REGULAR_SESSION: MarketSession = {
  timezone: 'America/New_York',
  openTime: '09:30:00',
  closeTime: '16:00:00',
};

/**
 * The regular session of a provider that is itself an exchange, as Yahoo
 * reports it for the same listings (`.L`, `.DE`). The provider override is the
 * only place the exchange is known for certain: with no override the security
 * is priced by the reader's default provider, which is never one of these.
 */
const EXCHANGE_PROVIDER_SESSIONS: Partial<Record<QuoteProviderName, MarketSession>> = {
  lse: { timezone: 'Europe/London', openTime: '08:00:00', closeTime: '16:30:00' },
  deutsche_boerse: { timezone: 'Europe/Berlin', openTime: '09:00:00', closeTime: '17:30:00' },
};

type TradingFields = Pick<
  Security,
  'securityType' | 'marketTimezone' | 'marketOpenTime' | 'marketCloseTime' | 'quoteProvider'
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
  const exchangeSession =
    (security.quoteProvider && EXCHANGE_PROVIDER_SESSIONS[security.quoteProvider]) ||
    US_REGULAR_SESSION;
  return getMarketState(exchangeSession, now) === 'open';
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
