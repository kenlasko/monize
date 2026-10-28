import { buildAccrualPlan } from "./accrual-allocation";
import { accrualBalanceAt } from "./accrual-balance";
import { formatAccrualMoney, parseAccrualMoney } from "./accrual-money";

describe("accrual allocation", () => {
  const custom = (amount: string, count: number, precision = 2) =>
    buildAccrualPlan("2026-10-15", amount, precision, {
      preset: "CUSTOM",
      startMonth: "2026-10",
      monthCount: count,
    });

  it("includes the payment month in LTM and NTM", () => {
    const ltm = buildAccrualPlan("2026-10-15", "-1200", 2, { preset: "LTM" });
    const ntm = buildAccrualPlan("2026-10-15", "-1200", 2, { preset: "NTM" });
    expect(ltm.allocations[0].recognitionDate).toBe("2025-11-30");
    expect(ltm.allocations[11].recognitionDate).toBe("2026-10-31");
    expect(ntm.allocations[0].recognitionDate).toBe("2026-10-31");
    expect(ntm.allocations[11].recognitionDate).toBe("2027-09-30");
  });

  it.each([
    ["100", ["33.3300", "33.3300", "33.3400"]],
    ["-100", ["-33.3300", "-33.3300", "-33.3400"]],
    ["0.01", ["0.0000", "0.0000", "0.0100"]],
    ["0", ["0.0000", "0.0000", "0.0000"]],
  ])("places the exact remainder last for %s", (amount, expected) => {
    expect(
      custom(amount as string, 3).allocations.map((row) => row.amount),
    ).toEqual(expected);
  });

  it("preserves the full decimal(20,4) range without Number conversion", () => {
    const amount = "9999999999999999.9999";
    const plan = custom(amount, 600);
    expect(
      plan.allocations.reduce(
        (sum, row) => sum + parseAccrualMoney(row.amount),
        0n,
      ),
    ).toBe(99_999_999_999_999_999_999n);
    expect(plan.amount).toBe(amount);
  });

  it.each([
    [0, "100", ["33.0000", "33.0000", "34.0000"]],
    [3, "1", ["0.3330", "0.3330", "0.3340"]],
    [2, "1.0001", ["0.3333", "0.3333", "0.3335"]],
  ])("respects precision %s", (precision, amount, expected) => {
    expect(
      custom(amount as string, 3, precision as number).allocations.map(
        (row) => row.amount,
      ),
    ).toEqual(expected);
  });

  it.each([
    ["2024-02", "2024-02-29"],
    ["2100-02", "2100-02-28"],
    ["2000-02", "2000-02-29"],
    ["0099-02", "0099-02-28"],
    ["9999-12", "9999-12-31"],
  ])("recognizes on calendar month-end for %s", (startMonth, expected) => {
    const plan = buildAccrualPlan("2026-10-15", "1", 2, {
      preset: "CUSTOM",
      startMonth,
      monthCount: 1,
    });
    expect(plan.allocations[0].recognitionDate).toBe(expected);
  });

  it.each([
    ["2026-10", "2026-10-01"], // Thursday: day 1 is already a weekday
    ["2026-11", "2026-11-02"], // Sunday: pushes to Monday the 2nd
    ["2026-08", "2026-08-03"], // Saturday: pushes to Monday the 3rd
  ])(
    "recognizes on the first business day for %s when asked",
    (startMonth, expected) => {
      const plan = buildAccrualPlan("2026-10-15", "1", 2, {
        preset: "CUSTOM",
        startMonth,
        monthCount: 1,
        dateRule: "FIRST_BUSINESS_DAY",
      });
      expect(plan.allocations[0].recognitionDate).toBe(expected);
    },
  );

  it("respects the first-business-day rule across LTM and NTM", () => {
    const ltm = buildAccrualPlan("2026-10-15", "-1200", 2, {
      preset: "LTM",
      dateRule: "FIRST_BUSINESS_DAY",
    });
    const ntm = buildAccrualPlan("2026-10-15", "-1200", 2, {
      preset: "NTM",
      dateRule: "FIRST_BUSINESS_DAY",
    });
    expect(ltm.allocations[11].recognitionDate).toBe("2026-10-01");
    expect(ntm.allocations[0].recognitionDate).toBe("2026-10-01");
    expect(ntm.allocations[1].recognitionDate).toBe("2026-11-02");
  });

  it.each([0, -1, 601, 1.5, NaN, Infinity])(
    "rejects month count %s",
    (count) => {
      expect(() => custom("100", count)).toThrow("Invalid accrual month count");
    },
  );
  it.each([
    "",
    "1e3",
    "NaN",
    "Infinity",
    "0.00001",
    "10000000000000000",
    " 10",
    "+10",
  ])("refuses malformed or excessive precision amount %s", (amount) => {
    expect(() => custom(amount, 3)).toThrow();
  });
  it.each(["2026-02-30", "2026-13-01", "0000-01-01"])(
    "refuses invalid payment %s",
    (date) => {
      expect(() => buildAccrualPlan(date, "1", 2, { preset: "NTM" })).toThrow();
    },
  );
  it("refuses schedules outside the supported calendar", () => {
    expect(() =>
      buildAccrualPlan("0001-01-01", "1", 2, { preset: "LTM" }),
    ).toThrow();
    expect(() =>
      buildAccrualPlan("9999-12-31", "1", 2, { preset: "NTM" }),
    ).toThrow();
  });
  it.each([-1, 5, 1.5, NaN])(
    "refuses unsupported currency precision %s",
    (precision) => {
      expect(() => custom("1", 3, precision)).toThrow();
    },
  );
  it("conserves totals over every supported month count and both signs", () => {
    for (let count = 1; count <= 600; count++) {
      for (const amount of ["1234.56", "-1234.56", "0.0001"]) {
        const plan = custom(amount, count);
        expect(
          plan.allocations.reduce(
            (sum, row) => sum + parseAccrualMoney(row.amount),
            0n,
          ),
        ).toBe(parseAccrualMoney(amount));
      }
    }
  });
});

