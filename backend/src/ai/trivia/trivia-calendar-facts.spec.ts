import { fullCalendarInput } from "./__fixtures__/trivia-pool.fixture";
import {
  anniversaryYears,
  buildCalendarTriviaFacts,
  yearAgoMonthRange,
  type TriviaCalendarInput,
} from "./trivia-calendar-facts";
import type { TriviaNetWorthMonth } from "./trivia-facts";
import type { TriviaFact } from "./trivia.types";

const month = (m: string, netWorth: number, fxComplete = true) =>
  ({ month: m, netWorth, assets: netWorth, fxComplete }) as TriviaNetWorthMonth;

/** The full input with the sources not under test switched off. */
function only(over: Partial<TriviaCalendarInput>): TriviaCalendarInput {
  const full = fullCalendarInput();
  return {
    ...full,
    months: [],
    records: { ...full.records!, firstTransactionDate: null, transactions: 0 },
    warranties: null,
    calendar: {
      accountFirstDates: null,
      transactionsRecordedBefore: null,
      yearAgoMonth: null,
    },
    ...over,
  };
}

const ids = (facts: TriviaFact[]) => facts.map((f) => f.id);
const withRecords = (
  over: Partial<TriviaCalendarInput["records"] & object>,
) => ({
  ...fullCalendarInput().records!,
  ...over,
});

