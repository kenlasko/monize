import { fullDailyInput, occurrence } from "./__fixtures__/trivia-pool.fixture";
import {
  buildDailyTriviaFacts,
  type TriviaDailyInput,
} from "./trivia-daily-facts";
import type { TriviaFact, TriviaFactId } from "./trivia.types";

const build = (over: Partial<TriviaDailyInput> = {}): TriviaFact[] =>
  buildDailyTriviaFacts({ ...fullDailyInput(), ...over });
const ids = (facts: TriviaFact[]): TriviaFactId[] => facts.map((f) => f.id);
const find = (facts: TriviaFact[], id: TriviaFactId) =>
  facts.find((f) => f.id === id);

describe("buildDailyTriviaFacts", () => {
  it("builds every daily family from a full input", () => {
    expect(ids(build()).sort()).toEqual(
      [
        "spendingMonthToDateLess",
        "spendingLastDay",
        "spendingLastSevenDays",
        "spendingBiggestRecentPurchase",
        "spendingNoSpendStreak",
        "spendingDaysSincePayee",
        "activityBillsDueThisWeek",
        "activityNextBill",
        "spendingBudgetPace",
        "investmentsTopMoverUp",
      ].sort(),
    );
  });

  it("says no source, no fact", () => {
    expect(
      build({
        monthToDate: null,
        lastDay: null,
        lastSevenDays: null,
        biggestPurchase: null,
        lastSpendDate: null,
        sincePayee: null,
        bills: null,
        budget: null,
        topMover: null,
      }),
    ).toEqual([]);
  });

  describe("month to date", () => {
    it("compares with the same day last month, by sign", () => {
      const less = find(build(), "spendingMonthToDateLess");
      expect(less?.figures).toEqual({
        mtdThrough: { kind: "day", value: "2026-11-18" },
        mtdSpent: { kind: "money", value: 400, currency: "CAD" },
        mtdPreviousSpent: { kind: "money", value: 500, currency: "CAD" },
        mtdDifference: { kind: "money", value: 100, currency: "CAD" },
      });
      const more = build({
        monthToDate: { through: "2026-11-18", spent: 650, previousSpent: 500 },
      });
      expect(ids(more)).toContain("spendingMonthToDateMore");
      expect(
        find(more, "spendingMonthToDateMore")?.figures.mtdDifference,
      ).toEqual({ kind: "money", value: 150, currency: "CAD" });
    });

    it.each([
      ["the 1st of a month", { today: "2026-11-01" }],
      [
        "a null report total",
        { monthToDate: { through: "x", spent: null, previousSpent: 5 } },
      ],
      [
        "a null previous total",
        { monthToDate: { through: "x", spent: 5, previousSpent: null } },
      ],
      [
        "a previous month at 0",
        { monthToDate: { through: "x", spent: 5, previousSpent: 0 } },
      ],
      [
        "equal spending",
        { monthToDate: { through: "x", spent: 5, previousSpent: 5 } },
      ],
    ] as [string, Partial<TriviaDailyInput>][])("refuses %s", (_name, over) => {
      const facts = build(over);
      expect(ids(facts)).not.toContain("spendingMonthToDateLess");
      expect(ids(facts)).not.toContain("spendingMonthToDateMore");
    });
  });

  describe("recent spending", () => {
    it("refuses a null or zero last day and week", () => {
      expect(
        ids(
          build({
            lastDay: { date: "2026-11-18", spent: null },
            lastSevenDays: { from: "2026-11-12", spent: 0 },
          }),
        ),
      ).not.toEqual(
        expect.arrayContaining(["spendingLastDay", "spendingLastSevenDays"]),
      );
    });

    it("refuses a multi-currency week, a foreign purchase and a null payee", () => {
      const purchase = fullDailyInput().biggestPurchase!;
      for (const over of [
        { singleCurrency: false },
        { currency: "USD" },
        { payee: null },
      ]) {
        expect(
          ids(build({ biggestPurchase: { ...purchase, ...over } })),
        ).not.toContain("spendingBiggestRecentPurchase");
      }
    });
  });

  describe("streaks", () => {
    it("counts the days from the last purchase to the last complete day", () => {
      expect(find(build(), "spendingNoSpendStreak")?.figures).toEqual({
        noSpendDays: { kind: "days", value: 3 },
        lastSpendDay: { kind: "day", value: "2026-11-15" },
      });
    });

    it("refuses a streak of 1 and of 31, and no purchase at all", () => {
      for (const lastSpendDate of ["2026-11-17", "2026-10-18", null]) {
        expect(ids(build({ lastSpendDate }))).not.toContain(
          "spendingNoSpendStreak",
        );
      }
      // 30 days is the last streak that counts.
      expect(ids(build({ lastSpendDate: "2026-10-19" }))).toContain(
        "spendingNoSpendStreak",
      );
    });

    it("states a streak only when the report confirms nothing was spent on its days", () => {
      // The purchase rule says nothing since the 15th; the report says 25 went
      // out on one of the days (a refund-netted category), so the list would
      // say "no spending for 3 days" beside "you spent 25".
      for (const streakSpent of [25, 0.01, null]) {
        expect(ids(build({ streakSpent }))).not.toContain(
          "spendingNoSpendStreak",
        );
      }
      expect(ids(build({ streakSpent: 0 }))).toContain("spendingNoSpendStreak");
    });

    it("counts the days since a payee to today, and needs 2 or more", () => {
      expect(find(build(), "spendingDaysSincePayee")?.figures).toEqual({
        sincePayeeName: { kind: "text", value: "Cafe" },
        sincePayeeDays: { kind: "days", value: 9 },
        sincePayeeDay: { kind: "day", value: "2026-11-10" },
      });
      expect(
        ids(build({ sincePayee: { name: "Cafe", lastDate: "2026-11-18" } })),
      ).not.toContain("spendingDaysSincePayee");
      expect(
        ids(build({ sincePayee: { name: null, lastDate: "2026-11-01" } })),
      ).not.toContain("spendingDaysSincePayee");
    });
  });

  describe("the day of a payee last spent with", () => {
    const dayFigure = (lastDate: string) =>
      find(
        build({ sincePayee: { name: "Cafe", lastDate } }),
        "spendingDaysSincePayee",
      )?.figures.sincePayeeDay;

    it("is a weekday figure within 60 days and a dated one beyond", () => {
      expect(dayFigure("2026-09-20")).toEqual({
        kind: "day",
        value: "2026-09-20",
      });
      // 61 days back: a weekday with no year would be ambiguous.
      expect(dayFigure("2026-09-19")).toEqual({
        kind: "date",
        value: "2026-09-19",
      });
      expect(dayFigure("2025-12-01")).toEqual({
        kind: "date",
        value: "2025-12-01",
      });
    });
  });

  describe("bills", () => {
    it("counts the occurrences and names the first as the next bill", () => {
      const facts = build();
      expect(find(facts, "activityBillsDueThisWeek")?.figures).toEqual({
        billsDueCount: { kind: "count", value: 2 },
        billsDueTotal: { kind: "money", value: 160, currency: "CAD" },
      });
      expect(find(facts, "activityNextBill")?.figures).toEqual({
        nextBillName: { kind: "text", value: "Rent" },
        nextBillAmount: { kind: "money", value: 80, currency: "CAD" },
        nextBillDate: { kind: "day", value: "2026-11-21" },
      });
    });

    it("gives no next-bill fact when the next bill is unpriced, though the second is", () => {
      const facts = build({
        bills: {
          occurrences: [
            occurrence({ amount: null, complete: false }),
            occurrence({ dueDate: "2026-11-23" }),
          ],
          total: null,
        },
      });
      expect(ids(facts)).not.toContain("activityNextBill");
      // A total of null is no bills fact either.
      expect(ids(facts)).not.toContain("activityBillsDueThisWeek");
    });

    it("gives the next-bill fact without a total when only the total is unknown", () => {
      const facts = build({
        bills: { occurrences: [occurrence()], total: null },
      });
      expect(ids(facts)).toContain("activityNextBill");
      expect(ids(facts)).not.toContain("activityBillsDueThisWeek");
    });

    it("gives no next-bill fact when the next bill is an estimate", () => {
      const facts = build({
        bills: {
          occurrences: [occurrence({ estimated: true }), occurrence()],
          total: 160,
        },
      });
      expect(ids(facts)).not.toContain("activityNextBill");
    });

    it("gives no total when any bill in the window is an estimate", () => {
      const facts = build({
        bills: {
          occurrences: [occurrence(), occurrence({ estimated: true })],
          total: 160,
        },
      });
      expect(ids(facts)).not.toContain("activityBillsDueThisWeek");
      // The first bill is exact, so it is still the next bill.
      expect(ids(facts)).toContain("activityNextBill");
    });

    it("says nothing without occurrences", () => {
      const facts = build({ bills: { occurrences: [], total: 0 } });
      expect(ids(facts)).not.toContain("activityBillsDueThisWeek");
      expect(ids(facts)).not.toContain("activityNextBill");
    });
  });

  describe("budget pace", () => {
    it("reports the used and elapsed shares", () => {
      expect(find(build(), "spendingBudgetPace")?.figures).toEqual({
        budgetName: { kind: "text", value: "Household" },
        budgetSpent: { kind: "money", value: 150, currency: "CAD" },
        budgetTotal: { kind: "money", value: 300, currency: "CAD" },
        budgetUsedPercent: { kind: "percent", value: 50 },
        // 19 of 30 days.
        budgetMonthPercent: { kind: "percent", value: 63.3333 },
      });
    });

    it("retains the signed net and percentage used by the neutral budget fact", () => {
      const budget = {
        ...fullDailyInput().budget!,
        lines: [{ spent: -50, budgeted: 100 }],
      };
      expect(
        find(build({ budget }), "spendingBudgetPace")?.figures,
      ).toMatchObject({
        budgetSpent: { kind: "money", value: -50 },
        budgetTotal: { kind: "money", value: 100 },
        budgetUsedPercent: { kind: "percent", value: -50 },
      });
    });

    it("refuses an income-linked budget, a null line and a zero budget", () => {
      const budget = fullDailyInput().budget!;
      for (const over of [
        { incomeLinked: true },
        { lines: [{ spent: null, budgeted: 200 }, ...budget.lines] },
        { lines: [{ spent: 0, budgeted: 0 }] },
        { lines: [] },
      ]) {
        expect(ids(build({ budget: { ...budget, ...over } }))).not.toContain(
          "spendingBudgetPace",
        );
      }
    });
  });

  describe("top mover", () => {
    it("words an up and a down move, with absolute figures", () => {
      const mover = fullDailyInput().topMover!;
      const down = build({
        topMover: {
          ...mover,
          dailyChangePercent: -3,
          dailyValueChange: -30,
        },
      });
      expect(find(down, "investmentsTopMoverDown")?.figures).toEqual({
        moverSymbol: { kind: "text", value: "XGRO" },
        moverPercent: { kind: "percent", value: 3 },
        moverSession: { kind: "day", value: "2026-11-18" },
        moverValueChange: { kind: "money", value: 30, currency: "CAD" },
      });
    });

    it("refuses a flat move and a null value change", () => {
      const mover = fullDailyInput().topMover!;
      for (const over of [
        { dailyChangePercent: 0 },
        { dailyValueChange: null },
      ]) {
        const facts = build({ topMover: { ...mover, ...over } });
        expect(ids(facts)).not.toContain("investmentsTopMoverUp");
        expect(ids(facts)).not.toContain("investmentsTopMoverDown");
      }
    });
  });
});
