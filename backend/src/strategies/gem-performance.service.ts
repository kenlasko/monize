import { Injectable } from "@nestjs/common";
import { roundToDecimals } from "../common/round.util";
import { todayYMD } from "../common/date-utils";
import { GemAssetRole } from "./entities/gem-strategy-asset.entity";
import {
  GEM_PP_DECIMALS,
  PricePoint,
  addMonthsUtc,
  parseYmd,
  daysBetween,
  pointAsOf,
} from "./gem-momentum.util";
import {
  GemPriceService,
  rangeMonths,
  rangeSampling,
} from "./gem-price.service";
import {
  GemCurrentPortfolioSimulation,
  GemPerformancePoint,
  GemPerformanceView,
  GemRange,
} from "./gem-report.types";

/** One security the accounts hold now, as the simulation needs it. */
export interface GemSimulationHolding {
  securityId: string | null;
  symbol: string | null;
  /** Value today, in any one currency; null when it could not be priced. */
  marketValue: number | null;
  isCash: boolean;
}

/** The earliest date any price series is allowed to start from, for MAX. */
const MAX_RANGE_START = "1900-01-01";

/**
 * How far after the window start a series may begin before it counts as not
 * covering the window. Generous enough to absorb the sampling bucket and a
 * closed market at the window edge, tight enough to catch an ETF that simply
 * did not exist yet.
 */
const COVERAGE_TOLERANCE_DAYS: Record<"day" | "week" | "month", number> = {
  day: 10,
  week: 21,
  month: 45,
};

/**
 * How stale a close may be and still stand for a plotted date.
 *
 * Every line here carries each asset forward from its last known close, which
 * is deliberate: a market holiday in one country must not punch a hole in the
 * others' lines. Unbounded, though, the same mechanism draws a delisted fund as
 * a perfectly flat line across every month since its feed stopped, and reports
 * the level it stopped at as the window's return. That is a stale quote wearing
 * today's date -- the thing `BOUNDARY_LAG_DAYS` exists to refuse on the signal
 * path, and there is no reason the chart should be laxer than the signal.
 *
 * One sampling bucket plus a closed market, matching the coverage tolerances
 * above in size but answering a different question: those ask whether a series
 * *started* in time, these whether it is still running.
 */
const CARRY_FORWARD_DAYS: Record<"day" | "week" | "month", number> = {
  day: 10,
  week: 21,
  month: 45,
};

/** ISO date `days` after `date`. */
function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Builds the report's asset-performance series: every strategy asset rebased to
 * zero at the start of the window, so instruments with different price levels
 * and currencies compare on one axis.
 */
@Injectable()
export class GemPerformanceService {
  constructor(private priceService: GemPriceService) {}

  /** First date of the window, or the epoch floor for MAX. */
  private windowStart(range: GemRange, asOf: string): string {
    const months = rangeMonths(range);
    if (months === null) return MAX_RANGE_START;
    return addMonthsUtc(parseYmd(asOf), -months).toISOString().slice(0, 10);
  }

  /**
   * The close standing for `date` in this series, carried forward from the last
   * observation but only while that observation is still recent enough to speak
   * for the date. Null once it is not: an unknown level, not a flat line.
   */
  private carriedClose(
    prices: PricePoint[],
    date: string,
    sampling: "day" | "week" | "month",
  ): number | null {
    const point = pointAsOf(prices, date);
    if (!point) return null;
    return daysBetween(point.date, date) <= CARRY_FORWARD_DAYS[sampling]
      ? point.close
      : null;
  }

  /**
   * Rebase one series to its first observation in the window. Returns null when
   * the series has no usable base (no prices in range, or a non-positive first
   * close), which the caller reports as an asset with no data rather than a flat
   * zero line.
   */
  private rebase(
    prices: PricePoint[],
    sampling: "day" | "week" | "month",
  ): ((date: string) => number | null) | null {
    if (prices.length === 0) return null;
    const base = prices[0].close;
    if (!(base > 0)) return null;
    return (date: string) => {
      const close = this.carriedClose(prices, date, sampling);
      if (close === null) return null;
      return roundToDecimals((close / base - 1) * 100, GEM_PP_DECIMALS);
    };
  }

