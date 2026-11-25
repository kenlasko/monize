import {
  FIAT_MONEY_DECIMALS,
  MONEY_SCALE,
  fromScaledUnits,
  moneyUnits,
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
 * Half a unit at `MONEY_SCALE`, the column scale, in accumulation units: a
 * subtotal smaller than this is finer than the smallest amount the ledger can
 * hold, so it is the residue of a float conversion, not money, and its sign is
 * zero (`sign`).
 */
const SIGN_THRESHOLD_UNITS =
  10n ** BigInt(ACCUMULATION_DECIMALS - MONEY_SCALE) / 2n;

/**
 * How far below a subtotal's components their float residue reaches, as a
 * shift. Each converted component is a double carrying three roundings of at
 * most u = 2^-53 of its size each (the amount read from its decimal, the
 * product `amount * rate`, the shortest decimal string it is scaled from), so
 * the residue a sum of them can carry is under 3u, and so under 2^-51, of
 * their summed magnitude. 16,768.69 at 9731.4245182213 (about 163 million),
 * refunded as 4,012.32 and 12,756.37 at the same rate, nets to -0.00000002 in
 * doubles: residue, not money, though over half a unit at `MONEY_SCALE`. The
 * bound only reaches a ten-thousandth once the components pass about 10^12,
 * where a double's own spacing is already wider than one.
 */
const FLOAT_RESIDUE_SHIFT = 51n;

/** One `10^-FIAT_MONEY_DECIMALS` unit, in accumulation units. */
const FIAT_UNIT = 10n ** BigInt(ACCUMULATION_DECIMALS - FIAT_MONEY_DECIMALS);

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
   * The components' summed magnitudes in the same units, which bound the float
   * residue their sum can carry (`sign`).
   */
  private magnitudeUnits = 0n;
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
    const units = toAccumulationUnits(amount);
    this.subtotalUnits += units;
    this.magnitudeUnits += units < 0n ? -units : units;
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
    this.magnitudeUnits += other.magnitudeUnits;
    this.nonFiniteSum += other.nonFiniteSum;
    for (const pair of other.missing) this.missing.add(pair);
    this.unknownComponents += other.unknownComponents;
  }

  /**
   * Fold in another aggregate with its subtotal negated, carrying its gaps as
   * `merge` does: an expense category's net, read as what it cost, folds into
   * a total exactly. Adding its rounded reading instead rounds the part before
   * the whole, so the total moves with the grouping
   * (`docs/specs/report-rounding-and-aggregation.md` rule 2).
   */
  mergeNegated(other: FxAggregate): void {
    this.subtotalUnits -= other.subtotalUnits;
    this.magnitudeUnits += other.magnitudeUnits;
    this.nonFiniteSum -= other.nonFiniteSum;
    for (const pair of other.missing) this.missing.add(pair);
    this.unknownComponents += other.unknownComponents;
  }

  /**
   * `parts` folded into one new aggregate, carrying every part's gaps: a total
   * over parts that are aggregates themselves.
   */
  static sum(parts: Iterable<FxAggregate>): FxAggregate {
    const sum = new FxAggregate();
    for (const part of parts) sum.merge(part);
    return sum;
  }

  /**
   * `minuend` less `subtrahend` as a new aggregate carrying both's gaps: a net
   * (income less expenses, a period's savings) worked out before either side
   * is rounded, so it is the single rounding of its own value.
   */
  static difference(
    minuend: FxAggregate,
    subtrahend: FxAggregate,
  ): FxAggregate {
    const difference = new FxAggregate();
    difference.merge(minuend);
    difference.mergeNegated(subtrahend);
    return difference;
  }

  /**
   * The sign of the known subtotal before it is rounded to money precision:
   * `1`, `-1`, or `0` for a subtotal that is float residue rather than money
   * -- under half a unit at `MONEY_SCALE` (finer than any amount the ledger
   * holds), or within the residue its components' size can carry
   * (`FLOAT_RESIDUE_SHIFT`). `NaN` once a `NaN` component was added. A
   * direction decision (is this category spending, is this net income) reads
   * this, never the rounded subtotal: a net of 0.00003 is money in, though it
   * reads `0` at four places
   * (`docs/specs/report-rounding-and-aggregation.md` rule 5).
   */
  get sign(): number {
    if (this.nonFiniteSum !== 0) return Math.sign(this.nonFiniteSum);
    const magnitude =
      this.subtotalUnits < 0n ? -this.subtotalUnits : this.subtotalUnits;
    if (
      magnitude < SIGN_THRESHOLD_UNITS ||
      magnitude <= this.magnitudeUnits >> FLOAT_RESIDUE_SHIFT
    ) {
      return 0;
    }
    return this.subtotalUnits > 0n ? 1 : -1;
  }

  /**
   * The known subtotals of `parts` in `10^-FIAT_MONEY_DECIMALS` units,
   * apportioned so they sum to `target`: each part is its unrounded subtotal
   * rounded down, and the units that leaves short go one each to the parts
   * with the largest remainders (a tie to the earlier part). `target` defaults
   * to the reading of the parts merged, which is the parent's own reading when
   * the parent was built from the same components.
   *
   * For a presentation whose parts must add up to their parent, the Cash Flow
   * Sankey's closing identity: rounding each part on its own made two
   * 124.752474 children 124.7525 each under a 249.5049 parent. Each part stays
   * within one unit of its own subtotal (rule 6). A non-finite part has no
   * units to apportion, so then every part reads on its own. A `target` the
   * parts cannot reach that way (more than one unit a part from their sum) is
   * a caller's error and throws, rather than leaving parts that do not add up.
   */
  static apportionUnits(
    parts: readonly FxAggregate[],
    target?: number,
  ): number[] {
    if (parts.some((part) => part.nonFiniteSum !== 0)) {
      return parts.map((part) =>
        moneyUnits(part.knownSubtotal, FIAT_MONEY_DECIMALS),
      );
    }
    const goal =
      target ??
      moneyUnits(FxAggregate.sum(parts).knownSubtotal, FIAT_MONEY_DECIMALS);
    const floors = parts.map((part) => {
      const units = part.subtotalUnits;
      const quotient = units / FIAT_UNIT;
      return quotient * FIAT_UNIT > units ? quotient - 1n : quotient;
    });
    const remainders = parts.map(
      (part, index) => part.subtotalUnits - floors[index] * FIAT_UNIT,
    );
    const short = goal - Number(floors.reduce((sum, f) => sum + f, 0n));
    const order = parts
      .map((_, index) => index)
      .sort((a, b) =>
        remainders[a] === remainders[b]
          ? a - b
          : remainders[b] > remainders[a]
            ? 1
            : -1,
      );
    if (short < 0 || short > parts.length) {
      throw new RangeError(
        `apportionUnits: ${goal} is not within a unit a part of the parts' sum`,
      );
    }
    const bonus = new Set(order.slice(0, short));
    return floors.map((f, index) => Number(f) + (bonus.has(index) ? 1 : 0));
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

  /**
   * The known subtotal before it is rounded to money precision: the double
   * nearest its twelve-place sum. For a figure that is not a sum -- a mean, a
   * share of a total -- which is divided first and rounded once after
   * (`docs/specs/report-rounding-and-aggregation.md` rule 8). A sum folds the
   * aggregate itself (`merge`), never this number: past about nine thousand a
   * double holds fewer places than the accumulator.
   */
  get unroundedSubtotal(): number {
    return (
      fromScaledUnits(this.subtotalUnits, ACCUMULATION_DECIMALS) +
      this.nonFiniteSum
    );
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
