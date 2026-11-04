/**
 * The invested part's period result, split by security.
 *
 * `investedPeriodResult` answers what a scope's INVESTMENTS earned over a
 * window; the Investment Performance report's rows ask the same question of
 * one security at a time. Each row is that same function run over the
 * security's own slice of the same series and the same flows -- its component
 * of `IV(t)` and the capital and income rows that name it -- so nothing here is
 * a second policy, and the rows add up to the portfolio figure
 * (`docs/specs/investment-performance-report-period.md`).
 *
 * Pure, so the spec's worked cases and the reconciliation with the portfolio
 * figure are table-tested without a database.
 */
import { roundMoney, roundToDecimals } from "../common/round.util";
import { PORTFOLIO_MOVE_PERCENT_DECIMALS } from "../notification-center/portfolio-movement.util";
import { InvestmentAction } from "../securities/entities/investment-transaction.entity";
import { baseInvestmentAction } from "../securities/investment-replay.util";
import { InvestedFlowDay, InvestedFlowRow } from "./invested-capital-flow.util";
import {
  InvestedDayValue,
  InvestedPeriodDecision,
  investedPeriodResult,
} from "./invested-period-result.util";
import { PeriodResultReason } from "./portfolio-period-result.util";

/** Why a security's price change over the window is withheld. */
export type PriceChangeReason = "noStartClose" | "noEndClose" | "splitInWindow";

/**
 * The part of one day of the daily fold this split reads
 * (`DailyPositions` in `net-worth.service.ts`).
 */
export interface SecurityPeriodDay {
  date: string;
  /** securityId -> shares held at the close; absent when not held. */
  quantities: ReadonlyMap<string, number>;
  /** securityId -> the accepted close valuing it; `null` when nothing priced it. */
  closes: ReadonlyMap<string, number | null>;
  /** securityId -> its value in the reporting currency; `null` when it did not convert. */
  closeValues: ReadonlyMap<string, number | null>;
}

/** What a row names its security by. */
export interface SecurityPeriodIdentity {
  symbol: string;
  name: string;
  currencyCode: string;
}

/**
 * The money-weighted figures of `InvestedPeriodDecision` are left out: the
 * report prints the P&L and the time-weighted return the Investments page's
 * card prints, and a rate over one security's handful of trades is a figure
 * nobody asked for.
 */
type SecurityInvestedFigures = Omit<
  InvestedPeriodDecision,
  | "investmentMoneyWeightedReturnPercent"
  | "investmentMoneyWeightedTotalPercent"
  | "investmentMoneyWeightedMethod"
>;

export interface SecurityPeriodRow extends SecurityInvestedFigures {
  securityId: string;
  /** `null` only when the security's own row could not be read. */
  symbol: string | null;
  name: string | null;
  /** The currency the closes below are quoted in. */
  securityCurrency: string | null;
  /** Shares held at the close of `b` and of `e`, summed over the scope. */
  startQuantity: number;
  endQuantity: number;
  /** The accepted close on or before `b` and `e`, in `securityCurrency`. */
  startClose: number | null;
  endClose: number | null;
  /** `endClose / startClose - 1`, as a percentage; see `priceChangeReason`. */
  priceChangePercent: number | null;
  priceChangeReason: PriceChangeReason | null;
}

export interface SecurityPeriodInput {
  /** The window's days, `b` first and `e` last, one per calendar day. */
  days: readonly SecurityPeriodDay[];
  /** Each security's capital and income per day, folded by `foldInvestedFlows`. */
  flowsBySecurity: ReadonlyMap<string, ReadonlyMap<string, InvestedFlowDay>>;
  /** The rows that name no security, folded the same way. */
  unattributedFlows: ReadonlyMap<string, InvestedFlowDay>;
  /** Securities with a SPLIT row in `(b, e]`. */
  splitSecurityIds: ReadonlySet<string>;
  securities: ReadonlyMap<string, SecurityPeriodIdentity>;
  /** The accepted close on or before a day: `positionCloseAsOf` over the valuation series. */
  closeAt: (securityId: string, date: string) => number | null;
  /** The reporting currency every money figure is in. */
  currency: string;
}

export interface SecurityPeriodSplit {
  securities: SecurityPeriodRow[];
  /**
   * `-K + I` of the rows that name no security: income the invested part
   * earned with no row to sit in. `null` when one of them did not convert.
   */
  unattributedPnl: number | null;
}

/**
 * The money-weighted causes are about figures this split drops, so a row does
 * not carry them.
 */
const MONEY_WEIGHTED_REASONS: ReadonlySet<PeriodResultReason> = new Set([
  "windowTooShort",
  "mwrUndefined",
]);

/** The securities with a SPLIT row among `rows`. */
export function splitSecurityIdsOf(
  rows: readonly InvestedFlowRow[],
): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      row.securityId &&
      baseInvestmentAction(row.action) === InvestmentAction.SPLIT
    ) {
      ids.add(row.securityId);
    }
  }
  return ids;
}

