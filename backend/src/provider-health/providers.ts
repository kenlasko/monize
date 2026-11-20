/**
 * The outbound providers whose availability is tracked.
 *
 * Mostly market data, plus Google Places, which answers the payee contact
 * lookup. The lookup is a user-facing request rather than a background price
 * refresh, but the reason for a breaker is the same: a dead upstream must not
 * be called once per payee across a whole deployment. Enable Banking is the
 * bank-sync aggregator: the daily sync calls it once per linked bank account
 * for every user, the same fan-out shape. Frankfurter (its v2 API, id
 * `frankfurter_v2`) is the first exchange rate provider on the chain: the daily
 * refresh asks it once per base currency for every pair in use, and a gap fill
 * once per window. NBP and GUS
 * publish the benchmark series (reference rate, CPI) that bond valuations read;
 * obligacjeskarbowe.pl publishes the Polish retail bond series terms that a
 * series fetch reads; TreasuryDirect publishes the auction terms and results of
 * the US Treasury securities that a series fetch reads; the Bureau of Labor
 * Statistics publishes the CPI-U levels that Treasury inflation-protected
 * securities read.
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
  frankfurter_v2: "Frankfurter",
  nbp: "Narodowy Bank Polski",
  gus: "Główny Urząd Statystyczny",
  obligacjeskarbowe: "Obligacje skarbowe (obligacjeskarbowe.pl)",
  treasurydirect: "TreasuryDirect (treasurydirect.gov)",
  bls: "U.S. Bureau of Labor Statistics (api.bls.gov)",
} as const;

export type TrackedProviderId = keyof typeof TRACKED_PROVIDERS;

/** The human name for a provider id, or the id itself for an unknown one. */
export function providerLabel(provider: string): string {
  return (
    (TRACKED_PROVIDERS as Record<string, string | undefined>)[provider] ??
    provider
  );
}

/**
 * How long a provider must have been failing before the outage alert
 * (`ProviderOutageAlertService`) emails anybody.
 *
 * The breaker opens after five consecutive transport failures, which a five
 * second blip can produce; nobody wants mail about that. Fifteen minutes is
 * "this is not going to fix itself before you notice", and it is measured from
 * the durable `outage_started_at`, so a container restarting inside the outage
 * does not reset the clock (issue #1265: the restart loop was a symptom).
 *
 * "Failing for fifteen minutes" has to be *observed*, not inferred from the
 * row still saying `down`: the state only changes when a call is made, so a
 * burst that fails once and is followed by silence stays `down` forever. That
 * is exactly what a PC waking from sleep produces -- the overdue price and FX
 * jobs fire in the same second the network comes back, every lookup fails with
 * `ENOTFOUND`, and nothing calls the provider again until somebody opens the
 * app. So the claim also requires a failure recorded at least this long after
 * the episode began (`last_failure_at >= outage_started_at + MIN_OUTAGE_MS`).
 * A provider that is genuinely down keeps failing every probe, so it still
 * qualifies -- at the first failure fifteen minutes in.
 */
export const MIN_OUTAGE_MS = 15 * 60_000;
