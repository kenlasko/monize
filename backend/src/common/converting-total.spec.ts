import { convertingTotal, memoizedRateResolver } from "./converting-total";

/**
 * The arithmetic that turns a bucket of per-currency amounts into one total, or
 * refuses to.
 *
 * Tested here rather than only through its two callers, because the defect it
 * replaces was the block existing twice: a per-caller test proves the caller's
 * wiring, not the rule, and the second copy passed its own tests throughout.
 */
describe("convertingTotal", () => {
  const rates = (table: Record<string, number | null>) => ({
    getRateForDate: jest.fn(async (from: string, to: string) => {
      const value = table[`${from}->${to}`];
      return value === undefined ? null : value;
    }),
    getLatestRate: jest.fn(async () => null),
  });

  it("converts every component before summing", async () => {
    const source = rates({ "CAD->USD": 0.74 });
    const result = await convertingTotal(
      [
        { amount: 500, currency: "USD" },
        { amount: 1350, currency: "CAD" },
      ],
      "USD",
      memoizedRateResolver(source, "USD", "2026-03-01"),
    );
    // 500 + 1350 x 0.74 = 1499. Never 1850.
    expect(result.total).toBe(1499);
    expect(result.missingPairs).toEqual([]);
  });

  it("withholds the total and names the pair when a rate is missing", async () => {
    const source = rates({});
    const result = await convertingTotal(
      [
        { amount: 500, currency: "USD" },
        { amount: 1350, currency: "CAD" },
      ],
      "USD",
      memoizedRateResolver(source, "USD", "2026-03-01"),
    );
    expect(result.total).toBeNull();
    expect(result.knownSubtotal).toBe(500);
    expect(result.missingPairs).toEqual(["CAD->USD"]);
  });

  it("names no pair for a component whose own value is unknown", async () => {
    // Unknown in EVERY currency, so blaming a pair would send the reader to fix
    // a rate that is very likely already there.
    const source = rates({ "CAD->USD": 0.74 });
    const result = await convertingTotal(
      [
        { amount: null, currency: "CAD" },
        { amount: 500, currency: "USD" },
      ],
      "USD",
      memoizedRateResolver(source, "USD", "2026-03-01"),
    );
    expect(result.total).toBeNull();
    expect(result.knownSubtotal).toBe(500);
    expect(result.missingPairs).toEqual([]);
  });

  it("treats a non-positive rate as absent, not as a conversion", async () => {
    // Multiplying by zero converts a 1,350 bill to nothing and reports the total
    // complete -- a plausible 500 in place of an honest refusal.
    for (const rate of [0, -1.2]) {
      const result = await convertingTotal(
        [
          { amount: 500, currency: "USD" },
          { amount: 1350, currency: "CAD" },
        ],
        "USD",
        memoizedRateResolver(rates({ "CAD->USD": rate }), "USD", "2026-03-01"),
      );
      expect(result.total).toBeNull();
      expect(result.missingPairs).toEqual(["CAD->USD"]);
    }
  });

  it("needs no rate for a total already in the reporting currency", async () => {
    const source = rates({});
    const result = await convertingTotal(
      [{ amount: 500, currency: "USD" }],
      "USD",
      memoizedRateResolver(source, "USD", "2026-03-01"),
    );
    expect(result.total).toBe(500);
    expect(source.getRateForDate).not.toHaveBeenCalled();
  });

  it("is zero, not unknown, for an empty bucket", async () => {
    // An empty account holds zero, and reporting that as unknown tells the user
    // a settled question could not be worked out.
    const result = await convertingTotal(
      [],
      "USD",
      memoizedRateResolver(rates({}), "USD", "2026-03-01"),
    );
    expect(result.total).toBe(0);
  });

  it("applies the bucket's sign convention", async () => {
    const result = await convertingTotal(
      [
        { amount: -500, currency: "USD" },
        { amount: -1350, currency: "CAD" },
      ],
      "USD",
      memoizedRateResolver(rates({ "CAD->USD": 0.74 }), "USD", "2026-03-01"),
    );
    expect(result.total).toBe(-1499);

    const asMagnitudes = await convertingTotal(
      [
        { amount: -500, currency: "USD" },
        { amount: -1350, currency: "CAD" },
      ],
      "USD",
      memoizedRateResolver(rates({ "CAD->USD": 0.74 }), "USD", "2026-03-01"),
      (amount) => Math.abs(amount),
    );
    expect(asMagnitudes.total).toBe(1499);
  });

  it("accumulates at the storage scale rather than in floats", async () => {
    // Three thirds of a cent must not drift; `FxAggregate` accumulates in
    // ten-thousandths for this reason.
    const result = await convertingTotal(
      Array.from({ length: 3 }, () => ({ amount: 0.1, currency: "USD" })),
      "USD",
      memoizedRateResolver(rates({}), "USD", "2026-03-01"),
    );
    expect(result.total).toBe(0.3);
  });
  it("rounds once, from the unrounded parts (INV-REPORT-005)", async () => {
    // Three 1.25005 parts sum to 3.75015 -> 3.7502; rounding each part first gave 3.7503.
    const result = await convertingTotal(
      Array.from({ length: 3 }, () => ({ amount: 1, currency: "CAD" })),
      "USD",
      memoizedRateResolver(rates({ "CAD->USD": 1.25005 }), "USD", "2026-03-01"),
    );
    expect(result.total).toBe(3.7502);
    expect(result.knownSubtotal).toBe(3.7502);
  });
});

describe("memoizedRateResolver", () => {
  it("asks for a pair once, however many components share it", async () => {
    // Twelve CAD bills asked the identical question twelve times, in series, and
    // on a cold pair the first fetches a provider window while the rest wait.
    const source = {
      getRateForDate: jest.fn(async () => 0.74),
      getLatestRate: jest.fn(async () => null),
    };
    const rateFor = memoizedRateResolver(source, "USD", "2026-03-01");
    await convertingTotal(
      Array.from({ length: 12 }, () => ({ amount: 100, currency: "CAD" })),
      "USD",
      rateFor,
    );
    expect(source.getRateForDate).toHaveBeenCalledTimes(1);
  });

  it("shares one cache across the buckets a caller converts", async () => {
    // Two buckets holding the same unclassified occurrence would otherwise ask
    // for its pair twice.
    const source = {
      getRateForDate: jest.fn(async () => 0.74),
      getLatestRate: jest.fn(async () => null),
    };
    const rateFor = memoizedRateResolver(source, "USD", "2026-03-01");
    await convertingTotal([{ amount: 100, currency: "CAD" }], "USD", rateFor);
    await convertingTotal([{ amount: 200, currency: "CAD" }], "USD", rateFor);
    expect(source.getRateForDate).toHaveBeenCalledTimes(1);
  });
});
