/**
 * Whether a quote provider may price this security.
 *
 * A security linked to a bond instrument (`bondProgramId`) is priced by the
 * bond engine only (`bonds/bond-price.service.ts`): Yahoo and MSN are not a
 * source of retail bond terms or values, and a provider quote written beside the
 * engine's would be a second answer to one question. This is the single
 * predicate every path that asks a provider for a quote, a bar, a window or an
 * intraday series consults (INV-BOND-005); `provider-priced.guard.spec.ts` fails
 * when one of them stops.
 *
 * Read by shape, not by entity, so a raw row or a partial selection works too.
 * An absent `bondProgramId` (a row from a deployment that predates the
 * column) is "not linked".
 */
export function isPricedByQuoteProvider(security: {
  readonly bondProgramId?: string | null;
}): boolean {
  return !security.bondProgramId;
}

/**
 * A security linked to a bond instrument is never eligible: the bond engine is
 * its only automatic price source (`isPricedByQuoteProvider`, INV-BOND-005).
 * Otherwise a security is eligible for an automatic quote-provider fetch --
 * scheduled refresh, backfill or an intraday chart -- only when
 * `skipPriceUpdates` is false. The flag is the user's own switch (the security
 * form's "disable automatic price updates"), and imports set it on the
 * securities whose symbol they invented. A per-security provider override or
 * MSN Instrument ID does not override it: choosing one clears the flag at
 * write time (`SecuritiesService.update`), so a security that still carries
 * the flag is one the user has asked not to be fetched.
 */
export function isRefreshEligible(security: {
  readonly skipPriceUpdates: boolean;
  readonly bondProgramId?: string | null;
}): boolean {
  if (!isPricedByQuoteProvider(security)) return false;
  return !security.skipPriceUpdates;
}
