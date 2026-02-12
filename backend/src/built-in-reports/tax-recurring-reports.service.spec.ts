import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";

describe("TaxRecurringReportsService", () => {
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
      convertAmount: jest.fn().mockImplementation((amount) => amount),
    };

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
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getTaxSummary(mockUserId, 2025);

      expect(result.incomeBySource).toEqual([]);
      expect(result.deductibleExpenses).toEqual([]);
      expect(result.allExpenses).toEqual([]);
      expect(result.totals).toEqual({
        income: 0,
        expenses: 0,
        deductible: 0,
      });
    });

    it("separates income from expenses correctly", async () => {
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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

      expect(result.incomeBySource[0].name).toBe("Uncategorized");
      expect(result.allExpenses[0].name).toBe("Uncategorized");
    });

    it("converts foreign currency amounts", async () => {
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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

      expect(result.incomeBySource[0].total).toBe(3333.33);
      expect(result.totals.income).toBe(3333.33);
      expect(result.deductibleExpenses[0].total).toBe(111.12);
    });

    it("passes correct year date range to the query", async () => {
      transactionsRepository.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getTaxSummary(mockUserId, 2024);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2024-01-01", "2024-12-31"]);
    });

    it("detects education-related deductible expenses", async () => {
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([]);
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
      transactionsRepository.query.mockResolvedValue([]);

      const result = await service.getRecurringExpenses(mockUserId);

      expect(result.data).toEqual([]);
      expect(result.summary).toEqual({
        totalRecurring: 0,
        monthlyEstimate: 0,
        uniquePayees: 0,
      });
    });

    it("identifies recurring expenses by payee", async () => {
      const lastDate = new Date();
      transactionsRepository.query.mockResolvedValue([
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
      expect(result.data[0].frequency).toBe("Monthly");
    });

    it("determines frequency based on occurrence count", async () => {
      const lastDate = new Date();
      transactionsRepository.query.mockResolvedValue([
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
      ]);

      const result = await service.getRecurringExpenses(mockUserId);

      const byName = new Map(result.data.map((d) => [d.payeeName, d]));
      expect(byName.get("Weekly")!.frequency).toBe("Weekly");
      expect(byName.get("Biweekly")!.frequency).toBe("Bi-weekly");
      expect(byName.get("Monthly")!.frequency).toBe("Monthly");
      expect(byName.get("Occasional")!.frequency).toBe("Occasional");
    });

    it("merges payees with different currencies by normalized name", async () => {
      const lastDate1 = new Date("2025-06-15");
      const lastDate2 = new Date("2025-07-15");

      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValue([
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
      // 30 USD + 27.27 EUR * 1.1 = 30 + 29.997
      expect(result.data[0].totalAmount).toBe(60);
    });

    it("uses the most recent last_transaction_date when merging", async () => {
      const olderDate = new Date("2025-05-01");
      const newerDate = new Date("2025-07-01");

      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([
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
      transactionsRepository.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId, 5);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1][3]).toBe(5);
    });

    it("uses default minOccurrences of 3", async () => {
      transactionsRepository.query.mockResolvedValue([]);

      await service.getRecurringExpenses(mockUserId);

      const queryCall = transactionsRepository.query.mock.calls[0];
      expect(queryCall[1][3]).toBe(3);
    });

    it("rounds monetary values to 2 decimal places", async () => {
      const lastDate = new Date();
      transactionsRepository.query.mockResolvedValue([
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

      expect(result.data[0].totalAmount).toBe(33.33);
      expect(result.data[0].averageAmount).toBe(11.11);
    });

    it("uses 'Uncategorized' when category_name is null", async () => {
      const lastDate = new Date();
      transactionsRepository.query.mockResolvedValue([
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

      expect(result.data[0].categoryName).toBe("Uncategorized");
    });

    it("calls currency service with correct user id", async () => {
      transactionsRepository.query.mockResolvedValue([]);

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
      transactionsRepository.query.mockResolvedValueOnce([]);

      const result = await service.getBillPaymentHistory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.billPayments).toEqual([]);
      expect(result.monthlyTotals).toEqual([]);
      expect(result.summary).toEqual({
        totalPaid: 0,
        totalPayments: 0,
        uniqueBills: 0,
        monthlyAverage: 0,
      });
    });

    it("matches transactions to scheduled bills by payee name", async () => {
      // First query returns scheduled transactions
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Rent Payment",
          amount: "-1500.00",
          payee_name: "Landlord Inc",
        },
      ]);

      // Second query returns actual transactions
      transactionsRepository.query.mockResolvedValueOnce([
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

    it("only matches transactions within 20% tolerance of scheduled amount", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Internet Bill",
          amount: "-100.00",
          payee_name: "ISP Corp",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Some Bill",
          amount: "-100.00",
          payee_name: "Some Vendor",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Rent",
          amount: "-1500.00",
          payee_name: "Landlord",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
    });

    it("sorts monthly totals in ascending order", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([
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

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([
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

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getBillPaymentHistory(
        mockUserId,
        "2025-06-01",
        "2025-12-31",
      );

      // Second query should not be called since no scheduled transactions
      expect(transactionsRepository.query).toHaveBeenCalledTimes(1);
    });

    it("omits startDate filter from transaction query when undefined", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);
      transactionsRepository.query.mockResolvedValueOnce([]);

      await service.getBillPaymentHistory(mockUserId, undefined, "2025-12-31");

      const txQueryCall = transactionsRepository.query.mock.calls[1];
      expect(txQueryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(txQueryCall[0]).not.toContain("$3");
    });

    it("handles lastPaymentDate correctly", async () => {
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-100.00",
          payee_name: "Vendor",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      currencyService.convertAmount.mockImplementation(
        (amount: number, fromCurrency: string) => {
          if (fromCurrency === "EUR") return amount * 1.1;
          return amount;
        },
      );

      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Euro Bill",
          amount: "-100.00",
          payee_name: "Euro Vendor",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "No Payee Bill",
          amount: "-100.00",
          payee_name: null,
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      transactionsRepository.query.mockResolvedValueOnce([]);

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
      transactionsRepository.query.mockResolvedValueOnce([
        {
          id: "st-1",
          name: "Bill",
          amount: "-33.33",
          payee_name: "Vendor",
        },
      ]);

      transactionsRepository.query.mockResolvedValueOnce([
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
      expect(result.billPayments[0].averagePayment).toBe(33.33);
    });
  });
});
