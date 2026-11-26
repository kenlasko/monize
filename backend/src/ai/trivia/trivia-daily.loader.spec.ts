import { DataSource, EntityManager } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { BuiltInReportsService } from "../../built-in-reports/built-in-reports.service";
import type { SpendingByPayeeResponse } from "../../built-in-reports/dto/spending-by-payee.dto";
import { queryCategorySpending } from "../../budgets/budget-spending.util";
import { BudgetPeriodCategory } from "../../budgets/entities/budget-period-category.entity";
import { ExchangeRateService } from "../../currencies/exchange-rate.service";
import { ScheduledOccurrenceService } from "../../scheduled-transactions/scheduled-occurrence.service";
import { PortfolioService } from "../../securities/portfolio.service";
import { occurrence } from "./__fixtures__/trivia-pool.fixture";
import { TriviaDailyLoader } from "./trivia-daily.loader";
import { seedHash, dayIndex } from "./trivia-windows";

jest.mock("../../common/db/scoped-db", () => ({ withScopedDb: jest.fn() }));
jest.mock("../../budgets/budget-spending.util", () => ({
  ...jest.requireActual("../../budgets/budget-spending.util"),
  queryCategorySpending: jest.fn(),
}));

const TODAY = "2026-11-19";
const USER = "user-1";

const report = (totalSpending: number | null) =>
  ({ totalSpending }) as Awaited<
    ReturnType<BuiltInReportsService["getSpendingByCategory"]>
  >;

const byPayee = (names: string[]): SpendingByPayeeResponse =>
  ({
    data: names.map((n, i) => ({
      payeeId: n === "Unknown" ? null : `p-${n}`,
      payeeName: n,
      total: 100 - i,
    })),
  }) as unknown as SpendingByPayeeResponse;

