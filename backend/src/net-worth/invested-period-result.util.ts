/**
 * What the INVESTED part of a portfolio earned over a period, and at what rate.
 *
 * The sibling of `decidePeriodResult`, over the same series and the same
 * window, asking the question a reader hears under the caption "Portfolio
 * performance": how much did my INVESTMENTS earn or lose, not how much did the
 * whole investment account move including the cash I paid into it. Cash held in
 * an investment account is not an investment, so it is in neither figure and in
 * neither the numerator nor the base of the percentage: paying it in or out
 * moves neither (INV-PORTRESULT-002,
 * `docs/specs/portfolio-period-result.md` section 10).
 *
 * Pure, so the whole policy is table-tested without a database -- the spec's
 * twelve worked cases are `invested-period-result.util.spec.ts` -- and so
 * neither the single-range route nor the batch route re-derives a row of it.
 */
import { roundMoney, roundToDecimals } from "../common/round.util";
import { daysBetween } from "../common/time-series/price-boundary.util";
import {
  chainTwrPercent,
  subPeriodFactor,
} from "../common/time-series/twr-chain.util";
import {
  XirrFlow,
  totalOverDays,
  xirrAnnualRate,
} from "../common/time-series/xirr.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";
import {
  EMPTY_INVESTED_FLOW_DAY,
  InvestedFlowDay,
} from "./invested-capital-flow.util";
import { PeriodResultReason } from "./portfolio-period-result.util";

/**
 * How `investmentReturnPercent` was arrived at, named on the wire so a later
 * method is a new union member rather than a silent change of meaning under the
 * same caption -- the reason `PeriodReturnMethod` names `simple`.
 */
export type InvestedReturnMethod = "twr";

/**
 * How `investmentMoneyWeightedReturnPercent` was arrived at, named on the wire
 * for the same reason `InvestedReturnMethod` is: a later method (a Modified
 * Dietz approximation, say) is a new union member and a compile error at every
 * consumer that switched on it, rather than a silent change of meaning under
 * one caption.
 */
export type MoneyWeightedReturnMethod = "xirr";

/**
 * The shortest window an annualised rate is reported over.
 *
 * A 1% week is a 68% year (`docs/specs/portfolio-period-result.md` section
 * 11.7, case 8): arithmetically correct, read as a claim about a year, and
 * moving by tens of points on the next day's close. Under this bound the annual
 * figure is withheld with `windowTooShort` and only the window's own total --
 * the same money, weighted the same way, with no extrapolation in it -- is
 * reported.
 */
export const MWR_MIN_ANNUALISED_WINDOW_DAYS = 30;

/** One day of the value series, as the invested measure reads it. */
export interface InvestedDayValue {
  date: string;
  /** `IV(t)`: the securities at that close, no cash. A subtotal when a bit is false. */
  securitiesValue: number;
  fxComplete?: boolean;
  pricesComplete?: boolean;
  missingRatePairs?: string[];
  unpricedSecurityIds?: string[];
}

export interface InvestedPeriodInput {
  /** The contiguous daily series the window is sliced out of. */
  points: readonly InvestedDayValue[];
  /** Index of `b`: the close the period is measured FROM. */
  startIndex: number;
  /** Index of `e`: the close it is measured TO. */
  endIndex: number;
  /** The invested part's capital and income, per day, already in the currency. */
  flowsByDay: ReadonlyMap<string, InvestedFlowDay>;
}

