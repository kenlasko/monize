import { reportingAmount } from "./reporting-money";
import type { RateIndex } from "../common/time-series/rate-index.util";

describe("Report money at the component date", () => {
  const source = { currencyCode: "USD", transactionDate: "2026-06-30" };
  const history: RateIndex = new Map([
    [
      "USD->EUR",
      [
        { date: "2026-06-30", rate: 0.8 },
        { date: "2026-07-31", rate: 0.9 },
      ],
    ],
  ]);
  it("retains recognition date and four decimal precision", () => {
    expect(reportingAmount(-100.0001, source, "EUR", history)).toBe(-80.0001);
    expect(
      reportingAmount(
        -100,
        { ...source, transactionDate: "2026-07-31" },
        "EUR",
        history,
      ),
    ).toBe(-90);
  });
  it("resolves inverse history and applicable source-entered rates", () => {
    expect(
      reportingAmount(
        -100,
        source,
        "EUR",
        new Map([["EUR->USD", [{ date: "2026-06-30", rate: 1.25 }]]]),
      ),
    ).toBe(-80);
    expect(
      reportingAmount(
        -125,
        { ...source, originalCurrencyCode: "EUR", exchangeRate: 1.25 },
        "EUR",
        new Map(),
      ),
    ).toBe(-100);
  });
  it("refuses future, stale or invalid rates, without turning unknown into zero", () => {
    for (const transactionDate of ["2026-06-15", "2026-09-30"])
      expect(() =>
        reportingAmount(100, { ...source, transactionDate }, "EUR", history),
      ).toThrow();
    expect(() => reportingAmount(NaN, source, "USD", new Map())).toThrow();
  });
  it("preserves refunds, zero and same-currency values", () => {
    expect(reportingAmount(100, source, "EUR", history)).toBe(80);
    expect(reportingAmount(0, source, "EUR", new Map())).toBe(0);
    expect(reportingAmount(-100.0001, source, "USD", new Map())).toBe(
      -100.0001,
    );
  });
});
