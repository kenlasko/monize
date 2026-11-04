/**
 * The outbound providers whose availability is tracked.
 *
 * Mostly market data, plus Google Places, which answers the payee contact
 * lookup. The lookup is a user-facing request rather than a background price
 * refresh, but the reason for a breaker is the same: a dead upstream must not
 * be called once per payee across a whole deployment. Enable Banking is the
 * bank-sync aggregator: the daily sync calls it once per linked bank account
 * for every user, the same fan-out shape. Frankfurter is the first exchange
 * rate provider on the chain: the daily refresh asks it once per base
 * currency for every pair in use, and a gap fill once per window. NBP and GUS
 * publish the benchmark series (reference rate, CPI) that bond valuations read;
 * obligacjeskarbowe.pl publishes the Polish retail bond series terms that a
 * series fetch reads; TreasuryDirect publishes the auction terms and results of
 * the US Treasury securities that a series fetch reads.
 *
 * The id is what goes in `provider_health.provider` and must stay stable -- it
 * is the primary key of the durable notification state, so renaming one starts
 * a fresh outage episode and could re-send an alert. The label is what an
 * operator reads in an email.
 */
export const TRACKED_PROVIDERS = {
  yahoo_finance: "Yahoo Finance",
  msn_finance: "MSN Finance",
  lse: "London Stock Exchange",
  deutsche_boerse: "Deutsche Börse",
  google_places: "Google Places",
  enable_banking: "Enable Banking",
  simplefin: "SimpleFIN Bridge",
  frankfurter: "Frankfurter",
  nbp: "Narodowy Bank Polski",
  gus: "Główny Urząd Statystyczny",
  obligacjeskarbowe: "Obligacje skarbowe (obligacjeskarbowe.pl)",
  treasurydirect: "TreasuryDirect (treasurydirect.gov)",
} as const;

export type TrackedProviderId = keyof typeof TRACKED_PROVIDERS;

/** The human name for a provider id, or the id itself for an unknown one. */
export function providerLabel(provider: string): string {
  return (
    (TRACKED_PROVIDERS as Record<string, string | undefined>)[provider] ??
    provider
  );
}