export interface InvestedPeriodDecision {
  /** `IV(b)`; null when that day is a subtotal. */
  investedValueStart: number | null;
  /** `IV(e)`; null when that day is a subtotal. */
  investedValueEnd: number | null;
  /**
   * `IV(e) - IV(b)`: what the securities are worth at the end less what they
   * were worth at the start -- the last point a value chart draws less its
   * first. Two-ended, like the account's `valueChange`: known whenever both
   * boundary days are complete, even where a gap between them or an
   * unmeasurable movement withholds the P&L. Unlike `investedValueStart` and
   * `investedValueEnd`, it is not nulled with the rest of the decision, which
   * is why a surface reads it rather than subtracting those two.
   */
  investedValueChange: number | null;
  /**
   * Net value paid into the invested part on `(b, e]`: buys less disposals,
   * plus the distributions reinvested in shares (each the BUY half of the
   * DIVIDEND and BUY it stands for).
   */
  investmentCapitalFlows: number | null;
  /**
   * Dividends, interest and capital-gain distributions received on `(b, e]`,
   * paid in cash or reinvested in shares.
   */
  investmentIncome: number | null;
  /** `IV(e) - IV(b) - capital + income`: what the investments earned. */
  investmentPnl: number | null;
  /** The time-weighted return over the same days; see `investmentReturnMethod`. */
  investmentReturnPercent: number | null;
  investmentReturnMethod: InvestedReturnMethod;
  /**
   * The ANNUALISED money-weighted return (XIRR) over the same flows: the rate
   * the reader's own money earned, each purchase, disposal and distribution
   * weighted by when it happened (section 11). `null` is withheld, never zero:
   * the window may be too short to annualise (`windowTooShort`), the schedule
   * may define no single rate (`mwrUndefined`), or the whole decision may be
   * withheld for the reasons the two figures above are.
   */
  investmentMoneyWeightedReturnPercent: number | null;
  /**
   * The same rate over the window rather than over a year,
   * `(1 + r)^(days/365) - 1`. An extrapolation of the rate, NOT a realised
   * total: a schedule whose money came back halfway compounds its rate over a
   * remainder that held nothing, so a surface captions it as a rate over the
   * window and never as what the reader made (section 11.3).
   */
  investmentMoneyWeightedTotalPercent: number | null;
  investmentMoneyWeightedMethod: MoneyWeightedReturnMethod;
  /**
   * True only when `investmentPnl` and `investmentReturnPercent` are both
   * known. It is about those two: a window whose money-weighted rate is
   * undefined or too short to annualise still has a P&L and a time-weighted
   * return, and says so (section 11.5).
   */
  investedComplete: boolean;
  /** Why a figure is withheld, from the same closed set the account measure uses. */
  investedReasons: PeriodResultReason[];
}

const WITHHELD: Omit<
  InvestedPeriodDecision,
  | "investedReasons"
  | "investmentCapitalFlows"
  | "investmentIncome"
  | "investedValueChange"
> = {
  investedValueStart: null,
  investedValueEnd: null,
  investmentPnl: null,
  investmentReturnPercent: null,
  investmentReturnMethod: "twr",
  investmentMoneyWeightedReturnPercent: null,
  investmentMoneyWeightedTotalPercent: null,
  investmentMoneyWeightedMethod: "xirr",
  investedComplete: false,
};

/**
 * `=== false`, never `!flag`: an absent bit is an older producer saying nothing,
 * which is no information rather than a claim of incompleteness.
 *
 * `cashComplete` is deliberately not among them. No cash is in `IV`, so a cash
 * account with no balance for a day cannot make these figures wrong; it still
 * withholds the account-level `valueChange` and is still reported to the reader.
 */
function pointComplete(point: InvestedDayValue): boolean {
  return point.fxComplete !== false && point.pricesComplete !== false;
}

/**
 * Each day's growth factor of the invested part, in day order: `null` for a
 * day with no capital at risk (the chain treats it as factor 1).
 *
 * A purchase is funded at the START of the day and a disposal or distribution
 * leaves at the END of it (section 10.2), so `base = IV(d-1) + capitalIn(d)` and
 * `ending = IV(d) + capitalOut(d) + I(d)`. The one place that derivation is
 * written: `investedPeriodResult` chains these into the window's return and
 * `investedTwrSeries` into its running value, so the line and the card beside
 * it cannot read different factors (INV-PORTTWR-001).
 *
 * `days` are the days AFTER `start`, and `flowDays[i]` is `days[i]`'s flow.
 */
export function investedDayFactors(
  start: InvestedDayValue,
  days: readonly InvestedDayValue[],
  flowDays: readonly InvestedFlowDay[],
): Array<number | null> {
  return days.map((day, i) => {
    const previous =
      i === 0 ? start.securitiesValue : days[i - 1].securitiesValue;
    const flow = flowDays[i];
    return subPeriodFactor(
      previous + flow.capitalIn,
      day.securitiesValue + flow.capitalOut + flow.income,
    );
  });
}

