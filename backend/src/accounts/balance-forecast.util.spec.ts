import {
  ForecastOccurrenceInput,
  accumulateForecastDeltas,
  buildForecastSeries,
  forecastLanding,
} from "./balance-forecast.util";

/**
 * One occurrence as the projection receives it: already expanded, already
 * matched against its override and already priced. Expansion and override
 * selection are `common/scheduled-occurrences.ts`'s job and are tested there --
 * this module is the arithmetic that follows (issue #1247).
 */
function occurrence(
  overrides: Partial<ForecastOccurrenceInput> = {},
): ForecastOccurrenceInput {
  return {
    scheduledTransactionId: "st-1",
    name: "Rent",
    accountId: "acc-1",
    transferAccountId: null,
    dueDate: "2024-07-15",
    amount: -100,
    ...overrides,
  };
}

/** The deltas alone, for the cases that are not about gaps. */
function deltasOf(
  occurrences: ForecastOccurrenceInput[],
  accountId: string,
  actuals?: Map<string, number>,
): Map<string, number> {
  const { byDate, gaps } = accumulateForecastDeltas(
    occurrences,
    accountId,
    actuals,
  );
  expect(gaps).toEqual([]);
  return byDate;
}

describe("balance-forecast.util", () => {
  describe("accumulateForecastDeltas", () => {
    it("sums each occurrence onto the date it falls on", () => {
      const deltas = deltasOf(
        [
          occurrence({ dueDate: "2024-07-15" }),
          occurrence({ dueDate: "2024-08-15" }),
          occurrence({ dueDate: "2024-09-15" }),
        ],
        "acc-1",
      );

      expect([...deltas.keys()].sort()).toEqual([
        "2024-07-15",
        "2024-08-15",
        "2024-09-15",
      ]);
      expect(deltas.get("2024-08-15")).toBe(-100);
    });

    it("adds two occurrences that land on the same day", () => {
      const deltas = deltasOf(
        [
          occurrence({ amount: -100 }),
          occurrence({ scheduledTransactionId: "st-2", amount: -250 }),
        ],
        "acc-1",
      );

      expect(deltas.get("2024-07-15")).toBe(-350);
    });

    it("treats a transfer target as an inflow", () => {
      const deltas = deltasOf(
        [
          occurrence({
            accountId: "other",
            transferAccountId: "acc-1",
            amount: -250,
          }),
        ],
        "acc-1",
      );

      expect(deltas.get("2024-07-15")).toBe(250);
    });

    it("merges future-dated actuals", () => {
      const deltas = deltasOf(
        [occurrence({ dueDate: "2024-08-01" })],
        "acc-1",
        new Map([["2024-07-20", 500]]),
      );

      expect(deltas.get("2024-07-20")).toBe(500);
      expect(deltas.get("2024-08-01")).toBe(-100);
    });

    it("emits no point for a day whose net effect is zero", () => {
      // A transfer between two accounts, neither of which is this one, plus a
      // zero-amount reminder on the charted account.
      const deltas = deltasOf([occurrence({ amount: 0 })], "acc-1");

      expect([...deltas.keys()]).toEqual([]);
    });

    it("ignores an occurrence that does not touch this account", () => {
      const { byDate, gaps } = accumulateForecastDeltas(
        [occurrence({ accountId: "other", amount: null })],
        "acc-1",
      );

      expect([...byDate.keys()]).toEqual([]);
      expect(gaps).toEqual([]);
    });

    // ---- Unknown amounts (issue #1247) ----

    it("reports an unpriced occurrence as a gap instead of skipping it", () => {
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          occurrence({
            scheduledTransactionId: "st-inv",
            name: "Monthly ETF buy",
            amount: null,
            gapReason: "unresolvedSettlementRate",
            gapFromCurrency: "USD",
            gapToCurrency: "CAD",
          }),
        ],
        "acc-1",
      );

      // Nothing is added -- an unknown amount is not a zero.
      expect([...byDate.keys()]).toEqual([]);
      expect(gaps).toEqual([
        {
          scheduledTransactionId: "st-inv",
          name: "Monthly ETF buy",
          reason: "unresolvedSettlementRate",
          fromCurrency: "USD",
          toCurrency: "CAD",
        },
      ]);
    });

    it("reports one gap per schedule, not one per occurrence", () => {
      const { gaps } = accumulateForecastDeltas(
        [
          occurrence({ amount: null, dueDate: "2024-07-15" }),
          occurrence({ amount: null, dueDate: "2024-08-15" }),
          occurrence({ amount: null, dueDate: "2024-09-15" }),
        ],
        "acc-1",
      );

      // The reader needs the schedule named once, not three times.
      expect(gaps).toHaveLength(1);
    });

    it("defaults the reason when the caller named none", () => {
      const { gaps } = accumulateForecastDeltas(
        [occurrence({ amount: null })],
        "acc-1",
      );

      expect(gaps[0]).toEqual({
        scheduledTransactionId: "st-1",
        name: "Rent",
        reason: "unresolvedSettlementRate",
        fromCurrency: null,
        toCurrency: null,
      });
    });

    it("carries a cross-currency transfer's own reason", () => {
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          occurrence({
            accountId: "other",
            transferAccountId: "acc-1",
            amount: null,
            gapReason: "crossCurrencyTransfer",
            gapFromCurrency: "EUR",
            gapToCurrency: "CAD",
          }),
        ],
        "acc-1",
      );

      expect([...byDate.keys()]).toEqual([]);
      expect(gaps[0]).toMatchObject({
        reason: "crossCurrencyTransfer",
        fromCurrency: "EUR",
        toCurrency: "CAD",
      });
    });

    it("keeps the known occurrences of a schedule whose other occurrence is a gap", () => {
      // One unknown occurrence makes the SERIES unusable -- that decision is the
      // caller's. This function still reports the deltas it could compute, so
      // the caller can say which day the gap starts at.
      const { byDate, gaps } = accumulateForecastDeltas(
        [
          occurrence({ dueDate: "2024-07-15", amount: -100 }),
          occurrence({ dueDate: "2024-08-15", amount: null }),
        ],
        "acc-1",
      );

      expect(byDate.get("2024-07-15")).toBe(-100);
      expect(byDate.has("2024-08-15")).toBe(false);
      expect(gaps).toHaveLength(1);
    });
  });

  // Discussion #1784: an occurrence due and unposted is owed, not dropped.
  describe("forecastLanding", () => {
    it("keeps a future occurrence on its own date", () => {
      expect(forecastLanding("2024-07-15", "2024-07-08")).toEqual({
        date: "2024-07-15",
        overdue: false,
      });
    });

    it("moves an occurrence due before today onto tomorrow, as overdue", () => {
      expect(forecastLanding("2024-07-01", "2024-07-08")).toEqual({
        date: "2024-07-09",
        overdue: true,
      });
    });

    it("moves an occurrence due today onto tomorrow without calling it overdue", () => {
      expect(forecastLanding("2024-07-08", "2024-07-08")).toEqual({
        date: "2024-07-09",
        overdue: false,
      });
    });

    it("crosses a month boundary", () => {
      expect(forecastLanding("2024-07-30", "2024-07-31")).toEqual({
        date: "2024-08-01",
        overdue: true,
      });
    });
  });

  describe("accumulateForecastDeltas: overdue summary", () => {
    it("counts each overdue occurrence once and nets their effect", () => {
      const { byDate, overdue } = accumulateForecastDeltas(
        [
          occurrence({ dueDate: "2024-07-09", overdue: true, amount: -100 }),
          occurrence({ dueDate: "2024-07-09", overdue: true, amount: -50 }),
          occurrence({ dueDate: "2024-07-09", amount: -25 }),
        ],
        "acc-1",
      );
      expect(overdue).toEqual({ count: 2, amount: -150 });
      expect(byDate.get("2024-07-09")).toBe(-175);
    });

    it("signs an overdue transfer by the side this account is on", () => {
      const transfer = occurrence({
        accountId: "acc-1",
        transferAccountId: "acc-2",
        dueDate: "2024-07-09",
        overdue: true,
        amount: -300,
      });
      expect(accumulateForecastDeltas([transfer], "acc-1").overdue).toEqual({
        count: 1,
        amount: -300,
      });
      expect(accumulateForecastDeltas([transfer], "acc-2").overdue).toEqual({
        count: 1,
        amount: 300,
      });
    });

    it("ignores an overdue occurrence that does not touch this account", () => {
      const { overdue } = accumulateForecastDeltas(
        [occurrence({ accountId: "acc-9", overdue: true })],
        "acc-1",
      );
      expect(overdue).toEqual({ count: 0, amount: 0 });
    });

    it("counts an unpriced overdue occurrence and reports it as a gap", () => {
      const { gaps, overdue } = accumulateForecastDeltas(
        [occurrence({ overdue: true, amount: null })],
        "acc-1",
      );
      expect(gaps).toHaveLength(1);
      expect(overdue).toEqual({ count: 1, amount: 0 });
    });
  });

  describe("buildForecastSeries", () => {
    it("anchors at today and accumulates deltas", () => {
      const deltas = new Map([
        ["2024-07-15", -100],
        ["2024-08-15", -100],
      ]);
      const series = buildForecastSeries(
        1000,
        "2024-07-08",
        "2024-10-08",
        deltas,
      );
      expect(series).toEqual([
        { date: "2024-07-08", balance: 1000 },
        { date: "2024-07-15", balance: 900 },
        { date: "2024-08-15", balance: 800 },
      ]);
    });

    it("keeps a BTC wallet's running balance at its eight places (INV-MONEY-001)", () => {
      const { byDate, overdue } = accumulateForecastDeltas(
        [
          occurrence({ dueDate: "2024-07-15", amount: -0.000025 }),
          occurrence({ dueDate: "2024-07-15", amount: -0.0000321 }),
          occurrence({
            dueDate: "2024-07-08",
            amount: -0.0004321,
            overdue: true,
          }),
        ],
        "acc-1",
        new Map(),
        8,
      );
      expect(byDate.get("2024-07-15")).toBe(-0.0000571);
      expect(overdue.amount).toBe(-0.0004321);

      const series = buildForecastSeries(
        0.01249993,
        "2024-07-08",
        "2024-10-08",
        byDate,
        8,
      );
      // At four places the anchor read 0.0125 and the 2,500-sat fee vanished.
      expect(series).toEqual([
        { date: "2024-07-08", balance: 0.01249993 },
        { date: "2024-07-15", balance: 0.01244283 },
      ]);
    });

    it("rounds a fiat series at four places, as before", () => {
      const series = buildForecastSeries(
        100.00004,
        "2024-07-08",
        "2024-10-08",
        new Map([["2024-07-15", -0.00002]]),
      );
      expect(series).toEqual([
        { date: "2024-07-08", balance: 100 },
        { date: "2024-07-15", balance: 100 },
      ]);
    });

    it("returns just the anchor when there are no future deltas", () => {
      const series = buildForecastSeries(
        500,
        "2024-07-08",
        "2024-10-08",
        new Map(),
      );
      expect(series).toEqual([{ date: "2024-07-08", balance: 500 }]);
    });
  });
});
