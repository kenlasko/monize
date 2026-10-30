import { Injectable } from "@nestjs/common";
import { todayYMD } from "../common/date-utils";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import {
  GemPriceService,
  PRICE_WINDOW_LEAD_DAYS,
  withLeadDays,
} from "./gem-price.service";
import {
  GemBacktestPeriod,
  GemBacktestResult,
  runBacktest,
} from "./gem-backtest.util";
import { GemCadence } from "./entities/gem-strategy.entity";
import { addMonthsUtc, cadenceMonths, parseYmd } from "./gem-momentum.util";

/**
 * Turns the stored signal history into the report's backtest summary.
 *
 * The simulation replays the evaluations the strategy actually produced, so the
 * summary is bounded by how long the strategy has been running -- there is no
 * synthetic history, and a strategy configured last month reports a month.
 * That is the honest answer: re-deriving signals for years the user never ran
 * would report a rule's past, not theirs.
 */
/**
 * The evaluated periods with the calendar's own gaps put back.
 *
 * `runBacktest` bounds each period by the next one in the list, so a period
 * missing from the list is not skipped -- it is absorbed into its predecessor.
 * A placeholder with no instrument prices to null, which is exactly how the
 * simulation already handles a period it cannot value: the run restarts after
 * the last one and the coverage figure says how much was left out.
 */
function withMissingPeriods(
  evaluated: GemBacktestPeriod[],
  cadence: GemCadence,
  asOf: string,
): GemBacktestPeriod[] {
  const step = cadenceMonths(cadence);
  const filled: GemBacktestPeriod[] = [];
  for (const [index, period] of evaluated.entries()) {
    filled.push(period);
    // The tail counts too. A calendar period after the last evaluated one --
    // an evaluation this configuration cannot answer for, or one whose prices
    // went stale -- is otherwise absorbed into its predecessor, which then
    // runs its instrument through a month the strategy decided differently and
    // still reports full coverage.
    const next = evaluated[index + 1] ?? { effectiveFrom: asOf };
    let expected = ymd(addMonthsUtc(parseYmd(period.effectiveFrom), step));
    // Bounded by the next evaluated period, so a calendar change (or a
    // cadence the dates do not line up with) cannot spin here.
    while (expected < next.effectiveFrom) {
      filled.push({
        effectiveFrom: expected,
        targetRole: null,
        targetSecurityId: null,
        previousRole: period.targetRole,
      });
      expected = ymd(addMonthsUtc(parseYmd(expected), step));
    }
  }
  return filled;
}

/** ISO date of a UTC date, without the local-timezone round trip. */
function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class GemBacktestService {
  constructor(private priceService: GemPriceService) {}

  /**
   * Simulate the stored evaluations, or null when there is nothing to simulate.
   *
   * `notional` is the capital the strategy runs, used only to express the
   * configured per-trade commission as a drag on a unitless equity curve.
   */
  async build(params: {
    strategy: GemStrategy;
    /** Stored evaluations in any order; the simulation sorts them. */
    signals: GemStrategySignal[];
    /** The risk-off instrument, for the "beat the safe asset" comparison. */
    safeSecurityId: string | null;
    notional: number | null;
    /**
     * How many accounts the strategy is run in. A switch costs one order per
     * account, exactly as the live estimate counts them.
     */
    accountCount: number;
    /**
     * Whether the strategy evaluated anything before the oldest signal here.
     * Answered from the table by the caller, because the signals in hand are
     * bounded to the last `GEM_HISTORY_PERIODS` periods and cannot say.
     */
    hasEarlierSignals: boolean;
    asOf?: string;
  }): Promise<GemBacktestResult | null> {
    const {
      strategy,
      signals,
      safeSecurityId,
      notional,
      accountCount,
      hasEarlierSignals,
    } = params;
    const asOf = params.asOf ?? todayYMD();

    const evaluated = [...signals]
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
      .map((signal) => ({
        effectiveFrom: signal.effectiveFrom,
        targetRole: signal.targetRole,
        targetSecurityId: signal.targetSecurityId,
        // Carried through so the simulation can tell its first period apart
        // from the strategy's first allocation. The history is bounded to the
        // last `GEM_HISTORY_PERIODS` periods, so for any older strategy the
        // oldest signal here follows one nobody passed in -- and treating it
        // as an opening purchase charges a commission for a trade that never
        // happened and dates the tax basis to the edge of the visible window.
        previousRole: signal.previousRole,
      }));
    // One signal is enough: its period runs to `asOf`, so a strategy that
    // produced its first signal last month has a full month to simulate.
    if (evaluated.length === 0) return null;

    // A period this configuration could not answer for is a hole in the run,
    // not an absence of one.
    //
    // The signals handed in are the ones matching the current fingerprint and
    // algorithm version, so a month answered only by a legacy row, or not
    // answered at all, is simply missing from the list -- and a period bounded
    // by "the next one supplied" then swallows it, holding the previous
    // instrument through a month the strategy decided differently, charging
    // neither the switch's tax nor its commissions, and still reporting full
    // coverage. Filling the hole with an unpriceable placeholder puts it back
    // on the calendar, where the existing gap machinery restarts the run after
    // it and `coveragePercent` counts it.
    const periods = withMissingPeriods(evaluated, strategy.cadence, asOf);

    const securityIds = [
      ...new Set(
        [
          ...periods.map((period) => period.targetSecurityId),
          safeSecurityId,
        ].filter((id): id is string => !!id),
      ),
    ];
    if (securityIds.length === 0) return null;

    // Daily closes from a lead window before the first period start: the
    // drawdown is measured inside the periods, not only at their boundaries,
    // and a period opening on a weekend or a holiday is priced by the close
    // before it -- which a series starting exactly on the boundary omits, so
    // the first period read as unpriced while its price sat in the database.
    const seriesBySecurity = await this.priceService.loadSeries(
      securityIds,
      withLeadDays(periods[0].effectiveFrom, PRICE_WINDOW_LEAD_DAYS),
      "day",
      undefined,
      strategy.userId,
    );

    return runBacktest({
      periods,
      hasEarlierSignals,
      seriesBySecurity,
      safeSecurityId,
      taxRatePercent: strategy.taxRatePercent,
      commissionAmount: strategy.commissionAmount,
      notional,
      accountCount,
      asOf,
    });
  }
}
