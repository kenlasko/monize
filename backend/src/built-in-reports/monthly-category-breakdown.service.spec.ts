import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MonthlyCategoryBreakdownService } from "./monthly-category-breakdown.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";

describe("MonthlyCategoryBreakdownService", () => {
  let service: MonthlyCategoryBreakdownService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;
  let exchangeRateService: Record<string, jest.Mock>;

  const mockUserId = "user-1";

  const mockParentCategory: Category = {
    id: "cat-parent",
    userId: mockUserId,
    parentId: null,
    parent: null,
    children: [],
    name: "Food & Dining",
    description: null,
    icon: null,
    color: "#FF5733",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockChildCategory: Category = {
    id: "cat-child",
    userId: mockUserId,
    parentId: "cat-parent",
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: "#33FF57",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-02"),
  };

  const mockIncomeCategory: Category = {
    id: "cat-income",
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
    createdAt: new Date("2025-01-03"),
  };

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };
    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };
    exchangeRateService = {
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MonthlyCategoryBreakdownService,
        ReportCurrencyService,
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: userPreferenceRepository,
        },
        {
          provide: ExchangeRateService,
          useValue: exchangeRateService,
        },
      ],
    }).compile();

    service = module.get<MonthlyCategoryBreakdownService>(
      MonthlyCategoryBreakdownService,
    );
  });

  it("returns empty data when no transactions exist", async () => {
    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    expect(result.months).toEqual([]);
    expect(result.data).toEqual([]);
    expect(result.transfers).toEqual([]);
    expect(result.currency).toBe("USD");
  });

  it("splits transfers into signed from/to rows per account", async () => {
    // First query (categories) returns nothing; second query (transfers)
    // returns per-account, per-month aggregates of the two transfer legs.
    transactionsRepository.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          month: "2025-01",
          account_id: "acc-chequing",
          account_name: "Chequing",
          currency_code: "USD",
          outflow: "500.00",
          inflow: "0.00",
        },
        {
          month: "2025-01",
          account_id: "acc-savings",
          account_name: "Savings",
          currency_code: "USD",
          outflow: "0.00",
          inflow: "500.00",
        },
      ]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    expect(result.months).toContain("2025-01");
    const fromRow = result.transfers.find((r) => r.direction === "from");
    const toRow = result.transfers.find((r) => r.direction === "to");
    // Outflow becomes a positive "from" row (a source of funds).
    expect(fromRow?.accountName).toBe("Chequing");
    expect(fromRow?.valuesByMonth["2025-01"]).toBe(500);
    // Inflow becomes a negative "to" row (a use of funds).
    expect(toRow?.accountName).toBe("Savings");
    expect(toRow?.valuesByMonth["2025-01"]).toBe(-500);

    // The transfer query selects only transfer legs, once each.
    const transferSql = transactionsRepository.query.mock.calls[1][0];
    expect(transferSql).toContain("t.is_transfer = true");
    expect(transferSql).toContain("parent_transaction_id IS NULL");
  });

  it("builds an expense row with parent metadata and signed monthly values", async () => {
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-02",
        category_id: "cat-child",
        currency_code: "USD",
        deposits: "0.00",
        withdrawals: "120.00",
      },
      {
        month: "2025-01",
        category_id: "cat-child",
        currency_code: "USD",
        deposits: "0.00",
        withdrawals: "100.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([
      mockParentCategory,
      mockChildCategory,
    ]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    // Months are sorted ascending.
    expect(result.months).toEqual(["2025-01", "2025-02"]);
    expect(result.data).toHaveLength(1);
    const row = result.data[0];
    expect(row.categoryId).toBe("cat-child");
    expect(row.categoryName).toBe("Groceries");
    expect(row.parentId).toBe("cat-parent");
    expect(row.parentName).toBe("Food & Dining");
    expect(row.parentIsIncome).toBe(false);
    expect(row.isIncome).toBe(false);
    // Expense net = withdrawals - deposits, positive magnitude.
    expect(row.valuesByMonth["2025-01"]).toBe(100);
    expect(row.valuesByMonth["2025-02"]).toBe(120);
    expect(row.withdrawalTotal).toBe(220);
    expect(row.depositTotal).toBe(0);
  });

  it("classifies a category as income when deposits dominate", async () => {
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-01",
        category_id: "cat-income",
        currency_code: "USD",
        deposits: "5000.00",
        withdrawals: "0.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const row = result.data[0];
    expect(row.isIncome).toBe(true);
    expect(row.parentId).toBeNull();
    expect(row.parentName).toBeNull();
    expect(row.parentIsIncome).toBeNull();
    // Income net = deposits - withdrawals.
    expect(row.valuesByMonth["2025-01"]).toBe(5000);
  });

  it("keeps an expense category as expense even when deposits dominate", async () => {
    // A refund-heavy month leaves a designated expense category with more
    // deposits than withdrawals. The category's own isIncome flag must still
    // win so the row lands in the expense group with a (negative) net.
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-01",
        category_id: "cat-child",
        currency_code: "USD",
        deposits: "300.00",
        withdrawals: "100.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([
      mockParentCategory,
      mockChildCategory,
    ]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const row = result.data[0];
    expect(row.isIncome).toBe(false);
    // Expense net = withdrawals - deposits, here negative (a net refund).
    expect(row.valuesByMonth["2025-01"]).toBe(-200);
  });

  it("treats unknown or missing category as Uncategorized and merges rows", async () => {
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-01",
        category_id: null,
        currency_code: "USD",
        deposits: "0.00",
        withdrawals: "40.00",
      },
      {
        month: "2025-01",
        category_id: "ghost-cat",
        currency_code: "USD",
        deposits: "0.00",
        withdrawals: "10.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    expect(result.data).toHaveLength(1);
    expect(result.data[0].categoryId).toBeNull();
    expect(result.data[0].categoryName).toBe("Uncategorized");
    expect(result.data[0].valuesByMonth["2025-01"]).toBe(50);
  });

  it("converts foreign currency amounts to the base currency", async () => {
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-01",
        category_id: "cat-child",
        currency_code: "EUR",
        deposits: "0.00",
        withdrawals: "100.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([
      mockParentCategory,
      mockChildCategory,
    ]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    // 100 EUR * 1.1 = 110 USD
    expect(result.data[0].valuesByMonth["2025-01"]).toBe(110);
    expect(result.data[0].withdrawalTotal).toBe(110);
  });

  it("passes startDate parameter when provided and omits it otherwise", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );
    expect(transactionsRepository.query.mock.calls[0][1]).toEqual([
      mockUserId,
      "2025-12-31",
      "2025-01-01",
    ]);

    transactionsRepository.query.mockClear();

    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      undefined,
      "2025-12-31",
    );
    const call = transactionsRepository.query.mock.calls[0];
    expect(call[1]).toEqual([mockUserId, "2025-12-31"]);
    expect(call[0]).not.toContain("$3");
  });

  it("excludes transfers, investments and the asset-value-change category in SQL", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const sql = transactionsRepository.query.mock.calls[0][0];
    expect(sql).toContain("t.is_transfer = false");
    expect(sql).toContain("a.account_type != 'INVESTMENT'");
    expect(sql).toContain("asset_category_id");
    expect(sql).toContain("parent_transaction_id IS NULL");
  });

  it("counts brokerage income legs as income, not transfers, in SQL", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const incomeSql = transactionsRepository.query.mock.calls[0][0];
    const transferSql = transactionsRepository.query.mock.calls[1][0];

    // The income query keeps a transaction whose linked investment action is an
    // income action (interest, dividends, capital gains) even though it is
    // flagged is_transfer = true.
    expect(incomeSql).toContain(
      "it.action IN ('INTEREST', 'DIVIDEND', 'CAPITAL_GAIN')",
    );
    expect(incomeSql).toMatch(/t\.is_transfer = false\s*\n\s*OR\s/);
    expect(incomeSql).toMatch(/t\.is_transfer = false[\s\S]*EXISTS/);

    // The income query collapses those legs into the synthetic
    // investment-income bucket instead of their (absent) real category.
    expect(incomeSql).toContain("'investment-income'");
    expect(incomeSql).toContain(" as category_id");

    // Investment accounts are still excluded except for income legs sitting in
    // an INVESTMENT_CASH sub-account, where brokerage interest/dividends land.
    expect(incomeSql).toContain("a.account_sub_type = 'INVESTMENT_CASH'");
    expect(incomeSql).toMatch(
      /a\.account_type != 'INVESTMENT'\s*\n\s*OR\s*\(a\.account_sub_type = 'INVESTMENT_CASH'/,
    );

    // The transfer query drops those same legs so they are not double-reported.
    expect(transferSql).toContain("t.is_transfer = true");
    expect(transferSql).toMatch(/NOT\s*\n\s*EXISTS/);
    expect(transferSql).toContain(
      "it.action IN ('INTEREST', 'DIVIDEND', 'CAPITAL_GAIN')",
    );
  });

  it("surfaces a brokerage income leg under the Investment Income bucket", async () => {
    // The income query tags these legs with the synthetic investment-income
    // category id; the row must carry the 'Investment Income' label, classify as
    // income, and stay out of the transfers section.
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-03",
        category_id: "investment-income",
        currency_code: "USD",
        deposits: "42.50",
        withdrawals: "0.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    expect(result.data).toHaveLength(1);
    const row = result.data[0];
    expect(row.categoryId).toBe("investment-income");
    expect(row.categoryName).toBe("Investment Income");
    expect(row.parentId).toBeNull();
    expect(row.isIncome).toBe(true);
    expect(row.valuesByMonth["2025-03"]).toBe(42.5);
    expect(result.transfers).toEqual([]);
  });

  it("keeps the investment-income bucket separate from uncategorized rows", async () => {
    transactionsRepository.query.mockResolvedValueOnce([
      {
        month: "2025-03",
        category_id: "investment-income",
        currency_code: "USD",
        deposits: "42.50",
        withdrawals: "0.00",
      },
      {
        month: "2025-03",
        category_id: null,
        currency_code: "USD",
        deposits: "0.00",
        withdrawals: "10.00",
      },
    ]);
    categoriesRepository.find.mockResolvedValue([]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const investment = result.data.find(
      (r) => r.categoryId === "investment-income",
    );
    const uncategorized = result.data.find((r) => r.categoryId === null);
    expect(investment?.categoryName).toBe("Investment Income");
    expect(investment?.isIncome).toBe(true);
    expect(uncategorized?.categoryName).toBe("Uncategorized");
  });
});
