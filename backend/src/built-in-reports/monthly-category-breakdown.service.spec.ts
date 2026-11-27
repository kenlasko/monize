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
import {
  FIXTURE_TX_DATE,
  rateIndexOf,
} from "../test-helpers/report-rate-testing";

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
      getRateIndex: jest.fn().mockResolvedValue(rateIndexOf(mockExchangeRates)),
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

  it("leaves a category's foreign month out whole when one of its days has no rate (issue #2106)", async () => {
    // EUR->USD is stored for the fixture day only; 2024-01-05 has no rate.
    const part = (txDate: string, withdrawals: string) => ({
      month: "2026-01",
      category_id: null,
      currency_code: "EUR",
      tx_date: txDate,
      own_rate: null,
      deposits: "0",
      withdrawals,
    });
    scopedManager.query
      .mockResolvedValueOnce([
        part(FIXTURE_TX_DATE, "100"),
        part("2024-01-05", "50"),
      ])
      .mockResolvedValueOnce([]);

    const result = await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2024-01-01",
      "2026-01-31",
    );

    expect(result.data).toEqual([]);
    expect(result.excludedCount).toBe(1);
    expect(result.missingCurrencies).toEqual(["EUR"]);
  });

  // Two months of 0.005 groceries read 0.01 each: the page added the two
  // readings into a year cell, a row total and the section's and group's
  // totals of 0.02, where the months come to 0.01 (issue #2413).
  describe("totals read once from the cells' aggregates", () => {
    const grocery = (month: string) => ({
      month,
      category_id: "cat-child",
      currency_code: "USD",
      tx_date: `${month}-10`,
      own_rate: null,
      deposits: "0",
      withdrawals: "0.005",
    });

    beforeEach(() => {
      categoriesRepository.find.mockResolvedValue([
        mockParentCategory,
        mockChildCategory,
        mockIncomeCategory,
      ]);
    });

    it("folds a year's months before reading its cell", async () => {
      scopedManager.query
        .mockResolvedValueOnce([grocery("2025-01"), grocery("2025-02")])
        .mockResolvedValueOnce([]);

      const result = await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
        { period: "year" },
      );

      expect(result.period).toBe("year");
      expect(result.months).toEqual(["2025"]);
      expect(result.data[0].valuesByMonth).toEqual({ "2025": 0.01 });
      expect(result.data[0]).toMatchObject({
        sectionKey: "cat-parent",
        total: 0.01,
        average: 0.01,
      });
      expect(result.sections).toEqual([
        {
          key: "cat-parent",
          isIncome: false,
          valuesByMonth: { "2025": 0.01 },
          total: 0.01,
          average: 0.01,
        },
      ]);
      expect(result.summary.expenses.total).toBe(0.01);
      expect(result.summary.balance.total).toBe(-0.01);
    });

    it("reads a monthly row's total and the groups once", async () => {
      scopedManager.query
        .mockResolvedValueOnce([grocery("2025-01"), grocery("2025-02")])
        .mockResolvedValueOnce([
          {
            month: "2025-02",
            account_id: "acc-chequing",
            account_name: "Chequing",
            currency_code: "USD",
            tx_date: "2025-02-03",
            outflow: "0.005",
            inflow: "0",
          },
        ]);

      const result = await service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2025-01-01",
        "2025-12-31",
      );

      expect(result.period).toBe("month");
      expect(result.data[0].valuesByMonth).toEqual({
        "2025-01": 0.01,
        "2025-02": 0.01,
      });
      // 0.010 over two months, read once: 0.01, its mean 0.005 reads 0.01.
      expect(result.data[0]).toMatchObject({ total: 0.01, average: 0.01 });
      // 0.005 over two months: its mean, 0.0025, reads 0.00.
      expect(result.transfers[0]).toMatchObject({ total: 0.01, average: 0 });
      // February's 0.005 of spending and 0.005 transferred net to zero, and
      // the window's -0.010 + 0.005 is -0.005, read once: -0.01.
      expect(result.summary.overall.valuesByMonth).toEqual({
        "2025-01": -0.01,
        "2025-02": 0,
      });
      expect(result.summary.overall.total).toBe(-0.01);
    });
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
        tx_date: FIXTURE_TX_DATE,
        outflow: "500.00",
        inflow: "0.00",
      },
      {
        month: "2025-01",
        account_id: "acc-savings",
        account_name: "Savings",
        currency_code: "USD",
        tx_date: FIXTURE_TX_DATE,
        outflow: "0.00",
        inflow: "500.00",
        // The incoming leg is an imported estimate (design section 6, P5).
        provisional_count: "1",
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
    // The estimate stays in the figure and is counted beside it.
    expect(result.provisionalCount).toBe(1);
    expect(transferSql).toContain(
      "COUNT(*) FILTER (WHERE t.amount_is_provisional = true) as provisional_count",
    );
  });

  // docs/specs/transfer-categories.md section 7: a leg holding a Transfer
  // category is on its category's row; every other leg, one holding an
  // Expense category included, stays on its account's row.
  describe("Transfer categories in the Transfers group", () => {
    const transferParent = {
      ...mockParentCategory,
      id: "cat-transfers",
      name: "Transfers",
      categoryType: "transfer",
    } as Category;
    const savings = {
      ...mockChildCategory,
      id: "cat-savings",
      parentId: "cat-transfers",
      name: "Savings contributions",
      categoryType: "transfer",
    } as Category;
    const mortgage = {
      ...mockParentCategory,
      id: "cat-mortgage",
      name: "Mortgage",
      categoryType: "expense",
    } as Category;
    const leg = (
      account: string,
      transferCategoryId: string | null,
      outflow: string,
      inflow: string,
    ) => ({
      month: "2026-03",
      account_id: `acc-${account}`,
      account_name: account,
      transfer_category_id: transferCategoryId,
      currency_code: "USD",
      tx_date: FIXTURE_TX_DATE,
      outflow,
      inflow,
      provisional_count: "0",
    });
    // Chequing -> HISA 500 and HISA -> Chequing 200 (Savings contributions),
    // Chequing -> HISA 100 (none), Chequing -> Mortgage 1,500 (Expense:
    // Mortgage, whose category the SQL does not report as a Transfer one).
    const allAccounts = [
      leg("Chequing", "cat-savings", "500", "200"),
      leg("HISA", "cat-savings", "200", "500"),
      leg("Chequing", null, "1600", "0"),
      leg("HISA", null, "0", "100"),
      leg("Mortgage", null, "0", "1500"),
    ];
    const run = async (legs: unknown[]) => {
      categoriesRepository.find.mockResolvedValue([
        transferParent,
        savings,
        mortgage,
      ]);
      scopedManager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(legs)
        .mockResolvedValueOnce([]);
      return service.getMonthlyCategoryBreakdown(
        mockUserId,
        "2026-03-01",
        "2026-03-31",
      );
    };
    const figure = (
      rows: { kind: string; direction: string; total: number }[],
      kind: string,
      direction: string,
      name: (r: never) => boolean,
    ) =>
      rows.find(
        (r) => r.kind === kind && r.direction === direction && name(r as never),
      )?.total;

    it("lists the category's outgoing and incoming rows, all accounts", async () => {
      const result = await run(allAccounts);
      const rows = result.transfers.filter((r) => !r.isSubtotal);
      const byCategory = (dir: string) =>
        figure(
          rows,
          "category",
          dir,
          (r: { categoryId: string }) => r.categoryId === "cat-savings",
        );
      const byAccount = (dir: string, name: string) =>
        figure(
          rows,
          "account",
          dir,
          (r: { accountName: string }) => r.accountName === name,
        );
      expect(byCategory("from")).toBe(700);
      expect(byCategory("to")).toBe(-700);
      expect(byAccount("from", "Chequing")).toBe(1600);
      expect(byAccount("to", "Chequing")).toBeUndefined();
      expect(byAccount("from", "HISA")).toBeUndefined();
      expect(byAccount("to", "HISA")).toBe(-100);
      expect(byAccount("to", "Mortgage")).toBe(-1500);
      expect(rows).toHaveLength(5);
      // The group total is what it was: every leg is on one row once.
      expect(result.summary.transfers.total).toBe(0);
      // The category row names its tree.
      const row = rows.find((r) => r.categoryId === "cat-savings");
      expect(row).toMatchObject({
        categoryName: "Savings contributions",
        parentId: "cat-transfers",
        parentName: "Transfers",
        accountId: null,
      });
    });

    it("rolls a parent's rows up per direction, outside the group total", async () => {
      const result = await run(allAccounts);
      const subtotals = result.transfers.filter((r) => r.isSubtotal);
      expect(
        subtotals.map((r) => [r.categoryId, r.direction, r.total]),
      ).toEqual([
        ["cat-transfers", "from", 700],
        ["cat-transfers", "to", -700],
      ]);
      expect(result.summary.transfers.total).toBe(0);
    });

    it("counts only the scope's legs, Chequing only", async () => {
      const result = await run([
        leg("Chequing", "cat-savings", "500", "200"),
        leg("Chequing", null, "1600", "0"),
      ]);
      const rows = result.transfers.filter((r) => !r.isSubtotal);
      expect(rows.map((r) => [r.kind, r.direction, r.total])).toEqual([
        ["category", "from", 500],
        ["category", "to", -200],
        ["account", "from", 1600],
      ]);
      expect(result.summary.transfers.total).toBe(1900);
    });

    it("reads the leg's own category, a whole leg's and a line's", async () => {
      await run([]);
      const [whole, line] = [
        scopedManager.query.mock.calls[1][0],
        scopedManager.query.mock.calls[2][0],
      ];
      expect(whole).toContain(
        "LEFT JOIN categories tc ON tc.id = t.category_id",
      );
      expect(line).toContain(
        "LEFT JOIN categories tc ON tc.id = ts.category_id",
      );
      expect(whole).toContain("tc.category_type = 'transfer'");
    });

    it("leaves a leg on its account's row when its category is not in scope", async () => {
      const result = await run([leg("Chequing", "cat-gone", "50", "0")]);
      expect(result.transfers).toEqual([
        expect.objectContaining({
          kind: "account",
          accountName: "Chequing",
          direction: "from",
          total: 50,
        }),
      ]);
    });
  });

  it("builds an expense row with parent metadata and signed monthly values", async () => {
    scopedManager.query.mockResolvedValueOnce([
      {
        month: "2025-02",
        category_id: "cat-child",
        currency_code: "USD",
        tx_date: FIXTURE_TX_DATE,
        deposits: "0.00",
        withdrawals: "120.00",
      },
      {
        month: "2025-01",
        category_id: "cat-child",
        currency_code: "USD",
        tx_date: FIXTURE_TX_DATE,
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
        tx_date: FIXTURE_TX_DATE,
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
        tx_date: FIXTURE_TX_DATE,
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
        tx_date: FIXTURE_TX_DATE,
        deposits: "0.00",
        withdrawals: "40.00",
      },
      {
        month: "2025-01",
        category_id: "ghost-cat",
        currency_code: "USD",
        tx_date: FIXTURE_TX_DATE,
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
        tx_date: FIXTURE_TX_DATE,
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

  it("reads each figure once at the reporting currency's places (issue #2410)", async () => {
    // 1.00 EUR at 2.50498 is 2.50498 USD: 2.50, where its four-place reading
    // 2.5050 showed as 2.51.
    exchangeRateService.getRateIndex.mockResolvedValue(
      rateIndexOf([{ fromCurrency: "EUR", toCurrency: "USD", rate: 2.50498 }]),
    );
    scopedManager.query.mockResolvedValueOnce([
      {
        month: "2025-01",
        category_id: "cat-child",
        currency_code: "EUR",
        tx_date: FIXTURE_TX_DATE,
        deposits: "0.00",
        withdrawals: "1.00",
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

    expect(result.data[0].valuesByMonth["2025-01"]).toBe(2.5);
    expect(result.data[0].withdrawalTotal).toBe(2.5);
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
      "USD",
      "2025-01-01",
    ]);

    scopedManager.query.mockClear();

    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      undefined,
      "2025-12-31",
    );
    const call = scopedManager.query.mock.calls[0];
    expect(call[1]).toEqual([mockUserId, "2025-12-31", "USD"]);
    expect(call[0]).not.toContain("transaction_date >= $");
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

  it("keeps a categorized transfer out of the category query (INV-REPORT-003)", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const categorySql = scopedManager.query.mock.calls[0][0];
    expect(categorySql).toContain("AND t.is_transfer = false");
    expect(categorySql).not.toContain("t.is_transfer = true");
  });

  it("reports a categorized transfer only in the transfer rollup", async () => {
    await service.getMonthlyCategoryBreakdown(
      mockUserId,
      "2025-01-01",
      "2025-12-31",
    );

    const transferSql = scopedManager.query.mock.calls[1][0];
    expect(transferSql).toContain("t.is_transfer = true");
    expect(transferSql).not.toContain("t.category_id IS NULL");
  });

  // A missing exchange rate is unknown, never 1:1 (INV-FX-001).
  describe("a currency that has no rate", () => {
    beforeEach(() => {
      exchangeRateService.getRateIndex.mockResolvedValue(rateIndexOf([]));
    });

    it("leaves the unconverted rows out of every figure and names the currency", async () => {
      categoriesRepository.find.mockResolvedValue([mockIncomeCategory]);
      scopedManager.query
        .mockResolvedValueOnce([
          {
            month: "2025-01",
            category_id: "cat-income",
            currency_code: "USD",
            tx_date: FIXTURE_TX_DATE,
            deposits: "50.00",
            withdrawals: "0.00",
          },
          {
            month: "2025-02",
            category_id: "cat-income",
            currency_code: "JPY",
            tx_date: FIXTURE_TX_DATE,
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
            tx_date: FIXTURE_TX_DATE,
            outflow: "100000",
            inflow: "0.00",
            provisional_count: "1",
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
      // An estimate left out for want of a rate is in no figure.
      expect(result.provisionalCount).toBe(0);
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
      // Per request: the category query, then the transfer rows' two branches.
      expect(calls).toHaveLength(6);
      for (const [sql, params] of calls) {
        expect(sql).not.toContain("ANY(");
        expect(params).toEqual([mockUserId, "2025-12-31", "USD", "2025-01-01"]);
      }
      // The two requests are the same SQL: omitting it is today's query.
      for (let i = 0; i < 3; i++) expect(calls[i + 3][0]).toBe(calls[i][0]);
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
        expect(sql).toContain("t.account_id = ANY($5::uuid[])");
        expect(sql).not.toContain("acct-1");
        expect(params).toEqual([
          mockUserId,
          "2025-12-31",
          "USD",
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
        expect(sql).toContain("t.account_id = ANY($4::uuid[])");
        expect(params).toEqual([mockUserId, "2025-12-31", "USD", ["acct-1"]]);
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
    });
  });
});
