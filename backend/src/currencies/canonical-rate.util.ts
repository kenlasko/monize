import { roundFxRate } from "../common/fx-entry.util";

/**
 * The one orientation a currency pair is stored in, and the only way a row
 * reaches `INSERT INTO exchange_rates`.
 *
 * `exchange_rates` used to hold two rows per pair and date: the direction a
 * provider was asked for, and `roundFxRate(1 / rate)` written beside it so a
 * reverse lookup would find something. Nothing kept the two reciprocal. A write
 * that touched one side only -- a Money import upserting `CAD->USD` for a date a
 * provider had written both ways -- left a pair whose two rows disagreed, and
 * `resolveFxRate` picks the more recently observed direction, so which figure a
 * date resolved to depended on which row happened to be newer. Two totals in one
 * report could then disagree with nothing saying so.
 *
 * Storing one orientation removes the class rather than the symptom: there is no
 * second row to diverge from. Readers lose nothing, because `resolveFxRate`
 * already consults both directions and inverts the reverse observation
 * (`docs/specs/exchange-rate-canonical-orientation.md`, INV-FX-003).
 */

/**
 * Whether a code is a CRYPTO currency (`currencies.kind`). The writers read it
 * once per operation (`loadCoinLookup`) and hand it in; the default answers
 * "no" for every code, which is the plain code-order rule.
 */
export type IsCoin = (code: string) => boolean;

/** Nobody is a coin: the plain code-order rule. */
export const NO_COINS: IsCoin = () => false;

/**
 * The largest rate `NUMERIC(20,10)` holds is just under 1e10; a stored rate at
 * or above it overflows the column and fails the whole statement.
 */
export const MAX_STORED_RATE = 1e10;

/**
 * Whether `from -> to` is the orientation a pair is stored in.
 *
 * **A pair with exactly one coin side is stored coin -> fiat**, whichever code
 * sorts first. A coin is worth many units of a fiat, so the coin -> fiat rate
 * is large and the fiat -> coin rate tiny: `XBT -> IDR` at 1.52e9 is
 * `IDR -> XBT` at 6.6e-10, which ten decimal places keep as `0.0000000007`
 * and which resolves back to 1.43e9, 6% off. Stored coin-first, the rate keeps
 * every significant figure the provider sent (docs/specs/
 * exchange-rate-canonical-orientation.md, addendum 2026-11-05).
 *
 * **Two fiats, or two coins, keep plain code-point order**, which is what
 * `[from, to].sort()` gives for the three-letter uppercase codes this table
 * holds. The rule has to be user-independent: "foreign to the reporting
 * currency" would orient a shared table by whichever user's refresh ran first.
 * `currencies.kind` is global reference data, so the coin rule is too.
 */
export function isCanonicalOrientation(
  from: string,
  to: string,
  isCoin: IsCoin = NO_COINS,
): boolean {
  const fromCoin = isCoin(from);
  const toCoin = isCoin(to);
  if (fromCoin !== toCoin) return fromCoin;
  return from < to;
}

/**
 * The pair in plain code-point order, ignoring currency kind: how
 * `exchange_rate_coverage` keys a pair (its CHECK is `from_currency <
 * to_currency`) and how `directionlessPairKey` names one unit of work.
 *
 * Deliberately not the storage orientation. A coverage row and a pair key
 * answer "which pair", not "which direction is stored": a rate window covers
 * both directions, and a key that moved with `currencies.kind` would orphan a
 * coverage row (and a remembered empty window) the day a currency changed kind.
 * Code order is a property of the two codes alone, so it can never disagree
 * with the CHECK.
 */
export function codeOrderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** A row as it is stored: the canonical orientation and the rate for it. */
export interface CanonicalRateRow {
  from: string;
  to: string;
  rate: number;
}

/**
 * Why an observation has no row to store, or `null` when it has one:
 *
 * - `not_a_pair`: a code is empty, or both are the same code (1 is not an
 *   observation; `resolveFxRate` answers a same-currency lookup without
 *   reading anything);
 * - `not_a_rate`: zero, negative, `NaN` or infinite -- absent, not applicable,
 *   because multiplying by them reports a real holding as worthless or inverts
 *   its sign (INV-FX-001);
 * - `out_of_range`: the rate as stored would be at or above `MAX_STORED_RATE`
 *   (the column overflows) or rounds to zero at ten decimals (it would store
 *   a rate of nothing). A caller reports the pair and carries on; one such
 *   pair never fails a batch.
 */
export type CanonicalRateRefusal = "not_a_pair" | "not_a_rate" | "out_of_range";

export function canonicalRateRefusal(
  from: string,
  to: string,
  rate: number,
  isCoin: IsCoin = NO_COINS,
): CanonicalRateRefusal | null {
  if (!from || !to || from === to) return "not_a_pair";
  if (!Number.isFinite(rate) || rate <= 0) return "not_a_rate";
  const stored = roundFxRate(storedRate(from, to, rate, isCoin));
  if (stored >= MAX_STORED_RATE || stored <= 0) {
    return "out_of_range";
  }
  return null;
}

/**
 * The row to store for an observation of `from -> to` at `rate`, or `null` when
 * there is nothing to store (`canonicalRateRefusal` says why).
 *
 * A non-canonical observation is inverted at the rate column's own precision,
 * ten decimals, never money precision: 1 / 1.3652 rounded to four places is
 * 0.7325, which converts back to 1.3661, an error a statement quoting six
 * decimals shows up immediately. At ten places the absolute round-trip error
 * of a fiat rate is below 1e-9; a rate whose inverse is itself tiny keeps few
 * significant figures, which is why a coin pair is stored coin-first.
 */
export function canonicalRateRow(
  from: string,
  to: string,
  rate: number,
  isCoin: IsCoin = NO_COINS,
): CanonicalRateRow | null {
  if (canonicalRateRefusal(from, to, rate, isCoin) !== null) return null;

  return isCanonicalOrientation(from, to, isCoin)
    ? { from, to, rate }
    : { from: to, to: from, rate: storedRate(from, to, rate, isCoin) };
}

/** The rate as the canonical row would carry it, before the range check. */
function storedRate(
  from: string,
  to: string,
  rate: number,
  isCoin: IsCoin,
): number {
  return isCanonicalOrientation(from, to, isCoin)
    ? rate
    : roundFxRate(1 / rate);
}
