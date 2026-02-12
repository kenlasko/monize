import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { ImportContext } from "./import-context";
import { TransactionStatus } from "../transactions/entities/transaction.entity";
import { AccountType } from "../accounts/entities/account.entity";
import { Payee } from "../payees/entities/payee.entity";
import { ImportResultDto } from "./dto/import.dto";

describe("ImportRegularProcessorService", () => {
  let service: ImportRegularProcessorService;

  const userId = "user-1";
  const accountId = "acc-1";

  const makeImportResult = (): ImportResultDto => ({
    imported: 0,
    skipped: 0,
    errors: 0,
    errorMessages: [],
    categoriesCreated: 0,
    accountsCreated: 0,
    payeesCreated: 0,
    securitiesCreated: 0,
  });

  const makeMockQueryBuilder = (result: any = null) => {
    const qb: Record<string, jest.Mock> = {
      innerJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(result),
      getMany: jest.fn().mockResolvedValue(result ? [result] : []),
    };
    return qb;
  };

  const makeMockManager = () => ({
    save: jest.fn().mockImplementation((entity: any) => {
      if (!entity.id) {
        entity.id = `gen-${Date.now()}-${Math.random()}`;
      }
      return Promise.resolve(entity);
    }),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest.fn().mockImplementation((_cls: any, data: any) => ({
      ...data,
      id: `gen-${Date.now()}-${Math.random()}`,
    })),
    createQueryBuilder: jest.fn().mockReturnValue(makeMockQueryBuilder()),
  });

  const makeContext = (
    overrides: Partial<ImportContext> = {},
  ): ImportContext => {
    const qr = { manager: makeMockManager() };
    return {
      queryRunner: qr,
      userId,
      accountId,
      account: {
        id: accountId,
        currencyCode: "CAD",
        accountType: AccountType.CHEQUING,
        name: "My Chequing",
      } as any,
      categoryMap: new Map(),
      accountMap: new Map(),
      loanCategoryMap: new Map(),
      securityMap: new Map(),
      importStartTime: new Date(),
      dateCounters: new Map(),
      affectedAccountIds: new Set(),
      importResult: makeImportResult(),
      ...overrides,
    };
  };

  beforeEach(() => {
    service = new ImportRegularProcessorService();
  });

  describe("processTransaction", () => {
    it("should create a basic transaction and increment imported", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -50.25,
        payee: "Grocery Store",
        memo: "Weekly groceries",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      expect(ctx.queryRunner.manager.create).toHaveBeenCalled();
      expect(ctx.queryRunner.manager.save).toHaveBeenCalled();
    });

    it("should set RECONCILED status when reconciled flag is true", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        reconciled: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.RECONCILED);
    });

    it("should set CLEARED status when cleared flag is true", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        cleared: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.CLEARED);
    });

    it("should set UNRECONCILED status by default", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.UNRECONCILED);
    });

    it("should reconciled takes precedence over cleared", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        reconciled: true,
        cleared: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.RECONCILED);
    });

    it("should map category from categoryMap", async () => {
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Groceries", "cat-groceries");
      const ctx = makeContext({ categoryMap });

      const qifTx = {
        date: "2025-01-15",
        amount: -50,
        category: "Groceries",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].categoryId).toBe("cat-groceries");
    });

    it("should set categoryId to null for transfer transactions", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        isTransfer: true,
        transferAccount: "Savings",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].categoryId).toBeNull();
      expect(createCall[1].isTransfer).toBe(true);
    });

    it("should increment dateCounters for duplicate dates", async () => {
      const ctx = makeContext();
      ctx.dateCounters.set("2025-01-15", 3);

      const qifTx = {
        date: "2025-01-15",
        amount: -20,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.dateCounters.get("2025-01-15")).toBe(4);
    });

    it("should use account currencyCode for the transaction", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -20,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].currencyCode).toBe("CAD");
    });

    it("should set isSplit flag for transactions with splits", async () => {
      const ctx = makeContext();
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      categoryMap.set("Gas", "cat-gas");
      ctx.categoryMap = categoryMap;

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        splits: [
          { amount: -60, category: "Food", memo: "Food portion" },
          { amount: -40, category: "Gas", memo: "Gas portion" },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].isSplit).toBe(true);
      expect(createCall[1].categoryId).toBeNull();
    });

    it("should process splits and save TransactionSplit entities", async () => {
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      categoryMap.set("Gas", "cat-gas");
      const ctx = makeContext({ categoryMap });

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        splits: [
          { amount: -60, category: "Food", memo: "Food" },
          { amount: -40, category: "Gas", memo: "Gas" },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // create should be called for the main transaction + each split
      const createCalls = ctx.queryRunner.manager.create.mock.calls;
      // Main transaction + 2 splits = at least 3 create calls
      expect(createCalls.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe("isDuplicateTransfer (via processTransaction)", () => {
    it("should skip duplicate linked transfers from prior imports", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      // Set up query builder to find existing linked transfer
      const existingTransfer = { id: "tx-existing", accountId: "acc-1" };
      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(existingTransfer),
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        isTransfer: true,
        transferAccount: "Savings",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.imported).toBe(0);
    });

    it("should skip split-linked transfers from prior imports", async () => {
      const ctx = makeContext();

      // When isTransfer is true but transferAccount is absent,
      // the first block in isDuplicateTransfer is skipped entirely.
      // Only the second block (split-linked check) runs, which is the first QB call.
      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder({ id: "tx-split-linked" }),
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        isTransfer: true,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
    });

    it("should not skip non-transfer transactions", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -50,
        payee: "Store",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });
  });

  describe("matchPendingTransfer (via processTransaction)", () => {
    it("should match and update a pending cross-currency transfer", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      const pendingTransfer = {
        id: "tx-pending",
        amount: 95,
        payeeName: "Transfer",
        referenceNumber: null,
        linkedTransaction: { accountId: "acc-usd" },
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          // isDuplicateTransfer checks (no duplicates)
          return makeMockQueryBuilder(null);
        }
        // matchPendingTransfer: found pending
        return makeMockQueryBuilder(pendingTransfer);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
        memo: "Updated memo",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      expect(ctx.queryRunner.manager.update).toHaveBeenCalled();
    });

    it("should not match pending transfer for non-transfer transactions", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -50,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // Update should only be called for balance update, not for pending transfer matching
    });
  });

  describe("resolvePayee (via processTransaction)", () => {
    it("should find existing payee by name", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, opts: any) => {
          if (entity === Payee && opts?.where?.name === "Tim Hortons") {
            return Promise.resolve({ id: "payee-tim", name: "Tim Hortons" });
          }
          // For account balance update
          return Promise.resolve({ id: accountId, currentBalance: 500 });
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -5.25,
        payee: "Tim Hortons",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].payeeId).toBe("payee-tim");
    });

    it("should create new payee when not found", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.findOne.mockImplementation(
        (entity: any, _opts: any) => {
          if (entity === Payee) return Promise.resolve(null);
          // For account balance update
          return Promise.resolve({ id: accountId, currentBalance: 500 });
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -5.25,
        payee: "New Coffee Shop",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.payeesCreated).toBe(1);
    });

    it("should set payeeId to null when no payee provided", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -5.25,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].payeeId).toBeNull();
    });
  });

  describe("resolveTransactionTarget (via processTransaction)", () => {
    it("should use assetCategoryId for ASSET account types", async () => {
      const ctx = makeContext({
        account: {
          id: accountId,
          currencyCode: "CAD",
          accountType: AccountType.ASSET,
          assetCategoryId: "cat-asset",
          name: "My House",
        } as any,
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 5000,
        category: "Appreciation",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].categoryId).toBe("cat-asset");
    });

    it("should detect loan payment categories and create transfer", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Car Loan", "acc-loan");
      const ctx = makeContext({ loanCategoryMap });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-loan") {
            return Promise.resolve({
              id: "acc-loan",
              currencyCode: "CAD",
            });
          }
          // For account balance update
          return Promise.resolve({ id: accountId, currentBalance: 500 });
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan",
        payee: "Auto Finance",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].isTransfer).toBe(true);
      expect(createCall[1].categoryId).toBeNull();
      expect(ctx.affectedAccountIds.has("acc-loan")).toBe(true);
    });

    it("should set categoryId to null for unmapped categories", async () => {
      const ctx = makeContext();

      const qifTx = {
        date: "2025-01-15",
        amount: -50,
        category: "UnknownCategory",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].categoryId).toBeNull();
    });
  });

  describe("processTransfer (via processTransaction)", () => {
    it("should create linked transaction for simple transfer", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-savings") {
            return Promise.resolve({
              id: "acc-savings",
              currencyCode: "CAD",
            });
          }
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 1000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "Savings",
        payee: "Transfer",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.affectedAccountIds.has("acc-savings")).toBe(true);
      expect(ctx.importResult.imported).toBe(1);

      // Should have created a linked transaction in the target account
      const createCalls = ctx.queryRunner.manager.create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-savings",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].amount).toBe(500); // Negated
      expect(linkedTxCreate[1].isTransfer).toBe(true);
    });

    it("should add PENDING IMPORT note for cross-currency transfers", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-usd") {
            return Promise.resolve({
              id: "acc-usd",
              currencyCode: "USD",
            });
          }
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 1000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "USD Account",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = ctx.queryRunner.manager.create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-usd",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].description).toContain("PENDING IMPORT");
    });

    it("should use loan payment payee name for loan transfers", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Car Loan", "acc-loan");
      const ctx = makeContext({ loanCategoryMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-loan") {
            return Promise.resolve({
              id: "acc-loan",
              currencyCode: "CAD",
            });
          }
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 2000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = ctx.queryRunner.manager.create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-loan",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].payeeName).toContain("Loan Payment");
    });
  });

  describe("processSplits (via processTransaction)", () => {
    it("should create split transfer entries for splits with transfer accounts", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      const ctx = makeContext({ accountMap, categoryMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 1000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        splits: [
          { amount: -100, category: "Food", memo: "Food portion" },
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Savings transfer",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      expect(ctx.affectedAccountIds.has("acc-savings")).toBe(true);
    });

    it("should handle loan categories within splits", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Mortgage", "acc-mortgage");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Interest", "cat-interest");
      const ctx = makeContext({ loanCategoryMap, categoryMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 5000,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -1500,
        splits: [
          { amount: -1000, category: "Mortgage", memo: "Principal" },
          { amount: -500, category: "Interest", memo: "Interest" },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.affectedAccountIds.has("acc-mortgage")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle transaction with all optional fields missing", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: 0,
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
    });

    it("should pass referenceNumber from qifTx.number", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -50,
        number: "CHK-1234",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].referenceNumber).toBe("CHK-1234");
    });

    it("should set userId and accountId on every created transaction", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = ctx.queryRunner.manager.create.mock.calls[0];
      expect(createCall[1].userId).toBe(userId);
      expect(createCall[1].accountId).toBe(accountId);
    });
  });
});