/**
 * The invested part's result for one window of one series.
 *
 * The guards run in the order of the truth table in section 10.4:
 *
 * 1. No window -> nothing is known.
 * 2. A day the CHAIN SPANS that is a subtotal -> no figures, carrying that
 *    day's own causes. A factor chained over a subtotal is a return on a
 *    portfolio nobody owns -- and unlike a value difference, a chain cannot be
 *    repaired at the two ends.
 * 3. A capital or income row that did not convert -> no figures, pairs named.
 * 4. A movement the flow classifier cannot count -> no figures, cause named.
 * 5. A window in which nothing was ever invested -> a known zero when nothing
 *    was earned either, and no ratio otherwise.
 */
export function investedPeriodResult(
  input: InvestedPeriodInput,
): InvestedPeriodDecision {
  return decideInvestedPeriod(input, true).decision;
}

/**
 * The same decision without the money-weighted pair, plus the day factors it
 * chained: what `investedTwrSeries` needs to draw the line the card's
 * time-weighted return ends on, without solving an XIRR it discards or
 * deriving the factors a second time. `dayFactors` is null wherever the
 * decision withholds the return before chaining. The MWR figures are null and
 * carry no reason of their own, so only the TWR fields are meaningful here.
 */
export function investedTimeWeightedDecision(input: InvestedPeriodInput): {
  decision: InvestedPeriodDecision;
  dayFactors: Array<number | null> | null;
} {
  return decideInvestedPeriod(input, false);
}

/** Where a caller does not want the money-weighted pair at all. */
const NO_MONEY_WEIGHTED: ReturnType<typeof moneyWeightedFigures> = {
  figures: {
    investmentMoneyWeightedReturnPercent: null,
    investmentMoneyWeightedTotalPercent: null,
    investmentMoneyWeightedMethod: "xirr",
  },
  reason: null,
};