  /**
   * One point per observation date across all assets, each asset carried forward
   * from its last known close so a market holiday in one country does not punch
   * a hole in the others' lines.
   */
  async build(params: {
    range: GemRange;
    /** Role -> securityId for mapped roles only. */
    securityByRole: Map<GemAssetRole, string>;
    /** What the strategy accounts hold now, for the composition simulation. */
    holdings?: GemSimulationHolding[];
    asOf?: string;
    /** Whose reporting currency the closes are converted into. */
    userId: string;
  }): Promise<GemPerformanceView | null> {
    const { range, securityByRole, userId } = params;
    const asOf = params.asOf ?? todayYMD();
    const securityIds = [...securityByRole.values()];
    if (securityIds.length === 0) return null;

    const from = this.windowStart(range, asOf);
    const sampling = rangeSampling(range);
    // The simulation reads the same window at the same sampling, so its
    // securities ride along on the one query rather than opening a second.
    const held = (params.holdings ?? []).filter(
      (holding) => !holding.isCash && holding.securityId !== null,
    );
    const series = await this.priceService.loadSeries(
      [
        ...new Set([
          ...securityIds,
          ...held.map((holding) => holding.securityId as string),
        ]),
      ],
      from,
      sampling,
      undefined,
      userId,
    );

    const readers = new Map<GemAssetRole, (date: string) => number | null>();
    const dates = new Set<string>();
    const starts: string[] = [];
    let incomplete = false;

    for (const [role, securityId] of securityByRole) {
      const prices = series.get(securityId) ?? [];
      const reader = this.rebase(prices, sampling);
      if (!reader) {
        incomplete = true;
        continue;
      }
      readers.set(role, reader);
      starts.push(prices[0].date);
      for (const point of prices) dates.add(point.date);
    }

    if (readers.size === 0) return null;
    // A role with no prices at all leaves the comparison a line short.
    if (readers.size < securityByRole.size) incomplete = true;
    // So does a series that only starts mid-window: it is rebased to its own
    // later start, so its line understates the window and cannot be read
    // against the others without the caveat. MAX has no fixed start, so there
    // the yardstick is the earliest series rather than the requested date.
    const expectedStart =
      rangeMonths(range) === null
        ? starts.reduce((earliest, date) => (date < earliest ? date : earliest))
        : from;
    const latestAcceptableStart = addDays(
      expectedStart,
      COVERAGE_TOLERANCE_DAYS[sampling],
    );
    if (starts.some((date) => date > latestAcceptableStart)) incomplete = true;

    const orderedDates = [...dates].sort();
    const firstObservation = new Map<GemAssetRole, string>();
    for (const [role, securityId] of securityByRole) {
      const prices = series.get(securityId);
      if (prices?.length) firstObservation.set(role, prices[0].date);
    }
    const points: GemPerformancePoint[] = orderedDates.map((date) => {
      const values: Partial<Record<GemAssetRole, number | null>> = {};
      for (const [role, reader] of readers) {
        const value = reader(date);
        values[role] = value;
        // A hole after the series has begun is a stretch of the line nobody
        // observed. Only a late start is excused here -- that is the case the
        // start-coverage test above already reports, and re-reporting it would
        // say nothing new.
        if (value === null && date >= (firstObservation.get(role) as string)) {
          incomplete = true;
        }
      }
      return { date, values };
    });

    const lastDate = orderedDates[orderedDates.length - 1];
    const totals: Partial<Record<GemAssetRole, number | null>> = {};
    for (const [role, reader] of readers) {
      // The window's return, or nothing. A series whose feed stopped in March
      // is not up 20% over the year: it is up 20% to March and unknown since,
      // and the second half of that sentence is the half that matters.
      totals[role] = reader(lastDate);
    }

    const currentPortfolio = this.simulateCurrentComposition({
      held,
      series,
      dates: orderedDates,
      sampling,
    });

    return { range, points, totals, incomplete, currentPortfolio };
  }

