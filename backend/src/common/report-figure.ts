import { EntityManager } from "typeorm";
import { loadCurrencyDecimalPlaces } from "../currencies/currency-decimal-places";
import { decimalPlacesFor } from "./format-currency.util";
import { MONEY_SCALE, roundMoney } from "./round.util";

/**
 * A report figure as it leaves the server: its calculated value rounded once,
 * at `places`, the reporting currency's own (2 for USD, 0 for JPY, a coin's up
 * to eight), half away from zero for both signs.
 *
 * The output precision of `docs/specs/report-rounding-and-aggregation.md`
 * (section 2), decided in its section 6: a figure that left at four places and
 * was rounded again at two on the screen went through two roundings in series,
 * so 2.50498 left as 2.5050 and showed as 2.51 where rounding once gives 2.50.
 * Rounded here, the screen's rounding is the identity and the CSV, the PDF and
 * the assistant read the figure the screen shows.
 *
 * For a figure that is not an aggregate (a mean, one converted row, a sum the
 * database worked out in the reporting currency); an `FxAggregate` reads
 * `knownSubtotalAt(places)` / `totalAt(places)`, the same rounding of its
 * accumulated sum. Never for a posted amount, a price, a quantity, a rate or a
 * percentage, which keep their own precision.
 */
export function reportFigure(value: number, places: number): number {
  return roundMoney(value, places);
}

/** {@link reportFigure} of a figure that may be unknown, `null` kept. */
export function reportFigureOrNull(
  value: number | null,
  places: number,
): number | null {
  return value === null ? null : reportFigure(value, places);
}

/**
 * The places a report figure in `code` leaves the server at: the places the
 * screen formats it at (`useNumberFormat().formatCurrency`), so rounding it
 * again there changes nothing. That is the ISO minor unit for an ISO 4217
 * code, else the currency row's `decimal_places` (`currencies` maps a non-ISO
 * code to it, as `loadCurrencyDecimalPlaces` loads it), else 2; never more
 * than `MONEY_SCALE`, the column scale.
 */
export function reportPlacesFor(
  code: string,
  currencies: ReadonlyMap<string, number>,
): number {
  return Math.min(MONEY_SCALE, decimalPlacesFor(code, currencies));
}

/**
 * {@link reportPlacesFor} of `code`, its row read on `manager` when it is not
 * an ISO code (an ISO code needs no read), for a report figure computed
 * outside `ReportCurrencyService` (`getReportPlaces`).
 */
export async function loadReportPlaces(
  manager: EntityManager,
  code: string,
): Promise<number> {
  return reportPlacesFor(
    code,
    await loadCurrencyDecimalPlaces(manager, [code]),
  );
}
