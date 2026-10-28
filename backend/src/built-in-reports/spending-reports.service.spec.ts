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
import { SpendingReportsService } from "./spending-reports.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
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

describe("SpendingReportsService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: SpendingReportsService;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;
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

  const mockExchangeRates = [
    { fromCurrency: "EUR", toCurrency: "USD", rate: 1.1 },
    { fromCurrency: "GBP", toCurrency: "USD", rate: 1.27 },
    { fromCurrency: "USD", toCurrency: "CAD", rate: 1.36 },
  ];

  beforeEach(async () => {
    transactionsRepository = {
      query: jest.fn().mockResolvedValue([]),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    payeesRepository = {
      findByIds: jest.fn().mockResolvedValue([]),
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
        [Payee, payeesRepository as never],
        [UserPreference, userPreferenceRepository as never],
      ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SpendingReportsService,
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
          provide: getRepositoryToken(Payee),
          useValue: payeesRepository,
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

    service = module.get<SpendingReportsService>(SpendingReportsService);
  });

  // ---------------------------------------------------------------------------
  // getSpendingByCategory
  // ---------------------------------------------------------------------------
  describe("getSpendingByCategory", () => {
    it("returns empty data when no transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalSpending).toBe(0);
    });

    it("aggregates spending by parent category with rollup", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "150.00" },
        { category_id: "cat-parent", currency_code: "USD", total: "50.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBe("cat-parent");
      expect(result.data[0].categoryName).toBe("Food & Dining");
      expect(result.data[0].total).toBe(200);
      expect(result.totalSpending).toBe(200);
    });

    it("withholds the total and names the currency when a rate is missing", async () => {
      // JPY has no rate into USD in the fixture. The honest answer is neither
      // the smaller number presented as a total nor the raw yen added to
      // dollars, which is what the report did before.
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "USD", total: "100.00" },
        { category_id: "cat-parent", currency_code: "JPY", total: "50000.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBeNull();
      expect(result.knownSpending).toBe(100);
      expect(result.data[0].total).toBe(100);
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(result.currency).toBe("USD");
    });

    it("reports a complete total when every row converted", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "USD", total: "100.00" },
        { category_id: "cat-parent", currency_code: "EUR", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBe(210);
      expect(result.knownSpending).toBe(210);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });

    it("restricts the window to the requested accounts", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { accountIds: ["acct-1", "acct-2"] },
      );

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.account_id = ANY($4::uuid[])");
      expect(params[3]).toEqual(["acct-1", "acct-2"]);
    });

    it("numbers the account parameter around an absent start date", async () => {
      // The filter is appended after the optional start date, so its position
      // is not a constant. A hardcoded $4 here silently filtered on the date.
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(mockUserId, undefined, "2025-12-31", {
        accountIds: ["acct-1"],
      });

      const [sql, params] = scopedManager.query.mock.calls[0];
      expect(sql).toContain("t.account_id = ANY($3::uuid[])");
      expect(params[2]).toEqual(["acct-1"]);
    });

    it("adds no account filter for an empty selection", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { accountIds: [] },
      );

      const [sql] = scopedManager.query.mock.calls[0];
      expect(sql).not.toContain("account_id = ANY");
    });

    describe("tag key and value filter", () => {
      it("is today's query, byte for byte, without a tag filter", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );
        await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { tagKey: undefined, tagValue: undefined },
        );

        const [plainSql, plainParams] = scopedManager.query.mock.calls[0];
        const [sameSql, sameParams] = scopedManager.query.mock.calls[1];
        expect(plainSql).not.toContain("transaction_tags");
        expect(plainSql).not.toContain("transaction_split_tags");
        expect(plainParams).toEqual([mockUserId, "2025-12-31", "2025-01-01"]);
        expect(sameSql).toBe(plainSql);
        expect(sameParams).toEqual(plainParams);
      });

      it("keeps rows whose own tag values include the value, with bound parameters", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { accountIds: ["acct-1"], tagKey: "scope", tagValue: "household" },
        );

        const [sql, params] = scopedManager.query.mock.calls[0];
        // After the account filter ($4): key $5, value $6; never interpolated.
        expect(params).toEqual([
          mockUserId,
          "2025-12-31",
          "2025-01-01",
          ["acct-1"],
          "scope",
          "household",
        ]);
        expect(sql).toContain("$6::text = ANY(");
        expect(sql).toContain("LOWER($5)");
        expect(sql).not.toContain("household");
        // Reads BOTH levels: the transaction's tags and this split's tags.
        expect(sql).toContain("FROM transaction_tags");
        expect(sql).toContain("FROM transaction_split_tags");
        // The filter narrows; every exclusion of the base query still holds.
        expect(sql).toContain("t.is_transfer = false");
        expect(sql).toContain("status != 'VOID'");
        expect(sql).toContain("t.parent_transaction_id IS NULL");
        expect(sql).toContain(
          "GROUP BY COALESCE(ts.category_id, t.category_id)",
        );
      });

      it("numbers the tag parameters around an absent start date and accounts", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getSpendingByCategory(
          mockUserId,
          undefined,
          "2025-12-31",
          {
            tagKey: "scope",
            tagValue: "household",
          },
        );

        const [sql, params] = scopedManager.query.mock.calls[0];
        expect(params).toEqual([
          mockUserId,
          "2025-12-31",
          "scope",
          "household",
        ]);
        expect(sql).toContain("$4::text = ANY(");
        expect(sql).toContain("LOWER($3)");
      });

      it("filters on nothing when only one half is given", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getSpendingByCategory(
          mockUserId,
          undefined,
          "2025-12-31",
          {
            tagKey: "scope",
          },
        );

        const [sql, params] = scopedManager.query.mock.calls[0];
        expect(sql).not.toContain("transaction_tags");
        expect(params).toEqual([mockUserId, "2025-12-31"]);
      });
    });

    it("handles uncategorized transactions (null category_id)", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "75.50" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
      expect(result.data[0].total).toBe(75.5);
    });

    it("treats unknown category_id as uncategorized", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "unknown-cat", currency_code: "USD", total: "30.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      expect(result.data[0].categoryName).toBe("Uncategorized");
    });

    it("converts foreign currency amounts to default currency", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "EUR", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(110);
    });

    it("sorts results by total descending and returns every category", async () => {
      const rawResults = Array.from({ length: 20 }, (_, i) => ({
        category_id: `cat-gen-${i}`,
        currency_code: "USD",
        total: `${(20 - i) * 10}.00`,
      }));
      const categories: Category[] = Array.from({ length: 20 }, (_, i) => ({
        id: `cat-gen-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Category ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: false,
        autoSign: null,
        isSystem: false,
        createdAt: new Date(),
      }));
      scopedManager.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(categories);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Every category, not a top-N. Truncating here made `totalSpending` the
      // sum of the largest fifteen under a name that says "total"; the caller
      // decides how many to draw and can still say what it merged.
      expect(result.data).toHaveLength(20);
      expect(result.data[0].total).toBeGreaterThanOrEqual(result.data[1].total);
      expect(result.totalSpending).toBe(
        result.data.reduce((sum, item) => sum + item.total, 0),
      );
    });

    it("uses default currency USD when user preference not found", async () => {
      userPreferenceRepository.findOne.mockResolvedValue(null);
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "USD", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].total).toBe(100);
    });

    it("passes startDate parameter when provided", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-01-01"]);
    });

    it("omits startDate filter when startDate is undefined", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(mockUserId, undefined, "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
      expect(queryCall[0]).not.toContain("$3");
    });

    it("returns color from parent category in response", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-child", currency_code: "USD", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].color).toBe("#FF5733");
    });

    it("merges multiple uncategorized rows", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: null, currency_code: "USD", total: "50.00" },
        { category_id: null, currency_code: "EUR", total: "100.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].categoryId).toBeNull();
      // 50 USD + 100 EUR * 1.1 = 160
      expect(result.data[0].total).toBe(160);
    });

    it("uses inverse rate for currency conversion when direct not available", async () => {
      scopedManager.query.mockResolvedValue([
        { category_id: "cat-parent", currency_code: "CAD", total: "136.00" },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // 136 CAD / 1.36 = 100 USD
      expect(result.data[0].total).toBe(100);
    });

    it("filters out the asset value change category in the SQL query", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getSpendingByCategory(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("asset_category_id");
      expect(sql).toMatch(
        /ax\.asset_category_id\s*=\s*COALESCE\(ts\.category_id,\s*t\.category_id\)/,
      );
    });

    // Issue #1125: a credit filed against an expense category (a refund, a
    // return) was dropped row by row, so the report disagreed with the
    // register's own balance for the same filter.
    describe("credits filed against an expense category", () => {
      it("reads rows of both signs and sums the negated amount", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        const sql: string = scopedManager.query.mock.calls[0][0];
        expect(sql).toContain("SUM(-COALESCE(ts.amount, t.amount))");
        expect(sql).toContain("COALESCE(ts.amount, t.amount) <> 0");
        // The two shapes that discard credits.
        expect(sql).not.toContain("COALESCE(ts.amount, t.amount) < 0");
        expect(sql).not.toContain("ABS(COALESCE(ts.amount, t.amount))");
      });

      it("reports the debits net of the credits", async () => {
        // The issue's figures: $23,212.25 of travel spending against a $6.18
        // credit, which the register totals as $23,206.07.
        scopedManager.query.mockResolvedValue([
          {
            category_id: "cat-parent",
            currency_code: "USD",
            total: "23206.07",
          },
        ]);
        categoriesRepository.find.mockResolvedValue([mockParentCategory]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data[0].total).toBe(23206.07);
        expect(result.totalSpending).toBe(23206.07);
      });

      it("drops a category whose credits outweigh its debits", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-parent", currency_code: "USD", total: "-500.00" },
          { category_id: "cat-child", currency_code: "USD", total: "-25.00" },
          { category_id: null, currency_code: "USD", total: "40.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([
          { ...mockParentCategory, parentId: null },
          { ...mockChildCategory, parentId: null },
        ]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data.map((d) => d.categoryId)).toEqual([null]);
        expect(result.totalSpending).toBe(40);
      });

      it("drops a category refunded back to exactly zero", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-parent", currency_code: "USD", total: "0.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([mockParentCategory]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data).toEqual([]);
        expect(result.totalSpending).toBe(0);
      });

      it("nets a subcategory's refund against its parent's spending", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-parent", currency_code: "USD", total: "150.00" },
          { category_id: "cat-child", currency_code: "USD", total: "-20.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([
          mockParentCategory,
          mockChildCategory,
        ]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data).toHaveLength(1);
        expect(result.data[0].categoryId).toBe("cat-parent");
        expect(result.data[0].total).toBe(130);
      });
    });

    describe("rollupToParent = false", () => {
      it("keeps subcategories separate with 'Parent: Child' name format", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-child", currency_code: "USD", total: "150.00" },
          { category_id: "cat-parent", currency_code: "USD", total: "50.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([
          mockParentCategory,
          mockChildCategory,
        ]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { rollupToParent: false },
        );

        expect(result.data).toHaveLength(2);
        const child = result.data.find((d) => d.categoryId === "cat-child");
        const parent = result.data.find((d) => d.categoryId === "cat-parent");
        expect(child).toBeDefined();
        expect(child!.categoryName).toBe("Food & Dining: Groceries");
        expect(child!.total).toBe(150);
        expect(parent).toBeDefined();
        expect(parent!.categoryName).toBe("Food & Dining");
        expect(parent!.total).toBe(50);
      });

      it("keeps parent-only categories with their own name", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-parent", currency_code: "USD", total: "200.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([mockParentCategory]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { rollupToParent: false },
        );

        expect(result.data).toHaveLength(1);
        expect(result.data[0].categoryName).toBe("Food & Dining");
      });

      it("uses the subcategory's own color", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-child", currency_code: "USD", total: "100.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([
          mockParentCategory,
          mockChildCategory,
        ]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { rollupToParent: false },
        );

        expect(result.data[0].color).toBe("#33FF57");
      });

      it("merges multi-currency rows for the same subcategory", async () => {
        scopedManager.query.mockResolvedValue([
          { category_id: "cat-child", currency_code: "USD", total: "100.00" },
          { category_id: "cat-child", currency_code: "EUR", total: "50.00" },
        ]);
        categoriesRepository.find.mockResolvedValue([
          mockParentCategory,
          mockChildCategory,
        ]);

        const result = await service.getSpendingByCategory(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
          { rollupToParent: false },
        );

        expect(result.data).toHaveLength(1);
        expect(result.data[0].categoryId).toBe("cat-child");
        // 100 USD + 50 EUR * 1.1 = 155
        expect(result.data[0].total).toBe(155);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // getSpendingByPayee
  // ---------------------------------------------------------------------------
  describe("getSpendingByPayee", () => {
    it("returns empty data when no transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
      expect(result.totalSpending).toBe(0);
    });

    it("aggregates spending by payee and merges multi-currency rows", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Starbucks",
          currency_code: "USD",
          total: "50.00",
        },
        {
          payee_id: "payee-1",
          payee_name: "Starbucks",
          currency_code: "EUR",
          total: "20.00",
        },
      ]);
      payeesRepository.findByIds.mockResolvedValue([
        { id: "payee-1", name: "Starbucks" },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Starbucks");
      // 50 USD + 20 EUR * 1.1 = 50 + 22 = 72
      expect(result.data[0].total).toBe(72);
    });

    it("handles transactions without payee_id using payee_name", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: "Corner Store",
          currency_code: "USD",
          total: "25.00",
        },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Corner Store");
      expect(result.data[0].payeeId).toBeNull();
      expect(result.data[0].total).toBe(25);
    });

    it("sorts by total descending and limits to top 20", async () => {
      const rawResults = Array.from({ length: 25 }, (_, i) => ({
        payee_id: `payee-${i}`,
        payee_name: `Payee ${i}`,
        currency_code: "USD",
        total: `${(25 - i) * 10}.00`,
      }));
      payeesRepository.findByIds.mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          id: `payee-${i}`,
          name: `Payee ${i}`,
        })),
      );
      scopedManager.query.mockResolvedValue(rawResults);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(20);
      expect(result.data[0].total).toBeGreaterThanOrEqual(result.data[1].total);
    });

    it("skips payee lookup when no payee_ids in results", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: "Cash Payment",
          currency_code: "USD",
          total: "10.00",
        },
      ]);

      await service.getSpendingByPayee(mockUserId, "2025-01-01", "2025-12-31");

      expect(payeesRepository.findByIds).not.toHaveBeenCalled();
    });

    it("displays 'Unknown' for payee with neither payee_id nor payee_name", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: null,
          payee_name: null,
          currency_code: "USD",
          total: "15.00",
        },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].payeeName).toBe("Unknown");
    });

    it("passes startDate when provided", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getSpendingByPayee(mockUserId, "2025-06-01", "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31", "2025-06-01"]);
    });

    it("omits startDate filter when undefined", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getSpendingByPayee(mockUserId, undefined, "2025-12-31");

      const queryCall = scopedManager.query.mock.calls[0];
      expect(queryCall[1]).toEqual([mockUserId, "2025-12-31"]);
    });

    it("calculates totalSpending from the top 20 results", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Store A",
          currency_code: "USD",
          total: "100.00",
        },
        {
          payee_id: "payee-2",
          payee_name: "Store B",
          currency_code: "USD",
          total: "200.00",
        },
      ]);
      payeesRepository.findByIds.mockResolvedValue([
        { id: "payee-1", name: "Store A" },
        { id: "payee-2", name: "Store B" },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBe(300);
    });

    it("filters out the asset value change category in the SQL query", async () => {
      scopedManager.query.mockResolvedValue([]);

      await service.getSpendingByPayee(mockUserId, "2025-01-01", "2025-12-31");

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("asset_category_id");
      expect(sql).toMatch(
        /ax\.asset_category_id\s*=\s*COALESCE\(ts\.category_id,\s*t\.category_id\)/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getMonthlySpendingTrend
  // ---------------------------------------------------------------------------
  describe("getMonthlySpendingTrend", () => {
    it("returns empty data when no transactions exist", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toEqual([]);
    });

    it("groups spending by month and category with parent rollup", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-child",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "50.00",
        },
        {
          month: "2025-02",
          category_id: "cat-child",
          currency_code: "USD",
          total: "120.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
      ]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[0].totalSpending).toBe(150);
      expect(result.data[1].month).toBe("2025-02");
      expect(result.data[1].totalSpending).toBe(120);
    });

    it("limits categories to top 10 across all months", async () => {
      const manyCategories: Category[] = Array.from({ length: 12 }, (_, i) => ({
        id: `cat-${i}`,
        userId: mockUserId,
        parentId: null,
        parent: null,
        children: [],
        name: `Category ${i}`,
        description: null,
        icon: null,
        color: null,
        isIncome: false,
        autoSign: null,
        isSystem: false,
        createdAt: new Date(),
      }));

      const rawResults = manyCategories.map((c, i) => ({
        month: "2025-01",
        category_id: c.id,
        currency_code: "USD",
        total: `${(12 - i) * 10}.00`,
      }));

      scopedManager.query.mockResolvedValue(rawResults);
      categoriesRepository.find.mockResolvedValue(manyCategories);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].categories).toHaveLength(10);
    });

    it("sorts months in ascending order", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-03",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "200.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[1].month).toBe("2025-03");
    });

    it("handles uncategorized spending in trend data", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: null,
          currency_code: "USD",
          total: "80.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      const uncatEntry = result.data[0].categories.find(
        (c) => c.categoryId === null,
      );
      expect(uncatEntry).toBeDefined();
      expect(uncatEntry!.categoryName).toBe("Uncategorized");
      expect(uncatEntry!.total).toBe(80);
    });

    it("converts foreign currency amounts in trend", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "EUR",
          total: "100.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // EUR->USD at 1.1 = 110
      expect(result.data[0].totalSpending).toBe(110);
    });

    it("fills zero for months where a category has no spending", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "100.00",
        },
        {
          month: "2025-02",
          category_id: null,
          currency_code: "USD",
          total: "50.00",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      // Feb should have cat-parent with 0 total since it only has uncategorized
      const febParent = result.data[1].categories.find(
        (c) => c.categoryId === "cat-parent",
      );
      expect(febParent).toBeDefined();
      expect(febParent!.total).toBe(0);
    });

    // Issue #1125, the trend's half of it.
    describe("credits filed against an expense category", () => {
      it("reads rows of both signs and sums the negated amount", async () => {
        scopedManager.query.mockResolvedValue([]);
        categoriesRepository.find.mockResolvedValue([]);

        await service.getMonthlySpendingTrend(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        const sql: string = scopedManager.query.mock.calls[0][0];
        expect(sql).toContain("SUM(-COALESCE(ts.amount, t.amount))");
        expect(sql).toContain("COALESCE(ts.amount, t.amount) <> 0");
        expect(sql).not.toContain("COALESCE(ts.amount, t.amount) < 0");
        expect(sql).not.toContain("ABS(COALESCE(ts.amount, t.amount))");
      });

      it("nets a later month's refund against the same category", async () => {
        scopedManager.query.mockResolvedValue([
          {
            month: "2025-01",
            category_id: "cat-parent",
            currency_code: "USD",
            total: "100.00",
          },
          {
            month: "2025-02",
            category_id: "cat-parent",
            currency_code: "USD",
            total: "-30.00",
          },
        ]);
        categoriesRepository.find.mockResolvedValue([mockParentCategory]);

        const result = await service.getMonthlySpendingTrend(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data.map((m) => m.totalSpending)).toEqual([100, -30]);
      });

      it("keeps a net-credit category out of the series", async () => {
        scopedManager.query.mockResolvedValue([
          {
            month: "2025-01",
            category_id: "cat-parent",
            currency_code: "USD",
            total: "100.00",
          },
          {
            month: "2025-01",
            category_id: "cat-child",
            currency_code: "USD",
            total: "-80.00",
          },
        ]);
        categoriesRepository.find.mockResolvedValue([
          { ...mockParentCategory, parentId: null },
          { ...mockChildCategory, parentId: null },
        ]);

        const result = await service.getMonthlySpendingTrend(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data[0].categories.map((c) => c.categoryId)).toEqual([
          "cat-parent",
        ]);
      });

      it("drops a month that holds only credits", async () => {
        scopedManager.query.mockResolvedValue([
          {
            month: "2025-01",
            category_id: "cat-parent",
            currency_code: "USD",
            total: "100.00",
          },
          {
            month: "2025-02",
            category_id: "cat-income",
            currency_code: "USD",
            total: "-4000.00",
          },
        ]);
        categoriesRepository.find.mockResolvedValue([mockParentCategory]);

        const result = await service.getMonthlySpendingTrend(
          mockUserId,
          "2025-01-01",
          "2025-12-31",
        );

        expect(result.data.map((m) => m.month)).toEqual(["2025-01"]);
      });
    });

    it("filters out the asset value change category in the SQL query", async () => {
      scopedManager.query.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([]);

      await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      const sql = scopedManager.query.mock.calls[0][0];
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("asset_category_id");
      expect(sql).toMatch(
        /ax\.asset_category_id\s*=\s*COALESCE\(ts\.category_id,\s*t\.category_id\)/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // A missing exchange rate is unknown, never 1:1 (INV-FX-001)
  // ---------------------------------------------------------------------------
  describe("a currency that has no rate", () => {
    beforeEach(() => {
      exchangeRateService.getLatestRates.mockResolvedValue([]);
    });

    it("getSpendingByPayee withholds the total and drops the unconverted payee row", async () => {
      scopedManager.query.mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Starbucks",
          currency_code: "USD",
          total: "50.00",
        },
        {
          payee_id: "payee-2",
          payee_name: "Tokyo Shop",
          currency_code: "JPY",
          total: "100000",
        },
      ]);
      payeesRepository.findByIds.mockResolvedValue([
        { id: "payee-1", name: "Starbucks" },
      ]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBeNull();
      expect(result.knownSpending).toBe(50);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("getSpendingByPayee answers zero, not null, for no rows", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getSpendingByPayee(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.totalSpending).toBe(0);
      expect(result.knownSpending).toBe(0);
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });

    it("getMonthlySpendingTrend leaves the unconverted row out of every month", async () => {
      scopedManager.query.mockResolvedValue([
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "USD",
          total: "50.00",
        },
        {
          month: "2025-01",
          category_id: "cat-parent",
          currency_code: "JPY",
          total: "100000",
        },
        {
          month: "2025-02",
          category_id: "cat-parent",
          currency_code: "JPY",
          total: "100000",
        },
      ]);
      categoriesRepository.find.mockResolvedValue([mockParentCategory]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].month).toBe("2025-01");
      expect(result.data[0].totalSpending).toBe(50);
      expect(result.currency).toBe("USD");
      expect(result.missingCurrencies).toEqual(["JPY"]);
      expect(result.excludedCount).toBe(2);
      expect(JSON.stringify(result)).not.toContain("100000");
    });

    it("getMonthlySpendingTrend reports no gaps when everything converted", async () => {
      scopedManager.query.mockResolvedValue([]);

      const result = await service.getMonthlySpendingTrend(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
    });
  });
});
