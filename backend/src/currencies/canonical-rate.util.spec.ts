import { roundFxRate } from "../common/fx-entry.util";
import {
  DatedRate,
  resolveFxRate,
} from "../common/time-series/fx-rate-resolver";
import {
  MAX_STORED_RATE,
  canonicalRateRefusal,
  canonicalRateRow,
  codeOrderedPair,
  isCanonicalOrientation,
} from "./canonical-rate.util";

/**
 * The truth table in `docs/specs/exchange-rate-canonical-orientation.md`
 * section 4. The property that matters is that two observations of one pair --
 * one given each way -- produce rows with the same key, so they cannot sit in
 * the table disagreeing with each other.
 */
describe("canonicalRateRow", () => {
  it("keeps an observation that is already canonical", () => {
    expect(canonicalRateRow("CAD", "USD", 0.7143)).toEqual({
      from: "CAD",
      to: "USD",
      rate: 0.7143,
    });
  });

  it("swaps and inverts an observation stored the other way", () => {
    expect(canonicalRateRow("USD", "CAD", 1.4)).toEqual({
      from: "CAD",
      to: "USD",
      rate: roundFxRate(1 / 1.4),
    });
  });

  it("inverts at rate precision, not money precision", () => {
    // 1 / 1.3652 at four places is 0.7325, which converts back to 1.3661 -- an
    // error a statement quoting six decimals reconciles against by cents.
    const row = canonicalRateRow("USD", "CAD", 1.3652);

    expect(row?.rate).toBe(roundFxRate(1 / 1.3652));
    expect(row?.rate).not.toBe(0.7325);
    expect(roundFxRate(1 / (row as { rate: number }).rate)).toBeCloseTo(
      1.3652,
      9,
    );
  });

  it("gives both directions of one observation the same key", () => {
    const direct = canonicalRateRow("USD", "CAD", 1.4);
    const reverse = canonicalRateRow("CAD", "USD", roundFxRate(1 / 1.4));

    expect(direct?.from).toBe(reverse?.from);
    expect(direct?.to).toBe(reverse?.to);
    expect(direct?.rate).toBeCloseTo(reverse?.rate as number, 9);
  });

  it("is idempotent: canonicalising its own output changes nothing", () => {
    const once = canonicalRateRow("USD", "CAD", 1.4);
    const twice = canonicalRateRow(
      (once as CanonicalRow).from,
      (once as CanonicalRow).to,
      (once as CanonicalRow).rate,
    );

    expect(twice).toEqual(once);
  });

  it("has nothing to store for a same-currency pair", () => {
    // 1 is not an observation: a same-currency lookup is answered without
    // reading the history at all (INV-FX-001).
    expect(canonicalRateRow("USD", "USD", 1)).toBeNull();
  });

  it("treats a non-positive rate as absent rather than applicable", () => {
    expect(canonicalRateRow("USD", "CAD", 0)).toBeNull();
    expect(canonicalRateRow("USD", "CAD", -1.4)).toBeNull();
  });

  it("refuses a rate that is not a finite number", () => {
    expect(canonicalRateRow("USD", "CAD", Number.NaN)).toBeNull();
    expect(canonicalRateRow("USD", "CAD", Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("has nothing to store when a code is missing", () => {
    expect(canonicalRateRow("", "CAD", 1.4)).toBeNull();
    expect(canonicalRateRow("USD", "", 1.4)).toBeNull();
  });
});

interface CanonicalRow {
  from: string;
  to: string;
  rate: number;
}

describe("isCanonicalOrientation", () => {
  it("orders a pair by its codes", () => {
    expect(isCanonicalOrientation("CAD", "USD")).toBe(true);
    expect(isCanonicalOrientation("USD", "CAD")).toBe(false);
  });

  it("agrees with the sort the directionless pair key uses", () => {
    for (const [a, b] of [
      ["USD", "CAD"],
      ["EUR", "PLN"],
      ["GBP", "USD"],
      ["JPY", "AUD"],
    ]) {
      const [first, second] = [a, b].sort();
      expect(isCanonicalOrientation(first, second)).toBe(true);
    }
  });
});

/**
 * The coin rule (`docs/specs/exchange-rate-canonical-orientation.md`, addendum
 * 2026-11-05): a pair with exactly one CRYPTO side is stored coin -> fiat
 * whichever code sorts first, because the fiat -> coin rate of an expensive
 * coin keeps too few significant figures at ten decimals.
 */
describe("the coin rule", () => {
  const isCoin = (code: string) => ["XBT", "BTC", "ETH"].includes(code);

  it("stores XBT->IDR as observed although IDR sorts first", () => {
    expect(canonicalRateRow("XBT", "IDR", 1.52e9, isCoin)).toEqual({
      from: "XBT",
      to: "IDR",
      rate: 1.52e9,
    });
  });

  it("turns an IDR->XBT observation round to the coin side", () => {
    const row = canonicalRateRow("IDR", "XBT", 1 / 1.52e9, isCoin);

    expect(row?.from).toBe("XBT");
    expect(row?.to).toBe("IDR");
    expect(Math.abs((row as CanonicalRow).rate - 1.52e9) / 1.52e9).toBeLessThan(
      1e-9,
    );
  });

  it("is what goes wrong without it: fiat-first loses the price", () => {
    // Stored IDR->XBT at ten decimals is 0.0000000007, which resolves back to
    // 1.43e9 -- 6% below the 1.52e9 the provider sent.
    const row = canonicalRateRow("XBT", "IDR", 1.52e9);
    expect(row).toEqual({ from: "IDR", to: "XBT", rate: 0.0000000007 });
    expect(1 / (row as CanonicalRow).rate).toBeLessThan(1.44e9);
  });

  it("resolves IDR->XBT from the coin-first row within 1e-9 relative", () => {
    const row = canonicalRateRow("XBT", "IDR", 1.52e9, isCoin) as CanonicalRow;
    const stored: Record<string, DatedRate[]> = {
      [`${row.from}->${row.to}`]: [{ date: "2026-11-05", rate: row.rate }],
    };
    const lookup = (from: string, to: string) => stored[`${from}->${to}`];

    const inverse = resolveFxRate("IDR", "XBT", "2026-11-05", lookup, {
      today: "2026-11-05",
    });
    const direct = resolveFxRate("XBT", "IDR", "2026-11-05", lookup, {
      today: "2026-11-05",
    });

    expect(inverse.direction).toBe("inverse");
    const expected = 1 / 1.52e9;
    expect(
      Math.abs((inverse.rate as number) - expected) / expected,
    ).toBeLessThan(1e-9);
    expect(direct.rate).toBe(1.52e9);
  });

  it("leaves BTC/EUR exactly as before: BTC sorts first and is the coin", () => {
    expect(canonicalRateRow("BTC", "EUR", 91000, isCoin)).toEqual(
      canonicalRateRow("BTC", "EUR", 91000),
    );
    expect(canonicalRateRow("EUR", "BTC", 1 / 91000, isCoin)).toEqual(
      canonicalRateRow("EUR", "BTC", 1 / 91000),
    );
  });

  it("keeps code order for two fiats and for two coins", () => {
    expect(isCanonicalOrientation("CAD", "USD", isCoin)).toBe(true);
    expect(isCanonicalOrientation("USD", "CAD", isCoin)).toBe(false);
    expect(isCanonicalOrientation("BTC", "ETH", isCoin)).toBe(true);
    expect(isCanonicalOrientation("ETH", "BTC", isCoin)).toBe(false);
  });

  it("puts the coin first whichever way the pair is asked", () => {
    expect(isCanonicalOrientation("XBT", "IDR", isCoin)).toBe(true);
    expect(isCanonicalOrientation("IDR", "XBT", isCoin)).toBe(false);
    expect(isCanonicalOrientation("XBT", "IDR")).toBe(false);
  });
});

describe("a rate the column cannot hold", () => {
  it("is null at or above 1e10 as stored", () => {
    expect(canonicalRateRow("BTC", "LBP", 1.1e10)).toBeNull();
    expect(canonicalRateRefusal("BTC", "LBP", 1.1e10)).toBe("out_of_range");
    expect(canonicalRateRow("BTC", "LBP", MAX_STORED_RATE)).toBeNull();
  });

  it("is null when the observation inverts to one at or above 1e10", () => {
    const isCoin = (code: string) => code === "BTC";
    expect(canonicalRateRow("LBP", "BTC", 1 / 1.1e10, isCoin)).toBeNull();
  });

  it("is null when the stored rate rounds to zero at ten decimals", () => {
    expect(canonicalRateRow("AAA", "ZZZ", 1e-12)).toBeNull();
    expect(canonicalRateRefusal("AAA", "ZZZ", 1e-12)).toBe("out_of_range");
  });

  it("names the other refusals apart from it", () => {
    expect(canonicalRateRefusal("USD", "USD", 1)).toBe("not_a_pair");
    expect(canonicalRateRefusal("USD", "CAD", 0)).toBe("not_a_rate");
    expect(canonicalRateRefusal("USD", "CAD", 1.4)).toBeNull();
  });

  it("still stores a rate just inside the column", () => {
    expect(canonicalRateRow("BTC", "LBP", 9.9e9)).toEqual({
      from: "BTC",
      to: "LBP",
      rate: 9.9e9,
    });
  });
});

describe("codeOrderedPair", () => {
  it("is plain code order whatever the kind, as exchange_rate_coverage's CHECK requires", () => {
    expect(codeOrderedPair("XBT", "IDR")).toEqual(["IDR", "XBT"]);
    expect(codeOrderedPair("IDR", "XBT")).toEqual(["IDR", "XBT"]);
    expect(codeOrderedPair("CAD", "USD")).toEqual(["CAD", "USD"]);
  });
});
