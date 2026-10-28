jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
jest.mock("../accruals/reporting-query", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingQueryMockModule(),
);
jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);

import { DataSource } from "typeorm";
import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MonthlyCategoryBreakdownService } from "./monthly-category-breakdown.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("MonthlyCategoryBreakdownService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
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
    autoSign: null,
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
    autoSign: null,
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
    autoSign: null,
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
      getRateHistory: jest.fn().mockResolvedValue([]),
      getLatestRates: jest.fn().mockResolvedValue(mockExchangeRates),
    };

    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Transaction, transactionsRepository as never],
        [Category, categoriesRepository as never],
        [UserPreference, userPreferenceRepository as never],
      ]));
    // The raw statements the reports issue default to no rows, as the
    // repository query mock they replaced did.
    scopedManager.query.mockResolvedValue([]);

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
        { provide: DataSource, useValue: scopedDataSource },
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
    scopedManager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
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
    const transferSql = scopedManager.query.mock.calls[1][0];
    expect(transferSql).toContain("t.is_transfer = true");
    expect(transferSql).toContain("parent_transaction_id IS NULL");
  });

  it("builds an expense row with parent metadata and signed monthly values", async () => {
    scopedManager.query.mockResolvedValueOnce([
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
    scopedManager.query.mockResolvedValueOnce([
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
    scopedManager.query.mockResolvedValueOnce([
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
    scopedManager.query.mockResolvedValueOnce([
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
    scopedManager.query.mockResolvedValueOnce([
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
    expect(scopedManager.query.mock.calls[0][1]).toEqual([
      mockUserId,
      "2025-12-31",
      "2025-01-01",
    ]);

    scopedManager.query.mockClear();

    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      undefined,
      "2025-12-31",
    );
    const call = scopedManager.query.mock.calls[0];
    expect(call[1]).toEqual([mockUserId, "2025-12-31"]);
    expect(call[0]).not.toContain("$3");
  });

  it("excludes transfers, investments and the asset-value-change category in SQL", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const sql = scopedManager.query.mock.calls[0][0];
    expect(sql).toContain("t.is_transfer = false");
    // Investment scope is linkage, not account type (issue #1257): the cash
    // sleeve of an INVESTMENT account holds ordinary money.
    expect(sql).not.toContain("a.account_type != 'INVESTMENT'");
    expect(sql).toContain(
      "(a.account_sub_type IS NULL OR a.account_sub_type != 'INVESTMENT_BROKERAGE')",
    );
    expect(sql).toContain("it.transaction_id = t.id");
    expect(sql).toContain("its.transaction_split_id = ts.id");
    expect(sql).toContain("asset_category_id");
    expect(sql).toContain("parent_transaction_id IS NULL");
  });

  it("includes the outflow leg of a categorized transfer in the category query", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const categorySql = scopedManager.query.mock.calls[0][0];
    // A categorized transfer is counted once, as its outflow leg, under its
    // category -- without ever being treated as income/expense elsewhere.
    expect(categorySql).toContain("t.is_transfer = true");
    expect(categorySql).toContain("t.category_id IS NOT NULL");
    expect(categorySql).toContain("t.amount < 0");
  });

  it("excludes categorized transfers from the transfer rollup to avoid double-counting", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const transferSql = scopedManager.query.mock.calls[1][0];
    expect(transferSql).toContain("t.is_transfer = true");
    expect(transferSql).toContain("t.category_id IS NULL");
  });

  // A missing exchange rate is unknown, never 1:1 (INV-FX-001).
  describe("a currency that has no rate", () => {
    beforeEach(() => {
      exchangeRateService.getLatestRates.mockResolvedValue([]);
    });

    it("leaves the unconverted rows out of every figure and names the currency", async () => {
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);
      scopedManager.query
        .mockResolvedValueOnce([
          {
            month: "2025-01",
            category_id: "cat-income",
            currency_code: "USD",
            deposits: "50.00",
            withdrawals: "0.00",
          },
          {
            month: "2025-02",
            category_id: "cat-income",
            currency_code: "JPY",
            deposits: "100000",
            withdrawals: "0.00",
          },
        ])
        .mockResolvedValueOnce([
          {
            month: "2025-03",
            account_id: "acc-yen",
            account_name: "Yen",
            currency_code: "JPY",
            outflow: "100000",
            inflow: "0.00",
          },
        ]);

      const result = await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.months).toEqual(["2025-01"]);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].depositTotal).toBe(50);
      expect(result.transfers).toEqual([]);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(2);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("reports no gaps when nothing is excluded", async () => {
      const result = await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });
  });

  describe("account filter", () => {
    it("adds no account predicate and no parameter without a selection", async () => {
      await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );
      await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { accountIds: [] },
      );

      const calls = scopedManager.query.mock.calls;
      expect(calls).toHaveLength(4);
      for (const [sql, params] of calls) {
        expect(sql).not.toContain("ANY(");
        expect(params).toEqual([mockUserId, "2025-12-31", "2025-01-01"]);
      }
      // The two requests are the same SQL: omitting it is today's query.
      expect(calls[2][0]).toBe(calls[0][0]);
      expect(calls[3][0]).toBe(calls[1][0]);
    });

    it("scopes BOTH the category query and the transfer-rows query, parameterized", async () => {
      await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { accountIds: ["acct-1", "acct-2"] },
      );

      const [categorySql, categoryParams] = scopedManager.query.mock.calls[0];
      const [transferSql, transferParams] = scopedManager.query.mock.calls[1];
      for (const [sql, params] of [
        [categorySql, categoryParams],
        [transferSql, transferParams],
      ] as const) {
        expect(sql).toContain("t.account_id = ANY($4::uuid[])");
        expect(sql).not.toContain("acct-1");
        expect(params).toEqual([
          mockUserId,
          "2025-12-31",
          "2025-01-01",
          ["acct-1", "acct-2"],
        ]);
      }
    });

    it("numbers the account parameter around an absent start date", async () => {
      await service.getMonthlyCategoryBreakdown(
        mockUserId,
        undefined,
        "2025-12-31",
        { accountIds: ["acct-1"] },
      );

      for (const [sql, params] of scopedManager.query.mock.calls) {
        expect(sql).toContain("t.account_id = ANY($3::uuid[])");
        expect(params).toEqual([mockUserId, "2025-12-31", ["acct-1"]]);
      }
    });

    it("keeps every other exclusion on both queries when scoped", async () => {
      await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { accountIds: ["acct-1"] },
      );
      const [categorySql] = scopedManager.query.mock.calls[0];
      const [transferSql] = scopedManager.query.mock.calls[1];
      expect(categorySql).toContain("status != 'VOID'");
      expect(categorySql).toContain("INVESTMENT_BROKERAGE");
      expect(transferSql).toContain("status != 'VOID'");
      expect(transferSql).toContain("t.category_id IS NULL");
    });
  });
});
