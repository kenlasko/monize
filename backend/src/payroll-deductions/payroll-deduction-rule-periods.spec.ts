import { EntityManager } from "typeorm";
import {
  deleteRulePeriodsAfter,
  figuresForPeriod,
  loadRulePeriods,
  writeRulePeriod,
} from "./payroll-deduction-rule-periods";

const USER = "11111111-1111-4111-8111-111111111111";

describe("payroll deduction rule periods (spec section 11)", () => {
  describe("figuresForPeriod (truth table D)", () => {
    const rule = {
      yearlyMaximum: 1000,
      expectedPerPaycheque: 50,
      periods: [
        {
          periodStart: "2027-01-01",
          yearlyMaximum: 1200,
          expectedPerPaycheque: null,
        },
        {
          periodStart: "2026-01-01",
          yearlyMaximum: 1100,
          expectedPerPaycheque: 55,
        },
      ],
    };

    it.each([
      ["2025-01-01", 1000, 50, null, false],
      ["2026-01-01", 1100, 55, "2026-01-01", true],
      ["2027-01-01", 1200, null, "2027-01-01", true],
      ["2028-01-01", 1200, null, "2027-01-01", true],
    ])(
      "the period starting %s uses %d",
      (periodStart, max, expected, from, recorded) => {
        expect(figuresForPeriod(rule, periodStart)).toEqual({
          yearlyMaximum: max,
          expectedPerPaycheque: expected,
          fromPeriodStart: from,
          recorded,
        });
      },
    );

    it("reads the columns when the rule has no rows", () => {
      expect(
        figuresForPeriod(
          {
            yearlyMaximum: "1077.4800" as unknown as number,
            expectedPerPaycheque: null,
          },
          "2026-01-01",
        ),
      ).toEqual({
        yearlyMaximum: 1077.48,
        expectedPerPaycheque: null,
        fromPeriodStart: null,
        recorded: false,
      });
    });
  });

  it("loads nothing for no rules and groups rows by rule", async () => {
    const query = jest.fn(async () => [
      {
        rule_id: "r1",
        period_start: "2026-01-01",
        yearly_maximum: "10.0000",
        expected_per_paycheque: null,
      },
      {
        rule_id: "r1",
        period_start: "2027-01-01",
        yearly_maximum: "12.0000",
        expected_per_paycheque: "2.5000",
      },
    ]);
    const m = { query } as unknown as EntityManager;
    expect((await loadRulePeriods(m, [])).size).toBe(0);
    expect(query).not.toHaveBeenCalled();
    const loaded = await loadRulePeriods(m, ["r1"]);
    expect(loaded.get("r1")).toEqual([
      {
        periodStart: "2026-01-01",
        yearlyMaximum: 10,
        expectedPerPaycheque: null,
      },
      {
        periodStart: "2027-01-01",
        yearlyMaximum: 12,
        expectedPerPaycheque: 2.5,
      },
    ]);
  });

  it("upserts on (rule, period start) and deletes one period's row", async () => {
    const query = jest.fn(
      async (_sql: string, _params: unknown[]) => [] as unknown[],
    );
    const m = { query } as unknown as EntityManager;
    await writeRulePeriod(m, USER, "r1", {
      periodStart: "2027-01-01",
      yearlyMaximum: 1123.07,
      expectedPerPaycheque: null,
    });
    expect(query.mock.calls[0][0]).toContain(
      "ON CONFLICT (rule_id, period_start)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      USER,
      "r1",
      "2027-01-01",
      1123.07,
      null,
    ]);
    await deleteRulePeriodsAfter(m, USER, "r1", "2026-01-01");
    expect(query.mock.calls[1][0]).toContain("period_start > $3");
    expect(query.mock.calls[1][1]).toEqual([USER, "r1", "2026-01-01"]);
  });
});
