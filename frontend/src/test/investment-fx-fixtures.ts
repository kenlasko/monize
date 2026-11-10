/**
 * The server's per-row conversion figures, for fixtures written before the
 * server sent them (issue #2106). A row or entry that states its own keeps it;
 * anything else reads as a reader in `currency` whose rows are already in it
 * (a factor of 1), which is what the identity `convert` mocks these specs used
 * to stand in for.
 */

type Row = Record<string, unknown>;

/** Default `reportingCurrencyCode` / `reportingRate` / `accountRate` on each row. */
export function withRowFactors<T>(response: T, currency = 'CAD'): T {
  const stamp = (row: Row): Row => ({
    reportingCurrencyCode: currency,
    reportingRate: 1,
    accountRate: 1,
    ...row,
  });
  if (Array.isArray(response)) return response.map(stamp) as T;
  if (response && typeof response === 'object' && Array.isArray((response as Row).data)) {
    return { ...(response as Row), data: ((response as Row).data as Row[]).map(stamp) } as T;
  }
  return response;
}

/** Default `inReportingCurrency` on each capital-gain entry: its own figures. */
export function withCapitalGainReporting<T>(entries: T, currency = 'CAD'): T {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry: Row) => ({
    inReportingCurrency: {
      currency,
      startValue: entry.startValue ?? null,
      endValue: entry.endValue ?? null,
      realizedGain: entry.realizedGain ?? null,
      realizedGainKnownSubtotal: entry.realizedGainKnownSubtotal ?? null,
      unrealizedGain: entry.unrealizedGain ?? null,
      totalCapitalGain: entry.totalCapitalGain ?? null,
    },
    ...entry,
  })) as T;
}
