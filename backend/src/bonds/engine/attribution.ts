import { ExactDecimal } from "../domain/exact-decimal";
import { BondTerms } from "../domain/bond-terms";
import {
  baseAt,
  compounds,
  couponOf,
  periodInterest,
  PricedPeriod,
} from "./accrual";
import { RateScheduleEntry } from "./bond-engine-types";
import { PeriodRate } from "./rate-resolution";

type Attribution = Pick<
  RateScheduleEntry,
  "interest" | "fixedPart" | "benchmarkPart" | "addendPart" | "announcedPart"
>;

const UNKNOWN: Attribution = {
  interest: null,
  fixedPart: null,
  benchmarkPart: null,
  addendPart: null,
  announcedPart: null,
};

const PLACES = 10;
const text = (value: ExactDecimal) => value.toFixed(PLACES);

/**
 * Period `k`'s interest per bond, split by the components of its rate (spec
 * 13.2). A coupon bond's interest is the coupon as paid (rounded per bond, the
 * figure `couponOf` pays); a compounding bond's is the exact accrual from the
 * base of the period (`baseAt`, so the terms' base rounding applies) and the
 * rate over the whole period (`periodInterest`). A bond that compounds needs every earlier rate
 * for its base: with one unknown, every figure is null.
 *
 * The parts are split exactly, each at 10 decimal places, and the rounding
 * residual of a period goes to the addend part, so that the parts of a period
 * always sum to its interest (`benchmarkPart + addendPart = interest`).
 */
export function attributeInterest(
  terms: BondTerms,
  rates: readonly PeriodRate[],
  k: number,
  /**
   * The index ratio of the period's end for an indexed principal: the interest
   * is then the unrounded coupon on the face value times the ratio (a unit's
   * indexed figure is not rounded, spec 5.3); null when the ratio is unknown.
   * Absent for every other principal.
   */
  ratio?: ExactDecimal | null,
): Attribution {
  const current = rates[k - 1];
  if (current.rate === null || current.source === null) return UNKNOWN;
  if (ratio === null) return UNKNOWN;
  const prior: PricedPeriod[] = [];
  if (compounds(terms)) {
    for (const earlier of rates.slice(0, k - 1)) {
      if (earlier.rate === null) return UNKNOWN;
      prior.push({ period: earlier.period, rate: earlier.rate });
    }
  }
  const { period } = current;
  // An indexed principal pays its coupons on the face value (capitalization
  // NONE), scaled by the ratio of the period's end.
  const base =
    ratio === undefined
      ? baseAt(terms, prior, { date: period.start })
      : ExactDecimal.parse(terms.instrument.faceValue);
  const interest =
    ratio === undefined
      ? (couponOf(terms, { period, rate: current.rate }) ??
        periodInterest(terms, base, period, current.rate))
      : periodInterest(terms, base, period, current.rate).mul(ratio);
  const zero = text(ExactDecimal.ZERO);
  const none = {
    fixedPart: zero,
    benchmarkPart: zero,
    addendPart: zero,
    announcedPart: zero,
  };
  const whole = { interest: text(interest), ...none };

  switch (current.source) {
    case "TERMS":
      return { ...whole, fixedPart: text(interest) };
    case "ANNOUNCED":
      return { ...whole, announcedPart: text(interest) };
    case "DERIVED":
    case "PROJECTED": {
      const { benchmark, addend } = current;
      if (benchmark === null || benchmark.flooredValue === null || !addend)
        return { ...whole, fixedPart: text(interest) };
      const benchmarkPart = ExactDecimal.parse(
        text(
          periodInterest(
            terms,
            base,
            period,
            ExactDecimal.parse(benchmark.flooredValue),
          ),
        ),
      );
      const total = ExactDecimal.parse(whole.interest);
      return {
        ...whole,
        benchmarkPart: text(benchmarkPart),
        addendPart: text(total.sub(benchmarkPart)),
      };
    }
  }
}