describe("TriviaDailyLoader", () => {
  let query: jest.Mock;
  let budgetFind: jest.Mock;
  let periodLineFind: jest.Mock;
  let reports: jest.Mocked<
    Pick<BuiltInReportsService, "getSpendingByCategory">
  >;
  let occurrences: jest.Mocked<
    Pick<ScheduledOccurrenceService, "findOccurrences">
  >;
  let portfolio: jest.Mocked<Pick<PortfolioService, "getTopMovers">>;
  let rates: jest.Mocked<
    Pick<ExchangeRateService, "getRateForDate" | "getLatestRate">
  >;
  let loader: TriviaDailyLoader;

  const noOptions = { bills: false, spendingByPayee: null };

  beforeEach(() => {
    (queryCategorySpending as jest.Mock).mockReset();
    query = jest.fn().mockResolvedValue([]);
    budgetFind = jest.fn().mockResolvedValue([]);
    periodLineFind = jest.fn().mockResolvedValue([]);
    (withScopedDb as jest.Mock).mockImplementation(
      (_ds: DataSource, fn: (m: EntityManager) => unknown) =>
        fn({
          query,
          getRepository: (entity: unknown) => ({
            find: entity === BudgetPeriodCategory ? periodLineFind : budgetFind,
          }),
        } as unknown as EntityManager),
    );
    reports = {
      getSpendingByCategory: jest.fn().mockResolvedValue(report(10)),
    };
    occurrences = { findOccurrences: jest.fn().mockResolvedValue([]) };
    portfolio = { getTopMovers: jest.fn().mockResolvedValue([]) };
    rates = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };
    loader = new TriviaDailyLoader(
      {} as DataSource,
      reports as unknown as BuiltInReportsService,
      occurrences as unknown as ScheduledOccurrenceService,
      rates as unknown as ExchangeRateService,
      portfolio as unknown as PortfolioService,
    );
  });

  it("reads each report over its window, ending at the last complete day", async () => {
    await loader.load(USER, "CAD", TODAY, noOptions);
    const calls = reports.getSpendingByCategory.mock.calls.map((c) =>
      c.slice(1),
    );
    expect(calls).toEqual(
      expect.arrayContaining([
        // month to date, then the same span a month earlier
        ["2026-11-01", "2026-11-18"],
        ["2026-10-01", "2026-10-18"],
        // last day
        ["2026-11-18", "2026-11-18"],
        // last seven days
        ["2026-11-12", "2026-11-18"],
      ]),
    );
  });

  it("clamps the previous month's span to its last day", async () => {
    // asOf is 2026-03-30: February ends on the 28th.
    await loader.load(USER, "CAD", "2026-03-31", noOptions);
    const calls = reports.getSpendingByCategory.mock.calls.map((c) =>
      c.slice(1),
    );
    expect(calls).toContainEqual(["2026-03-01", "2026-03-30"]);
    expect(calls).toContainEqual(["2026-02-01", "2026-02-28"]);
  });

  it("crosses a year back to December for the previous span", async () => {
    await loader.load(USER, "CAD", "2027-01-05", noOptions);
    const calls = reports.getSpendingByCategory.mock.calls.map((c) =>
      c.slice(1),
    );
    expect(calls).toContainEqual(["2027-01-01", "2027-01-04"]);
    expect(calls).toContainEqual(["2026-12-01", "2026-12-04"]);
  });

  it("has no month to date on the 1st", async () => {
    const input = await loader.load(USER, "CAD", "2026-11-01", noOptions);
    expect(input.monthToDate).toBeNull();
  });

  it("returns the report totals as they are, null included", async () => {
    reports.getSpendingByCategory.mockResolvedValue(report(null));
    const input = await loader.load(USER, "CAD", TODAY, noOptions);
    expect(input.lastDay).toEqual({ date: "2026-11-18", spent: null });
    expect(input.monthToDate).toEqual({
      through: "2026-11-18",
      spent: null,
      previousSpent: null,
    });
  });

  describe("bills", () => {
    it("reads the next seven days' outflows", async () => {
      occurrences.findOccurrences.mockResolvedValue([
        occurrence(),
        occurrence({ amount: -20 }),
      ]);
      const input = await loader.load(USER, "CAD", TODAY, {
        ...noOptions,
        bills: true,
      });
      expect(occurrences.findOccurrences).toHaveBeenCalledWith(
        USER,
        { from: TODAY, through: "2026-11-25" },
        { outflowsOnly: true },
      );
      expect(input.bills?.total).toBe(100);
      expect(input.bills?.occurrences).toHaveLength(2);
    });

    it("withholds the total when a bill is in a currency with no rate", async () => {
      occurrences.findOccurrences.mockResolvedValue([
        occurrence(),
        occurrence({ currencyCode: "USD" }),
      ]);
      const input = await loader.load(USER, "CAD", TODAY, {
        ...noOptions,
        bills: true,
      });
      expect(input.bills?.total).toBeNull();
    });

    it("does not read them at all in page mode", async () => {
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(occurrences.findOccurrences).not.toHaveBeenCalled();
      expect(input.bills).toBeNull();
    });
  });

  describe("row reads", () => {
    it("reads the biggest purchase over the seven days to the last complete day", async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("foreign_rows")
            ? [
                {
                  amount: "120.5",
                  currency_code: "CAD",
                  payee: "Grocer",
                  tx_date: "2026-11-15",
                  foreign_rows: "0",
                },
              ]
            : [{ last_date: "2026-11-15" }],
        ),
      );
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(input.biggestPurchase).toEqual({
        amount: 120.5,
        currency: "CAD",
        payee: "Grocer",
        date: "2026-11-15",
        singleCurrency: true,
      });
      const [sql, params] = query.mock.calls.find(([s]) =>
        s.includes("foreign_rows"),
      )!;
      expect(params).toEqual([USER, "2026-11-12", "2026-11-18", "CAD"]);
      expect(sql).toContain("t.parent_transaction_id IS NULL");
      expect(input.lastSpendDate).toBe("2026-11-15");
    });

    it("reads the report's spending over the days after the last purchase", async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("foreign_rows") ? [] : [{ last_date: "2026-11-15" }],
        ),
      );
      reports.getSpendingByCategory.mockImplementation((_u, from) =>
        Promise.resolve(report(from === "2026-11-16" ? 25 : 10)),
      );
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(
        reports.getSpendingByCategory.mock.calls.map((c) => c.slice(1)),
      ).toContainEqual(["2026-11-16", "2026-11-18"]);
      expect(input.streakSpent).toBe(25);
    });

    it("reads no streak report without a streak", async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("foreign_rows") ? [] : [{ last_date: "2026-11-17" }],
        ),
      );
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(input.streakSpent).toBeNull();
    });

    it("marks a window holding another currency", async () => {
      query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("foreign_rows")
            ? [
                {
                  amount: "9",
                  currency_code: "CAD",
                  payee: "X",
                  tx_date: "2026-11-15",
                  foreign_rows: "2",
                },
              ]
            : [],
        ),
      );
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(input.biggestPurchase?.singleCurrency).toBe(false);
    });

    it("picks the payee from the top five by the day, never the Unknown bucket", async () => {
      const names = ["Unknown", "A", "B", "C", "D", "E", "F"];
      const candidates = ["A", "B", "C", "D", "E"];
      const expected =
        candidates[
          seedHash(USER, "sincePayee", String(dayIndex(TODAY))) %
            candidates.length
        ];
      query.mockImplementation((sql: string, params: unknown[]) =>
        Promise.resolve(
          !sql.includes("foreign_rows") && params[2]
            ? [{ last_date: "2026-11-10" }]
            : [],
        ),
      );
      const input = await loader.load(USER, "CAD", TODAY, {
        bills: false,
        spendingByPayee: byPayee(names),
      });
      expect(input.sincePayee).toEqual({
        name: expected,
        lastDate: "2026-11-10",
      });
      const sinceCall = query.mock.calls.find(
        ([, p]) => p.length === 3 && p[2],
      );
      expect(sinceCall?.[1]).toEqual([USER, "2026-11-18", `p-${expected}`]);
    });
  });

  describe("budget", () => {
    const line = (over: Record<string, unknown>) => ({
      categoryId: "c1",
      amount: 200,
      isIncome: false,
      isTransfer: false,
      transferAccountId: null,
      ...over,
    });

    it("reads monthly spending and includes the signed incoming balance in the budget", async () => {
      budgetFind.mockResolvedValueOnce([
        {
          id: "b1",
          name: "Household",
          incomeLinked: false,
          categories: [
            line({ id: "food-line", rolloverType: "MONTHLY" }),
            line({ categoryId: "c2", isIncome: true }),
          ],
        },
      ]);
      periodLineFind.mockResolvedValue([
        { budgetCategoryId: "food-line", rolloverIn: -250 },
      ]);
      (queryCategorySpending as jest.Mock).mockResolvedValue({
        currency: "CAD",
        spendingMap: new Map([["c1", -75]]),
        transferSpendingMap: new Map(),
        transferIncomeMap: new Map(),
        incompleteCategoryIds: new Set(),
        incompleteTransferAccountIds: new Set(),
        incompleteTransferIncomeAccountIds: new Set(),
      });
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      const args = (queryCategorySpending as jest.Mock).mock.calls[0];
      expect(args.slice(2)).toEqual([
        USER,
        expect.any(Array),
        "2026-11-01",
        "2026-11-30",
        "b1",
      ]);
      // The income line is not an expense line.
      expect(input.budget).toEqual({
        name: "Household",
        currency: "CAD",
        incomeLinked: false,
        lines: [{ spent: 75, budgeted: -50 }],
      });
    });

    it("marks a line with a missing rate as unknown, not as zero", async () => {
      budgetFind.mockResolvedValue([
        {
          id: "b1",
          name: "H",
          incomeLinked: false,
          categories: [line({})],
        },
      ]);
      (queryCategorySpending as jest.Mock).mockResolvedValue({
        currency: "CAD",
        spendingMap: new Map(),
        transferSpendingMap: new Map(),
        transferIncomeMap: new Map(),
        incompleteCategoryIds: new Set(["c1"]),
        incompleteTransferAccountIds: new Set(),
        incompleteTransferIncomeAccountIds: new Set(),
      });
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(input.budget?.lines).toEqual([{ spent: null, budgeted: 200 }]);
    });

    it("loads only the newest active budget, not every one with its lines", async () => {
      await loader.load(USER, "CAD", TODAY, noOptions);
      expect(budgetFind).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: USER, isActive: true },
          order: { createdAt: "DESC" },
          take: 1,
        }),
      );
    });

    it("has no budget when none is active", async () => {
      const input = await loader.load(USER, "CAD", TODAY, noOptions);
      expect(input.budget).toBeNull();
      expect(queryCategorySpending).not.toHaveBeenCalled();
    });
  });

  it("takes the first top mover", async () => {
    portfolio.getTopMovers.mockResolvedValue([
      { symbol: "A" },
      { symbol: "B" },
    ] as never);
    const input = await loader.load(USER, "CAD", TODAY, noOptions);
    expect(input.topMover?.symbol).toBe("A");
  });

  it("lets one throwing source null only its own field", async () => {
    portfolio.getTopMovers.mockRejectedValue(new Error("boom"));
    query.mockRejectedValue(new Error("db"));
    const input = await loader.load(USER, "CAD", TODAY, noOptions);
    expect(input.topMover).toBeNull();
    expect(input.biggestPurchase).toBeNull();
    expect(input.lastSpendDate).toBeNull();
    expect(input.lastDay).toEqual({ date: "2026-11-18", spent: 10 });
    expect(input.lastSevenDays?.spent).toBe(10);
  });
});