describe("historical timing balances", () => {
  const expense = buildAccrualPlan("2026-10-15", "-1200", 2, { preset: "NTM" });
  const income = buildAccrualPlan("2026-10-15", "1200", 2, { preset: "NTM" });
  it.each([
    ["2026-10-14", "0.0000"],
    ["2026-10-15", "1200.0000"],
    ["2026-10-31", "1100.0000"],
    ["2027-09-30", "0.0000"],
  ])("reports prepaid and unearned at %s", (asOf, expected) => {
    expect(accrualBalanceAt("expense", "2026-10-15", expense, asOf)).toBe(
      expected,
    );
    expect(accrualBalanceAt("income", "2026-10-15", income, asOf)).toBe(
      expected,
    );
  });
  it("nets backward expense recognition in prepaid without clamping", () => {
    const plan = buildAccrualPlan("2026-10-15", "-1200", 2, { preset: "LTM" });
    expect(accrualBalanceAt("expense", "2026-10-15", plan, "2026-09-30")).toBe(
      "-1100.0000",
    );
    expect(accrualBalanceAt("expense", "2026-10-15", plan, "2026-10-15")).toBe(
      "100.0000",
    );
    expect(accrualBalanceAt("expense", "2026-10-15", plan, "2026-10-31")).toBe(
      "0.0000",
    );
  });
  it("nets backward income in unearned", () => {
    const plan = buildAccrualPlan("2026-10-15", "1200", 2, { preset: "LTM" });
    expect(accrualBalanceAt("income", "2026-10-15", plan, "2026-09-30")).toBe(
      "-1100.0000",
    );
    expect(accrualBalanceAt("income", "2026-10-15", plan, "2026-10-31")).toBe(
      "0.0000",
    );
  });
  it("includes both payment and recognition on the same month-end", () => {
    expect(
      accrualBalanceAt("expense", "2026-10-31", expense, "2026-10-31"),
    ).toBe("1100.0000");
  });
  it("keeps refunds signed and avoids negative zero", () => {
    expect(
      accrualBalanceAt("expense", "2026-10-15", income, "2026-10-31"),
    ).toBe("-1100.0000");
    expect(formatAccrualMoney(parseAccrualMoney("-0.0000"))).toBe("0.0000");
  });
});
