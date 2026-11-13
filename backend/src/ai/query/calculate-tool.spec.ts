import {
  executeCalculation,
  executeConversion,
  CalculateInput,
  DatedConverter,
} from "./calculate-tool";

jest.mock("../../common/date-utils", () => ({
  ...jest.requireActual("../../common/date-utils"),
  todayYMD: jest.fn(() => "2026-09-10"),
}));

describe("executeCalculation", () => {
  describe("percentage", () => {
    it("computes percentage correctly", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [300, 5000],
      });

      expect(result).toEqual({
        result: 6,
        formattedResult: "6%",
        operation: "percentage",
      });
    });

    it("rounds only the display: result keeps the full quotient", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [1, 3],
      });

      expect(result).toEqual({
        result: 33.333333333333336,
        formattedResult: "33.33%",
        operation: "percentage",
      });
    });

    it("works on the decimal values, not their binary doubles", () => {
      // (0.07 / 0.1) * 100 is 70.00000000000001 in floats.
      const result = executeCalculation({
        operation: "percentage",
        values: [0.07, 0.1],
      });

      expect(result).toMatchObject({ result: 70, formattedResult: "70%" });
    });

    it("returns error when divisor is zero", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [100, 0],
      });

      expect(result).toEqual({
        error: "Cannot calculate percentage: divisor is zero.",
      });
    });

    it("returns error with fewer than 2 values", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [100],
      });

      expect(result).toEqual({
        error: "Percentage requires exactly 2 values: [part, whole].",
      });
    });

    it("handles negative values", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [-200, 1000],
      });

      expect(result).toEqual({
        result: -20,
        formattedResult: "-20%",
        operation: "percentage",
      });
    });
  });

  describe("difference", () => {
    it("computes difference correctly", () => {
      const result = executeCalculation({
        operation: "difference",
        values: [1500, 1200],
      });

      expect(result).toEqual({
        result: 300,
        formattedResult: "300.00",
        operation: "difference",
      });
    });

    it("handles negative result", () => {
      const result = executeCalculation({
        operation: "difference",
        values: [500, 800],
      });

      expect(result).toEqual({
        result: -300,
        formattedResult: "-300.00",
        operation: "difference",
      });
    });

    it("displays a cent midpoint half away from zero, like roundToDecimals", () => {
      // 1.005 * 100 is 100.49999999999999 in binary, so the local
      // Math.round(x * 100) / 100 this tool once had answered 1.00.
      const result = executeCalculation({
        operation: "difference",
        values: [1.005, 0],
      });

      expect(result).toMatchObject({ result: 1.005, formattedResult: "1.01" });
    });

    it("displays a negative cent midpoint half away from zero", () => {
      const result = executeCalculation({
        operation: "difference",
        values: [0, 1.005],
      });

      expect(result).toMatchObject({
        result: -1.005,
        formattedResult: "-1.01",
      });
    });

    it("is exact where floats drift", () => {
      // 0.3 - 0.1 is 0.19999999999999998 in floats.
      const result = executeCalculation({
        operation: "difference",
        values: [0.3, 0.1],
      });

      expect(result).toMatchObject({ result: 0.2, formattedResult: "0.20" });
    });

    it("never displays a sub-cent negative as -0.00", () => {
      const result = executeCalculation({
        operation: "difference",
        values: [0, 0.001],
      });

      expect(result).toMatchObject({ result: -0.001, formattedResult: "0.00" });
    });

    it("returns error with fewer than 2 values", () => {
      const result = executeCalculation({
        operation: "difference",
        values: [100],
      });

      expect(result).toEqual({
        error: "Difference requires exactly 2 values: [a, b].",
      });
    });
  });

  describe("ratio", () => {
    it("computes ratio correctly", () => {
      const result = executeCalculation({
        operation: "ratio",
        values: [5000, 3000],
      });

      expect(result).toEqual({
        result: 1.6666666666666667,
        formattedResult: "1.67:1",
        operation: "ratio",
      });
    });

    it("returns the unrounded ratio (Discussion #2136)", () => {
      const result = executeCalculation({
        operation: "ratio",
        values: [1.2345, 1],
      });

      expect(result).toMatchObject({
        result: 1.2345,
        formattedResult: "1.23:1",
      });
    });

    it("returns error when divisor is zero", () => {
      const result = executeCalculation({
        operation: "ratio",
        values: [100, 0],
      });

      expect(result).toEqual({
        error: "Cannot calculate ratio: divisor is zero.",
      });
    });

    it("returns error with fewer than 2 values", () => {
      const result = executeCalculation({
        operation: "ratio",
        values: [100],
      });

      expect(result).toEqual({
        error: "Ratio requires exactly 2 values: [a, b].",
      });
    });
  });

  describe("sum", () => {
    it("computes sum correctly", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [100, 200, 300],
      });

      expect(result).toEqual({
        result: 600,
        formattedResult: "600.00",
        operation: "sum",
      });
    });

    it("avoids floating-point drift", () => {
      // 0.1 + 0.2 would be 0.30000000000000004 with naive addition
      const result = executeCalculation({
        operation: "sum",
        values: [0.1, 0.2],
      });

      expect(result).toEqual({
        result: 0.3,
        formattedResult: "0.30",
        operation: "sum",
      });
    });

    it("handles many values with potential drift", () => {
      // Ten values of 0.1 should sum to exactly 1.0
      const result = executeCalculation({
        operation: "sum",
        values: Array(10).fill(0.1),
      });

      expect(result).toEqual({
        result: 1,
        formattedResult: "1.00",
        operation: "sum",
      });
    });

    it("does not round the inputs or the total (Discussion #2136)", () => {
      // sumMoney once rounded each input to 4 places and the tool then the
      // total to 2, so this answered 0.01 while [0.00492, 0] as a
      // difference answered 0: one value, two answers.
      const sum = executeCalculation({
        operation: "sum",
        values: [0.00246, 0.00246],
      });
      const difference = executeCalculation({
        operation: "difference",
        values: [0.00492, 0],
      });

      expect(sum).toMatchObject({ result: 0.00492, formattedResult: "0.00" });
      expect(difference).toMatchObject({
        result: 0.00492,
        formattedResult: "0.00",
      });
    });

    it("keeps eight-place amounts exact", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [0.00000001, 0.00002499, 1e-9],
      });

      expect(result).toMatchObject({ result: 0.000025001 });
    });

    it("handles large values", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [999999999.99, 0.01],
      });

      expect(result).toEqual({
        result: 1000000000,
        formattedResult: "1000000000.00",
        operation: "sum",
      });
    });
  });

  describe("average", () => {
    it("computes average correctly", () => {
      const result = executeCalculation({
        operation: "average",
        values: [100, 200, 300],
      });

      expect(result).toEqual({
        result: 200,
        formattedResult: "200.00",
        operation: "average",
      });
    });

    it("rounds to 2 decimal places", () => {
      const result = executeCalculation({
        operation: "average",
        values: [1, 2],
      });

      expect(result).toEqual({
        result: 1.5,
        formattedResult: "1.50",
        operation: "average",
      });
    });

    it("averages the exact sum, with no intermediate rounding", () => {
      const result = executeCalculation({
        operation: "average",
        values: [0.00246, 0.00246],
      });

      expect(result).toMatchObject({
        result: 0.00246,
        formattedResult: "0.00",
      });
    });

    it("keeps a repeating mean at double precision", () => {
      const result = executeCalculation({
        operation: "average",
        values: [0.1, 0.1, 0.2],
      });

      expect(result).toMatchObject({
        result: 0.13333333333333333,
        formattedResult: "0.13",
      });
    });
  });

  describe("label", () => {
    it("includes label when provided", () => {
      const result = executeCalculation({
        operation: "percentage",
        values: [500, 5000],
        label: "savings rate",
      });

      expect(result).toEqual({
        result: 10,
        formattedResult: "10%",
        operation: "percentage",
        label: "savings rate",
      });
    });

    it("omits label when not provided", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [100, 200],
      });

      expect(result).not.toHaveProperty("label");
    });

    it("omits label when empty string (falsy)", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [1, 2],
        label: "",
      });
      expect(result).not.toHaveProperty("label");
    });
  });

  describe("edge cases", () => {
    it("returns error for empty values array", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [],
      });

      expect(result).toEqual({
        error: "At least one value is required.",
      });
    });

    it("returns error for a non-finite value", () => {
      const result = executeCalculation({
        operation: "sum",
        values: [1, Number.NaN],
      });

      expect(result).toEqual({
        error: "Every value must be a finite number.",
      });
    });

    it("returns error for unknown operation", () => {
      const result = executeCalculation({
        operation: "modulo" as CalculateInput["operation"],
        values: [10, 3],
      });

      expect(result).toEqual({
        error: "Unknown operation: modulo",
      });
    });
  });
});

