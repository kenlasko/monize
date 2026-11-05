import {
  pointAsOf,
  PricePoint,
} from "../common/time-series/price-boundary.util";
import { positionClosePointAsOf } from "../net-worth/position-price.util";

/**
 * A bond-linked security's close on `date` itself, or null.
 *
 * The bond engine writes a row for every calendar day it can value the lots
 * (accrual moves every day, weekends included) and none for a day it refuses
 * -- a lot whose series is not determined, a started period without its
 * benchmark observation, a refused purchase -- deleting any older row there
 * (INV-BOND-002, INV-BOND-005). So a missing day is a refusal, not a quote the
 * market did not print: carrying the previous engine close over it prices
 * lots the engine cannot value, and a transaction price is one lot's trade
 * price, never the holding's value. Only the accepted store is read (the
 * engine's own rows and a manual correction), and only on the day.
 */
export function bondEngineClosePointOn(
  stored: PricePoint[] | undefined,
  date: string,
): PricePoint | null {
  const point = stored && stored.length > 0 ? pointAsOf(stored, date) : null;
  return point && point.date === date ? point : null;
}

/**
 * The close a blend reader values a held position at on `date` -- the one
 * rule for every daily or monthly series that multiplies a quantity by a
 * stored close (A26-M26, INV-BOND-010).
 *
 * A bond-linked security (`bondProgramId` set) the engine prices is valued only
 * from the engine's row of that day: `bondEngineClosePointOn`. Null then means
 * the engine refused the day, and the reader reports the security unknown for
 * it (its `pricesComplete` / unpriced channel), never a carried close or a
 * trade price. A linked security that trades (`marketPriceRequired`) gets no
 * engine row at all: its price is the person's own, the one `bondHoldingValue`
 * values the holding at, so it is read like every other security. Every other
 * security keeps `positionClosePointAsOf`: the newest accepted close at or
 * before the day, merged with the legacy transaction fallback.
 */
export function valuationClosePointOn(
  security:
    | {
        readonly bondProgramId?: string | null;
        readonly marketPriceRequired?: boolean;
      }
    | null
    | undefined,
  stored: PricePoint[] | undefined,
  txFallback: PricePoint[] | undefined,
  date: string,
): PricePoint | null {
  return security?.bondProgramId && security.marketPriceRequired !== true
    ? bondEngineClosePointOn(stored, date)
    : positionClosePointAsOf(stored, txFallback, date);
}