/**
 * One security's component of each day's `IV(t)`, with that day's
 * completeness drawn from the security alone: a held day nothing priced is
 * `pricesComplete: false`, a priced day whose value did not convert is
 * `fxComplete: false` naming the pair, and a day it was not held is a known 0.
 */
export function securityDaySeries(
  days: readonly SecurityPeriodDay[],
  securityId: string,
  missingPair: string,
): InvestedDayValue[] {
  return days.map((day) => {
    if (!day.quantities.has(securityId)) {
      return { date: day.date, securitiesValue: 0 };
    }
    if ((day.closes.get(securityId) ?? null) === null) {
      return {
        date: day.date,
        securitiesValue: 0,
        pricesComplete: false,
        unpricedSecurityIds: [securityId],
      };
    }
    const value = day.closeValues.get(securityId) ?? null;
    if (value === null) {
      return {
        date: day.date,
        securitiesValue: 0,
        fxComplete: false,
        missingRatePairs: [missingPair],
      };
    }
    return { date: day.date, securitiesValue: roundMoney(value) };
  });
}

/**
 * The quoted close's move over the window, in the security's own currency.
 * Not a return: it holds no distribution, no trade and no currency move.
 */
export function priceChange(
  startClose: number | null,
  endClose: number | null,
  splitInWindow: boolean,
): {
  priceChangePercent: number | null;
  priceChangeReason: PriceChangeReason | null;
} {
  // Two quoted closes either side of a split are two different units: the
  // ratio would print the split as a loss or a gain nobody made.
  if (splitInWindow) {
    return { priceChangePercent: null, priceChangeReason: "splitInWindow" };
  }
  if (startClose === null || !(startClose > 0)) {
    return { priceChangePercent: null, priceChangeReason: "noStartClose" };
  }
  if (endClose === null) {
    return { priceChangePercent: null, priceChangeReason: "noEndClose" };
  }
  return {
    // A percentage is a ratio, not money: never roundMoney.
    priceChangePercent: roundToDecimals(
      (endClose / startClose - 1) * 100,
      PORTFOLIO_MOVE_PERCENT_DECIMALS,
    ),
    priceChangeReason: null,
  };
}

function withoutMoneyWeighted(
  decision: InvestedPeriodDecision,
): SecurityInvestedFigures {
  const {
    investmentMoneyWeightedReturnPercent: _rate,
    investmentMoneyWeightedTotalPercent: _total,
    investmentMoneyWeightedMethod: _method,
    ...figures
  } = decision;
  return {
    ...figures,
    investedReasons: figures.investedReasons.filter(
      (reason) => !MONEY_WEIGHTED_REASONS.has(reason),
    ),
  };
}

/**
 * Every security held on a day of the window or moved by a capital or income
 * row inside it, each measured by `investedPeriodResult` over its own slice.
 * A position closed inside the window is a row: without it the rows would not
 * add up to the portfolio's figure.
 */
export function securityPeriodResults(
  input: SecurityPeriodInput,
): SecurityPeriodSplit {
  const { days, flowsBySecurity, currency } = input;
  if (days.length === 0) {
    return { securities: [], unattributedPnl: null };
  }
  const first = days[0];
  const last = days[days.length - 1];

  const ids = new Set<string>(flowsBySecurity.keys());
  for (const day of days) {
    for (const id of day.quantities.keys()) ids.add(id);
  }

  const securities = [...ids].sort().map((securityId): SecurityPeriodRow => {
    const identity = input.securities.get(securityId) ?? null;
    const securityCurrency = identity?.currencyCode ?? null;
    const points = securityDaySeries(
      days,
      securityId,
      `${securityCurrency ?? "?"}->${currency}`,
    );
    const decision = investedPeriodResult({
      points,
      startIndex: 0,
      endIndex: points.length - 1,
      flowsByDay: flowsBySecurity.get(securityId) ?? new Map(),
    });
    const startClose = input.closeAt(securityId, first.date);
    const endClose = input.closeAt(securityId, last.date);
    return {
      securityId,
      symbol: identity?.symbol ?? null,
      name: identity?.name ?? null,
      securityCurrency,
      startQuantity: first.quantities.get(securityId) ?? 0,
      endQuantity: last.quantities.get(securityId) ?? 0,
      startClose,
      endClose,
      ...priceChange(
        startClose,
        endClose,
        input.splitSecurityIds.has(securityId),
      ),
      ...withoutMoneyWeighted(decision),
    };
  });

  // The same decision over a series that holds nothing: what is left is the
  // rows' own `-K + I`, withheld when one of them did not convert.
  const unattributed = investedPeriodResult({
    points: days.map((day) => ({ date: day.date, securitiesValue: 0 })),
    startIndex: 0,
    endIndex: days.length - 1,
    flowsByDay: input.unattributedFlows,
  });

  return { securities, unattributedPnl: unattributed.investmentPnl };
}