describe("buildCalendarTriviaFacts", () => {
  it("produces every calendar id from the full input", () => {
    expect(ids(buildCalendarTriviaFacts(fullCalendarInput())).sort()).toEqual(
      [
        "activityAccountAnniversary",
        "activityAnniversary",
        "activityTransactionMilestone",
        "netWorthMilestone",
        "netWorthYearAgoUp",
        "spendingYearAgoMonth",
        "warrantiesExpiresSoon",
      ].sort(),
    );
  });

  describe("activityAnniversary", () => {
    const at = (first: string, today: string) =>
      buildCalendarTriviaFacts(
        only({
          today,
          records: withRecords({ firstTransactionDate: first }),
        }),
      );

    it("names the years and the first date in the anniversary's week", () => {
      expect(at("2023-11-17", "2026-11-19")[0]).toEqual({
        id: "activityAnniversary",
        topic: "activity",
        figures: {
          anniversaryYears: { kind: "years", value: 3 },
          anniversaryFirstDate: { kind: "date", value: "2023-11-17" },
        },
      });
    });

    it.each([
      ["the day itself", "2026-11-17", true],
      ["six days after", "2026-11-23", true],
      ["seven days after", "2026-11-24", false],
      ["the day before", "2026-11-16", false],
    ])("%s", (_label, today, expected) => {
      expect(ids(at("2023-11-17", today))).toEqual(
        expected ? ["activityAnniversary"] : [],
      );
    });

    it("reads 02-29 as 02-28 in a non-leap year, and 02-29 in a leap one", () => {
      expect(anniversaryYears("2020-02-29", "2026-02-28")).toBe(6);
      expect(anniversaryYears("2020-02-29", "2026-03-06")).toBe(6);
      expect(anniversaryYears("2020-02-29", "2026-03-07")).toBeNull();
      expect(anniversaryYears("2020-02-29", "2028-02-29")).toBe(8);
    });

    it("says nothing in the first year", () => {
      expect(at("2026-11-17", "2026-11-19")).toEqual([]);
    });

    it("catches an anniversary from the end of last year", () => {
      expect(anniversaryYears("2023-12-30", "2026-01-02")).toBe(2);
    });

    it("says nothing without a first date", () => {
      expect(buildCalendarTriviaFacts(only({ records: null }))).toEqual([]);
    });
  });

  describe("activityAccountAnniversary", () => {
    const run = (
      accounts: { name: string; firstDate: string }[] | null,
      today = "2026-11-19",
    ) =>
      buildCalendarTriviaFacts(
        only({
          today,
          records: withRecords({ firstTransactionDate: "2023-11-17" }),
          calendar: {
            accountFirstDates: accounts,
            transactionsRecordedBefore: null,
            yearAgoMonth: null,
          },
        }),
      ).filter((f) => f.id === "activityAccountAnniversary");

    it("names the account, its years and its first date", () => {
      expect(
        run([{ name: "Chequing", firstDate: "2021-11-15" }])[0].figures,
      ).toEqual({
        anniversaryAccountName: { kind: "text", value: "Chequing" },
        anniversaryAccountYears: { kind: "years", value: 5 },
        anniversaryAccountSince: { kind: "date", value: "2021-11-15" },
      });
    });

    it("counts a brokerage pair once, from its earlier date", () => {
      const facts = run([
        { name: "TFSA", firstDate: "2022-11-18" },
        { name: "TFSA", firstDate: "2022-11-16" },
      ]);
      expect(facts).toHaveLength(1);
      expect(facts[0].figures.anniversaryAccountYears).toEqual({
        kind: "years",
        value: 4,
      });
      expect(facts[0].figures.anniversaryAccountSince).toEqual({
        kind: "date",
        value: "2022-11-16",
      });
    });

    it("leaves out the account opened with the ledger's first transaction", () => {
      expect(run([{ name: "Chequing", firstDate: "2023-11-17" }])).toEqual([]);
    });

    it("picks the oldest, ties by name", () => {
      const facts = run([
        { name: "B", firstDate: "2022-11-17" },
        { name: "A", firstDate: "2022-11-17" },
        { name: "C", firstDate: "2021-11-17" },
      ]);
      expect(facts[0].figures.anniversaryAccountName).toEqual({
        kind: "text",
        value: "C",
      });
      expect(
        run([
          { name: "B", firstDate: "2022-11-17" },
          { name: "A", firstDate: "2022-11-17" },
        ])[0].figures.anniversaryAccountName,
      ).toEqual({ kind: "text", value: "A" });
    });

    it("says nothing for an account outside its week or in its first year", () => {
      expect(run([{ name: "A", firstDate: "2022-10-01" }])).toEqual([]);
      expect(run([{ name: "A", firstDate: "2026-11-17" }])).toEqual([]);
      expect(run(null)).toEqual([]);
    });
  });

  describe("netWorthMilestone", () => {
    // A first month of history, so the series is not just starting out.
    const history = month("2026-05-01", 500);
    const runRaw = (series: TriviaNetWorthMonth[]) =>
      buildCalendarTriviaFacts(only({ months: series })).filter(
        (f) => f.id === "netWorthMilestone",
      );
    const run = (series: TriviaNetWorthMonth[]) => runRaw([history, ...series]);
    const amount = (series: TriviaNetWorthMonth[]) =>
      run(series)[0]?.figures.milestoneAmount;

    it("names the month and the amount passed", () => {
      expect(
        run([month("2026-10-01", 990), month("2026-11-01", 1050)])[0],
      ).toEqual({
        id: "netWorthMilestone",
        topic: "netWorth",
        figures: {
          milestoneAmount: { kind: "money", value: 1000, currency: "CAD" },
          milestoneMonth: { kind: "month", value: "2026-11" },
        },
      });
    });

    it("counts a crossing of exactly R, and gives none for a fall through R", () => {
      expect(
        amount([month("2026-10-01", 999.99), month("2026-11-01", 1000)]),
      ).toMatchObject({ value: 1000 });
      expect(
        run([month("2026-10-01", 1050), month("2026-11-01", 990)]),
      ).toEqual([]);
      expect(
        run([month("2026-10-01", 1000), month("2026-11-01", 1100)]),
      ).toEqual([]);
    });

    it("takes the largest of {1, 2, 5} x 10^k crossed", () => {
      expect(
        amount([month("2026-10-01", 900), month("2026-11-01", 2600)]),
      ).toMatchObject({ value: 2000 });
      expect(
        amount([month("2026-10-01", 900), month("2026-11-01", 120000)]),
      ).toMatchObject({ value: 100000 });
      expect(
        amount([month("2026-10-01", 4000), month("2026-11-01", 5000)]),
      ).toMatchObject({ value: 5000 });
    });

    it("gives none while the ledger is still being entered", () => {
      // The previous month is the series' first: a jump from the first entry.
      expect(
        runRaw([month("2026-10-01", 990), month("2026-11-01", 1050)]),
      ).toEqual([]);
      // The previous month holds no balance: the series climbs from nothing.
      expect(run([month("2026-10-01", 0), month("2026-11-01", 1050)])).toEqual(
        [],
      );
      expect(
        run([month("2026-10-01", -50), month("2026-11-01", 1050)]),
      ).toEqual([]);
    });

    it("has no milestone below 1,000", () => {
      expect(run([month("2026-10-01", 100), month("2026-11-01", 900)])).toEqual(
        [],
      );
    });

    it("needs both months complete and consecutive", () => {
      expect(
        run([month("2026-10-01", 990, false), month("2026-11-01", 1050)]),
      ).toEqual([]);
      expect(
        run([month("2026-10-01", 990), month("2026-11-01", 1050, false)]),
      ).toEqual([]);
      expect(
        run([month("2026-08-01", 990), month("2026-11-01", 1050)]),
      ).toEqual([]);
      expect(run([month("2026-11-01", 1050)])).toEqual([]);
    });
  });

  describe("activityTransactionMilestone", () => {
    const run = (before: number | null, total: number) =>
      buildCalendarTriviaFacts(
        only({
          records: withRecords({ transactions: total }),
          calendar: {
            accountFirstDates: null,
            transactionsRecordedBefore: before,
            yearAgoMonth: null,
          },
        }),
      ).filter((f) => f.id === "activityTransactionMilestone");

    it.each([
      [99, 100, 100],
      [240, 300, 250],
      [499, 800, 500],
      [1999, 2000, 2000],
      [1500, 3200, 3000],
    ])("%i to %i gives %i", (before, total, expected) => {
      expect(run(before, total)[0].figures.transactionMilestone).toEqual({
        kind: "count",
        value: expected,
      });
    });

    it.each([
      [2000, 2001],
      [100, 200],
      [150, 150],
      [0, 99],
    ])("%i to %i gives none", (before, total) => {
      expect(run(before, total)).toEqual([]);
    });

    it("gives none when the older count could not be read", () => {
      expect(run(null, 1000)).toEqual([]);
    });
  });

  describe("warrantiesExpiresSoon", () => {
    const run = (expiresOn: string) =>
      buildCalendarTriviaFacts(
        only({
          today: "2026-11-19",
          warranties: {
            covered: 1,
            nextExpiring: { name: "Laptop", expiresOn },
          },
        }),
      ).filter((f) => f.id === "warrantiesExpiresSoon");

    it("counts the days to the expiry", () => {
      expect(run("2026-12-04")[0].figures).toEqual({
        expiringWarrantyName: { kind: "text", value: "Laptop" },
        expiringWarrantyDays: { kind: "days", value: 15 },
        expiringWarrantyDate: { kind: "date", value: "2026-12-04" },
      });
    });

    it.each([
      ["0 days", "2026-11-19", false],
      ["1 day", "2026-11-20", true],
      ["30 days", "2026-12-19", true],
      ["31 days", "2026-12-20", false],
    ])("%s", (_label, expiresOn, expected) => {
      expect(run(expiresOn)).toHaveLength(expected ? 1 : 0);
    });

    it("says nothing with no warranty to expire", () => {
      expect(
        buildCalendarTriviaFacts(
          only({ warranties: { covered: 1, nextExpiring: null } }),
        ),
      ).toEqual([]);
    });
  });

  describe("spendingYearAgoMonth", () => {
    const report = (over: Record<string, unknown> = {}) => ({
      ...fullCalendarInput().calendar.yearAgoMonth!,
      ...over,
    });
    const run = (
      yearAgoMonth: TriviaCalendarInput["calendar"]["yearAgoMonth"],
      first: string | null = "2023-11-17",
    ) =>
      buildCalendarTriviaFacts(
        only({
          today: "2026-11-19",
          records: withRecords({ firstTransactionDate: first }),
          calendar: {
            accountFirstDates: null,
            transactionsRecordedBefore: null,
            yearAgoMonth,
          },
        }),
      ).filter((f) => f.id === "spendingYearAgoMonth");

    it("names the month, the total and the top category", () => {
      expect(run(report())[0].figures).toEqual({
        yearAgoMonth: { kind: "month", value: "2025-11" },
        yearAgoSpent: { kind: "money", value: 900, currency: "CAD" },
        yearAgoTopCategoryName: { kind: "text", value: "Groceries" },
      });
    });

    it("needs a whole month of records", () => {
      expect(run(report(), "2025-11-01")).toHaveLength(1);
      expect(run(report(), "2025-11-02")).toEqual([]);
      expect(run(report(), null)).toEqual([]);
    });

    it("refuses a null or empty total, and an uncategorised top row", () => {
      expect(run(report({ totalSpending: null }))).toEqual([]);
      expect(run(report({ totalSpending: 0 }))).toEqual([]);
      expect(run(null)).toEqual([]);
      expect(
        run(
          report({
            data: [
              { categoryId: null, categoryName: "X", color: null, total: 500 },
              { categoryId: "c", categoryName: "Y", color: null, total: 400 },
            ],
          }),
        ),
      ).toEqual([]);
    });

    it("dates the window a year before, for January and for a leap February", () => {
      expect(yearAgoMonthRange("2026-01-15")).toEqual({
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      });
      expect(yearAgoMonthRange("2025-02-10")).toEqual({
        startDate: "2024-02-01",
        endDate: "2024-02-29",
      });
    });
  });

  describe("netWorthYearAgo", () => {
    const run = (series: TriviaNetWorthMonth[]) =>
      buildCalendarTriviaFacts(only({ months: series })).filter((f) =>
        f.id.startsWith("netWorthYearAgo"),
      );

    it("says higher or lower by the sign of the change", () => {
      const up = run([month("2025-11-01", 800), month("2026-11-01", 1050)]);
      expect(up[0]).toEqual({
        id: "netWorthYearAgoUp",
        topic: "netWorth",
        figures: {
          yearAgoNetWorthMonth: { kind: "month", value: "2025-11" },
          yearAgoNetWorth: { kind: "money", value: 800, currency: "CAD" },
          yearAgoNetWorthChange: { kind: "money", value: 250, currency: "CAD" },
        },
      });
      const down = run([month("2025-11-01", 1200), month("2026-11-01", 1050)]);
      expect(down[0].id).toBe("netWorthYearAgoDown");
      expect(down[0].figures.yearAgoNetWorthChange).toMatchObject({
        value: 150,
      });
    });

    it("gives none when the earlier month has no complete FX", () => {
      expect(
        run([month("2025-11-01", 800, false), month("2026-11-01", 1050)]),
      ).toEqual([]);
    });

    it("gives none without a row exactly 12 months back, or for no change", () => {
      expect(
        run([month("2025-10-01", 800), month("2026-11-01", 1050)]),
      ).toEqual([]);
      expect(run([month("2025-11-01", 800), month("2026-11-01", 800)])).toEqual(
        [],
      );
    });
  });
});
