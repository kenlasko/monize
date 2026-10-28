jest.mock("../accruals/accrual-taxonomy-operation", () => ({
  beginTaxonomyOperation: async () => undefined,
  recordTaxonomyOperation: async () => undefined,
}));
import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { PayeeDetailService } from "./payee-detail.service";
import { PayeesService } from "./payees.service";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Account } from "../accounts/entities/account.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER_ID = "user-1";
const PAYEE_ID = "payee-1";

describe("PayeeDetailService", () => {
  let service: PayeeDetailService;
  let payeesService: Record<string, jest.Mock>;
  let aliasRepository: Record<string, jest.Mock>;
  let accountRepository: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let txManager: ManagerMock;

  const payee = {
    id: PAYEE_ID,
    userId: USER_ID,
    name: "Starbucks",
    defaultCategoryId: "cat-1",
    defaultCategory: { id: "cat-1", name: "Food & Drink" },
    notes: null,
    isActive: true,
    createdAt: new Date("2025-01-01"),
  } as unknown as Payee;

  /** One chainable query-builder mock whose terminal methods a test overrides. */
  function queryBuilder(overrides: Record<string, jest.Mock> = {}) {
    return {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
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
   * The service builds three raw queries, in creation order: lifetime stats,
   * account breakdown, largest transaction. Queue their results in that order;
   * a test states only what it cares about.
   */
  function given(options: {
    stats?: { count: string; first: string | null; last: string | null };
    accountRows?: Record<string, unknown>[];
    largestRow?: Record<string, unknown>;
    uncategorizedCount?: number;
    aliasCount?: number;
    overpaymentAccounts?: Record<string, unknown>[];
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
    txManager.count.mockResolvedValue(options.uncategorizedCount ?? 0);
    aliasRepository.count.mockResolvedValue(options.aliasCount ?? 0);
    accountRepository.find.mockResolvedValue(options.overpaymentAccounts ?? []);
  }

  beforeEach(async () => {
    payeesService = {
      findOne: jest.fn().mockResolvedValue(payee),
    };
    aliasRepository = { count: jest.fn().mockResolvedValue(0) };
    accountRepository = { find: jest.fn().mockResolvedValue([]) };

    const { manager, dataSource } = createScopedDbMocks([
      [PayeeAlias, aliasRepository],
      [Account, accountRepository],
    ]);
    txManager = manager;
    mockDataSource = dataSource;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayeeDetailService,
        { provide: DataSource, useValue: mockDataSource },
        { provide: PayeesService, useValue: payeesService },
      ],
    }).compile();

    service = module.get(PayeeDetailService);
  });

  it("propagates the not-found error from PayeesService.findOne", async () => {
    payeesService.findOne.mockRejectedValue(new NotFoundException());

    await expect(service.getDetail(USER_ID, PAYEE_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(mockDataSource.transaction).not.toHaveBeenCalled();
  });

  it("returns the payee row it validated, untouched", async () => {
    given({});

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

    expect(payeesService.findOne).toHaveBeenCalledWith(USER_ID, PAYEE_ID);
    expect(detail.payee).toBe(payee);
  });

  it("maps lifetime stats, uncategorized and alias counts", async () => {
    given({
      stats: { count: "42", first: "2019-03-01", last: "2026-07-15" },
      uncategorizedCount: 5,
      aliasCount: 3,
    });

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

    expect(detail.stats).toEqual({
      transactionCount: 42,
      firstTransactionDate: "2019-03-01",
      lastTransactionDate: "2026-07-15",
      uncategorizedCount: 5,
      aliasCount: 3,
    });
    expect(aliasRepository.count).toHaveBeenCalledWith({
      where: { userId: USER_ID, payeeId: PAYEE_ID },
    });
  });

  it("reports a never-transacted payee as zeros and nulls", async () => {
    // Postgres returns COUNT(*) = "0" with NULL MIN/MAX for an empty group.
    given({ stats: { count: "0", first: null, last: null } });

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

    expect(detail.stats.transactionCount).toBe(0);
    expect(detail.stats.firstTransactionDate).toBeNull();
    expect(detail.stats.lastTransactionDate).toBeNull();
    expect(detail.accounts).toEqual([]);
    expect(detail.largestTransaction).toBeNull();
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

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

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

  it("maps the largest transaction and defaults its description to null", async () => {
    given({
      largestRow: {
        id: "tx-9",
        transactionDate: "2024-12-24",
        amount: "-2500.129",
        currencyCode: "CAD",
        description: undefined,
        accountId: "acct-1",
        accountName: "Chequing",
      },
    });

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

    expect(detail.largestTransaction).toEqual({
      id: "tx-9",
      transactionDate: "2024-12-24",
      amount: -2500.129,
      currencyCode: "CAD",
      accountId: "acct-1",
      accountName: "Chequing",
      description: null,
    });
  });

  it("lists accounts that designate the payee for overpayments", async () => {
    given({
      overpaymentAccounts: [
        { id: "acct-loan", name: "Mortgage" },
        { id: "acct-loc", name: "Line of credit" },
      ],
    });

    const detail = await service.getDetail(USER_ID, PAYEE_ID);

    expect(accountRepository.find).toHaveBeenCalledWith({
      where: { userId: USER_ID, overpaymentPayeeId: PAYEE_ID },
      select: ["id", "name"],
      order: { name: "ASC" },
    });
    expect(detail.overpaymentForAccounts).toEqual([
      { accountId: "acct-loan", accountName: "Mortgage" },
      { accountId: "acct-loc", accountName: "Line of credit" },
    ]);
  });

  it("runs every read inside one scoped transaction", async () => {
    given({});

    await service.getDetail(USER_ID, PAYEE_ID);

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

    it("narrows every transaction figure and the overpayment list to the scoped accounts", async () => {
      given({});
      const builders = capturedBuilders();

      await service.getDetail(USER_ID, PAYEE_ID, ["acc-a"]);

      for (const builder of builders) {
        expect(builder.andWhere).toHaveBeenCalledWith(
          "t.account_id IN (:...delegateScopeAccountIds)",
          { delegateScopeAccountIds: ["acc-a"] },
        );
      }
      expect(txManager.count).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({
          where: expect.objectContaining({ accountId: In(["acc-a"]) }),
        }),
      );
      expect(accountRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: USER_ID,
            overpaymentPayeeId: PAYEE_ID,
            id: In(["acc-a"]),
          },
        }),
      );
    });

    it("reveals nothing for an empty scope", async () => {
      given({});
      const builders = capturedBuilders();

      const detail = await service.getDetail(USER_ID, PAYEE_ID, []);

      for (const builder of builders) {
        expect(builder.andWhere).toHaveBeenCalledWith("1 = 0");
      }
      expect(txManager.count).not.toHaveBeenCalled();
      expect(accountRepository.find).not.toHaveBeenCalled();
      expect(detail.stats.uncategorizedCount).toBe(0);
      expect(detail.overpaymentForAccounts).toEqual([]);
    });
  });
});
