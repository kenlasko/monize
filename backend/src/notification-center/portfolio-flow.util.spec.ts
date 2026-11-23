import { foldExternalFlow } from "./portfolio-flow.util";

describe("foldExternalFlow", () => {
  const rateFor = (rates: Record<string, number | null>) => (c: string) =>
    c in rates ? rates[c] : null;

  it("sums a single reporting-currency flow with no conversion", () => {
    const folded = foldExternalFlow(
      [{ currency: "USD", amount: 12_000 }],
      "USD",
      rateFor({}),
    );
    expect(folded).toEqual({ complete: true, value: 12_000, missingPairs: [] });
  });

  it("converts a foreign flow through the rate", () => {
    const folded = foldExternalFlow(
      [
        { currency: "USD", amount: 1_000 },
        { currency: "EUR", amount: 500 },
      ],
      "USD",
      rateFor({ EUR: 1.1 }),
    );
    expect(folded.complete).toBe(true);
    expect(folded.value).toBe(1_550); // 1000 + 500*1.1
  });

  it("folds large flows that cancel to exactly zero (Discussion #2343)", () => {
    // 300000000000.03 * 10000 is 3000000000000300.5 in doubles, which the
    // float scaling rounded up for the deposit and toward zero for the
    // withdrawal, leaving 0.0001.
    const folded = foldExternalFlow(
      [
        { currency: "USD", amount: 300_000_000_000.03 },
        { currency: "USD", amount: -300_000_000_000.03 },
      ],
      "USD",
      rateFor({}),
    );
    expect(folded).toEqual({ complete: true, value: 0, missingPairs: [] });
  });

  it("marks the flow incomplete when a currency has no rate", () => {
    const folded = foldExternalFlow(
      [
        { currency: "USD", amount: 1_000 },
        { currency: "JPY", amount: 100_000 },
      ],
      "USD",
      rateFor({ JPY: null }),
    );
    expect(folded.complete).toBe(false);
    expect(folded.missingPairs).toEqual(["JPY->USD"]);
  });

  it("treats a zero or negative rate as missing, never as applicable", () => {
    const folded = foldExternalFlow(
      [{ currency: "EUR", amount: 500 }],
      "USD",
      rateFor({ EUR: 0 }),
    );
    expect(folded.complete).toBe(false);
    expect(folded.missingPairs).toEqual(["EUR->USD"]);
  });

  it("skips a zero subtotal without needing a rate", () => {
    const folded = foldExternalFlow(
      [{ currency: "GBP", amount: 0 }],
      "USD",
      rateFor({}),
    );
    expect(folded).toEqual({ complete: true, value: 0, missingPairs: [] });
  });

  it("prices each dated subtotal at its own date's rate, never one date's", () => {
    // INV-PORTMOVE-007. A Saturday deposit and a Monday deposit in the same
    // currency: 1.30 and 1.40. Folding both at Monday's rate would report
    // 1000*1.4 + 1000*1.4 = 2,800 and call the 100 difference a market move.
    const perDate: Record<string, number> = {
      "2026-09-12": 1.3,
      "2026-09-14": 1.4,
    };
    const folded = foldExternalFlow(
      [
        { date: "2026-09-12", currency: "CAD", amount: 1_000 },
        { date: "2026-09-14", currency: "CAD", amount: 1_000 },
      ],
      "USD",
      (_currency, date) => (date === null ? null : (perDate[date] ?? null)),
    );
    expect(folded.complete).toBe(true);
    expect(folded.value).toBe(2_700);
  });

  it("withholds when one day's rate is missing, and names that day", () => {
    const folded = foldExternalFlow(
      [
        { date: "2026-09-12", currency: "CAD", amount: 1_000 },
        { date: "2026-09-14", currency: "CAD", amount: 1_000 },
      ],
      "USD",
      (_currency, date) => (date === "2026-09-14" ? 1.4 : null),
    );
    // A cause a reader can act on: the pair AND the day it is missing for.
    expect(folded.complete).toBe(false);
    expect(folded.missingPairs).toEqual(["CAD->USD on 2026-09-12"]);
  });

  it("needs no rate for the reporting currency on any date", () => {
    const folded = foldExternalFlow(
      [
        { date: "2026-09-12", currency: "USD", amount: 1_000 },
        { date: "2026-09-14", currency: "USD", amount: 500 },
      ],
      "USD",
      () => null,
    );
    expect(folded).toEqual({ complete: true, value: 1_500, missingPairs: [] });
  });

  it("does not drift when many dated subtotals are folded", () => {
    // Accumulating floats across 300 days leaves a tail that roundMoney at the
    // end cannot recover; the fold sums integer 1/10000 units and divides once.
    const rows = Array.from({ length: 300 }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      currency: "CAD",
      amount: 0.1,
    }));
    const folded = foldExternalFlow(rows, "USD", () => 1.1);
    expect(folded.value).toBe(33);
  });

  it("keeps a withdrawal's sign", () => {
    const folded = foldExternalFlow(
      [{ currency: "USD", amount: -5_000 }],
      "USD",
      rateFor({}),
    );
    expect(folded.value).toBe(-5_000);
  });
});
