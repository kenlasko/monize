import {
  buildLedgerTriviaFacts,
  TriviaLedgerInput,
} from "./trivia-ledger-facts";
import type { IncomeVsExpensesResponse } from "../../built-in-reports/dto/income-vs-expenses.dto";

const empty: TriviaLedgerInput = {
  currency: "CAD",
  spendingByCategory: null,
  spendingByPayee: null,
  incomeVsExpenses: null,
  incomeBySource: null,
  records: null,
  warranties: null,
};

const ids = (input: Partial<TriviaLedgerInput>) =>
  buildLedgerTriviaFacts({ ...empty, ...input }).map((f) => f.id);
const figuresOf = (input: Partial<TriviaLedgerInput>, id: string) =>
  buildLedgerTriviaFacts({ ...empty, ...input }).find((f) => f.id === id)
    ?.figures;

const month = (period: string, income: number, expenses: number) => ({
  period,
  periodStart: `${period}-01`,
  periodEnd: `${period}-28`,
  income,
  expenses,
  net: income - expenses,
});

const flows = (
  patch: Partial<IncomeVsExpensesResponse> = {},
): IncomeVsExpensesResponse => {
  const data = [
    month("2025-11", 5000, 3000),
    month("2025-12", 5000, 6200),
    month("2026-01", 5000, 4000),
  ];
  return {
    data,
    totals: {
      income: 15000,
      expenses: 13200,
      net: 1800,
      knownIncome: 15000,
      knownExpenses: 13200,
      knownNet: 1800,
    },
    currency: "CAD",
    missingCurrencies: [],
    excludedCount: 0,
    ...patch,
  };
};

describe("buildLedgerTriviaFacts", () => {
  it("says nothing with nothing read", () => {
    expect(buildLedgerTriviaFacts(empty)).toEqual([]);
  });

  describe("spending", () => {
    const byCategory = {
      data: [
        {
          categoryId: null,
          categoryName: "Uncategorized",
          color: null,
          total: 900,
        },
        {
          categoryId: "food",
          categoryName: "Groceries",
          color: null,
          total: 600,
        },
        { categoryId: "fun", categoryName: "Fun", color: null, total: 300 },
      ],
      totalSpending: 1800,
      knownSpending: 1800,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    };

    it("names the top real category and its share of the whole", () => {
      expect(
        figuresOf({ spendingByCategory: byCategory }, "spendingTopCategory"),
      ).toEqual({
        topCategoryName: { kind: "text", value: "Groceries" },
        topCategoryAmount: { kind: "money", value: 600, currency: "CAD" },
        topCategoryPercent: { kind: "percent", value: 33.3333 },
      });
    });

    it("withholds a share of a total that did not fully convert", () => {
      expect(
        ids({ spendingByCategory: { ...byCategory, totalSpending: null } }),
      ).toEqual([]);
    });

    it("names the payee spent with most, skipping a blank name", () => {
      expect(
        figuresOf(
          {
            spendingByPayee: {
              data: [
                { payeeId: null, payeeName: " ", total: 999 },
                { payeeId: "p", payeeName: "Grocer", total: 400 },
              ],
              totalSpending: 1399,
              knownSpending: 1399,
              currency: "CAD",
              missingCurrencies: [],
              excludedCount: 0,
            },
          },
          "spendingTopPayee",
        ),
      ).toEqual({
        topPayeeName: { kind: "text", value: "Grocer" },
        topPayeeAmount: { kind: "money", value: 400, currency: "CAD" },
      });
    });

    it("dates the month that spent the most", () => {
      expect(
        figuresOf({ incomeVsExpenses: flows() }, "spendingBiggestMonth"),
      ).toEqual({
        biggestSpendMonth: { kind: "month", value: "2025-12" },
        biggestSpendAmount: { kind: "money", value: 6200, currency: "CAD" },
      });
    });
  });

  describe("income", () => {
    it("says what was kept, as an amount and a share of income", () => {
      expect(
        figuresOf({ incomeVsExpenses: flows() }, "incomeKeptShare"),
      ).toEqual({
        keptAmount: { kind: "money", value: 1800, currency: "CAD" },
        keptPercent: { kind: "percent", value: 12 },
      });
    });

    it("counts the months that came out ahead", () => {
      expect(
        figuresOf({ incomeVsExpenses: flows() }, "incomeSurplusMonths"),
      ).toEqual({
        surplusMonths: { kind: "count", value: 2 },
        windowMonths: { kind: "count", value: 3 },
      });
    });

    it("keeps no kept share for a year that spent more than it earned", () => {
      const overspent = flows({
        totals: { ...flows().totals, net: -100, knownNet: -100 },
      });
      expect(ids({ incomeVsExpenses: overspent })).not.toContain(
        "incomeKeptShare",
      );
    });

    it.each([
      ["a missing currency", { missingCurrencies: ["JPY"] }],
      ["an unknown total", { totals: { ...flows().totals, income: null } }],
      ["too few months", { data: flows().data.slice(0, 2) }],
    ])("says nothing of cash flow with %s", (_label, patch) => {
      expect(
        ids({
          incomeVsExpenses: flows(patch as Partial<IncomeVsExpensesResponse>),
        }),
      ).toEqual([]);
    });

    it("names the biggest source of income", () => {
      expect(
        figuresOf(
          {
            incomeBySource: {
              data: [
                {
                  categoryId: "pay",
                  categoryName: "Salary",
                  color: null,
                  total: 9000,
                },
                {
                  categoryId: "int",
                  categoryName: "Interest",
                  color: null,
                  total: 1000,
                },
              ],
              totalIncome: 10000,
              knownIncome: 10000,
              currency: "CAD",
              missingCurrencies: [],
              excludedCount: 0,
            },
          },
          "incomeTopSource",
        ),
      ).toEqual({
        topSourceName: { kind: "text", value: "Salary" },
        topSourcePercent: { kind: "percent", value: 90 },
      });
    });
  });

  describe("activity and warranties", () => {
    const records = {
      transactions: 0,
      firstTransactionDate: null,
      activePayees: 0,
      categories: 0,
      activeScheduled: 0,
    };

    it("says nothing about empty records", () => {
      expect(ids({ records })).toEqual([]);
    });

    it("counts what has been recorded", () => {
      expect(
        ids({
          records: {
            transactions: 10,
            firstTransactionDate: "2020-03-15",
            activePayees: 4,
            categories: 9,
            activeScheduled: 2,
          },
        }),
      ).toEqual([
        "activityTransactions",
        "activityPayees",
        "activityScheduled",
      ]);
    });

    it("counts covered warranties and names the next to expire", () => {
      expect(
        buildLedgerTriviaFacts({
          ...empty,
          warranties: {
            covered: 3,
            nextExpiring: { name: "Fridge", expiresOn: "2027-02-10" },
          },
        }),
      ).toEqual([
        {
          id: "warrantiesCovered",
          topic: "warranties",
          figures: { warrantyCount: { kind: "count", value: 3 } },
        },
        {
          id: "warrantiesNextExpiry",
          topic: "warranties",
          figures: {
            nextWarrantyName: { kind: "text", value: "Fridge" },
            nextWarrantyMonth: { kind: "month", value: "2027-02" },
          },
        },
      ]);
    });

    it("says nothing with no warranty in cover", () => {
      expect(ids({ warranties: { covered: 0, nextExpiring: null } })).toEqual(
        [],
      );
    });
  });
});
