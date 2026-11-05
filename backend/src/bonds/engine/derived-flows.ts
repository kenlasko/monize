import { compareYMD } from "../domain/calendar-date";
import { ExactDecimal } from "../domain/exact-decimal";
import { SchedulePeriod } from "../domain/period-schedule";
import { principalLot } from "./accrual";
import { MissingObservation, ProjectionAssumption } from "./bond-engine-types";
import {
  accruedLotOn as floatingAccrued,
  couponLotOf as floatingCoupon,
  FloatingLot,
  maturityCashOf as floatingMaturity,
} from "./floating-lot";
import {
  couponLotOf as indexedCoupon,
  IndexedLot,
  indexOn,
  LotAmount,
  maturityCashOf as indexedMaturity,
  principalLotOn,
} from "./indexed-lot";
import type { PreparedLot } from "./prepared-lot";

/**
 * The cash flows of a lot whose figures depend on stored benchmark data of their
 * own: an indexed principal (`indexed-lot.ts`) or a floating rate
 * (`floating-lot.ts`). Each flow is a figure that may be unknown or projected;
 * what could not be read is collected and reported once (`trail`): the
 * observations that are due and missing, the assumption a projected figure used,
 * and the benchmark a later unknown figure still needs (INV-BOND-002).
 */

/** A lot figure that may be unknown (null) or rest on an assumption (`projected`). */
export interface FlowFigure {
  readonly value: ExactDecimal | null;
  readonly projected: boolean;
}

/** What the flows of a valuation could not read, assumed or still need. */
export interface DataTrail {
  readonly missing: readonly MissingObservation[];
  readonly assumptions: readonly ProjectionAssumption[];
  readonly projectionMissing: readonly {
    readonly benchmarkId: string;
    readonly publisher: string | null;
  }[];
}

export interface DerivedFlows {
  /** The coupon of a period at the rate the plan stored (null while unknown). */
  coupon(period: SchedulePeriod, rate: ExactDecimal | null): FlowFigure;
  /** The principal paid at the end of the last period. */
  principal(period: SchedulePeriod): FlowFigure;
  /** The cash at maturity: the principal and the last coupon; null while the coupon is unknown. */
  maturity(last: SchedulePeriod, rate: ExactDecimal | null): FlowFigure;
  /** Read after the flows: it includes the figures of the valuation day itself. */
  trail(): DataTrail;
}

const UNKNOWN: FlowFigure = { value: null, projected: false };

function indexedFlows(
  p: PreparedLot,
  lot: IndexedLot,
  asOf: string,
  matured: boolean,
): DerivedFlows {
  const { rule, publisher, annualInflation } = lot.series;
  const months = new Set<string>();
  let projected = false;
  let unknownLater = false;
  const track = (amount: LotAmount, on: string): FlowFigure => {
    if (amount.projected) projected = true;
    if (amount.value === null && amount.absent.length > 0) {
      if (compareYMD(on, asOf) <= 0)
        amount.absent.forEach((m) => months.add(m));
      else unknownLater = true;
    }
    return { value: amount.value, projected: amount.projected };
  };
  return {
    coupon: (period, rate) =>
      rate === null
        ? UNKNOWN
        : track(indexedCoupon(lot, { period, rate }, asOf), period.end),
    principal: (period) =>
      track(principalLotOn(lot, period.end, asOf, true), period.end),
    maturity: (last, rate) => {
      const cash = indexedMaturity(
        lot,
        rate === null ? null : { period: last, rate },
        p.maturity,
        asOf,
      );
      return { value: cash.value, projected: cash.projected };
    },
    trail: () => {
      // The ratio the valuation day itself is worked out on is due now.
      track(
        {
          value: null,
          projected: false,
          absent: indexOn(lot, matured ? p.maturity : asOf, asOf).absent,
        },
        asOf,
      );
      return {
        missing: [...months].sort().map((observation) => ({
          benchmarkId: rule.benchmarkId,
          observation,
          publisher,
        })),
        assumptions:
          projected && annualInflation !== null
            ? [
                {
                  benchmarkId: rule.benchmarkId,
                  value: annualInflation.toTrimmedString(10, 4),
                  basis: "SUPPLIED",
                  observation: null,
                  growth: "SIMPLE_ANNUAL",
                },
              ]
            : [],
        projectionMissing: unknownLater
          ? [{ benchmarkId: rule.benchmarkId, publisher }]
          : [],
      };
    },
  };
}

function floatingFlows(
  p: PreparedLot,
  lot: FloatingLot,
  asOf: string,
  current: SchedulePeriod | null,
): DerivedFlows {
  const { rule, publisher, assumed } = lot.series;
  const days = new Set<string>();
  let projected = false;
  let unknownLater = false;
  const track = (amount: {
    value: ExactDecimal | null;
    projected: boolean;
    dueUnknown: string | null;
    laterUnknown: boolean;
  }): FlowFigure => {
    if (amount.projected) projected = true;
    if (amount.value === null) {
      if (amount.dueUnknown !== null) days.add(amount.dueUnknown);
      if (amount.laterUnknown) unknownLater = true;
    }
    return { value: amount.value, projected: amount.projected };
  };
  return {
    coupon: (period) => track(floatingCoupon(lot, period, asOf)),
    principal: (period) => ({
      value: principalLot(
        lot.terms,
        { date: period.end, unitBase: p.unitBase },
        p.quantity,
        p.cost,
      ),
      projected: false,
    }),
    maturity: (last) => {
      const cash = floatingMaturity(lot, last, asOf);
      return { value: cash.value, projected: cash.projected };
    },
    trail: () => {
      // The interest accrued to the valuation day needs every day before it.
      if (current !== null) {
        const accrued = floatingAccrued(lot, current, asOf);
        if (accrued.dueUnknown !== null) days.add(accrued.dueUnknown);
      }
      return {
        missing: [...days].sort().map((observation) => ({
          benchmarkId: rule.benchmarkId,
          observation,
          publisher,
        })),
        assumptions:
          projected && assumed !== null
            ? [
                {
                  benchmarkId: rule.benchmarkId,
                  value: assumed.toTrimmedString(12, 4),
                  basis: "SUPPLIED",
                  observation: null,
                },
              ]
            : [],
        projectionMissing: unknownLater
          ? [{ benchmarkId: rule.benchmarkId, publisher }]
          : [],
      };
    },
  };
}

/** The derived flows of a lot, or null when its figures read no benchmark of their own. */
export function derivedFlowsOf(
  p: PreparedLot,
  asOf: string,
  matured: boolean,
  current: SchedulePeriod | null,
): DerivedFlows | null {
  const { terms } = p.input;
  if (p.index !== null) {
    return indexedFlows(
      p,
      { terms, series: p.index, quantity: p.quantity },
      asOf,
      matured,
    );
  }
  if (p.floating !== null) {
    return floatingFlows(
      p,
      { terms, series: p.floating, quantity: p.quantity },
      asOf,
      current,
    );
  }
  return null;
}