describe("executeConversion", () => {
  let rates: { convertOnDate: jest.Mock } & DatedConverter;

  beforeEach(() => {
    rates = {
      convertOnDate: jest.fn().mockResolvedValue({
        amount: 1500,
        fromCurrency: "CAD",
        toCurrency: "USD",
        date: "2026-09-01",
        rate: 0.7325,
        convertedAmount: 1098.75,
      }),
    };
  });

  it("prices the amount through the domain service and reports both sides", async () => {
    const result = await executeConversion(
      {
        values: [1500],
        fromCurrency: "cad",
        toCurrency: "usd",
        date: "2026-09-01",
        label: "rent in USD",
      },
      rates,
    );

    expect(rates.convertOnDate).toHaveBeenCalledWith(
      1500,
      "cad",
      "usd",
      "2026-09-01",
    );
    expect(result).toEqual({
      result: 1098.75,
      formattedResult: "1098.75 USD",
      operation: "convert",
      label: "rent in USD",
      amount: 1500,
      fromCurrency: "CAD",
      toCurrency: "USD",
      date: "2026-09-01",
      rate: 0.7325,
    });
  });

  it("defaults the date to today", async () => {
    await executeConversion(
      { values: [1], fromCurrency: "CAD", toCurrency: "USD" },
      rates,
    );

    expect(rates.convertOnDate).toHaveBeenCalledWith(
      1,
      "CAD",
      "USD",
      "2026-09-10",
    );
  });

  it("requires exactly one value", async () => {
    const result = await executeConversion(
      { values: [1, 2], fromCurrency: "CAD", toCurrency: "USD" },
      rates,
    );

    expect(result).toEqual({
      error: "Conversion requires exactly 1 value: [amount].",
    });
    expect(rates.convertOnDate).not.toHaveBeenCalled();
  });

  it("requires both currency codes, three letters each", async () => {
    const missing = await executeConversion(
      { values: [1], toCurrency: "USD" },
      rates,
    );
    const malformed = await executeConversion(
      { values: [1], fromCurrency: "CAD", toCurrency: "US$" },
      rates,
    );

    expect(missing).toHaveProperty(
      "error",
      expect.stringContaining("fromCurrency"),
    );
    expect(malformed).toHaveProperty(
      "error",
      expect.stringContaining("toCurrency"),
    );
    expect(rates.convertOnDate).not.toHaveBeenCalled();
  });

  it("rejects a date that is not a calendar day", async () => {
    for (const date of ["2026-02-30", "2026-13-01", "20260101", "tomorrow"]) {
      const result = await executeConversion(
        { values: [1], fromCurrency: "CAD", toCurrency: "USD", date },
        rates,
      );
      expect(result).toHaveProperty("error", expect.stringContaining(date));
    }
    expect(rates.convertOnDate).not.toHaveBeenCalled();
  });

  it("is an error, not a pass-through, when no rate exists", async () => {
    rates.convertOnDate.mockResolvedValue(null);

    const result = await executeConversion(
      {
        values: [100],
        fromCurrency: "CAD",
        toCurrency: "XXX",
        date: "2026-09-01",
      },
      rates,
    );

    expect(result).toEqual({
      error: expect.stringContaining(
        "No exchange rate is available for CAD->XXX on 2026-09-01",
      ),
    });
  });
});
