import type {
  DailyInvestmentValue,
  DailyInvestmentsWithPositions,
} from "./net-worth.service";

/**
 * The daily series as a report reads it: each day's `value` and
 * `securitiesValue` rounded once at `places`, the display currency's own, from
 * the day's own aggregates (`docs/specs/report-rounding-and-aggregation.md`
 * section 6), never from the four-place figures the period result's P&L, TWR
 * and MWR are worked out from. `keep`, when given, names the days to read (a
 * sampled chart's).
 */
export function dailyInvestmentsAtPlaces(
  loaded: Pick<DailyInvestmentsWithPositions, "series" | "readings">,
  places: number,
  keep?: ReadonlySet<string>,
): DailyInvestmentValue[] {
  return loaded.series.flatMap((point, i) =>
    keep && !keep.has(point.date)
      ? []
      : [
          {
            ...point,
            value: loaded.readings[i].value.knownSubtotalAt(places),
            securitiesValue:
              loaded.readings[i].securitiesValue.knownSubtotalAt(places),
          },
        ],
  );
}
