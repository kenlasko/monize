import { combineTotals, sumConverted, type ConvertedTotal } from './currency-total';
import { toMoneyUnits } from './format';

/**
 * A total only the page can build: over rows the page grouped itself (a month,
 * a security, a security type), from figures it converted or read off rows,
 * where the response carries no total to read.
 *
 * It is the exact sum of its components, accumulated as `sumConverted` does
 * and rounded once at `places`, the display currency's
 * (`docs/specs/report-rounding-and-aggregation.md` rules 2 and 4, section 7).
 * Never a float `+=` over the rows: 1.0007 and 1.0143 add to
 * 2.0149999999999997 in doubles, which reads $2.01, where their sum, 2.015,
 * reads $2.02. A group's total folds into the figure above it as its exact
 * sum (`foldPageSums`), never as its reading.
 *
 * `null` is unknown: a sum with an unknown component is unknown, never the
 * partial sum under the total's name.
 */
export type PageSum = ConvertedTotal | null;

/** The exact sum of `values`, read once at `places`; `null` when any is unknown. */
export function pageSum(values: readonly number[], places: number): ConvertedTotal;
export function pageSum(values: readonly (number | null)[], places: number): PageSum;
export function pageSum(values: readonly (number | null)[], places: number): PageSum {
  const known: number[] = [];
  for (const value of values) {
    if (value === null) return null;
    known.push(value);
  }
  return sumConverted(
    known,
    (value) => value,
    () => '',
    (value) => value,
    places,
  );
}

/**
 * Sums folded into one by their exact sums and read once at `places`; `null`
 * when any is unknown. No sums is a known zero.
 */
export function foldPageSums(sums: readonly ConvertedTotal[], places: number): ConvertedTotal;
export function foldPageSums(sums: readonly PageSum[], places: number): PageSum;
export function foldPageSums(sums: readonly PageSum[], places: number): PageSum {
  const known: ConvertedTotal[] = [];
  for (const sum of sums) {
    if (sum === null) return null;
    known.push(sum);
  }
  if (known.length === 0) return pageSum([], places);
  return combineTotals(known, known.map(() => 1 as const), places);
}

/** `minuend` less `subtrahend`, from their exact sums, read once at `places`. */
export function pageDifference(
  minuend: ConvertedTotal,
  subtrahend: ConvertedTotal,
  places: number,
): ConvertedTotal {
  return combineTotals([minuend, subtrahend], [1, -1], places);
}

/** A sum's reading, or `null` when it is unknown. */
export function pageSumValue(sum: PageSum): number | null {
  return sum === null ? null : sum.value;
}

/** A sum's exact value as a count of `10^-scale` units. */
function unitsAt(sum: ConvertedTotal, scale: number): bigint {
  const exact = sum.exact;
  // A figure read off a response arrives rounded once and counts as its value.
  if (!exact) return toMoneyUnits(sum.value, scale);
  return exact.units * BigInt(10) ** BigInt(scale - exact.scale);
}

/**
 * The sign of a sum's exact value: a sum of 0.003 reads 0.00 at two places
 * and is still money in (rule 5).
 */
export function pageSumSign(sum: ConvertedTotal): -1 | 0 | 1 {
  const units = sum.exact ? sum.exact.units : toMoneyUnits(sum.value, 8);
  if (units > BigInt(0)) return 1;
  if (units < BigInt(0)) return -1;
  return 0;
}

/**
 * `part` over `whole`, divided from their exact sums rather than their
 * readings (rule 8): two holdings of 1.2474 read 1.25 each over a total that
 * reads 2.49, and are each half of it, not 50.2%. `null` when `whole` is zero.
 */
export function pageRatio(part: ConvertedTotal, whole: ConvertedTotal): number | null {
  const scale = Math.max(part.exact?.scale ?? 12, whole.exact?.scale ?? 12);
  const denominator = unitsAt(whole, scale);
  if (denominator === BigInt(0)) return null;
  return Number(unitsAt(part, scale)) / Number(denominator);
}
