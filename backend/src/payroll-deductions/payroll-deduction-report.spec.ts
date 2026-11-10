import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { PayrollDeductionRule } from "./entities/payroll-deduction-rule.entity";
import { CATEGORY_DEDUCTION_ROWS_SQL } from "./payroll-deduction-cap";
import {
  assemblePayrollReport,
  DeductionTransaction,
  groupReportRules,
  PayrollReportGroup,
  periodStartingIn,
  queryDeductionTransactions,
  REPORT_EARLIEST_DATE,
  REPORT_LATEST_DATE,
  summariseReportCategory,
} from "./payroll-deduction-report";

const USER = "11111111-1111-4111-8111-111111111111";
const EI = "33333333-3333-4333-8333-333333333333";
const CPP = "44444444-4444-4444-8444-444444444444";

/** A group with one rule whose columns hold `yearlyMaximum` and no period rows. */
const group = ({
  yearlyMaximum = 1077.48,
  ...over
}: Partial<PayrollReportGroup> & {
  yearlyMaximum?: number;
} = {}): PayrollReportGroup => ({
  categoryId: EI,
  categoryName: "EI",
  currencyCode: "CAD",
  resetDate: "2026-01-01",
  billNames: ["Paycheque"],
  rules: [{ yearlyMaximum, expectedPerPaycheque: null, periods: [] }],
  ...over,
});

const tx = (
  id: string,
  date: string,
  deducted: number,
  currencyCode = "CAD",
): DeductionTransaction => ({
  transactionId: id,
  transactionDate: date,
  payeeName: "Employer",
  currencyCode,
  deducted,
});

