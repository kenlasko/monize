jest.mock("../accruals/accrual-taxonomy-operation", () => ({
  beginTaxonomyOperation: async () => undefined,
  recordTaxonomyOperation: async () => undefined,
}));
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { CategoryDetailService } from "./category-detail.service";
import { CategoriesService } from "./categories.service";
import { Category } from "./entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER_ID = "user-1";
const CATEGORY_ID = "cat-1";
const CHILD_ID = "cat-1a";

describe("CategoryDetailService", () => {
  let service: CategoryDetailService;
  let categoriesService: Record<string, jest.Mock>;
  let categoryRepository: Record<string, jest.Mock>;
  let payeeRepository: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let txManager: ManagerMock;

  const category = {
    id: CATEGORY_ID,
    userId: USER_ID,
    name: "Groceries",
    parentId: null,
    isIncome: false,
    isSystem: false,
    color: "#22c55e",
    effectiveColor: "#22c55e",
    children: [{ id: CHILD_ID, name: "Produce" }],
    createdAt: new Date("2025-01-01"),
  } as unknown as Category & { effectiveColor: string | null };

  /** One chainable query-builder mock whose terminal methods a test overrides. */
  function queryBuilder(overrides: Record<string, jest.Mock> = {}) {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue(undefined),
      getRawMany: jest.fn().mockResolvedValue([]),
      ...overrides,
    };
  }

  /**
   * The service builds three raw queries, in creation order: subtree stats,
   * account breakdown, largest transaction. Queue their results in that order;
   * a test states only what it cares about.
   */
  function given(options: {
    stats?: {
      count: string;
      first: string | null;
      last: string | null;
      payeeCount: string;
    };
    accountRows?: Record<string, unknown>[];
    largestRow?: Record<string, unknown>;
    allCategories?: { id: string; parentId: string | null }[];
    defaultPayees?: Record<string, unknown>[];
  }) {
    txManager.createQueryBuilder
      .mockImplementationOnce(() =>
        queryBuilder({
          getRawOne: jest.fn().mockResolvedValue(options.stats),
        }),
      )
      .mockImplementationOnce(() =>
        queryBuilder({
          getRawMany: jest.fn().mockResolvedValue(options.accountRows ?? []),
        }),
      )
      .mockImplementationOnce(() =>
        queryBuilder({
          getRawOne: jest.fn().mockResolvedValue(options.largestRow),
        }),
      );
    // getAllCategoryIdsWithChildren reads every category of the user.
    categoryRepository.find.mockResolvedValue(
      options.allCategories ?? [
        { id: CATEGORY_ID, parentId: null },
        { id: CHILD_ID, parentId: CATEGORY_ID },
      ],
    );
    payeeRepository.find.mockResolvedValue(options.defaultPayees ?? []);
  }

  beforeEach(async () => {
    categoriesService = {
      findOne: jest.fn().mockResolvedValue(category),
    };
    categoryRepository = { find: jest.fn().mockResolvedValue([]) };
    payeeRepository = { find: jest.fn().mockResolvedValue([]) };

    const { manager, dataSource } = createScopedDbMocks([
      [Category, categoryRepository],
      [Payee, payeeRepository],
    ]);
    txManager = manager;
    mockDataSource = dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryDetailService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: CategoriesService, useValue: categoriesService },
      ],
    }).compile();

    service = module.get(CategoryDetailService);
  });

  it("propagates the not-found error from CategoriesService.findOne", async () => {
    categoriesService.findOne.mockRejectedValue(new NotFoundException());

    await expect(service.getDetail(USER_ID, CATEGORY_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it("returns the category row it validated, untouched", async () => {
    given({});

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(categoriesService.findOne).toHaveBeenCalledWith(
      USER_ID,
      CATEGORY_ID,
    );
    expect(detail.category).toBe(category);
  });

  it("maps subtree stats and counts direct children only", async () => {
    given({
      stats: {
        count: "42",
        first: "2019-03-01",
        last: "2026-07-15",
        payeeCount: "7",
      },
    });

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(detail.stats).toEqual({
      transactionCount: 42,
      firstTransactionDate: "2019-03-01",
      lastTransactionDate: "2026-07-15",
      payeeCount: 7,
      subcategoryCount: 1,
    });
  });

  it("reports a never-used category as zeros and nulls", async () => {
    // Postgres returns COUNT = "0" with NULL MIN/MAX for an empty group.
    given({
      stats: { count: "0", first: null, last: null, payeeCount: "0" },
    });

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(detail.stats.transactionCount).toBe(0);
    expect(detail.stats.firstTransactionDate).toBeNull();
    expect(detail.stats.lastTransactionDate).toBeNull();
    expect(detail.stats.payeeCount).toBe(0);
    expect(detail.accounts).toEqual([]);
    expect(detail.largestTransaction).toBeNull();
    expect(detail.defaultCategoryForPayees).toEqual([]);
  });

  it("maps the per-account breakdown, parsing counts and rounding totals", async () => {
    given({
      accountRows: [
        {
          accountId: "acct-1",
          accountName: "Chequing",
          accountType: "CHEQUING",
          currencyCode: "CAD",
          transactionCount: "37",
          total: "-1234.56789",
          lastTransactionDate: "2026-06-30",
        },
        {
          accountId: "acct-2",
          accountName: "Visa",
          accountType: "CREDIT_CARD",
          currencyCode: "CAD",
          transactionCount: "4",
          total: "-89.5",
          lastTransactionDate: null,
        },
      ],
    });

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(detail.accounts).toEqual([
      {
        accountId: "acct-1",
        accountName: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "CAD",
        transactionCount: 37,
        total: -1234.5679,
        lastTransactionDate: "2026-06-30",
      },
      {
        accountId: "acct-2",
        accountName: "Visa",
        accountType: "CREDIT_CARD",
        currencyCode: "CAD",
        transactionCount: 4,
        total: -89.5,
        lastTransactionDate: null,
      },
    ]);
  });

  it("maps the largest transaction and defaults its optional fields to null", async () => {
    given({
      largestRow: {
        id: "tx-9",
        transactionDate: "2024-12-24",
        amount: "-2500.129",
        currencyCode: "CAD",
        description: undefined,
        payeeName: undefined,
        accountId: "acct-1",
        accountName: "Chequing",
      },
    });

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(detail.largestTransaction).toEqual({
      id: "tx-9",
      transactionDate: "2024-12-24",
      amount: -2500.129,
      currencyCode: "CAD",
      accountId: "acct-1",
      accountName: "Chequing",
      description: null,
      payeeName: null,
    });
  });

  it("lists payees defaulting to exactly this category, by name", async () => {
    given({
      defaultPayees: [
        { id: "payee-1", name: "Loblaws" },
        { id: "payee-2", name: "Metro" },
      ],
    });

    const detail = await service.getDetail(USER_ID, CATEGORY_ID);

    expect(payeeRepository.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, defaultCategoryId: CATEGORY_ID },
      select: ["id", "name"],
      order: { name: "ASC" },
    });
    expect(detail.defaultCategoryForPayees).toEqual([
      { payeeId: "payee-1", payeeName: "Loblaws" },
      { payeeId: "payee-2", payeeName: "Metro" },
    ]);
  });

  it("runs every read inside one scoped transaction", async () => {
    given({});

    await service.getDetail(USER_ID, CATEGORY_ID);

    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  describe("an account scope (an acting delegate's READ grants)", () => {
    /** Queue three builders and hand them back so a test can read their clauses. */
    function capturedBuilders() {
      // Replaces the builders `given` queued, keeping its other stubs.
      txManager.createQueryBuilder.mockReset();
      const builders = [queryBuilder(), queryBuilder(), queryBuilder()];
      for (const builder of builders) {
        txManager.createQueryBuilder.mockImplementationOnce(() => builder);
      }
      return builders;
    }

    it("narrows every transaction figure to the scoped accounts", async () => {
      given({});
      const builders = capturedBuilders();

      await service.getDetail(USER_ID, CATEGORY_ID, ["acc-a", "acc-b"]);

      for (const builder of builders) {
        expect(builder.andWhere).toHaveBeenCalledWith(
          "t.account_id IN (:...delegateScopeAccountIds)",
          { delegateScopeAccountIds: ["acc-a", "acc-b"] },
        );
      }
    });

    it("matches no transaction for an empty scope, never the whole ledger", async () => {
      given({});
      const builders = capturedBuilders();

      await service.getDetail(USER_ID, CATEGORY_ID, []);

      for (const builder of builders) {
        expect(builder.andWhere).toHaveBeenCalledWith("1 = 0");
      }
    });

    it("leaves the owner's (unscoped) figures across every account", async () => {
      given({});
      const builders = capturedBuilders();

      await service.getDetail(USER_ID, CATEGORY_ID);

      for (const builder of builders) {
        const clauses = builder.andWhere.mock.calls.map((call) => call[0]);
        expect(clauses).not.toContain(
          "t.account_id IN (:...delegateScopeAccountIds)",
        );
        expect(clauses).not.toContain("1 = 0");
      }
    });
  });
});
