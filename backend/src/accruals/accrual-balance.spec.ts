import { accrualBalancesAt } from "./accrual-balance";
import { buildAccrualPlan } from "./accrual-allocation";
describe("batch historical timing balances", () => {
  it("preserves requested order and duplicates with exact monthly balances", () => {
    const plan = buildAccrualPlan("2026-06-15", "-1200", 2, { preset: "NTM" });
    expect(
      accrualBalancesAt("expense", "2026-06-15", plan, [
        "2026-07-31",
        "2026-06-14",
        "2026-06-30",
        "2026-07-31",
        "2027-05-31",
      ]),
    ).toEqual(["1000.0000", "0.0000", "1100.0000", "1000.0000", "0.0000"]);
  });
  it("recognizes income correctly even if stored rows arrive out of date order", () => {
    const plan = buildAccrualPlan("2026-06-15", "1200", 2, { preset: "LTM" });
    expect(
      accrualBalancesAt(
        "income",
        "2026-06-15",
        { ...plan, allocations: [...plan.allocations].reverse() },
        ["2026-05-31", "2026-06-15", "2026-06-30"],
      ),
    ).toEqual(["-1100.0000", "100.0000", "0.0000"]);
  });
  it("refuses an invalid requested calendar date", () => {
    const plan = buildAccrualPlan("2026-06-15", "100", 2, { preset: "NTM" });
    expect(() =>
      accrualBalancesAt("income", "2026-06-15", plan, ["2026-02-30"]),
    ).toThrow();
  });
});
