import {
  FIAT_MONEY_DECIMALS,
  fromScaledUnits,
  roundMoney,
  toScaledUnits,
} from "./round.util";

/**
 * The places a component is accumulated at: the fiat precision plus eight
 * guard digits, so the subtotal is rounded to `FIAT_MONEY_DECIMALS` once, when
 * it is read, never component by component (issue #2360). Rounding each
 * converted component to four places first made "convert each row, then sum"
 * and "sum the rows, then convert" disagree: two 100.01 EUR receipts at 1.2474
 * are 124.752474 USD each, which rounded to 124.7525 and summed to 249.5050,
 * while their 200.02 EUR sum converts to 249.504948 and reads 249.5049.
 */
const ACCUMULATION_DECIMALS = FIAT_MONEY_DECIMALS + 8;

/**
 * `amount` as a whole count of `10^-ACCUMULATION_DECIMALS` units, shifted by
 * its decimal digits (`toScaledUnits`), never multiplied in floats (Discussion
 * #2343): for a large amount the float product is not the integer it denotes
 * (`300000000000.03 * 10000` is `3000000000000300.5`), and `Math.round` then
 * carried `+x` up and `-x` toward zero, so adding an amount and its negation
 * left `0.0001`.
 */
function toAccumulationUnits(amount: number): bigint {
  return toScaledUnits(amount, ACCUMULATION_DECIMALS);
}

/**
 * The subtotal `units` denotes, rounded to four places by `roundMoney` itself
 * (Discussion #2136): half away from zero, so `-0.00005` reads `-0.0001` where
 * a bare `Math.round` carried it toward zero, and with its one-ULP nudge, so a
 * float artefact just under a midpoint (`41919.852249999996`) reads up as
 * `roundMoney` answers it. Rounding the units in integers alone read it down.
 */
function readSubtotal(units: bigint): number {
  return roundMoney(
    fromScaledUnits(units, ACCUMULATION_DECIMALS),
    FIAT_MONEY_DECIMALS,
  );
}

/**
 * Accumulate amounts that each need converting into one reporting currency,
 * keeping "could not convert" distinguishable from "converted to zero".
 *
 * Why this is a class rather than a `reduce`: the defect it replaces was a
 * single `?? amount` at the end of a conversion helper (audit P5-009). Each
 * call site read `total += convert(...)` and looked correct; the lie was one
 * level down, where a missing rate became a rate of 1. Handing the sites an
 * accumulator that *cannot* silently absorb a missing rate removes the place
 * that mistake can live.
 *
 * Read `docs/specs/fx-conversion-completeness.md` for the invariants and the
 * numerical examples, and `docs/financial-calculation-contract.md` section 1 for
 * the total/subtotal rule this implements.
 */
export class FxAggregate {
  /**
   * Accumulated in integer `10^-ACCUMULATION_DECIMALS` units and rounded to
   * ten-thousandths (the resolution of `decimal(20,4)`) only when read, per the
   * Financial Math rule in CLAUDE.md: `subtotal += converted` in floats
   * accumulates drift, and this class is the one accumulator every total folds
   * through, which is exactly where that drift would multiply. A `BigInt`, as
   * in `sumMoney` (`docs/specs/money-precision.md` decision 4): integer units
   * in a double stop being exact past 2^53.
   */
  private subtotalUnits = 0n;
  /**
   * The sum of the non-finite components (`NaN`, `Infinity`), which have no
   * digits to count in `subtotalUnits`. Zero until one is added, so it
   * changes nothing; once one is, the subtotal reads `NaN` or `Infinity` as it
   * always has. This class does not decide what a non-finite amount means.
   */
  private nonFiniteSum = 0;
  private readonly missing = new Set<string>();
  /**
   * Components left out for a reason that is not a missing rate -- an amount the
   * server could not work out at all, which has no pair to name.
   *
   * Kept apart from `missing` because naming a currency for it would report a
   * rate gap that may not exist: a scheduled occurrence whose own settlement rate
   * is unknown is unknown in *every* currency, and saying "no rate for CAD->USD"
   * sends the reader to fix the wrong thing. `frontend/src/lib/currency-total.ts`
   * splits the same two causes as `missingCurrencies` and `excludedCount`.
   */
  private unknownComponents = 0;

  /**
   * Add one component. `converted` is what the conversion returned: `null`
   * means no rate was available for `from -> to`, which makes the total
   * unknowable rather than smaller.
   */
  add(converted: number | null, from: string, to: string): void {
    if (converted === null) {
      this.missing.add(`${from}->${to}`);
      return;
    }
    this.addConverted(converted);
  }

  /** Add a value that needed no conversion (already in the reporting currency). */
  addConverted(amount: number): void {
    if (!Number.isFinite(amount)) {
      this.nonFiniteSum += amount;
      return;
    }
    this.subtotalUnits += toAccumulationUnits(amount);
  }

  /**
   * Record a component whose value is unknown for a reason other than a missing
   * rate, so the total is withheld without blaming a currency pair.
   */
  addUnknown(): void {
    this.unknownComponents += 1;
  }

  /** Fold in another aggregate, carrying its gaps with its subtotal. */
  merge(other: FxAggregate): void {
    this.subtotalUnits += other.subtotalUnits;
    this.nonFiniteSum += other.nonFiniteSum;
    for (const pair of other.missing) this.missing.add(pair);
    this.unknownComponents += other.unknownComponents;
  }

  /**
   * The complete total, or `null` when any component could not be converted.
   *
   * Note that this is `0` -- not `null` -- for an aggregate nothing was ever
   * added to: an empty account holds zero, and reporting that as unknown tells
   * the user a settled question could not be worked out.
   */
  get total(): number | null {
    return this.isComplete ? this.knownSubtotal : null;
  }

  /**
   * The sum of the components that did convert, rounded to four places once,
   * after they were summed. Safe to display beside the missing pairs, never
   * under a field whose name says "total".
   */
  get knownSubtotal(): number {
    return readSubtotal(this.subtotalUnits) + this.nonFiniteSum;
  }

  /** `"USD->EUR"` for each unresolvable pair; empty when the total is complete. */
  get missingPairs(): string[] {
    return [...this.missing].sort();
  }

  /**
   * True when nothing was left out, by either cause. Checking `missingPairs`
   * alone would report a total containing an unpriceable component as complete.
   */
  get isComplete(): boolean {
    return this.missing.size === 0 && this.unknownComponents === 0;
  }

  /** How many components were left out for a reason with no pair to name. */
  get unknownCount(): number {
    return this.unknownComponents;
  }
}
