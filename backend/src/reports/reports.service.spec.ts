import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { ReportsService } from "./reports.service";
import {
  CustomReport,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  ReportViewType,
  ReportConfig,
  TableColumn,
  SortDirection,
} from "./entities/custom-report.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { BudgetsService } from "../budgets/budgets.service";

describe("ReportsService", () => {
  let service: ReportsService;
  let reportsRepository: Record<string, jest.Mock>;
  let transactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  let payeesRepository: Record<string, jest.Mock>;

  const defaultConfig: ReportConfig = {
    metric: MetricType.TOTAL_AMOUNT,
    includeTransfers: false,
    direction: DirectionFilter.EXPENSES_ONLY,
  };

  const mockReport: CustomReport = {
    id: "report-1",
    userId: "user-1",
    name: "Monthly Expenses",
    description: "Track monthly spending",
    icon: "chart",
    backgroundColor: "#3b82f6",
    viewType: ReportViewType.BAR_CHART,
    timeframeType: TimeframeType.LAST_3_MONTHS,
    groupBy: GroupByType.CATEGORY,
    filters: {},
    config: { ...defaultConfig },
    isFavourite: false,
    sortOrder: 0,
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };

  const mockCategory: Category = {
    id: "cat-1",
    userId: "user-1",
    parentId: null,
    parent: null,
    children: [],
    name: "Groceries",
    description: null,
    icon: null,
    color: "#22c55e",
    isIncome: false,
    isSystem: false,
    createdAt: new Date("2025-01-01"),
  };

  const mockPayee: Payee = {
    id: "payee-1",
    userId: "user-1",
    name: "Walmart",
    defaultCategoryId: null,
    notes: "" as any,
    defaultCategory: null as any,
    createdAt: new Date("2025-01-01"),
  };

  const createMockTransaction = (
    overrides: Partial<Transaction> = {},
  ): Transaction =>
    ({
      id: "tx-1",
      userId: "user-1",
      accountId: "acc-1",
      account: { id: "acc-1", name: "Checking" },
      transactionDate: "2025-06-15",
      payeeId: "payee-1",
      payee: { id: "payee-1", name: "Walmart" },
      payeeName: "Walmart",
      categoryId: "cat-1",
      category: { id: "cat-1", name: "Groceries" },
      amount: -50,
      currencyCode: "USD",
      exchangeRate: 1,
      description: "Weekly groceries",
      referenceNumber: null,
      status: "UNRECONCILED",
      reconciledDate: null,
      isSplit: false,
      parentTransactionId: null,
      isTransfer: false,
      linkedTransactionId: null,
      linkedTransaction: null,
      splits: [],
      createdAt: new Date("2025-06-15"),
      updatedAt: new Date("2025-06-15"),
      ...overrides,
    }) as unknown as Transaction;

  const createMockQueryBuilder = (
    overrides: Record<string, jest.Mock> = {},
  ) => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    ...overrides,
  });

  beforeEach(async () => {
    reportsRepository = {
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-report" })),
      save: jest.fn().mockImplementation((data) => data),
      findOne: jest.fn(),
      find: jest.fn(),
      remove: jest.fn(),
    };

    transactionsRepository = {
      createQueryBuilder: jest.fn(() => createMockQueryBuilder()),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    payeesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: getRepositoryToken(CustomReport),
          useValue: reportsRepository,
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: transactionsRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: categoriesRepository,
        },
        { provide: getRepositoryToken(Payee), useValue: payeesRepository },
        {
          provide: BudgetsService,
          useValue: {
            findAll: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
  });

  describe("create", () => {
    it("creates a report with default config values when config not provided", async () => {
      const dto = { name: "New Report" };

      const result = await service.create("user-1", dto);

      expect(reportsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "New Report",
          userId: "user-1",
          config: expect.objectContaining({
            metric: MetricType.TOTAL_AMOUNT,
            includeTransfers: false,
            direction: DirectionFilter.EXPENSES_ONLY,
          }),
          filters: {},
        }),
      );
      expect(reportsRepository.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("creates a report with provided config values", async () => {
      const dto = {
        name: "Income Report",
        config: {
          metric: MetricType.COUNT,
          includeTransfers: true,
          direction: DirectionFilter.INCOME_ONLY,
          customStartDate: "2025-01-01",
          customEndDate: "2025-06-30",
          tableColumns: [TableColumn.LABEL, TableColumn.VALUE],
          sortBy: TableColumn.VALUE,
          sortDirection: SortDirection.ASC,
        },
      };

      await service.create("user-1", dto);

      expect(reportsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          config: {
            metric: MetricType.COUNT,
            includeTransfers: true,
            direction: DirectionFilter.INCOME_ONLY,
            customStartDate: "2025-01-01",
            customEndDate: "2025-06-30",
            tableColumns: [TableColumn.LABEL, TableColumn.VALUE],
            sortBy: TableColumn.VALUE,
            sortDirection: SortDirection.ASC,
          },
        }),
      );
    });

    it("creates a report with provided filters", async () => {
      const dto = {
        name: "Filtered Report",
        filters: {
          accountIds: ["acc-1"],
          categoryIds: ["cat-1"],
          payeeIds: ["payee-1"],
          searchText: "groceries",
        },
      };

      await service.create("user-1", dto);

      expect(reportsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: dto.filters,
        }),
      );
    });

    it("defaults filters to empty object when not provided", async () => {
      await service.create("user-1", { name: "Bare Report" });

      expect(reportsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: {},
        }),
      );
    });

    it("defaults includeTransfers to false when config.includeTransfers is undefined", async () => {
      const dto = {
        name: "Test",
        config: { metric: MetricType.AVERAGE },
      };

      await service.create("user-1", dto);

      const createCall = reportsRepository.create.mock.calls[0][0];
      expect(createCall.config.includeTransfers).toBe(false);
    });
  });

  describe("findAll", () => {
    it("returns all reports for a user", async () => {
      const reports = [
        mockReport,
        { ...mockReport, id: "report-2", name: "Second Report" },
      ];
      reportsRepository.find.mockResolvedValue(reports);

      const result = await service.findAll("user-1");

      expect(result).toEqual(reports);
      expect(reportsRepository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        order: { sortOrder: "ASC", createdAt: "DESC" },
      });
    });

    it("returns empty array when user has no reports", async () => {
      reportsRepository.find.mockResolvedValue([]);

      const result = await service.findAll("user-1");

      expect(result).toEqual([]);
    });
  });

  describe("findOne", () => {
    it("returns report when found and belongs to user", async () => {
      reportsRepository.findOne.mockResolvedValue(mockReport);

      const result = await service.findOne("user-1", "report-1");

      expect(result).toEqual(mockReport);
      expect(reportsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "report-1" },
      });
    });

    it("throws NotFoundException when report not found", async () => {
      reportsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when report belongs to different user", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...mockReport,
        userId: "other-user",
      });

      await expect(service.findOne("user-1", "report-1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("update", () => {
    it("updates simple report fields", async () => {
      reportsRepository.findOne.mockResolvedValue({ ...mockReport });

      const result = await service.update("user-1", "report-1", {
        name: "Updated Report",
        description: "New description",
        icon: "pie-chart",
        backgroundColor: "#ff0000",
      });

      expect(result.name).toBe("Updated Report");
      expect(result.description).toBe("New description");
      expect(result.icon).toBe("pie-chart");
      expect(result.backgroundColor).toBe("#ff0000");
      expect(reportsRepository.save).toHaveBeenCalled();
    });

    it("updates viewType, timeframeType, groupBy", async () => {
      reportsRepository.findOne.mockResolvedValue({ ...mockReport });

      const result = await service.update("user-1", "report-1", {
        viewType: ReportViewType.PIE_CHART,
        timeframeType: TimeframeType.YEAR_TO_DATE,
        groupBy: GroupByType.PAYEE,
      });

      expect(result.viewType).toBe(ReportViewType.PIE_CHART);
      expect(result.timeframeType).toBe(TimeframeType.YEAR_TO_DATE);
      expect(result.groupBy).toBe(GroupByType.PAYEE);
    });

    it("updates isFavourite and sortOrder", async () => {
      reportsRepository.findOne.mockResolvedValue({ ...mockReport });

      const result = await service.update("user-1", "report-1", {
        isFavourite: true,
        sortOrder: 5,
      });

      expect(result.isFavourite).toBe(true);
      expect(result.sortOrder).toBe(5);
    });

    it("merges config when provided", async () => {
      const existingReport = {
        ...mockReport,
        config: {
          ...defaultConfig,
          tableColumns: [TableColumn.LABEL],
        },
      };
      reportsRepository.findOne.mockResolvedValue(existingReport);

      const result = await service.update("user-1", "report-1", {
        config: { metric: MetricType.AVERAGE },
      });

      expect(result.config.metric).toBe(MetricType.AVERAGE);
      // Existing config values should be preserved via spread
      expect(result.config.direction).toBe(DirectionFilter.EXPENSES_ONLY);
    });

    it("replaces filters when provided", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...mockReport,
        filters: { accountIds: ["old-acc"] },
      });

      const newFilters = { categoryIds: ["cat-new"] };
      const result = await service.update("user-1", "report-1", {
        filters: newFilters,
      });

      expect(result.filters).toEqual(newFilters);
    });

    it("does not overwrite fields that are not in the dto", async () => {
      const original = {
        ...mockReport,
        name: "Original Name",
        description: "Keep me",
      };
      reportsRepository.findOne.mockResolvedValue(original);

      const result = await service.update("user-1", "report-1", {
        icon: "new-icon",
      });

      expect(result.name).toBe("Original Name");
      expect(result.description).toBe("Keep me");
      expect(result.icon).toBe("new-icon");
    });

    it("throws NotFoundException when report does not exist", async () => {
      reportsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update("user-1", "nonexistent", { name: "New" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ForbiddenException when report belongs to different user", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...mockReport,
        userId: "other-user",
      });

      await expect(
        service.update("user-1", "report-1", { name: "Hacked" }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("remove", () => {
    it("removes report when found and belongs to user", async () => {
      reportsRepository.findOne.mockResolvedValue({ ...mockReport });

      await service.remove("user-1", "report-1");

      expect(reportsRepository.remove).toHaveBeenCalledWith(
        expect.objectContaining({ id: "report-1" }),
      );
    });

    it("throws NotFoundException when report does not exist", async () => {
      reportsRepository.findOne.mockResolvedValue(null);

      await expect(service.remove("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when report belongs to different user", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...mockReport,
        userId: "other-user",
      });

      await expect(service.remove("user-1", "report-1")).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe("execute", () => {
    const setupExecuteMocks = (
      report: Partial<CustomReport>,
      transactions: Transaction[] = [],
    ) => {
      const fullReport = { ...mockReport, ...report };
      reportsRepository.findOne.mockResolvedValue(fullReport);

      const qb = createMockQueryBuilder({
        getMany: jest.fn().mockResolvedValue(transactions),
      });
      transactionsRepository.createQueryBuilder.mockReturnValue(qb);

      return { qb, report: fullReport };
    };

    it("executes a report with no transactions and returns empty data", async () => {
      setupExecuteMocks({
        groupBy: GroupByType.NONE,
        config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
      });

      const result = await service.execute("user-1", "report-1");

      expect(result.reportId).toBe("report-1");
      expect(result.name).toBe("Monthly Expenses");
      expect(result.data).toEqual([]);
      expect(result.summary).toEqual({ total: 0, count: 0, average: 0 });
    });

    it("returns correct report metadata", async () => {
      setupExecuteMocks({
        viewType: ReportViewType.PIE_CHART,
        groupBy: GroupByType.CATEGORY,
        config: {
          ...defaultConfig,
          tableColumns: [TableColumn.LABEL, TableColumn.VALUE],
        },
      });
      categoriesRepository.find.mockResolvedValue([]);

      const result = await service.execute("user-1", "report-1");

      expect(result.viewType).toBe(ReportViewType.PIE_CHART);
      expect(result.groupBy).toBe(GroupByType.CATEGORY);
      expect(result.tableColumns).toEqual([
        TableColumn.LABEL,
        TableColumn.VALUE,
      ]);
      expect(result.timeframe).toBeDefined();
      expect(result.timeframe.startDate).toBeDefined();
      expect(result.timeframe.endDate).toBeDefined();
      expect(result.timeframe.label).toBeDefined();
    });

    it("uses override timeframe when provided", async () => {
      setupExecuteMocks({
        timeframeType: TimeframeType.LAST_3_MONTHS,
        config: { ...defaultConfig },
      });

      const result = await service.execute("user-1", "report-1", {
        timeframeType: TimeframeType.CUSTOM,
        startDate: "2025-01-01",
        endDate: "2025-06-30",
      });

      expect(result.timeframe.startDate).toBe("2025-01-01");
      expect(result.timeframe.endDate).toBe("2025-06-30");
      expect(result.timeframe.label).toBe("Custom Range");
    });

    it("uses report saved timeframe when no overrides provided", async () => {
      setupExecuteMocks({
        timeframeType: TimeframeType.YEAR_TO_DATE,
        config: { ...defaultConfig },
      });

      const result = await service.execute("user-1", "report-1");

      expect(result.timeframe.label).toBe("Year to Date");
    });

    it("throws NotFoundException when report does not exist", async () => {
      reportsRepository.findOne.mockResolvedValue(null);

      await expect(service.execute("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws ForbiddenException when report belongs to different user", async () => {
      reportsRepository.findOne.mockResolvedValue({
        ...mockReport,
        userId: "other-user",
      });

      await expect(service.execute("user-1", "report-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    describe("groupBy NONE", () => {
      it("aggregates transactions into a single total with TOTAL_AMOUNT metric", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", amount: -50 }),
          createMockTransaction({ id: "tx-2", amount: -30 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("total");
        expect(result.data[0].label).toBe("Total");
        expect(result.data[0].value).toBe(80); // abs(-50) + abs(-30)
        expect(result.data[0].count).toBe(2);
        expect(result.data[0].percentage).toBe(100);
      });

      it("returns COUNT metric as transaction count", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", amount: -50 }),
          createMockTransaction({ id: "tx-2", amount: -30 }),
          createMockTransaction({ id: "tx-3", amount: -20 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.COUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].value).toBe(3);
      });

      it("returns AVERAGE metric as average amount", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", amount: -60 }),
          createMockTransaction({ id: "tx-2", amount: -40 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.AVERAGE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].value).toBe(50); // (60+40)/2
      });

      it("returns individual transaction rows with NONE metric", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            amount: -50,
            payeeName: "Store A",
            description: "Desc A",
          }),
          createMockTransaction({
            id: "tx-2",
            amount: -30,
            payeeName: "Store B",
            description: "Desc B",
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.NONE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("tx-1");
        expect(result.data[0].label).toBe("Store A");
        expect(result.data[0].value).toBe(50);
        expect(result.data[0].payee).toBe("Store A");
        expect(result.data[0].description).toBe("Desc A");
        expect(result.data[1].id).toBe("tx-2");
      });

      it("handles split transactions with NONE metric by expanding splits", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            amount: -100,
            isSplit: true,
            splits: [
              {
                id: "split-1",
                transactionId: "tx-1",
                categoryId: "cat-1",
                category: { id: "cat-1", name: "Groceries" } as Category,
                amount: -60,
                memo: "Food",
              } as any,
              {
                id: "split-2",
                transactionId: "tx-1",
                categoryId: "cat-2",
                category: { id: "cat-2", name: "Household" } as Category,
                amount: -40,
                memo: "Cleaning supplies",
              } as any,
            ],
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.NONE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        expect(result.data[0].value).toBe(60);
        expect(result.data[0].memo).toBe("Food");
        expect(result.data[0].category).toBe("Groceries");
        expect(result.data[1].value).toBe(40);
        expect(result.data[1].memo).toBe("Cleaning supplies");
      });

      it("handles split transactions with TOTAL_AMOUNT metric by summing split amounts", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            amount: -100,
            isSplit: true,
            splits: [{ amount: -60 } as any, { amount: -40 } as any],
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(1);
        expect(result.data[0].value).toBe(100); // abs(-60) + abs(-40)
        expect(result.data[0].count).toBe(2);
      });
    });

    describe("groupBy CATEGORY", () => {
      it("aggregates transactions by category", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-1",
            amount: -30,
          }),
          createMockTransaction({
            id: "tx-3",
            categoryId: "cat-2",
            amount: -20,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining", color: "#ef4444" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        // Sorted descending by value
        expect(result.data[0].label).toBe("Groceries");
        expect(result.data[0].value).toBe(80);
        expect(result.data[0].color).toBe("#22c55e");
        expect(result.data[0].count).toBe(2);
        expect(result.data[1].label).toBe("Dining");
        expect(result.data[1].value).toBe(20);
        expect(result.data[1].count).toBe(1);
      });

      it("labels uncategorized transactions", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", categoryId: null, amount: -50 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue([]);

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("uncategorized");
        expect(result.data[0].label).toBe("Uncategorized");
      });

      it("handles split transactions grouped by category", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            isSplit: true,
            categoryId: null,
            amount: -100,
            splits: [
              { categoryId: "cat-1", amount: -60 } as any,
              { categoryId: "cat-2", amount: -40 } as any,
            ],
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        const groceries = result.data.find((d) => d.label === "Groceries");
        const dining = result.data.find((d) => d.label === "Dining");
        expect(groceries!.value).toBe(60);
        expect(dining!.value).toBe(40);
      });

      it("calculates percentages for category aggregation", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -75,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -25,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        const groceries = result.data.find((d) => d.label === "Groceries");
        const dining = result.data.find((d) => d.label === "Dining");
        expect(groceries!.percentage).toBe(75);
        expect(dining!.percentage).toBe(25);
      });

      it("fetches categories only when groupBy is CATEGORY", async () => {
        setupExecuteMocks({
          groupBy: GroupByType.CATEGORY,
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(categoriesRepository.find).toHaveBeenCalledWith({
          where: { userId: "user-1" },
        });
        expect(payeesRepository.find).not.toHaveBeenCalled();
      });
    });

    describe("groupBy PAYEE", () => {
      it("aggregates transactions by payee", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            payeeId: "payee-1",
            payeeName: "Walmart",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            payeeId: "payee-1",
            payeeName: "Walmart",
            amount: -30,
          }),
          createMockTransaction({
            id: "tx-3",
            payeeId: "payee-2",
            payeeName: "Target",
            amount: -20,
          }),
        ];
        const payees = [
          mockPayee,
          { ...mockPayee, id: "payee-2", name: "Target" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.PAYEE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        payeesRepository.find.mockResolvedValue(payees);

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        expect(result.data[0].label).toBe("Walmart");
        expect(result.data[0].value).toBe(80);
        expect(result.data[1].label).toBe("Target");
        expect(result.data[1].value).toBe(20);
      });

      it("labels unknown payees from payeeName field", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            payeeId: null,
            payeeName: "Cash Payment",
            amount: -25,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.PAYEE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        payeesRepository.find.mockResolvedValue([]);

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe("unknown");
        expect(result.data[0].label).toBe("Cash Payment");
      });

      it("labels completely unknown payees as Unknown", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            payeeId: null,
            payeeName: null,
            amount: -25,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.PAYEE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        payeesRepository.find.mockResolvedValue([]);

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].label).toBe("Unknown");
      });

      it("fetches payees only when groupBy is PAYEE", async () => {
        setupExecuteMocks({
          groupBy: GroupByType.PAYEE,
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(payeesRepository.find).toHaveBeenCalledWith({
          where: { userId: "user-1" },
        });
        expect(categoriesRepository.find).not.toHaveBeenCalled();
      });
    });

    describe("groupBy time periods", () => {
      it("aggregates by MONTH", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            transactionDate: "2025-01-15",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            transactionDate: "2025-01-20",
            amount: -30,
          }),
          createMockTransaction({
            id: "tx-3",
            transactionDate: "2025-02-10",
            amount: -20,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.MONTH,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        // Sorted by date key ascending
        expect(result.data[0].id).toBe("2025-01");
        expect(result.data[0].label).toBe("Jan 2025");
        expect(result.data[0].value).toBe(80);
        expect(result.data[1].id).toBe("2025-02");
        expect(result.data[1].label).toBe("Feb 2025");
        expect(result.data[1].value).toBe(20);
      });

      it("aggregates by YEAR", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            transactionDate: "2024-06-15",
            amount: -100,
          }),
          createMockTransaction({
            id: "tx-2",
            transactionDate: "2025-03-10",
            amount: -50,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.YEAR,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        expect(result.data[0].id).toBe("2024");
        expect(result.data[0].value).toBe(100);
        expect(result.data[1].id).toBe("2025");
        expect(result.data[1].value).toBe(50);
      });

      it("aggregates by DAY", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            transactionDate: "2025-03-15",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            transactionDate: "2025-03-15",
            amount: -30,
          }),
          createMockTransaction({
            id: "tx-3",
            transactionDate: "2025-03-16",
            amount: -20,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.DAY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(2);
        expect(result.data[0].value).toBe(80);
        expect(result.data[0].count).toBe(2);
        expect(result.data[1].value).toBe(20);
        expect(result.data[1].count).toBe(1);
      });

      it("aggregates by WEEK", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            transactionDate: "2025-03-10",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            transactionDate: "2025-03-11",
            amount: -30,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.WEEK,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        // Both should be in the same week
        expect(result.data).toHaveLength(1);
        expect(result.data[0].value).toBe(80);
        expect(result.data[0].label).toMatch(/^Week of /);
      });
    });

    describe("sorting", () => {
      it("applies custom sort by VALUE descending", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -20,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -80,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: {
              ...defaultConfig,
              metric: MetricType.TOTAL_AMOUNT,
              sortBy: TableColumn.VALUE,
              sortDirection: SortDirection.DESC,
            },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].value).toBeGreaterThanOrEqual(
          result.data[1].value,
        );
      });

      it("applies custom sort by LABEL ascending", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -50,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -30,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Aardvark Expenses" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: {
              ...defaultConfig,
              metric: MetricType.TOTAL_AMOUNT,
              sortBy: TableColumn.LABEL,
              sortDirection: SortDirection.ASC,
            },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].label).toBe("Aardvark Expenses");
        expect(result.data[1].label).toBe("Groceries");
      });

      it("defaults sort direction to DESC when not specified", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -20,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -80,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: {
              ...defaultConfig,
              metric: MetricType.TOTAL_AMOUNT,
              sortBy: TableColumn.VALUE,
              // no sortDirection -- should default to DESC
            },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].value).toBeGreaterThanOrEqual(
          result.data[1].value,
        );
      });

      it("sorts by COUNT column", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -10,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -10,
          }),
          createMockTransaction({
            id: "tx-3",
            categoryId: "cat-2",
            amount: -10,
          }),
          createMockTransaction({
            id: "tx-4",
            categoryId: "cat-2",
            amount: -10,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: {
              ...defaultConfig,
              metric: MetricType.TOTAL_AMOUNT,
              sortBy: TableColumn.COUNT,
              sortDirection: SortDirection.ASC,
            },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].count).toBeLessThanOrEqual(result.data[1].count!);
      });

      it("sorts by DATE for no-aggregation mode", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            transactionDate: "2025-03-20",
            amount: -50,
            payeeName: "Later",
          }),
          createMockTransaction({
            id: "tx-2",
            transactionDate: "2025-03-10",
            amount: -30,
            payeeName: "Earlier",
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: {
              ...defaultConfig,
              metric: MetricType.NONE,
              sortBy: TableColumn.DATE,
              sortDirection: SortDirection.ASC,
            },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].date).toBe("2025-03-10");
        expect(result.data[1].date).toBe("2025-03-20");
      });
    });

    describe("summary calculation", () => {
      it("calculates correct summary for aggregated data", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            categoryId: "cat-1",
            amount: -60,
          }),
          createMockTransaction({
            id: "tx-2",
            categoryId: "cat-2",
            amount: -40,
          }),
        ];
        const categories = [
          mockCategory,
          { ...mockCategory, id: "cat-2", name: "Dining" },
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.CATEGORY,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );
        categoriesRepository.find.mockResolvedValue(categories);

        const result = await service.execute("user-1", "report-1");

        expect(result.summary.total).toBe(100);
        expect(result.summary.count).toBe(2);
        expect(result.summary.average).toBe(50);
      });

      it("returns zero summary when no data", async () => {
        setupExecuteMocks({
          groupBy: GroupByType.NONE,
          config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.summary).toEqual({ total: 0, count: 0, average: 0 });
      });
    });

    describe("query builder filter application", () => {
      it("applies direction filter for EXPENSES_ONLY", async () => {
        const { qb } = setupExecuteMocks({
          config: {
            ...defaultConfig,
            direction: DirectionFilter.EXPENSES_ONLY,
          },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).toContain("transaction.amount < 0");
      });

      it("applies direction filter for INCOME_ONLY", async () => {
        const { qb } = setupExecuteMocks({
          config: {
            ...defaultConfig,
            direction: DirectionFilter.INCOME_ONLY,
          },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).toContain("transaction.amount > 0");
      });

      it("does not apply direction filter for BOTH", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig, direction: DirectionFilter.BOTH },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).not.toContain("transaction.amount > 0");
        expect(andWhereCalls).not.toContain("transaction.amount < 0");
      });

      it("filters out transfers when includeTransfers is false", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig, includeTransfers: false },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).toContain("transaction.isTransfer = false");
      });

      it("does not filter transfers when includeTransfers is true", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig, includeTransfers: true },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).not.toContain("transaction.isTransfer = false");
      });

      it("applies legacy accountIds filter", async () => {
        const { qb } = setupExecuteMocks({
          filters: { accountIds: ["acc-1", "acc-2"] },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(qb.andWhere).toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          { accountIds: ["acc-1", "acc-2"] },
        );
      });

      it("applies legacy categoryIds filter", async () => {
        const { qb } = setupExecuteMocks({
          filters: { categoryIds: ["cat-1", "cat-2"] },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(qb.andWhere).toHaveBeenCalledWith(
          "(transaction.categoryId IN (:...categoryIds) OR splits.categoryId IN (:...categoryIds))",
          { categoryIds: ["cat-1", "cat-2"] },
        );
      });

      it("applies legacy payeeIds filter", async () => {
        const { qb } = setupExecuteMocks({
          filters: { payeeIds: ["payee-1"] },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(qb.andWhere).toHaveBeenCalledWith(
          "transaction.payeeId IN (:...payeeIds)",
          { payeeIds: ["payee-1"] },
        );
      });

      it("applies legacy searchText filter", async () => {
        const { qb } = setupExecuteMocks({
          filters: { searchText: "coffee" },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(qb.andWhere).toHaveBeenCalledWith(
          "(LOWER(transaction.payeeName) LIKE :searchTerm OR LOWER(transaction.description) LIKE :searchTerm)",
          { searchTerm: "%coffee%" },
        );
      });

      it("does not apply searchText filter when empty/whitespace", async () => {
        const { qb } = setupExecuteMocks({
          filters: { searchText: "   " },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).not.toContain(
          expect.stringContaining("LIKE :searchTerm"),
        );
      });

      it("applies filterGroups instead of legacy filters when present", async () => {
        const { qb } = setupExecuteMocks({
          filters: {
            accountIds: ["should-be-ignored"],
            filterGroups: [
              {
                conditions: [{ field: "account", value: "acc-1" }],
              },
            ],
          },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        // Legacy accountIds should NOT be applied
        expect(qb.andWhere).not.toHaveBeenCalledWith(
          "transaction.accountId IN (:...accountIds)",
          expect.anything(),
        );
        // filterGroups should be applied via Brackets (andWhere called with a Brackets instance)
        const andWhereCalls = qb.andWhere.mock.calls;
        const hasBracketsCall = andWhereCalls.some(
          (c: unknown[]) =>
            c[0] && typeof c[0] === "object" && c[0].constructor !== String,
        );
        expect(hasBracketsCall).toBe(true);
      });

      it("skips empty filterGroups", async () => {
        const { qb } = setupExecuteMocks({
          filters: {
            filterGroups: [{ conditions: [] }],
          },
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        // The Brackets andWhere should NOT be called for empty conditions group
        // but the standard base where clauses are still present
        const andWhereCalls = qb.andWhere.mock.calls;
        const hasBracketsCall = andWhereCalls.some(
          (c: unknown[]) =>
            c[0] && typeof c[0] === "object" && c[0].constructor !== String,
        );
        expect(hasBracketsCall).toBe(false);
      });

      it("always excludes VOID transactions", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        const andWhereCalls = qb.andWhere.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(andWhereCalls).toContain("transaction.status != 'VOID'");
      });

      it("applies userId filter on query", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(qb.where).toHaveBeenCalledWith("transaction.userId = :userId", {
          userId: "user-1",
        });
      });

      it("joins account, category, payee, and splits relations", async () => {
        const { qb } = setupExecuteMocks({
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        const joinCalls = qb.leftJoinAndSelect.mock.calls.map(
          (c: unknown[]) => c[0],
        );
        expect(joinCalls).toContain("transaction.account");
        expect(joinCalls).toContain("transaction.category");
        expect(joinCalls).toContain("transaction.payee");
        expect(joinCalls).toContain("transaction.splits");
        expect(joinCalls).toContain("splits.category");
      });
    });

    describe("timeframe calculation", () => {
      it("handles CUSTOM timeframe with start and end dates from report config", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.CUSTOM,
          config: {
            ...defaultConfig,
            customStartDate: "2025-01-01",
            customEndDate: "2025-03-31",
          },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.startDate).toBe("2025-01-01");
        expect(result.timeframe.endDate).toBe("2025-03-31");
        expect(result.timeframe.label).toBe("Custom Range");
      });

      it("throws error for CUSTOM timeframe without dates", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.CUSTOM,
          config: { ...defaultConfig },
        });

        await expect(service.execute("user-1", "report-1")).rejects.toThrow(
          "Custom timeframe requires start and end dates",
        );
      });

      it("handles LAST_7_DAYS timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_7_DAYS,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Last 7 Days");
      });

      it("handles LAST_30_DAYS timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_30_DAYS,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Last 30 Days");
      });

      it("handles LAST_MONTH timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_MONTH,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        // Label should be month name and year, e.g., "January 2025"
        expect(result.timeframe.label).toMatch(/^\w+ \d{4}$/);
      });

      it("handles LAST_3_MONTHS timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_3_MONTHS,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Last 3 Months");
      });

      it("handles LAST_6_MONTHS timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_6_MONTHS,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Last 6 Months");
      });

      it("handles LAST_12_MONTHS timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_12_MONTHS,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Last 12 Months");
      });

      it("handles LAST_YEAR timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_YEAR,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        // Label should be just the year e.g. "2024"
        expect(result.timeframe.label).toMatch(/^\d{4}$/);
      });

      it("handles YEAR_TO_DATE timeframe", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.YEAR_TO_DATE,
          config: { ...defaultConfig },
        });

        const result = await service.execute("user-1", "report-1");

        expect(result.timeframe.label).toBe("Year to Date");
      });

      it("uses override dates for CUSTOM timeframe over report config dates", async () => {
        setupExecuteMocks({
          timeframeType: TimeframeType.LAST_3_MONTHS,
          config: {
            ...defaultConfig,
            customStartDate: "2024-01-01",
            customEndDate: "2024-06-30",
          },
        });

        const result = await service.execute("user-1", "report-1", {
          timeframeType: TimeframeType.CUSTOM,
          startDate: "2025-07-01",
          endDate: "2025-12-31",
        });

        expect(result.timeframe.startDate).toBe("2025-07-01");
        expect(result.timeframe.endDate).toBe("2025-12-31");
      });
    });

    describe("edge cases", () => {
      it("handles transaction with zero amount", async () => {
        const transactions = [createMockTransaction({ id: "tx-1", amount: 0 })];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data).toHaveLength(1);
        expect(result.data[0].value).toBe(0);
      });

      it("handles positive amounts (income) with abs value", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", amount: 1000 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: {
              ...defaultConfig,
              direction: DirectionFilter.INCOME_ONLY,
              metric: MetricType.TOTAL_AMOUNT,
            },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].value).toBe(1000);
      });

      it("handles default groupBy case (unrecognized value falls to NONE logic)", async () => {
        setupExecuteMocks({
          groupBy: "UNKNOWN_TYPE" as GroupByType,
          config: { ...defaultConfig, metric: MetricType.TOTAL_AMOUNT },
        });

        const result = await service.execute("user-1", "report-1");

        // Default case in aggregateData falls through to aggregateNoGrouping
        expect(result.data).toEqual([]);
      });

      it("uses description as label when payeeName is null (NONE metric mode)", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            payeeName: null,
            description: "ATM Withdrawal",
            amount: -50,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.NONE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].label).toBe("ATM Withdrawal");
      });

      it("uses 'Transaction' as label when both payeeName and description are null", async () => {
        const transactions = [
          createMockTransaction({
            id: "tx-1",
            payeeName: null,
            description: null,
            payee: null,
            amount: -50,
          }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.NONE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        expect(result.data[0].label).toBe("Transaction");
      });

      it("rounds metric values to 2 decimal places", async () => {
        const transactions = [
          createMockTransaction({ id: "tx-1", amount: -33.33 }),
          createMockTransaction({ id: "tx-2", amount: -33.33 }),
          createMockTransaction({ id: "tx-3", amount: -33.34 }),
        ];
        setupExecuteMocks(
          {
            groupBy: GroupByType.NONE,
            config: { ...defaultConfig, metric: MetricType.AVERAGE },
          },
          transactions,
        );

        const result = await service.execute("user-1", "report-1");

        // Average of 33.33, 33.33, 33.34 = 33.3333...
        // Should be rounded to 2 decimal places
        const value = result.data[0].value;
        const decimals = value.toString().split(".")[1] || "";
        expect(decimals.length).toBeLessThanOrEqual(2);
      });

      it("does not fetch categories or payees when groupBy is NONE", async () => {
        setupExecuteMocks({
          groupBy: GroupByType.NONE,
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(categoriesRepository.find).not.toHaveBeenCalled();
        expect(payeesRepository.find).not.toHaveBeenCalled();
      });

      it("does not fetch categories or payees when groupBy is a time period", async () => {
        setupExecuteMocks({
          groupBy: GroupByType.MONTH,
          config: { ...defaultConfig },
        });

        await service.execute("user-1", "report-1");

        expect(categoriesRepository.find).not.toHaveBeenCalled();
        expect(payeesRepository.find).not.toHaveBeenCalled();
      });
    });
  });
});