  /**
   * Today's holdings, in today's proportions, replayed over the window.
   *
   *   securityIndex_i(t) = P_i(t) / P_i(t0)
   *   portfolioIndex(t)  = sum(w_i * securityIndex_i(t))
   *   returnPercent(t)   = (portfolioIndex(t) - 1) * 100
   *
   * `w_i` is the holding's share of today's market value and is struck once, at
   * `t0`. Nothing rebalances it afterwards: the line is what buy-and-hold from
   * the start of the window would have done, which is what makes it comparable
   * with the single-instrument lines beside it. The prices are the same
   * adjusted closes those lines use, in each instrument's own listing currency,
   * so no FX movement enters either.
   *
   * Three ways it declines to answer, and it says which:
   *
   * - nothing is held, so there is no composition to simulate;
   * - a holding has no current value, so its weight is unknown -- and equal
   *   weights would be an invention, not a fallback;
   * - a holding has no usable price history, so it cannot be replayed. The
   *   others are *not* renormalised into a line without it: that is a
   *   different portfolio, and it would be read as this one.
   */
  private simulateCurrentComposition(params: {
    held: GemSimulationHolding[];
    series: Map<string, PricePoint[]>;
    dates: string[];
    sampling: "day" | "week" | "month";
  }): GemCurrentPortfolioSimulation | null {
    const { held, series, dates, sampling } = params;
    const empty = (
      unavailableReason: GemCurrentPortfolioSimulation["unavailableReason"],
    ): GemCurrentPortfolioSimulation => ({
      points: [],
      totalReturnPercent: null,
      completeRange: false,
      startsOn: null,
      endsOn: null,
      stoppedBy: [],
      includedHoldings: [],
      unavailableReason,
    });

    if (held.length === 0) return empty("NO_HOLDINGS");
    if (held.some((holding) => holding.marketValue === null)) {
      return empty("UNKNOWN_CURRENT_VALUE");
    }
    const total = held.reduce(
      (sum, holding) => sum + (holding.marketValue as number),
      0,
    );
    if (!(total > 0)) return empty("UNKNOWN_CURRENT_VALUE");

    const legs = held.map((holding) => ({
      securityId: holding.securityId as string,
      symbol: holding.symbol,
      weight: (holding.marketValue as number) / total,
      prices: series.get(holding.securityId as string) ?? [],
    }));
    if (
      legs.some((leg) => leg.prices.length === 0 || !(leg.prices[0].close > 0))
    ) {
      return empty("MISSING_PRICE_HISTORY");
    }

    // The simulation opens on the first date every leg can be priced on, and
    // never before the chart's own first point.
    //
    // Both bounds matter. A holding listed halfway through the window must not
    // be carried backwards at its own first close, which would draw a flat
    // stretch nobody held. And a holding whose history runs *deeper* than the
    // plotted window must not set the base off-chart: rebasing to 1976 while
    // the chart starts in 1993 opens the dashed line at +700% instead of 0%,
    // reports the wrong window's return, and stretches the y-axis until every
    // asset line beside it is flat.
    const firstPlotted = dates[0];
    const lastPlotted = dates[dates.length - 1];
    if (!firstPlotted) return empty("MISSING_PRICE_HISTORY");
    const startsOn = legs
      .map((leg) => leg.prices[0].date)
      .reduce((latest, date) => (date > latest ? date : latest), firstPlotted);
    // Listed after the last point the chart draws: there is no segment to
    // show, and saying so is the difference between an explained absence and a
    // legend entry for a line that is not there.
    if (startsOn > lastPlotted) return empty("MISSING_PRICE_HISTORY");
    // The opening level, held to the same freshness rule as every later point:
    // a leg whose feed stopped years before the window opens has no base here,
    // and rebasing the whole simulation to that dead quote would price every
    // point after it off a number nobody struck.
    const bases = legs.map((leg) => ({
      ...leg,
      base: this.carriedClose(leg.prices, startsOn, sampling) as number,
    }));
    if (bases.some((leg) => !(leg.base > 0))) {
      return empty("MISSING_PRICE_HISTORY");
    }

    const points = dates.map((date) => {
      if (date < startsOn) return { date, returnPercent: null };
      let index = 0;
      for (const leg of bases) {
        const close = this.carriedClose(leg.prices, date, sampling);
        if (close === null) return { date, returnPercent: null };
        index += leg.weight * (close / leg.base);
      }
      return {
        date,
        returnPercent: roundToDecimals((index - 1) * 100, GEM_PP_DECIMALS),
      };
    });

    // A simulation that cannot get past its own opening is not a simulation.
    //
    // Every leg can be based and still produce nothing after that. A feed that
    // stops before the window opens fails the freshness rule at every plotted
    // date, and `carriedClose` then returns null right across the range; a feed
    // that reaches only the opening leaves exactly one point, and that point is
    // 0% by construction -- the rebase, not a result. Both passed every check
    // above and came back with `unavailableReason: null`, which put "Today's
    // portfolio" in the legend over a line that was either absent or a single
    // dot on the zero axis, reading as "your portfolio returned nothing".
    //
    // Two priceable points is the least that can describe a change, so below
    // that the answer is the absence and its reason.
    const drawable = points.filter((point) => point.returnPercent !== null);
    if (drawable.length < 2) return empty("MISSING_PRICE_HISTORY");

    /**
     * Where the line stops, and which instrument stopped it.
     *
     * A point needs *every* leg priced -- a portfolio simulated from the legs
     * that happen to have data is a different portfolio -- so the line ends
     * with the first holding whose feed does. Ending is fine; ending without
     * saying why is not, and "why" here is a specific instrument the user can
     * go and fix, not a property of the chart.
     */
    const lastDrawn = drawable[drawable.length - 1].date;
    const brokeAt = points.find(
      (point) => point.date > lastDrawn && point.date >= startsOn,
    );
    const stoppedBy = brokeAt
      ? bases
          .filter(
            (leg) =>
              this.carriedClose(leg.prices, brokeAt.date, sampling) === null,
          )
          .map((leg) => leg.symbol)
          .filter((symbol): symbol is string => !!symbol)
      : [];

    // The return over the window, which means the value at the *end* of it.
    //
    // Taking the last point that happened to be priceable answered a different
    // question and labelled it with this one: a holding whose feed stopped four
    // months ago reported the return to the day it stopped as the return to
    // today, with nothing marking the difference.
    const closing = points[points.length - 1]?.returnPercent ?? null;
    return {
      points,
      totalReturnPercent: closing,
      // Complete means covering the chart from end to end. The start is
      // measured against the chart's own first point, not the requested
      // window: when the strategy's instruments are what cut the window short,
      // every line starts there and the simulation is as complete as the chart
      // can be -- blaming the user's holdings for it printed "at least one of
      // the instruments you hold now has no data from the start of the period"
      // over a holding priced from the very first day.
      completeRange:
        startsOn <= addDays(firstPlotted, COVERAGE_TOLERANCE_DAYS[sampling]) &&
        points.every(
          (point) => point.date < startsOn || point.returnPercent !== null,
        ),
      startsOn,
      // Only when it really is early: the last plotted date is where a
      // complete line is expected to finish, and saying "ends on" there would
      // be a caveat about nothing.
      endsOn: lastDrawn < lastPlotted ? lastDrawn : null,
      stoppedBy,
      includedHoldings: bases.map((leg) => ({
        securityId: leg.securityId,
        symbol: leg.symbol,
        weightPercent: roundToDecimals(leg.weight * 100, 2),
      })),
      unavailableReason: null,
    };
  }
}
