import { FIAT_MONEY_DECIMALS, roundMoney } from "./round.util";

/**
 * `amount` as a whole count of ten-thousandths, rounded half away from zero by
 * `roundMoney` before it is scaled (Discussion #2136). A bare
 * `Math.round(amount * 10000)` rounds a negative midpoint toward zero
 * (`-0.00005` came back `0` where `roundMoney` answers `-0.0001`) and a
 * positive one lost to the float multiply downward (`0.00145 * 10000` is
 * `14.499999999999998`); the product of an already-rounded value is an integer
 * to within an ULP, so `Math.round` only absorbs that ULP.
 */
function toMinorUnits(amount: number): number {
  return Math.round(roundMoney(amount, FIAT_MONEY_DECIMALS) * 10000);
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
   * Accumulated in integer ten-thousandths (the resolution of `decimal(20,4)`),
   * per the Financial Math rule in CLAUDE.md: `subtotal += converted` in floats
   * accumulates drift, and this class is the one accumulator every total folds
   * through, which is exactly where that drift would multiply.
   */
  private subtotalMinorUnits = 0;
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
    this.subtotalMinorUnits += toMinorUnits(converted);
  }

  /** Add a value that needed no conversion (already in the reporting currency). */
  addConverted(amount: number): void {
    this.subtotalMinorUnits += toMinorUnits(amount);
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
    this.subtotalMinorUnits += other.subtotalMinorUnits;
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
    return this.isComplete ? this.subtotalMinorUnits / 10000 : null;
  }

  /**
   * The sum of the components that did convert. Safe to display beside the
   * missing pairs, never under a field whose name says "total".
   */
  get knownSubtotal(): number {
    return this.subtotalMinorUnits / 10000;
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
