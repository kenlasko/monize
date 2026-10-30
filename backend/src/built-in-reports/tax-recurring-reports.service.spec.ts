import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import {
  investmentExclusionSql,
  reportableTransactionAmountSql,
} from "../common/investment-filter.util";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("TaxRecurringReportsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: TaxRecurringReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let currencyService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockSalaryCategory: Category = {
    id: "cat-salary",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Salary",
    description: null,
    icon: null,
    color: "#5733FF",
    isIncome: true,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockMedicalCategory: Category = {
    id: "cat-medical",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Medical Expenses",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockDonationCategory: Category = {
    id: "cat-donation",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Charitable Donation",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-03"),
  };

  const mockGroceriesCategory: Category = {
    id: "cat-groceries",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: "#3357FF",
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-04"),
  };

  const mockChildMedical: Category = {
    id: "cat-dental",
    userId: mockUserId,
    parentId: "cat-medical",
    parent: null,
    children: [],
    name: "Dental",
    description: null,
    icon: null,
    color: "#FF3357",
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-05"),
  };

  const mockEducationCategory: Category = {
    id: "cat-education",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Education Tuition",
    description: null,
    icon: null,
    color: "#57FF33",
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2025-01-06"),
  };

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    currencyService = {
      getDefaultCurrency: jest.fn().mockResolvedValue("USD"),
      buildRateMap: jest.fn().mockResolvedValue(new Map()),
      tryConvertAmount: jest.fn().mockImplementation((amount) => amount),
    };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Transaction, transactionsRepository as never],
        [Category, categoriesRepository as never],
      ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaxRecurringReportsService,
        {
          provide: ReportCurrencyService,
          useValue: currencyService,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get<TaxRecurringReportsService>(
      TaxRecurringReportsService,
    );
  });

  // ---------------------------------------------------------------------------
  // getTaxSummary
  // ---------------------------------------------------------------------------
  describe("getTaxSummary", () => {
    it("returns empty result when no transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.incomeBySource).toEqual([]);
      expect(result.deductibleExpenses).toEqual([]);
      expect(result.allExpenses).toEqual([]);
      expect(result.totals).toEqual({
        income: 0,
        expenses: 0,
        deductible: 0,
        knownIncome: 0,
        knownExpenses: 0,
        knownDeductible: 0,
      });
    });

    it("separates income from expenses correctly", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-salary",
          currency_code: "USD",
          amount: "5000.00",
        },
        {
          category_id: "cat-groceries",
          currency_code: "USD",
          amount: "-200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockSalaryCategory,
        mockGroceriesCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.totals.income).toBe(5000);
      expect(result.totals.expenses).toBe(200);
      expect(result.incomeBySource).toHaveLength(1);
      expect(result.incomeBySource[0].name).toBe("Salary");
      expect(result.allExpenses).toHaveLength(1);
      expect(result.allExpenses[0].name).toBe("Groceries");
    });

    it("identifies tax-deductible expenses by keyword matching", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-500.00",
        },
        {
          category_id: "cat-donation",
          currency_code: "USD",
          amount: "-300.00",
        },
        {
          category_id: "cat-groceries",
          currency_code: "USD",
          amount: "-200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockMedicalCategory,
        mockDonationCategory,
        mockGroceriesCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      // "Medical Expenses" matches "medical", "Charitable Donation" matches "charitable"
      expect(result.deductibleExpenses).toHaveLength(2);
      const deductibleNames = result.deductibleExpenses.map((d) => d.name);
      expect(deductibleNames).toContain("Medical Expenses");
      expect(deductibleNames).toContain("Charitable Donation");
      expect(result.totals.deductible).toBe(800);
    });

    it("uses parent category name for keyword matching", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-dental",
          currency_code: "USD",
          amount: "-150.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockMedicalCategory,
        mockChildMedical,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      // "Dental" child rolls up to parent "Medical Expenses" which matches "medical"
      expect(result.deductibleExpenses).toHaveLength(1);
      expect(result.deductibleExpenses[0].name).toBe("Medical Expenses");
    });

    it("handles uncategorized transactions", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: null,
          currency_code: "USD",
          amount: "1000.00",
        },
        {
          category_id: null,
          currency_code: "USD",
          amount: "-50.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      // Uncategorized has no direction: income and spending stay apart.
      expect(result.incomeBySource).toEqual([
        { name: "Uncategorized", total: 1000 },
      ]);
      expect(result.allExpenses).toEqual([
        { name: "Uncategorized", total: 50 },
      ]);
    });

    it("nets a refund against its category instead of reporting it as income (INV-REPORT-004)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-medical", currency_code: "USD", amount: "-100.00" },
        { category_id: "cat-medical", currency_code: "USD", amount: "30.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockMedicalCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.deductibleExpenses).toEqual([
        { name: "Medical Expenses", total: 70 },
      ]);
      expect(result.allExpenses).toEqual([
        { name: "Medical Expenses", total: 70 },
      ]);
      expect(result.incomeBySource).toEqual([]);
      expect(result.totals.deductible).toBe(70);
      expect(result.totals.expenses).toBe(70);
      expect(result.totals.income).toBe(0);
    });

    it("nets many 0.1 and 0.2 rows against 0.3 rows to exactly zero", async () => {
      const rows: Array<Record<string, string>> = [];
      for (let i = 0; i < 500; i++) {
        rows.push(
          { category_id: "cat-medical", currency_code: "USD", amount: "0.10" },
          { category_id: "cat-medical", currency_code: "USD", amount: "0.20" },
          { category_id: "cat-medical", currency_code: "USD", amount: "-0.30" },
        );
      }
      scopedManager.query.mockResolvedValue(rows);
      categoriesRepository.find.mockResolvedValue([mockMedicalCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.allExpenses).toEqual([]);
      expect(result.incomeBySource).toEqual([]);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.income).toBe(0);
    });

    it("converts foreign currency amounts", async () => {
      currencyService.tryConvertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-salary",
          currency_code: "EUR",
          amount: "3000.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockSalaryCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      // 3000 EUR * 1.1 = 3300
      expect(result.totals.income).toBe(3300);
      expect(result.incomeBySource[0].total).toBe(3300);
    });

    it("sorts income by total descending", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-salary",
          currency_code: "USD",
          amount: "5000.00",
        },
        {
          category_id: null,
          currency_code: "USD",
          amount: "8000.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockSalaryCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.incomeBySource[0].total).toBeGreaterThanOrEqual(
        result.incomeBySource[1].total,
      );
    });

    it("sorts expenses by total descending", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-groceries",
          currency_code: "USD",
          amount: "-100.00",
        },
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-500.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockGroceriesCategory,
        mockMedicalCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.allExpenses[0].total).toBeGreaterThanOrEqual(
        result.allExpenses[1].total,
      );
    });

    it("rounds monetary values to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-salary",
          currency_code: "USD",
          amount: "3333.333",
        },
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-111.115",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockSalaryCategory,
        mockMedicalCategory,
      ]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.incomeBySource[0].total).toBe(3333.333);
      expect(result.totals.income).toBe(3333.333);
      expect(result.deductibleExpenses[0].total).toBe(111.115);
    });

    it("passes correct year date range to the query", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getTaxSummary(mockUserId, 2024);

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2024-01-01", "2024-12-31"]);
    });

    it("detects education-related deductible expenses", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-education",
          currency_code: "USD",
          amount: "-2000.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockEducationCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.deductibleExpenses).toHaveLength(1);
      expect(result.deductibleExpenses[0].name).toBe("Education Tuition");
    });

    it("aggregates multiple transactions in the same category", async () => {
      scopedManager.query.mockResolvedValue([
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-100.00",
        },
        {
          category_id: "cat-medical",
          currency_code: "USD",
          amount: "-250.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockMedicalCategory]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.allExpenses).toHaveLength(1);
      expect(result.allExpenses[0].total).toBe(350);
      expect(result.deductibleExpenses[0].total).toBe(350);
    });

    it("calls currency service with correct user id", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getTaxSummary(mockUserId, 2025);

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });
  });

  // ---------------------------------------------------------------------------
  // getRecurringExpenses
  // ---------------------------------------------------------------------------
  describe("getRecurringExpenses", () => {
    it("returns empty result when no recurring expenses found", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toEqual([]);
      expect(result.summary).toEqual({
        totalRecurring: 0,
        knownTotalRecurring: 0,
        monthlyEstimate: 0,
        knownMonthlyEstimate: 0,
        monthCount: 6,
        uniquePayees: 0,
      });
    });

    it("identifies recurring expenses by payee", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name_normalized: "netflix",
          payee_name: "Netflix",
          category_name: "Entertainment",
          currency_code: "USD",
          occurrences: 6,
          total_amount: "90.00",
          last_transaction_date: lastDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Netflix");
      expect(result.data[0].totalAmount).toBe(90);
      expect(result.data[0].averageAmount).toBe(15);
      expect(result.data[0].occurrences).toBe(6);
      expect(result.data[0].frequency).toBe("MONTHLY");
    });

    it("determines frequency based on occurrence count", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "p-1",
          payee_name_normalized: "weekly",
          payee_name: "Weekly",
          category_name: null,
          currency_code: "USD",
          occurrences: 24,
          total_amount: "240.00",
          last_transaction_date: lastDate,
        },
        {
          payee_id: "p-2",
          payee_name_normalized: "biweekly",
          payee_name: "Biweekly",
          category_name: null,
          currency_code: "USD",
          occurrences: 12,
          total_amount: "120.00",
          last_transaction_date: lastDate,
        },
        {
          payee_id: "p-3",
          payee_name_normalized: "monthly",
          payee_name: "Monthly",
          category_name: null,
          currency_code: "USD",
          occurrences: 6,
          total_amount: "60.00",
          last_transaction_date: lastDate,
        },
        {
          payee_id: "p-4",
          payee_name_normalized: "occasional",
          payee_name: "Occasional",
          category_name: null,
          currency_code: "USD",
          occurrences: 3,
          total_amount: "30.00",
          last_transaction_date: lastDate,
        },
        {
          payee_id: "p-5",
          payee_name_normalized: "irregular",
          payee_name: "Irregular",
          category_name: null,
          currency_code: "USD",
          occurrences: 2,
          total_amount: "20.00",
          last_transaction_date: lastDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId, 2);

      const byName = new Map(result.data.map((d) => [d.payeeName, d]));
      expect(byName.get("Weekly")!.frequency).toBe("WEEKLY");
      expect(byName.get("Biweekly")!.frequency).toBe("BIWEEKLY");
      expect(byName.get("Monthly")!.frequency).toBe("MONTHLY");
      expect(byName.get("Occasional")!.frequency).toBe("OCCASIONAL");
      expect(byName.get("Irregular")!.frequency).toBe("IRREGULAR");
    });

    it("merges payees with different currencies by normalized name", async () => {
      const lastDate1 = new Date("2025-06-15");
      const lastDate2 = new Date("2025-07-15");

      currencyService.tryConvertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name_normalized: "spotify",
          payee_name: "Spotify",
          category_name: "Entertainment",
          currency_code: "USD",
          occurrences: 3,
          total_amount: "30.00",
          last_transaction_date: lastDate1,
        },
        {
          payee_id: "payee-1",
          payee_name_normalized: "spotify",
          payee_name: "Spotify",
          category_name: "Entertainment",
          currency_code: "EUR",
          occurrences: 3,
          total_amount: "27.27",
          last_transaction_date: lastDate2,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Spotify");
      expect(result.data[0].occurrences).toBe(6);
      // 30 USD + 27.27 EUR * 1.1 = 30 + 29.997 = 59.997 (4dp storage precision)
      expect(result.data[0].totalAmount).toBe(59.997);
    });

    it("uses the most recent last_transaction_date when merging", async () => {
      const olderDate = new Date("2025-05-01");
      const newerDate = new Date("2025-07-01");

      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name_normalized: "gym",
          payee_name: "Gym",
          category_name: "Health",
          currency_code: "USD",
          occurrences: 3,
          total_amount: "150.00",
          last_transaction_date: olderDate,
        },
        {
          payee_id: "payee-1",
          payee_name_normalized: "gym",
          payee_name: "Gym",
          category_name: "Health",
          currency_code: "USD",
          occurrences: 3,
          total_amount: "150.00",
          last_transaction_date: newerDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data[0].lastTransactionDate).toBe("2025-07-01");
    });

    it("calculates summary totals correctly", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "p-1",
          payee_name_normalized: "netflix",
          payee_name: "Netflix",
          category_name: "Entertainment",
          currency_code: "USD",
          occurrences: 6,
          total_amount: "90.00",
          last_transaction_date: lastDate,
        },
        {
          payee_id: "p-2",
          payee_name_normalized: "gym",
          payee_name: "Gym",
          category_name: "Health",
          currency_code: "USD",
          occurrences: 6,
          total_amount: "300.00",
          last_transaction_date: lastDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.summary.totalRecurring).toBe(390);
      // monthlyEstimate = totalRecurring / 6
      expect(result.summary.monthlyEstimate).toBe(65);
      expect(result.summary.uniquePayees).toBe(2);
    });

    it("passes custom minOccurrences to query", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId, 5);

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1][3]).toBe(5);
    });

    it("uses default minOccurrences of 3", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId);

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1][3]).toBe(3);
    });

    it("rounds monetary values to 2 decimal places", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "p-1",
          payee_name_normalized: "service",
          payee_name: "Service",
          category_name: null,
          currency_code: "USD",
          occurrences: 3,
          total_amount: "33.333",
          last_transaction_date: lastDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data[0].totalAmount).toBe(33.333);
      expect(result.data[0].averageAmount).toBe(11.111);
    });

    it("keeps categoryName null when category_name is null", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "p-1",
          payee_name_normalized: "payee",
          payee_name: "Payee",
          category_name: null,
          currency_code: "USD",
          occurrences: 3,
          total_amount: "100.00",
          last_transaction_date: lastDate,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data[0].categoryName).toBeNull();
    });

    describe("range", () => {
      const row = (overrides: Record<string, unknown>) => ({
        payee_id: "p-1",
        payee_name_normalized: "netflix",
        payee_name: "Netflix",
        category_name: null,
        currency_code: "USD",
        occurrences: 12,
        total_amount: "180.00",
        last_transaction_date: new Date("2026-10-01"),
        // The user's spending history, the same on every row.
        history_start: "2015-01-01",
        ...overrides,
      });

      beforeEach(() => {
        jest.useFakeTimers({ now: new Date(2026, 9, 20, 12) });
      });

      afterEach(() => {
        jest.useRealTimers();
      });

      it("keeps the six-month window by default", async () => {
        scopedManager.query.mockResolvedValue([]);

        await service.getRecurringExpenses(mockUserId);

        const params = scopedManager.query.mock.calls[0][1];
        expect(params[1]).toBe("2026-04-20");
        expect(params[2]).toBe("2026-10-20");
      });

      it.each([
        ["1y", "2025-10-20", 12],
        ["2y", "2024-10-20", 24],
        ["5y", "2021-10-20", 60],
      ] as const)(
        "bounds %s at %s and spreads the total over %i months",
        async (range, startDate, months) => {
          scopedManager.query.mockResolvedValue([
            row({ total_amount: String(months * 15) }),
          ]);

          const result = await service.getRecurringExpenses(
            mockUserId,
            3,
            range,
          );

          expect(scopedManager.query.mock.calls[0][1][1]).toBe(startDate);
          expect(result.summary.monthCount).toBe(months);
          expect(result.summary.monthlyEstimate).toBe(15);
        },
      );

      it("never spreads a preset over more months than the history holds", async () => {
        // Eight months of data: five years would otherwise divide by 60.
        scopedManager.query.mockResolvedValue([
          row({ history_start: "2026-02-20", total_amount: "240" }),
        ]);

        const result = await service.getRecurringExpenses(mockUserId, 3, "5y");

        expect(result.summary.monthCount).toBe(8);
        expect(result.summary.monthlyEstimate).toBe(30);
        // A longer history than the preset keeps the preset.
        scopedManager.query.mockResolvedValue([
          row({ history_start: "2020-01-01", total_amount: "240" }),
        ]);
        const sixMonths = await service.getRecurringExpenses(mockUserId, 3);
        expect(sixMonths.summary.monthCount).toBe(6);
        expect(sixMonths.summary.monthlyEstimate).toBe(40);
      });

      it("reads the history from the same spending rows the analysis counts", async () => {
        scopedManager.query.mockResolvedValue([]);

        await service.getRecurringExpenses(mockUserId, 3, "1y");

        const sql: string = scopedManager.query.mock.calls[0][0];
        const history = sql.slice(sql.indexOf("FROM transactions h"));
        expect(history).toContain("h.is_transfer = false");
        expect(history).toContain("h.status != 'VOID'");
        expect(history).toContain("h.parent_transaction_id IS NULL");
        // Investment cash is not spending history either (INV-REPORT-001).
        expect(history).toContain(`${reportableTransactionAmountSql("h")} < 0`);
        expect(history).toContain(
          investmentExclusionSql({ accountAlias: "ha", transactionAlias: "h" }),
        );
      });

      it("leaves all unbounded and spans the user's spending history", async () => {
        scopedManager.query.mockResolvedValue([
          row({ history_start: "2023-10-20", total_amount: "450" }),
          row({
            payee_id: "p-2",
            payee_name_normalized: "gym",
            payee_name: "Gym",
            history_start: "2023-10-20",
            total_amount: "990",
          }),
        ]);

        const result = await service.getRecurringExpenses(mockUserId, 3, "all");

        expect(scopedManager.query.mock.calls[0][1][1]).toBeNull();
        // 2023-10-20 to 2026-10-20 is 36 months.
        expect(result.summary.monthCount).toBe(36);
        expect(result.summary.monthlyEstimate).toBe(40);
      });

      it("counts at least one month when the history began this month", async () => {
        scopedManager.query.mockResolvedValue([
          row({ history_start: "2026-10-05", total_amount: "50" }),
        ]);

        const result = await service.getRecurringExpenses(mockUserId, 3, "all");

        expect(result.summary.monthCount).toBe(1);
        expect(result.summary.monthlyEstimate).toBe(50);
      });

      it("returns a zero estimate for all with nothing matched", async () => {
        scopedManager.query.mockResolvedValue([]);

        const result = await service.getRecurringExpenses(mockUserId, 3, "all");

        expect(result.summary.monthlyEstimate).toBe(0);
      });

      it("scales the frequency thresholds by the window length", async () => {
        // Over five years: 60 payments is monthly, 260 weekly, 130 biweekly,
        // 30 occasional (one every two months), 10 irregular.
        scopedManager.query.mockResolvedValue([
          row({ payee_name_normalized: "m", payee_name: "M", occurrences: 60 }),
          row({
            payee_name_normalized: "w",
            payee_name: "W",
            occurrences: 260,
          }),
          row({
            payee_name_normalized: "b",
            payee_name: "B",
            occurrences: 130,
          }),
          row({ payee_name_normalized: "o", payee_name: "O", occurrences: 30 }),
          row({ payee_name_normalized: "i", payee_name: "I", occurrences: 10 }),
        ]);

        const result = await service.getRecurringExpenses(mockUserId, 3, "5y");

        const byName = new Map(result.data.map((d) => [d.payeeName, d]));
        expect(byName.get("M")!.frequency).toBe("MONTHLY");
        expect(byName.get("W")!.frequency).toBe("WEEKLY");
        expect(byName.get("B")!.frequency).toBe("BIWEEKLY");
        expect(byName.get("O")!.frequency).toBe("OCCASIONAL");
        expect(byName.get("I")!.frequency).toBe("IRREGULAR");
      });
    });

    it("calls currency service with correct user id", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId);

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });
  });

  // ---------------------------------------------------------------------------
  // getBillPaymentHistory
  // ---------------------------------------------------------------------------
  describe("getBillPaymentHistory", () => {
    it("returns empty result when no scheduled transactions exist", async () => {
      // First query (scheduled_transactions) returns empty
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toEqual([]);
      expect(result.monthlyTotals).toEqual([]);
      expect(result.summary).toEqual({
        totalPaid: 0,
        knownTotalPaid: 0,
        totalPayments: 0,
        uniqueBills: 0,
        monthlyAverage: 0,
        knownMonthlyAverage: 0,
      });
    });

    it("matches transactions to scheduled bills by payee name", async () => {
      // First query returns scheduled transactions
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Rent Payment",
          amount: "-1500.00",
          payee_name: "Landlord Inc",
        },
      ]);

      // Second query returns actual transactions
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord inc",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord inc",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(1);
      expect(result.billPayments[0].scheduledTransactionName).toBe(
        "Rent Payment",
      );
      expect(result.billPayments[0].paymentCount).toBe(2);
      expect(result.billPayments[0].totalPaid).toBe(3000);
      expect(result.billPayments[0].averagePayment).toBe(1500);
    });

    it("reports the payee as the user wrote it, never the lowercased match key", async () => {
      // The transaction query hands back LOWER(TRIM(name)) because that is the
      // key the match runs on. The report once put that key on screen, so
      // "Hydro One" read as "hydro one" in every row.
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Electricity",
          amount: "-120.00",
          payee_name: "Hydro One",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "118.00",
          payee_name_normalized: "hydro one",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(1);
      expect(result.billPayments[0].payeeName).toBe("Hydro One");
    });

    it("only matches transactions within 20% tolerance of scheduled amount", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Internet Bill",
          amount: "-100.00",
          payee_name: "ISP Corp",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-match",
          transaction_date: new Date("2025-03-01"),
          currency_code: "USD",
          amount: "110.00",
          payee_name_normalized: "isp corp",
        },
        {
          id: "tx-too-high",
          transaction_date: new Date("2025-04-01"),
          currency_code: "USD",
          amount: "200.00",
          payee_name_normalized: "isp corp",
        },
        {
          id: "tx-too-low",
          transaction_date: new Date("2025-05-01"),
          currency_code: "USD",
          amount: "50.00",
          payee_name_normalized: "isp corp",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Only the $110 transaction should match (within 80-120 of $100)
      expect(result.billPayments).toHaveLength(1);
      expect(result.billPayments[0].paymentCount).toBe(1);
      expect(result.billPayments[0].totalPaid).toBe(110);
    });

    it("skips transactions without payee names", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Some Bill",
          amount: "-100.00",
          payee_name: "Some Vendor",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-03-01"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: null,
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(0);
    });

    it("calculates monthly totals correctly", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Rent",
          amount: "-1500.00",
          payee_name: "Landlord",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-01-20"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord",
        },
        {
          id: "tx-3",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "1500.00",
          payee_name_normalized: "landlord",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.monthlyTotals).toHaveLength(2);
      const jan = result.monthlyTotals.find((m) => m.month === "2025-01");
      const feb = result.monthlyTotals.find((m) => m.month === "2025-02");
      expect(jan!.total).toBe(3000);
      expect(feb!.total).toBe(1500);

      // The month travels as a key and nothing else. A server-formatted
      // `en-US` label used to ride beside it, unread by the only consumer and
      // English for every reader -- the next consumer to reach for the obvious
      // field name would have shipped English months again.
      expect(Object.keys(jan!).sort()).toEqual(["month", "total"]);
      expect(jan).not.toHaveProperty("label");
    });

    it("sorts monthly totals in ascending order", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-06-01"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-01-01"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.monthlyTotals[0].month).toBe("2025-01");
      expect(result.monthlyTotals[1].month).toBe("2025-06");
    });

    it("sorts bill payments by totalPaid descending", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Cheap Bill",
          amount: "-50.00",
          payee_name: "Cheap",
        },
        {
          id: "st-2",
          name: "Expensive Bill",
          amount: "-500.00",
          payee_name: "Expensive",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-03-01"),
          currency_code: "USD",
          amount: "50.00",
          payee_name_normalized: "cheap",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-03-01"),
          currency_code: "USD",
          amount: "500.00",
          payee_name_normalized: "expensive",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments[0].scheduledTransactionName).toBe(
        "Expensive Bill",
      );
      expect(result.billPayments[1].scheduledTransactionName).toBe(
        "Cheap Bill",
      );
    });

    it("calculates summary values correctly", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill A",
          amount: "-100.00",
          payee_name: "Vendor A",
        },
        {
          id: "st-2",
          name: "Bill B",
          amount: "-200.00",
          payee_name: "Vendor B",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor a",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor a",
        },
        {
          id: "tx-3",
          transaction_date: new Date("2025-01-20"),
          currency_code: "USD",
          amount: "200.00",
          payee_name_normalized: "vendor b",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalPaid).toBe(400);
      expect(result.summary.totalPayments).toBe(3);
      expect(result.summary.uniqueBills).toBe(2);
      // 2 unique months, totalPaid 400 / 2 = 200
      expect(result.summary.monthlyAverage).toBe(200);
    });

    it("includes startDate filter when provided", async () => {
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getBillPaymentHistory(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      // Second query should not be called since no scheduled transactions
      expect(scopedManager.query).toHaveBeenCalledTimes(1);
    });

    it("omits startDate filter from transaction query when undefined", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getBillPaymentHistory(mockUserId, undefined, "2025-12-31");

      const txQueryCall = scopedManager.query.mock.calls[1];
      expect(txQueryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(txQueryCall[0]).not.toContain("$3");
    });

    it("handles lastPaymentDate correctly", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-03-15"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-07-20"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "vendor",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments[0].lastPaymentDate).toBe("2025-07-20");
    });

    it("converts foreign currency amounts", async () => {
      currencyService.tryConvertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Euro Bill",
          amount: "-100.00",
          payee_name: "Euro Vendor",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-03-01"),
          currency_code: "EUR",
          amount: "100.00",
          payee_name_normalized: "euro vendor",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments[0].totalPaid).toBe(110);
    });

    it("skips scheduled transactions without payee names", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "No Payee Bill",
          amount: "-100.00",
          payee_name: null,
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-03-01"),
          currency_code: "USD",
          amount: "100.00",
          payee_name_normalized: "some vendor",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toHaveLength(0);
    });

    it("calls currency service with correct user id", async () => {
      scopedManager.query.mockResolvedValueOnce([]);

      await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(currencyService.getDefaultCurrency).toHaveBeenCalledWith(
        mockUserId,
      );
      expect(currencyService.buildRateMap).toHaveBeenCalledWith("USD");
    });

    it("rounds monetary values to 2 decimal places", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-33.33",
          payee_name: "Vendor",
        },
      ]);

      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "33.33",
          payee_name_normalized: "vendor",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-02-15"),
          currency_code: "USD",
          amount: "33.33",
          payee_name_normalized: "vendor",
        },
        {
          id: "tx-3",
          transaction_date: new Date("2025-03-15"),
          currency_code: "USD",
          amount: "33.34",
          payee_name_normalized: "vendor",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments[0].totalPaid).toBe(100);
      expect(result.billPayments[0].averagePayment).toBe(33.3333);
    });
  });

  // ---------------------------------------------------------------------------
  // A missing exchange rate is unknown, never 1:1 (INV-FX-001)
  // ---------------------------------------------------------------------------
  describe("a currency that has no rate", () => {
    beforeEach(() => {
      currencyService.tryConvertAmount.mockImplementation(
        (amount: number, from: string) => (from === "JPY" ? null : amount),
      );
    });

    it("getTaxSummary withholds every total and leaves the JPY row out of every figure", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", amount: "-50.00" },
        { category_id: null, currency_code: "JPY", amount: "-100000" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.totals.expenses).toBeNull();
      expect(result.totals.income).toBeNull();
      expect(result.totals.deductible).toBeNull();
      expect(result.totals.knownExpenses).toBe(50);
      expect(result.totals.knownIncome).toBe(0);
      expect(result.totals.knownDeductible).toBe(0);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(result.allExpenses).toEqual([
        { name: "Uncategorized", total: 50 },
      ]);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("getTaxSummary withholds the income total for an unconverted income row", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", amount: "50.00" },
        { category_id: null, currency_code: "JPY", amount: "100000" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.totals.income).toBeNull();
      expect(result.totals.knownIncome).toBe(50);
      expect(result.incomeBySource).toEqual([
        { name: "Uncategorized", total: 50 },
      ]);
    });

    it("getRecurringExpenses withholds the recurring total and the monthly estimate", async () => {
      const lastDate = new Date();
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name_normalized: "netflix",
          payee_name: "Netflix",
          category_name: null,
          currency_code: "USD",
          occurrences: 6,
          total_amount: "60.00",
          last_transaction_date: lastDate,
          history_start: null,
        },
        {
          payee_id: "payee-2",
          payee_name_normalized: "tokyo gym",
          payee_name: "Tokyo Gym",
          category_name: null,
          currency_code: "JPY",
          occurrences: 6,
          total_amount: "100000",
          last_transaction_date: lastDate,
          history_start: null,
        },
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.summary.totalRecurring).toBeNull();
      expect(result.summary.monthlyEstimate).toBeNull();
      expect(result.summary.knownTotalRecurring).toBe(60);
      expect(result.summary.knownMonthlyEstimate).toBe(10);
      expect(result.summary.uniquePayees).toBe(1);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("getBillPaymentHistory withholds the paid total and excludes the unconverted payment", async () => {
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Rent",
          amount: "-50.00",
          payee_name: "Landlord",
        },
        {
          id: "st-2",
          name: "Tokyo Bill",
          amount: "-100000",
          payee_name: "Tokyo Utility",
        },
      ]);
      scopedManager.query.mockResolvedValueOnce([
        {
          id: "tx-1",
          transaction_date: new Date("2025-01-15"),
          currency_code: "USD",
          amount: "50.00",
          payee_name_normalized: "landlord",
        },
        {
          id: "tx-2",
          transaction_date: new Date("2025-01-20"),
          currency_code: "JPY",
          amount: "100000",
          payee_name_normalized: "tokyo utility",
        },
      ]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalPaid).toBeNull();
      expect(result.summary.monthlyAverage).toBeNull();
      expect(result.summary.knownTotalPaid).toBe(50);
      expect(result.summary.knownMonthlyAverage).toBe(50);
      expect(result.billPayments).toHaveLength(1);
      expect(result.monthlyTotals).toEqual([{ month: "2025-01", total: 50 }]);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("getBillPaymentHistory answers zero, not null, when there are no bills", async () => {
      scopedManager.query.mockResolvedValueOnce([]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.summary.totalPaid).toBe(0);
      expect(result.summary.knownTotalPaid).toBe(0);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });
  });
});