describe("payroll deduction report", () => {
  describe("periodStartingIn", () => {
    it("is the period whose start is the reset's anniversary in the year", () => {
      expect(periodStartingIn("2024-07-01", 2026)).toEqual({
        periodStart: "2026-07-01",
        periodEnd: "2027-06-30",
        nextResetOn: "2027-07-01",
      });
      // A leap-day anchor clamps to the 28th in a common year.
      expect(periodStartingIn("2024-02-29", 2025).periodStart).toBe(
        "2025-02-28",
      );
    });
  });

  describe("groupReportRules", () => {
    const rule = (over: Partial<PayrollDeductionRule>): PayrollDeductionRule =>
      ({
        categoryId: EI,
        yearlyMaximum: "1077.4800" as unknown as number,
        resetDate: "2026-01-01",
        category: { name: "EI" } as Category,
        scheduledTransaction: {
          name: "Mid-month",
          currencyCode: "CAD",
        } as ScheduledTransaction,
        ...over,
      }) as PayrollDeductionRule;

    it("keeps one group per category and currency, naming every bill and keeping every rule", () => {
      const groups = groupReportRules([
        rule({}),
        rule({
          yearlyMaximum: 1000,
          resetDate: "2026-07-01",
          scheduledTransaction: {
            name: "Month-end",
            currencyCode: "CAD",
          } as ScheduledTransaction,
        }),
        rule({
          scheduledTransaction: {
            name: "US job",
            currencyCode: "USD",
          } as ScheduledTransaction,
        }),
      ]);
      expect(groups).toEqual([
        {
          categoryId: EI,
          categoryName: "EI",
          currencyCode: "CAD",
          // The earliest rule's anchor, as the history route uses.
          resetDate: "2026-01-01",
          billNames: ["Mid-month", "Month-end"],
          // The rules themselves, whose figures per period the summary reads.
          rules: [
            expect.objectContaining({ resetDate: "2026-01-01" }),
            expect.objectContaining({
              yearlyMaximum: 1000,
              resetDate: "2026-07-01",
            }),
          ],
        },
        {
          categoryId: EI,
          categoryName: "EI",
          currencyCode: "USD",
          resetDate: "2026-01-01",
          billNames: ["US job"],
          rules: [expect.objectContaining({ categoryId: EI })],
        },
      ]);
    });
  });

  describe("queryDeductionTransactions", () => {
    it("reads the paid figure's rows over the whole ledger, one row per transaction, as magnitudes", async () => {
      const query = jest.fn(async () => [
        {
          transaction_id: "t1",
          transaction_date: "2026-01-15",
          payee_name: "Employer",
          currency_code: "CAD",
          amount: "-64.0000",
        },
        {
          transaction_id: "t2",
          transaction_date: "2026-01-31",
          payee_name: null,
          currency_code: "CAD",
          amount: "10.0000",
        },
      ]);
      const rows = await queryDeductionTransactions(
        { query } as unknown as EntityManager,
        USER,
        EI,
      );
      expect(rows).toEqual([
        {
          transactionId: "t1",
          transactionDate: "2026-01-15",
          payeeName: "Employer",
          currencyCode: "CAD",
          deducted: 64,
        },
        // A refund row lowers what was deducted.
        {
          transactionId: "t2",
          transactionDate: "2026-01-31",
          payeeName: null,
          currencyCode: "CAD",
          deducted: -10,
        },
      ]);
      const [sql, params] = query.mock.calls[0] as unknown as [
        string,
        unknown[],
      ];
      expect(sql).toContain(CATEGORY_DEDUCTION_ROWS_SQL);
      expect(sql).toContain("TO_CHAR(x.transaction_date, 'YYYY-MM-DD')");
      expect(params).toEqual([
        USER,
        EI,
        REPORT_EARLIEST_DATE,
        REPORT_LATEST_DATE,
      ]);
      // The window is the years the route accepts, so a mistyped year 9999
      // row cannot offer a year the route refuses.
      expect([REPORT_EARLIEST_DATE, REPORT_LATEST_DATE]).toEqual([
        "1900-01-01",
        "2100-12-31",
      ]);
    });
  });

  describe("summariseReportCategory", () => {
    const today = "2026-04-10";

    it("summarises the current period against the maximum and dates when it was reached", () => {
      const { category, selected } = summariseReportCategory(
        group({ yearlyMaximum: 150 }),
        [
          tx("a", "2025-12-15", 64),
          tx("b", "2026-01-15", 64),
          tx("c", "2026-01-31", 64),
          tx("d", "2026-02-15", 22),
          tx("e", "2026-02-28", 0.01, "USD"),
        ],
        2026,
        today,
      );
      expect(selected.map((t) => t.transactionId)).toEqual(["b", "c", "d"]);
      expect(category.summary).toEqual({
        periodStart: "2026-01-01",
        periodEnd: "2026-12-31",
        paidToDate: 150,
        foreignCurrencyRows: 1,
        paycheques: 3,
        averagePerPaycheque: 50,
        isCurrent: true,
        yearlyMaximum: 150,
        remaining: 0,
        percentOfMaximum: 100,
        maximumReachedOn: "2026-02-15",
      });
    });

    it("reads the selected period's own figure, not the next period's, the lower rule binding", () => {
      const periods = [
        {
          periodStart: "2026-01-01",
          yearlyMaximum: 150,
          expectedPerPaycheque: null,
        },
        {
          periodStart: "2027-01-01",
          yearlyMaximum: 400,
          expectedPerPaycheque: null,
        },
      ];
      const { category } = summariseReportCategory(
        group({
          rules: [
            { yearlyMaximum: 400, expectedPerPaycheque: null, periods },
            { yearlyMaximum: 500, expectedPerPaycheque: null, periods: [] },
          ],
        }),
        [tx("a", "2026-01-15", 120)],
        2026,
        today,
      );
      expect(category.summary).toMatchObject({
        yearlyMaximum: 150,
        remaining: 30,
        percentOfMaximum: 80,
      });
    });

    it("shows a closed period's maximum when every rule recorded one for it", () => {
      const { category } = summariseReportCategory(
        group({
          rules: [
            {
              yearlyMaximum: 2000,
              expectedPerPaycheque: null,
              periods: [
                {
                  periodStart: "2025-01-01",
                  yearlyMaximum: 1000,
                  expectedPerPaycheque: null,
                },
                {
                  periodStart: "2026-01-01",
                  yearlyMaximum: 2000,
                  expectedPerPaycheque: null,
                },
              ],
            },
          ],
        }),
        [tx("a", "2025-03-15", 600), tx("b", "2025-04-15", 400)],
        2025,
        today,
      );
      expect(category.summary).toMatchObject({
        yearlyMaximum: 1000,
        remaining: 0,
        percentOfMaximum: 100,
        maximumReachedOn: "2025-04-15",
      });
    });

    it("withholds the maximum from a closed period, whose own maximum was never stored", () => {
      const { category } = summariseReportCategory(
        group(),
        [tx("a", "2025-03-15", 1077.48)],
        2025,
        today,
      );
      expect(category.summary).toMatchObject({
        periodStart: "2025-01-01",
        paidToDate: 1077.48,
        isCurrent: false,
        yearlyMaximum: null,
        remaining: null,
        percentOfMaximum: null,
        maximumReachedOn: null,
      });
    });

    it("answers a known zero for a year with no paycheque", () => {
      const { category, selected } = summariseReportCategory(
        group(),
        [],
        2026,
        today,
      );
      expect(selected).toEqual([]);
      expect(category.summary).toMatchObject({
        paidToDate: 0,
        paycheques: 0,
        averagePerPaycheque: null,
        yearlyMaximum: 1077.48,
        remaining: 1077.48,
        percentOfMaximum: 0,
        maximumReachedOn: null,
      });
      // The current period is reported even with nothing in it.
      expect(category.history).toEqual([
        {
          periodStart: "2026-01-01",
          periodEnd: "2026-12-31",
          paidToDate: 0,
          foreignCurrencyRows: 0,
          paycheques: 0,
          averagePerPaycheque: null,
          isCurrent: true,
        },
      ]);
    });

    it("lists every period from the current one back to the earliest row, empty years included, newest first", () => {
      const { category } = summariseReportCategory(
        group(),
        [
          tx("a", "2022-06-15", 900),
          tx("b", "2024-06-15", 1000),
          tx("c", "2024-06-30", 49.12),
        ],
        2026,
        today,
      );
      expect(
        category.history.map((p) => [
          p.periodStart,
          p.paidToDate,
          p.paycheques,
        ]),
      ).toEqual([
        ["2026-01-01", 0, 0],
        ["2025-01-01", 0, 0],
        ["2024-01-01", 1049.12, 2],
        ["2023-01-01", 0, 0],
        ["2022-01-01", 900, 1],
      ]);
    });

    it("follows a mid-year reset date, and reaches forward to a future-dated row", () => {
      const { category } = summariseReportCategory(
        group({ resetDate: "2020-07-01" }),
        [tx("a", "2025-08-01", 10), tx("b", "2027-08-01", 20)],
        2025,
        today,
      );
      expect(category.history.map((p) => p.periodStart)).toEqual([
        "2027-07-01",
        "2026-07-01",
        "2025-07-01",
      ]);
      expect(category.summary).toMatchObject({
        periodStart: "2025-07-01",
        periodEnd: "2026-06-30",
        paidToDate: 10,
        isCurrent: true,
      });
    });

    it("offers no period starting before the first reportable year", () => {
      // A mid-year reset puts a March 1900 row in the period from July 1899.
      const { category } = summariseReportCategory(
        group({ resetDate: "2020-07-01" }),
        [tx("a", "1900-03-01", 10), tx("b", "1900-08-01", 20)],
        1900,
        "1901-01-10",
      );
      expect(category.history.map((p) => p.periodStart)).toEqual([
        "1900-07-01",
      ]);
    });

    it("adds up money without float drift", () => {
      const { category } = summariseReportCategory(
        group(),
        [tx("a", "2026-01-15", 0.1), tx("b", "2026-01-31", 0.2)],
        2026,
        today,
      );
      expect(category.summary.paidToDate).toBe(0.3);
    });
  });

  describe("assemblePayrollReport", () => {
    const today = "2026-04-10";

    it("merges the year's paycheques across categories and adds up a single currency", () => {
      const report = assemblePayrollReport(
        [
          {
            group: group({ yearlyMaximum: 1077.48 }),
            transactions: [
              tx("p1", "2026-01-15", 64),
              tx("p2", "2026-01-31", 64),
              tx("old", "2024-12-31", 50),
            ],
          },
          {
            group: group({
              categoryId: CPP,
              categoryName: "CPP",
              yearlyMaximum: 4034.1,
            }),
            transactions: [
              tx("p1", "2026-01-15", 200.5),
              tx("p2", "2026-01-31", 200.5),
            ],
          },
        ],
        2026,
        today,
      );
      // Categories by name.
      expect(report.categories.map((c) => c.categoryName)).toEqual([
        "CPP",
        "EI",
      ]);
      expect(report.paycheques).toEqual([
        {
          transactionId: "p1",
          transactionDate: "2026-01-15",
          payeeName: "Employer",
          currencyCode: "CAD",
          amounts: { [`${EI}|CAD`]: 64, [`${CPP}|CAD`]: 200.5 },
          total: 264.5,
        },
        {
          transactionId: "p2",
          transactionDate: "2026-01-31",
          payeeName: "Employer",
          currencyCode: "CAD",
          amounts: { [`${EI}|CAD`]: 64, [`${CPP}|CAD`]: 200.5 },
          total: 264.5,
        },
      ]);
      expect(report.total).toBe(529);
      expect(report.totalCurrencyCode).toBe("CAD");
      // Each column adds up to its category's summary.
      for (const category of report.categories) {
        const column = report.paycheques.reduce(
          (sum, p) => sum + (p.amounts[category.key] ?? 0),
          0,
        );
        expect(column).toBeCloseTo(category.summary.paidToDate, 4);
      }
      expect(report.year).toBe(2026);
      expect(report.availableYears).toEqual([2026, 2025, 2024]);
    });

    it("adds no total across currencies", () => {
      const report = assemblePayrollReport(
        [
          { group: group(), transactions: [tx("a", "2026-01-15", 64)] },
          {
            group: group({ currencyCode: "USD" }),
            transactions: [tx("b", "2026-01-15", 30, "USD")],
          },
        ],
        2026,
        today,
      );
      expect(report.total).toBeNull();
      expect(report.totalCurrencyCode).toBeNull();
      expect(report.paycheques.map((p) => p.currencyCode)).toEqual([
        "CAD",
        "USD",
      ]);
    });

    it("offers the selected and the current year even with no rules", () => {
      const report = assemblePayrollReport([], 2030, today);
      expect(report).toEqual({
        year: 2030,
        availableYears: [2030, 2026],
        categories: [],
        paycheques: [],
        total: 0,
        totalCurrencyCode: null,
      });
    });
  });
});