function decideInvestedPeriod(
  input: InvestedPeriodInput,
  withMoneyWeighted: boolean,
): {
  decision: InvestedPeriodDecision;
  dayFactors: Array<number | null> | null;
} {
  const { points, startIndex, endIndex, flowsByDay } = input;
  const withheldOnly = (decision: InvestedPeriodDecision) => ({
    decision,
    dayFactors: null,
  });

  if (
    points.length === 0 ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= points.length
  ) {
    return withheldOnly({
      ...WITHHELD,
      investedValueChange: null,
      investmentCapitalFlows: null,
      investmentIncome: null,
      investedReasons: ["noValueSeries"],
    });
  }

  const start = points[startIndex];
  const end = points[endIndex];

  // Read off the two boundaries alone, before any guard below can withhold
  // the rest: a subtotal on a day in between leaves both ends a whole value.
  const investedValueChange =
    pointComplete(start) && pointComplete(end)
      ? roundMoney(
          (Math.round(end.securitiesValue * 10000) -
            Math.round(start.securitiesValue * 10000)) /
            10000,
        )
      : null;

  const reasons = new Set<PeriodResultReason>();

  // The days the chain spans, and the flows that land on them. `(b, e]`: IV(b)
  // is a close and already holds everything dated b, so counting those rows
  // again would subtract them from a value that holds them.
  const days = points.slice(startIndex + 1, endIndex + 1);
  const flowDays = days.map(
    (point) => flowsByDay.get(point.date) ?? EMPTY_INVESTED_FLOW_DAY,
  );

  // Money is accumulated in integer ten-thousandths and divided once, never
  // summed as floats (AGENTS.md, Financial math).
  let capitalMinor = 0;
  let incomeMinor = 0;
  // A reinvested distribution is income AND capital: it enters both printed
  // figures, so the P&L they add up to is the one the value change already
  // holds -- its shares are in `IV(e)` -- and neither return chain reads it.
  let reinvestedMinor = 0;
  let flowsComplete = true;
  for (const day of flowDays) {
    capitalMinor += Math.round((day.capitalIn - day.capitalOut) * 10000);
    incomeMinor += Math.round(day.income * 10000);
    reinvestedMinor += Math.round(day.reinvestedIncome * 10000);
    if (!day.complete) {
      flowsComplete = false;
      // Two different repairs, so two different reasons: a rate to add on the
      // Currencies page, or a close for a named security on the day its shares
      // moved. A leg nothing priced leaves its shares in `IV` with no capital
      // flow to net them, which would read as a gain.
      if (day.missingPairs.length > 0) reasons.add("missingRatePairs");
      if (day.unpricedSecurityIds.length > 0) reasons.add("incompletePrices");
    }
  }
  const investmentCapitalFlows = flowsComplete
    ? roundMoney((capitalMinor + reinvestedMinor) / 10000)
    : null;
  const investmentIncome = flowsComplete
    ? roundMoney((incomeMinor + reinvestedMinor) / 10000)
    : null;

  for (const point of [start, ...days]) {
    if (pointComplete(point)) continue;
    if (point.pricesComplete === false) reasons.add("incompletePrices");
    if (point.fxComplete === false) reasons.add("missingRatePairs");
  }

  // None of the uncountable-movement counts is read here. They exist for the
  // ACCOUNT result, whose flow is drawn around cash accounts; this measure is
  // drawn around the securities. `IV` is the positions' value and `K` and `I`
  // are each row's own `total_amount`, wherever its cash settled -- a BUY
  // funded from chequing is `+T` of capital against `+T` of shares, a dividend
  // paid to a bank is `+D` of income, and an embedded split line has its own
  // investment row. A share leg is valued at the day's accepted close, the
  // same one `IV` valued the position at, so the two cancel; a leg nothing
  // priced is withheld above, by the day it made incomplete, naming the
  // security rather than the movement (sections 10.6 and 6.1).

  const withheld = (): InvestedPeriodDecision => ({
    ...WITHHELD,
    investedValueChange,
    investmentCapitalFlows,
    investmentIncome,
    investedReasons: [...reasons],
  });

  if (reasons.size > 0) return withheldOnly(withheld());

  const pnl = roundMoney(
    (Math.round(end.securitiesValue * 10000) -
      Math.round(start.securitiesValue * 10000) -
      capitalMinor +
      incomeMinor) /
      10000,
  );

  // A purchase is funded at the START of the day, so buying cannot be a gain;
  // a disposal and a distribution leave at the END of it, so selling cannot be
  // a loss. Section 10.2 derives the split convention: a single start-of-day
  // convention makes a profitable full sale's base negative and drops the day
  // that realised the whole gain out of the chain.
  const dayFactors = investedDayFactors(start, days, flowDays);
  const factors: number[] = [];
  let anyBase = false;
  for (const factor of dayFactors) {
    if (factor === null) continue;
    anyBase = true;
    factors.push(factor);
  }

  // The same window, the same flows, asked the reader's own question: at what
  // rate did MY money grow, weighted by when I paid it in (section 11). It is
  // computed only where the two figures above are reportable, because it reads
  // the same `IV`, the same `K` and the same `I`: anything that makes a chained
  // factor a return on a portfolio nobody owns does the same to a discounted
  // flow.
  const moneyWeighted = withMoneyWeighted
    ? moneyWeightedFigures(start, end, days, flowDays)
    : NO_MONEY_WEIGHTED;
  // Its own cause, and only where the rest of the decision is reportable: a
  // window already withholding the P&L and the TWR has causes of its own, and
  // "the rate is undefined too" adds nothing to them (section 11.5).
  const withMwrReason = (): PeriodResultReason[] =>
    moneyWeighted.reason ? [...reasons, moneyWeighted.reason] : [...reasons];

  const measured = (decision: InvestedPeriodDecision) => ({
    decision,
    dayFactors,
  });

  if (!anyBase) {
    // No day of the window had capital at risk. Nothing invested and nothing
    // earned is a KNOWN zero (the spec's case 1); a result with no invested
    // capital behind it has no ratio at all.
    if (pnl === 0) {
      return measured({
        investedValueStart: start.securitiesValue,
        investedValueEnd: end.securitiesValue,
        investedValueChange,
        investmentCapitalFlows,
        investmentIncome,
        investmentPnl: 0,
        investmentReturnPercent: 0,
        investmentReturnMethod: "twr",
        ...moneyWeighted.figures,
        investedComplete: true,
        investedReasons: withMwrReason(),
      });
    }
    reasons.add("zeroStart");
    return measured({
      ...WITHHELD,
      investedValueStart: start.securitiesValue,
      investedValueEnd: end.securitiesValue,
      investedValueChange,
      investmentCapitalFlows,
      investmentIncome,
      investmentPnl: pnl,
      investedReasons: [...reasons],
    });
  }

  const percent = chainTwrPercent(factors);
  if (percent === null) {
    reasons.add("zeroStart");
    return measured({
      ...WITHHELD,
      investedValueStart: start.securitiesValue,
      investedValueEnd: end.securitiesValue,
      investedValueChange,
      investmentCapitalFlows,
      investmentIncome,
      investmentPnl: pnl,
      investedReasons: [...reasons],
    });
  }

  return measured({
    investedValueStart: start.securitiesValue,
    investedValueEnd: end.securitiesValue,
    investedValueChange,
    investmentCapitalFlows,
    investmentIncome,
    investmentPnl: pnl,
    // A percentage is a ratio, not money: PORTFOLIO_MOVE_PERCENT_DECIMALS,
    // never roundMoney.
    investmentReturnPercent: roundToDecimals(
      percent,
      PORTFOLIO_MOVE_PERCENT_DECIMALS,
    ),
    investmentReturnMethod: "twr",
    ...moneyWeighted.figures,
    investedComplete: true,
    investedReasons: withMwrReason(),
  });
}

