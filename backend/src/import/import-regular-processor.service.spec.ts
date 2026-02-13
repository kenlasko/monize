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

  describe("cross-currency transfer detection and matching", () => {
    it("should detect cross-currency transfer and find existing pending transfer", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      const existingPending = {
        id: "tx-pending-cross",
        amount: 380,
        payeeName: null,
        description: "PENDING IMPORT",
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          // isDuplicateTransfer checks return null (no duplicates)
          return makeMockQueryBuilder(null);
        }
        if (qbCallCount === 3) {
          // matchPendingTransfer returns null
          return makeMockQueryBuilder(null);
        }
        // processTransfer cross-currency pending check
        return makeMockQueryBuilder(existingPending);
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-usd") {
            return Promise.resolve({
              id: "acc-usd",
              currencyCode: "USD",
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
        payee: "Transfer to USD",
        memo: "Currency conversion",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // Should update the existing pending transfer to link it
      expect(ctx.queryRunner.manager.update).toHaveBeenCalled();
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      // One of the update calls should set linkedTransactionId on the pending transfer
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === existingPending.id,
      );
      expect(pendingUpdate).toBeDefined();
    });

    it("should create pending import note when no existing pending transfer found for cross-currency", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("EUR Account", "acc-eur");
      const ctx = makeContext({ accountMap });

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-eur") {
            return Promise.resolve({
              id: "acc-eur",
              currencyCode: "EUR",
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "EUR Account",
        memo: "FX transfer",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = ctx.queryRunner.manager.create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-eur",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].description).toContain("PENDING IMPORT");
      expect(linkedTxCreate[1].currencyCode).toBe("EUR");
    });

    it("should use loan payment payee name for cross-currency existing pending transfer", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Car Loan USD", "acc-loan-usd");
      const ctx = makeContext({ loanCategoryMap });

      const existingPending = {
        id: "tx-pending-loan",
        amount: 380,
        payeeName: null,
        description: "PENDING IMPORT",
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        // processTransfer cross-currency pending check
        return makeMockQueryBuilder(existingPending);
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === "acc-loan-usd") {
            return Promise.resolve({
              id: "acc-loan-usd",
              currencyCode: "USD",
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan USD",
      };

      await service.processTransaction(ctx, qifTx);

      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === existingPending.id,
      );
      expect(pendingUpdate).toBeDefined();
      expect(pendingUpdate[2].payeeName).toContain("Loan Payment");
    });
  });

  describe("split transfer linking from prior imports", () => {
    it("should link existing split transfer from prior import", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      const ctx = makeContext({ accountMap, categoryMap });

      const existingLinkedTx = {
        id: "tx-existing-linked",
        accountId: "acc-savings",
        linkedTransactionId: null,
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          // isDuplicateTransfer checks
          return makeMockQueryBuilder(null);
        }
        // processSplitTransfer existing linked check
        return makeMockQueryBuilder(existingLinkedTx);
      });

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
          { amount: -100, category: "Food", memo: "Food" },
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Savings",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // Should have updated the split to link to existing tx
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const splitLinkUpdate = updateCalls.find(
        (call: any) => call[2]?.linkedTransactionId === existingLinkedTx.id,
      );
      expect(splitLinkUpdate).toBeDefined();
    });

    it("should link existing split transfer and update back-link when not already linked", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      const existingLinkedTx = {
        id: "tx-existing-no-link",
        accountId: "acc-savings",
        linkedTransactionId: null,
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(existingLinkedTx);
      });

      ctx.queryRunner.manager.findOne.mockResolvedValue(null);

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        splits: [
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // Should update the existing linked tx's linkedTransactionId to point to saved tx
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const backLinkUpdate = updateCalls.find(
        (call: any) => call[1] === existingLinkedTx.id,
      );
      expect(backLinkUpdate).toBeDefined();
    });
  });

  describe("placeholder transaction cleanup", () => {
    it("should clean up placeholder transaction when linking existing split transfer", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      const placeholderTx = {
        id: "tx-placeholder",
        accountId: accountId,
        amount: -100,
      };

      const existingLinkedTx = {
        id: "tx-existing-with-placeholder",
        accountId: "acc-savings",
        linkedTransactionId: "tx-placeholder",
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(existingLinkedTx);
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (
            opts?.where?.id === "tx-placeholder" &&
            opts?.where?.accountId === accountId
          ) {
            return Promise.resolve(placeholderTx);
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
        amount: -100,
        splits: [
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // Should delete the placeholder transaction
      expect(ctx.queryRunner.manager.delete).toHaveBeenCalled();
      const deleteCall = ctx.queryRunner.manager.delete.mock.calls.find(
        (call: any) => call[1] === "tx-placeholder",
      );
      expect(deleteCall).toBeDefined();

      // Should nullify the linkedTransactionId on existing linked tx
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const nullifyLinkUpdate = updateCalls.find(
        (call: any) =>
          call[1] === existingLinkedTx.id &&
          call[2]?.linkedTransactionId === null,
      );
      expect(nullifyLinkUpdate).toBeDefined();
    });

    it("should not clean up when placeholder not found in current account", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      const existingLinkedTx = {
        id: "tx-existing-link-other",
        accountId: "acc-savings",
        linkedTransactionId: "tx-other-account",
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(existingLinkedTx);
      });

      // findOne returns null for the placeholder (not in current account)
      ctx.queryRunner.manager.findOne.mockResolvedValue(null);

      const qifTx = {
        date: "2025-01-15",
        amount: -100,
        splits: [
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // Should NOT delete any transaction since placeholder was not found
      expect(ctx.queryRunner.manager.delete).not.toHaveBeenCalled();
    });
  });

  describe("balance adjustments for currency conversions", () => {
    it("should adjust balance when pending transfer amount differs from actual", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      const pendingTransfer = {
        id: "tx-pending-diff",
        amount: 90,
        payeeName: "Transfer",
        referenceNumber: null,
        linkedTransaction: { accountId: "acc-usd" },
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(pendingTransfer);
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 500,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
        memo: "Updated conversion",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // Balance adjustment should happen for the difference (100 - 90 = 10)
      expect(ctx.queryRunner.manager.update).toHaveBeenCalled();
    });

    it("should not adjust balance when pending transfer amount matches actual", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      const pendingTransfer = {
        id: "tx-pending-exact",
        amount: 100,
        payeeName: "Transfer",
        referenceNumber: null,
        linkedTransaction: { accountId: "acc-usd" },
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(pendingTransfer);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // The update for the pending transfer should happen, but the balance update
      // for the account should NOT happen because balanceDiff === 0
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      // Only the pending transfer update should exist, no Account balance update
      const pendingTxUpdate = updateCalls.find(
        (call: any) => call[1] === pendingTransfer.id,
      );
      expect(pendingTxUpdate).toBeDefined();
    });

    it("should adjust balance for split pending transfer with amount difference", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      const ctx = makeContext({ accountMap, categoryMap });

      const pendingSplitTransfer = {
        id: "tx-split-pending",
        amount: 80,
        description: "PENDING IMPORT note",
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        if (qbCallCount === 3) {
          // First split: existing linked check returns null
          return makeMockQueryBuilder(null);
        }
        // Second call for split: pending transfer check
        return makeMockQueryBuilder(pendingSplitTransfer);
      });

      ctx.queryRunner.manager.findOne.mockImplementation(
        (_entity: any, opts: any) => {
          if (opts?.where?.id === accountId) {
            return Promise.resolve({
              id: accountId,
              currentBalance: 1000,
            });
          }
          if (opts?.where?.id === "acc-savings") {
            return Promise.resolve({
              id: "acc-savings",
              currentBalance: 500,
            });
          }
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        splits: [
          { amount: -100, category: "Food", memo: "Food" },
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer part",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.imported).toBe(1);
      // The pending transfer should be updated
      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === pendingSplitTransfer.id,
      );
      expect(pendingUpdate).toBeDefined();
    });
  });

  describe("isDuplicateTransfer - transfer with mapped account but no existing", () => {
    it("should not skip when transfer account is mapped but no duplicate found", async () => {
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
          return Promise.resolve(null);
        },
      );

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        isTransfer: true,
        transferAccount: "Savings",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });
  });

  describe("matchPendingTransfer edge cases", () => {
    it("should return false when transfer account is not mapped", async () => {
      const ctx = makeContext();

      ctx.queryRunner.manager.createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      ctx.queryRunner.manager.findOne.mockResolvedValue(null);

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        isTransfer: true,
        transferAccount: "Unknown Account",
      };

      await service.processTransaction(ctx, qifTx);

      // Should not match pending and instead create new (but no linked since no mapped account)
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should preserve existing payeeName and referenceNumber if not provided in qifTx", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      const pendingTransfer = {
        id: "tx-pending-existing-fields",
        amount: 95,
        payeeName: "Existing Payee",
        referenceNumber: "REF-123",
        linkedTransaction: { accountId: "acc-usd" },
      };

      let qbCallCount = 0;
      ctx.queryRunner.manager.createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(pendingTransfer);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
        // No payee or number provided
      };

      await service.processTransaction(ctx, qifTx);

      const updateCalls = ctx.queryRunner.manager.update.mock.calls;
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === pendingTransfer.id,
      );
      expect(pendingUpdate).toBeDefined();
      expect(pendingUpdate[2].payeeName).toBe("Existing Payee");
      expect(pendingUpdate[2].referenceNumber).toBe("REF-123");
    });
  });
});