/**
 * The money-weighted pair for a window whose invested figures are reportable.
 *
 * The schedule is the reader's own (section 11.2): `-IV(b)` on the baseline --
 * what was already invested is a purchase made on day one -- then each day's
 * capital and income with the investor's sign, and `+IV(e)` at the end, as if
 * the position were liquidated there. Deposits, withdrawals and idle cash are
 * in none of it, exactly as they are in neither the P&L nor the TWR.
 *
 * Money is folded in integer ten-thousandths and the solver divides once
 * (AGENTS.md, Financial math). The two answers are one rate in two dresses, so
 * a schedule with no single rate withholds both.
 */
function moneyWeightedFigures(
  start: InvestedDayValue,
  end: InvestedDayValue,
  days: readonly InvestedDayValue[],
  flowDays: readonly InvestedFlowDay[],
): {
  figures: Pick<
    InvestedPeriodDecision,
    | "investmentMoneyWeightedReturnPercent"
    | "investmentMoneyWeightedTotalPercent"
    | "investmentMoneyWeightedMethod"
  >;
  reason: PeriodResultReason | null;
} {
  const windowDays = daysBetween(start.date, end.date);

  const flows: XirrFlow[] = [
    { dayOffset: 0, amountMinor: -Math.round(start.securitiesValue * 10000) },
    {
      dayOffset: windowDays,
      amountMinor: Math.round(end.securitiesValue * 10000),
    },
  ];
  for (let i = 0; i < days.length; i++) {
    const flow = flowDays[i];
    flows.push({
      dayOffset: daysBetween(start.date, days[i].date),
      amountMinor:
        Math.round(flow.capitalOut * 10000) +
        Math.round(flow.income * 10000) -
        Math.round(flow.capitalIn * 10000),
    });
  }

  const rate = xirrAnnualRate(flows);
  const method: MoneyWeightedReturnMethod = "xirr";
  if (rate === null) {
    return {
      figures: {
        investmentMoneyWeightedReturnPercent: null,
        investmentMoneyWeightedTotalPercent: null,
        investmentMoneyWeightedMethod: method,
      },
      reason: "mwrUndefined",
    };
  }

  const total = totalOverDays(rate, windowDays);
  // A percentage is a ratio, not money: PORTFOLIO_MOVE_PERCENT_DECIMALS, never
  // roundMoney.
  const asPercent = (value: number | null): number | null =>
    value === null
      ? null
      : roundToDecimals(value * 100, PORTFOLIO_MOVE_PERCENT_DECIMALS);

  // Too short to annualise: the rate exists and the window's own total reports
  // it honestly, while a year's worth of it would be a claim about a year.
  const tooShort = windowDays < MWR_MIN_ANNUALISED_WINDOW_DAYS;
  return {
    figures: {
      investmentMoneyWeightedReturnPercent: tooShort ? null : asPercent(rate),
      investmentMoneyWeightedTotalPercent: asPercent(total),
      investmentMoneyWeightedMethod: method,
    },
    reason: tooShort ? "windowTooShort" : null,
  };
}

/** The answer for a scope or window with no series at all. */
export const NO_INVESTED_PERIOD: InvestedPeriodDecision = {
  ...WITHHELD,
  investedValueChange: null,
  investmentCapitalFlows: null,
  investmentIncome: null,
  investedReasons: ["noValueSeries"],
};
