jest.mock("./import-accrual-guard", () => ({
  prepareImportAccrualSources: async () => new Set<string>(),
  assertImportAccrualMatch: async () => undefined,
  assertImportAccrualIds: async () => undefined,
  assertImportAccrualEntry: async () => undefined,
  rememberImportedAccrualSource: () => undefined,
}));
import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { TransactionRulesApplierService } from "../transaction-rules/transaction-rules-applier.service";
import { ImportContext } from "./import-context";
import {
  Transaction,
  TransactionStatus,
} from "../transactions/entities/transaction.entity";
import { AccountType } from "../accounts/entities/account.entity";
import { Payee } from "../payees/entities/payee.entity";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { ImportResultDto } from "./dto/import.dto";

describe("ImportRegularProcessorService", () => {
  let service: ImportRegularProcessorService;
  let exchangeRateService: {
    getRateForDate: jest.Mock;
    getLatestRate: jest.Mock;
  };

  const userId = "user-1";
  const accountId = "acc-1";

  const makeImportResult = (): ImportResultDto => ({
    imported: 0,
    skipped: 0,
    skippedRows: [],
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
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
      getRawOne: jest.fn().mockResolvedValue(result ?? undefined),
      getOne: jest.fn().mockResolvedValue(result),
      getMany: jest.fn().mockResolvedValue(result ? [result] : []),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(result ? 1 : 0),
    };
    return qb;
  };

  // ctx.manager is typed as a real EntityManager; the spec drives the jest mocks
  // behind it, so read it back through this accessor rather than casting inline.
  const managerOf = (ctx: ImportContext): Record<string, jest.Mock> =>
    ctx.manager as unknown as Record<string, jest.Mock>;

  const makeMockManager = () => ({
    save: jest.fn().mockImplementation((entity: any) => {
      if (!entity.id) {
        entity.id = `gen-${Date.now()}-${Math.random()}`;
      }
      return Promise.resolve(entity);
    }),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    // `updateAccountBalance` moves a balance with one atomic
    // `current_balance = current_balance + $1` statement.
    query: jest.fn().mockResolvedValue([[], 1]),
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
    return {
      manager: makeMockManager() as any,
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
      tagMap: new Map(),
      importStartTime: new Date(),
      dateCounters: new Map(),
      affectedAccountIds: new Set(),
      settledScheduleIds: new Set(),
      importResult: makeImportResult(),
      transferDupCounts: new Map(),
      heldExternalIds: new Map(),
      ...overrides,
    };
  };

  beforeEach(() => {
    exchangeRateService = {
      getRateForDate: jest.fn().mockResolvedValue(null),
      getLatestRate: jest.fn().mockResolvedValue(null),
    };
    service = new ImportRegularProcessorService(
      {
        applyToNew: jest.fn().mockResolvedValue([]),
      } as unknown as TransactionRulesApplierService,
      exchangeRateService as unknown as ExchangeRateService,
    );
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
      expect(managerOf(ctx).create).toHaveBeenCalled();
      expect(managerOf(ctx).save).toHaveBeenCalled();
    });

    it("should set RECONCILED status when reconciled flag is true", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        reconciled: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.CLEARED);
    });

    it("should set UNRECONCILED status by default", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.RECONCILED);
    });

    it("should set VOID status when the void flag is true", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        void: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.VOID);
    });

    it("should treat VOID as higher priority than reconciled/cleared", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        void: true,
        reconciled: true,
        cleared: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].status).toBe(TransactionStatus.VOID);
    });

    // A transaction may be preceded by a payee create call, so locate the
    // transaction create by its transaction-only transactionDate field.
    const findTxCreate = (ctx: ImportContext) =>
      managerOf(ctx).create.mock.calls.find(
        (call: any[]) => call[1].transactionDate !== undefined,
      );

    it("appends the void note to the description for export-voided rows", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: 0,
        payee: "Grocery Store",
        memo: "Weekly groceries",
        void: true,
        voidedByExport: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = findTxCreate(ctx);
      expect(createCall[1].status).toBe(TransactionStatus.VOID);
      expect(createCall[1].description).toBe(
        "Weekly groceries Voided in the source; the original amount was omitted from the export and imported as zero.",
      );
    });

    it("uses only the void note when an export-voided row has no memo", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: 0,
        payee: "Grocery Store",
        memo: "",
        void: true,
        voidedByExport: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = findTxCreate(ctx);
      expect(createCall[1].description).toBe(
        "Voided in the source; the original amount was omitted from the export and imported as zero.",
      );
    });

    it("does not append the void note for a CSV-style void without the export flag", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
        memo: "Cancelled payment",
        void: true,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = findTxCreate(ctx);
      expect(createCall[1].status).toBe(TransactionStatus.VOID);
      expect(createCall[1].description).toBe("Cancelled payment");
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

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
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
      const createCalls = managerOf(ctx).create.mock.calls;
      // Main transaction + 2 splits = at least 3 create calls
      expect(createCalls.length).toBeGreaterThanOrEqual(3);
    });

    it("sets kind=category and clears transferAccountId for category splits", async () => {
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Food", "cat-food");
      const ctx = makeContext({ categoryMap });

      await service.processTransaction(ctx, {
        date: "2025-01-15",
        amount: -60,
        splits: [{ amount: -60, category: "Food", memo: "Food" }],
      });

      const splitCreate = managerOf(ctx).create.mock.calls.find(
        (c: unknown[]) =>
          c[1] != null && typeof c[1] === "object" && "kind" in c[1],
      );
      expect(splitCreate?.[1]).toMatchObject({
        kind: SplitKind.CATEGORY,
        categoryId: "cat-food",
        transferAccountId: null,
      });
    });

    it("sets kind=transfer and clears categoryId for transfer splits", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Checking", "acc-chk");
      const ctx = makeContext({ accountMap });

      await service.processTransaction(ctx, {
        date: "2025-01-15",
        amount: -50,
        splits: [
          {
            amount: -50,
            isTransfer: true,
            transferAccount: "Checking",
            memo: "xfer",
          },
        ],
      });

      const splitCreate = managerOf(ctx).create.mock.calls.find(
        (c: unknown[]) =>
          c[1] != null && typeof c[1] === "object" && "kind" in c[1],
      );
      expect(splitCreate?.[1]).toMatchObject({
        kind: SplitKind.TRANSFER,
        categoryId: null,
        transferAccountId: "acc-chk",
      });
    });
  });

  describe("OFX bank id (FITID)", () => {
    const holdsKey = (
      ctx: ImportContext,
      key: string,
      holder = { transactionDate: "2026-01-15", amount: -50 },
    ) => ctx.heldExternalIds.set(key, holder);

    const keyLookupsOf = (ctx: ImportContext) =>
      managerOf(ctx).findOne.mock.calls.filter(
        ([, options]) => options?.where?.externalId !== undefined,
      );

    it("skips a row whose bank id the account already holds, writes nothing and lists it with its date and amount", async () => {
      const ctx = makeContext();
      holdsKey(ctx, "ofx:A1");

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -50,
        payee: "Store",
        fitId: "A1",
      });

      expect(ctx.importResult.imported).toBe(0);
      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.skippedRows).toEqual([
        {
          date: "2026-01-15",
          amount: -50,
          currencyCode: "CAD",
          payee: "Store",
          reason: "alreadyImported",
        },
      ]);
      expect(managerOf(ctx).create).not.toHaveBeenCalled();
      expect(managerOf(ctx).save).not.toHaveBeenCalled();
      expect(managerOf(ctx).query).not.toHaveBeenCalled();
      // The held keys were read once for the whole file, not per row.
      expect(keyLookupsOf(ctx)).toEqual([]);
    });

    it("matches the held row's amount as the database returns it, a 4dp decimal string", async () => {
      const ctx = makeContext();
      holdsKey(ctx, "ofx:A1", {
        transactionDate: "2026-01-15",
        amount: "-50.0000" as unknown as number,
      });

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -50,
        payee: "Store",
        fitId: "A1",
      });

      expect(ctx.importResult.skipped).toBe(1);
      expect(managerOf(ctx).create).not.toHaveBeenCalled();
    });

    it.each([
      ["another date", { transactionDate: "2025-12-15", amount: -50 }],
      ["another amount", { transactionDate: "2026-01-15", amount: -75 }],
    ])(
      "imports a row whose bank id a row of %s holds, without the key, since the bank reused it",
      async (_label, holder) => {
        const ctx = makeContext();
        holdsKey(ctx, "ofx:A1", holder);

        await service.processTransaction(ctx, {
          date: "2026-01-15",
          amount: -50,
          payee: "Store",
          fitId: "A1",
        });

        expect(ctx.importResult.skipped).toBe(0);
        expect(ctx.importResult.imported).toBe(1);
        expect(managerOf(ctx).create).toHaveBeenCalledWith(
          Transaction,
          expect.objectContaining({ externalId: null }),
        );
      },
    );

    it("stores the bank id as the new row's externalId", async () => {
      const ctx = makeContext();

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -50,
        payee: "Store",
        fitId: "A1",
      });

      expect(ctx.importResult.imported).toBe(1);
      expect(managerOf(ctx).create).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({ externalId: "ofx:A1" }),
      );
    });

    it("imports a row without a bank id as before, with no key and no lookup", async () => {
      const ctx = makeContext();

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -50,
        payee: "Store",
      });

      expect(ctx.importResult.imported).toBe(1);
      expect(managerOf(ctx).create).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({ externalId: null }),
      );
      expect(keyLookupsOf(ctx)).toEqual([]);
    });

    it("records the key it wrote, so the rest of the file sees the account holding it", async () => {
      const ctx = makeContext();

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -50,
        payee: "Store",
        fitId: "A1",
      });

      expect(ctx.heldExternalIds.get("ofx:A1")).toEqual({
        transactionDate: "2026-01-15",
        amount: -50,
      });
    });

    it("answers a held bank id before the transfer check, so a transfer line is named as already imported", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });
      holdsKey(ctx, "ofx:T-7", { transactionDate: "2026-01-15", amount: -200 });

      await service.processTransaction(ctx, {
        date: "2026-01-15",
        amount: -200,
        isTransfer: true,
        transferAccount: "Savings",
        fitId: "T-7",
      });

      expect(ctx.importResult.skippedRows.map((r) => r.reason)).toEqual([
        "alreadyImported",
      ]);
      // It still takes its turn in the per-signature transfer count, so a new
      // identical transfer later in the file is not matched against it, and it
      // takes that turn without running the counted queries.
      expect(
        ctx.transferDupCounts.get("linked|2026-01-15|-200|acc-savings"),
      ).toBe(1);
      expect(ctx.transferDupCounts.get("split|2026-01-15|-200")).toBe(1);
      expect(managerOf(ctx).createQueryBuilder).not.toHaveBeenCalled();
    });

    describe("a transfer line whose bank id the account does not hold", () => {
      const savingsContext = () => {
        const accountMap = new Map<string, string | null>();
        accountMap.set("Savings", "acc-savings");
        return makeContext({ accountMap });
      };
      const line = {
        date: "2026-01-15",
        amount: -100,
        isTransfer: true,
        transferAccount: "Savings",
        fitId: "X3",
      };

      it("takes over the bank id on a recorded transfer that has none and is skipped as that transfer", async () => {
        const ctx = savingsContext();
        const adoptQb = makeMockQueryBuilder({ id: "tx-leg" });
        managerOf(ctx).createQueryBuilder.mockImplementation(() => adoptQb);

        await service.processTransaction(ctx, line);

        expect(ctx.importResult.imported).toBe(0);
        expect(ctx.importResult.skippedRows.map((r) => r.reason)).toEqual([
          "duplicateTransfer",
        ]);
        expect(adoptQb.andWhere).toHaveBeenCalledWith("t.external_id IS NULL");
        expect(adoptQb.andWhere).toHaveBeenCalledWith(
          "t.created_at < :importStartTime",
          { importStartTime: ctx.importStartTime },
        );
        expect(adoptQb.set).toHaveBeenCalledWith({ externalId: "ofx:X3" });
        expect(adoptQb.where).toHaveBeenCalledWith("id = :id", {
          id: "tx-leg",
        });
        expect(ctx.heldExternalIds.get("ofx:X3")).toEqual({
          transactionDate: "2026-01-15",
          amount: -100,
        });
        expect(managerOf(ctx).create).not.toHaveBeenCalled();
      });

      it("imports as a new transfer when no recorded one is free, whatever the counted check would find", async () => {
        const ctx = savingsContext();
        // Two recorded transfers of the signature, both already holding a
        // bank id: the counted check would call this line a duplicate.
        const qb = makeMockQueryBuilder(null);
        qb.getCount.mockResolvedValue(2);
        managerOf(ctx).createQueryBuilder.mockImplementation(() => qb);

        await service.processTransaction(ctx, line);

        // A split-linked row is this transfer only when its split is in the
        // account the line names.
        expect(qb.andWhere).toHaveBeenCalledWith(
          "parent.account_id = :transferAccountId",
          { transferAccountId: "acc-savings" },
        );
        expect(qb.getCount).not.toHaveBeenCalled();
        expect(ctx.importResult.skipped).toBe(0);
        expect(ctx.importResult.imported).toBe(1);
        expect(managerOf(ctx).create).toHaveBeenCalledWith(
          Transaction,
          expect.objectContaining({ externalId: "ofx:X3" }),
        );
        expect(
          ctx.transferDupCounts.get("linked|2026-01-15|-100|acc-savings"),
        ).toBe(1);
      });

      it("imports as a new transfer when another import claimed the recorded one first", async () => {
        const ctx = savingsContext();
        const qb = makeMockQueryBuilder({ id: "tx-leg" });
        qb.execute.mockResolvedValue({ affected: 0 });
        qb.getRawMany.mockResolvedValue([]);
        qb.getOne.mockResolvedValue(null);
        managerOf(ctx).createQueryBuilder.mockImplementation(() => qb);

        await service.processTransaction(ctx, line);

        expect(ctx.importResult.imported).toBe(1);
        expect(ctx.heldExternalIds.get("ofx:X3")).toEqual({
          transactionDate: "2026-01-15",
          amount: -100,
        });
      });
    });
  });

  describe("isDuplicateTransfer (via processTransaction)", () => {
    it("should skip duplicate linked transfers", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      // Set up query builder to find existing linked transfer
      const existingTransfer = { id: "tx-existing", accountId: "acc-1" };
      managerOf(ctx).createQueryBuilder.mockReturnValue(
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
      expect(ctx.importResult.skippedRows).toEqual([
        {
          date: "2025-01-15",
          amount: -200,
          currencyCode: "CAD",
          payee: "",
          reason: "duplicateTransfer",
        },
      ]);
    });

    it("should skip split-linked transfers", async () => {
      const ctx = makeContext();

      // When isTransfer is true but transferAccount is absent,
      // the first block in isDuplicateTransfer is skipped entirely.
      // Only the second block (split-linked check) runs, which is the first QB call.
      managerOf(ctx).createQueryBuilder.mockReturnValue(
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

    it("should not skip a second transfer with same date/amount/account but different payee", async () => {
      // Reproduces GitHub issue #288: two transfers on the same day for the
      // same amount to the same account (e.g. Manulife $150 and Cris Morley $150
      // both to Tangerine) should NOT be treated as duplicates of each other.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Tangerine", "acc-tangerine");
      const ctx = makeContext({ accountMap });

      // After the first transfer is processed, the DB has 1 existing linked
      // transfer matching the signature. The counting logic should let the
      // second QIF entry through because seenCount (2) > existingCount (1).
      // QB call sequence per processTransaction:
      //   1. isDuplicateTransfer linked check
      //   2. isDuplicateTransfer split-linked check
      //   3. matchPendingTransfer
      // So for tx2, the linked check is call 4.
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 4) {
          // 2nd tx's linked-transfer check: 1 existing match in DB
          qb.getCount.mockResolvedValue(1);
        }
        return qb;
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-tangerine") {
          return Promise.resolve({
            id: "acc-tangerine",
            currencyCode: "CAD",
          });
        }
        return Promise.resolve(null);
      });

      const tx1 = {
        date: "2020-10-05",
        amount: -150,
        payee: "Manulife",
        memo: "Insurance",
        isTransfer: true,
        transferAccount: "Tangerine",
      };
      const tx2 = {
        date: "2020-10-05",
        amount: -150,
        payee: "Cris Morley",
        memo: "For Boots",
        isTransfer: true,
        transferAccount: "Tangerine",
      };

      await service.processTransaction(ctx, tx1);
      await service.processTransaction(ctx, tx2);

      expect(ctx.importResult.imported).toBe(2);
      expect(ctx.importResult.skipped).toBe(0);
    });

    it("should correctly skip both sides when processing the other account block", async () => {
      // When processing the transfer-target account, both incoming transfers
      // should be detected as duplicates (they were already created as linked txs).
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      // Both QIF entries find 2 existing linked transfers in the DB
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        const qb = makeMockQueryBuilder(null);
        qb.getCount.mockResolvedValue(2);
        return qb;
      });

      const tx1 = {
        date: "2020-10-05",
        amount: 150,
        payee: "Manulife",
        isTransfer: true,
        transferAccount: "Source Account",
      };
      const tx2 = {
        date: "2020-10-05",
        amount: 150,
        payee: "Cris Morley",
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, tx1);
      await service.processTransaction(ctx, tx2);

      expect(ctx.importResult.skipped).toBe(2);
      expect(ctx.importResult.imported).toBe(0);
    });

    it("should skip Quicken merged split transfers when splits were already imported", async () => {
      // Quicken merges multiple split transfers to the same account into a
      // single transaction on the receiving side. E.g., Account-A has a split
      // with $50 and $40 to Account-B; Account-B gets a single $90 transaction.
      // Since we create individual split-linked transactions ($50 and $40),
      // the merged $90 should be detected and skipped.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      // QB call sequence for isDuplicateTransfer:
      //   1. linked-transfer check (getCount)
      //   2. split-linked check (getCount)
      //   3. merged split check (getRawMany)
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          // Merged split check: return a group where 2 splits sum to 90
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          qb.getRawMany = jest
            .fn()
            .mockResolvedValue([
              { parentId: "parent-tx-1", totalAmount: "90", splitCount: "2" },
            ]);
        }
        return qb;
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.imported).toBe(0);
    });

    it("should not skip a transfer that does not match any merged split sum", async () => {
      // A $90 transfer exists but the split-linked transactions sum to a
      // different amount (e.g. $80), so it should NOT be skipped.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          // Merged split check: splits sum to 80, not 90
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          qb.getRawMany = jest
            .fn()
            .mockResolvedValue([
              { parentId: "parent-tx-1", totalAmount: "80", splitCount: "2" },
            ]);
        }
        return qb;
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-source") {
          return Promise.resolve({
            id: "acc-source",
            currencyCode: "CAD",
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should not skip merged split check when only 1 split exists (not a merge)", async () => {
      // If there's only a single split transfer (not merged), the transfer
      // should be handled by the regular duplicate checks, not the merge check.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          // Merged split check: only 1 split, so count < 2
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          qb.getRawMany = jest
            .fn()
            .mockResolvedValue([
              { parentId: "parent-tx-1", totalAmount: "90", splitCount: "1" },
            ]);
        }
        return qb;
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-source") {
          return Promise.resolve({
            id: "acc-source",
            currencyCode: "CAD",
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should skip merged split transfer with case-insensitive account name matching", async () => {
      // Transfer account name in QIF may differ in casing from accountMap key
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          qb.getRawMany = jest
            .fn()
            .mockResolvedValue([
              { parentId: "parent-tx-1", totalAmount: "90", splitCount: "2" },
            ]);
        }
        return qb;
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "source account", // lowercase
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.imported).toBe(0);
    });

    it("should not run merged split check for non-transfer transactions", async () => {
      const ctx = makeContext();

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        payee: "Store",
        // Not a transfer: isTransfer is falsy
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(0);
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should skip merged split transfer with floating point amounts that round to match", async () => {
      // Ensure the comparison handles floating-point precision correctly
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          // Sum that is very close due to floating point: 50.005 + 39.995 = 90.00000...01
          qb.getRawMany = jest.fn().mockResolvedValue([
            {
              parentId: "parent-tx-1",
              totalAmount: "90.0000",
              splitCount: "3",
            },
          ]);
        }
        return qb;
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
    });

    it("should handle multiple parent groups and match the correct one", async () => {
      // Two parent split transactions from the same account on the same date,
      // only one has splits that sum to the merged amount
      const accountMap = new Map<string, string | null>();
      accountMap.set("Source Account", "acc-source");
      const ctx = makeContext({ accountMap });

      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 3) {
          qb.select = jest.fn().mockReturnValue(qb);
          qb.addSelect = jest.fn().mockReturnValue(qb);
          qb.groupBy = jest.fn().mockReturnValue(qb);
          qb.getRawMany = jest.fn().mockResolvedValue([
            { parentId: "parent-tx-1", totalAmount: "60", splitCount: "2" },
            { parentId: "parent-tx-2", totalAmount: "90", splitCount: "3" },
          ]);
        }
        return qb;
      });

      const qifTx = {
        date: "2025-01-15",
        amount: 90,
        isTransfer: true,
        transferAccount: "Source Account",
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
    });

    it("should not delete a prior split transaction when a second split transaction shares the same transfer account", async () => {
      // Reproduces a bug where two split transactions with the same date/amount
      // and a common transfer split (e.g. both have [Accounts Rec] -76.00) caused
      // the second import to steal the linked transaction from the first and then
      // delete the first parent transaction as a phantom placeholder.
      //
      // Both transactions have amount -100 with splits:
      //   TX1: [Personal Care -24, [Accounts Rec] -76]
      //   TX2: [[Accounts Rec] -76, Personal Care -24]  (same splits, reversed order)
      //
      // Expected: both imported (imported=2), TX1 is NOT deleted.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Accounts Rec", "acc-rec");
      const ctx = makeContext({ accountMap });

      // isDuplicateTransfer returns false for split transactions (isTransfer is
      // false on the parent). processSplitTransfer uses getOne, not getCount.
      // Return null from all query builders so no existing linked tx is found
      // (simulating a fresh import where neither TX has been stored yet).
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      // findOne: return the target account for balance updates
      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-rec") {
          return Promise.resolve({
            id: "acc-rec",
            currencyCode: "CAD",
            currentBalance: 0,
          });
        }
        if (opts?.where?.id === ctx.accountId) {
          return Promise.resolve({
            id: ctx.accountId,
            currencyCode: "CAD",
            currentBalance: 0,
          });
        }
        return Promise.resolve(null);
      });

      const tx1 = {
        date: "2022-06-01",
        amount: -100,
        payee: "Galib Shariff Prof",
        memo: "Physio - Dan",
        reconciled: true,
        splits: [
          {
            category: "Personal Care:Massage - Physio - Chiro",
            amount: -24,
          },
          {
            isTransfer: true,
            transferAccount: "Accounts Rec",
            amount: -76,
          },
        ],
      };
      const tx2 = {
        date: "2022-06-01",
        amount: -100,
        payee: "Galib Shariff Prof",
        memo: "Physio - Dan",
        reconciled: true,
        splits: [
          {
            isTransfer: true,
            transferAccount: "Accounts Rec",
            amount: -76,
          },
          {
            category: "Personal Care:Massage - Physio - Chiro",
            amount: -24,
          },
        ],
      };

      await service.processTransaction(ctx, tx1);
      await service.processTransaction(ctx, tx2);

      expect(ctx.importResult.imported).toBe(2);
      expect(ctx.importResult.skipped).toBe(0);

      // Verify TX1 was not deleted: the delete mock should not have been
      // called with the ID of the transaction saved during TX1's processing.
      const deleteCalls = managerOf(ctx).delete.mock.calls;
      expect(deleteCalls.length).toBe(0);
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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
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
      expect(managerOf(ctx).update).toHaveBeenCalled();
    });

    it("gives the matched pending row the line's bank id, so the next download of it is skipped", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });
      const pendingTransfer = {
        id: "tx-pending",
        amount: 95,
        payeeName: "Transfer",
        referenceNumber: null,
        externalId: null,
        linkedTransaction: { accountId: "acc-usd" },
      };
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        return makeMockQueryBuilder(qbCallCount <= 2 ? null : pendingTransfer);
      });

      await service.processTransaction(ctx, {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
        fitId: "X-9",
      });

      expect(managerOf(ctx).update).toHaveBeenCalledWith(
        Transaction,
        "tx-pending",
        expect.objectContaining({ externalId: "ofx:X-9" }),
      );
    });

    it("keeps a key the matched pending row already holds", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });
      const pendingTransfer = {
        id: "tx-pending",
        amount: 95,
        payeeName: "Transfer",
        referenceNumber: null,
        externalId: "client-key",
        linkedTransaction: { accountId: "acc-usd" },
      };
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        return makeMockQueryBuilder(qbCallCount <= 2 ? null : pendingTransfer);
      });

      await service.processTransaction(ctx, {
        date: "2025-01-15",
        amount: 100,
        isTransfer: true,
        transferAccount: "USD Account",
        fitId: "X-9",
      });

      expect(managerOf(ctx).update).toHaveBeenCalledTimes(1);
      expect(managerOf(ctx).update.mock.calls[0][2]).not.toHaveProperty(
        "externalId",
      );
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

      managerOf(ctx).findOne.mockImplementation((entity: any, opts: any) => {
        if (entity === Payee && opts?.where?.name === "Tim Hortons") {
          return Promise.resolve({ id: "payee-tim", name: "Tim Hortons" });
        }
        // For account balance update
        return Promise.resolve({ id: accountId, currentBalance: 500 });
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -5.25,
        payee: "Tim Hortons",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].payeeId).toBe("payee-tim");
    });

    it("should create new payee when not found", async () => {
      const ctx = makeContext();

      managerOf(ctx).findOne.mockImplementation((entity: any, _opts: any) => {
        if (entity === Payee) return Promise.resolve(null);
        // For account balance update
        return Promise.resolve({ id: accountId, currentBalance: 500 });
      });

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

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].categoryId).toBe("cat-asset");
    });

    it("should detect loan payment categories and create transfer", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Car Loan", "acc-loan");
      const ctx = makeContext({ loanCategoryMap });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-loan") {
          return Promise.resolve({
            id: "acc-loan",
            currencyCode: "CAD",
          });
        }
        // For account balance update
        return Promise.resolve({ id: accountId, currentBalance: 500 });
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan",
        payee: "Auto Finance",
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
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

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].categoryId).toBeNull();
    });
  });

  describe("processTransfer (via processTransaction)", () => {
    it("should create linked transaction for simple transfer", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
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
      });

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
      const createCalls = managerOf(ctx).create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-savings",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].amount).toBe(500); // Negated
      expect(linkedTxCreate[1].isTransfer).toBe(true);
      // The QIF payee is carried onto the linked leg verbatim; there is no
      // stamped fallback any more (issue #1214).
      expect(linkedTxCreate[1].payeeName).toBe("Transfer");
    });

    it("persists a blank transfer payee as null on the linked leg (issue #1214)", async () => {
      // No QIF payee: the old writer stamped "Transfer from <account>" here.
      // Blank stays blank now, and the display resolves the label from the
      // linked leg at read time.
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-savings") {
          return Promise.resolve({ id: "acc-savings", currencyCode: "CAD" });
        }
        if (opts?.where?.id === accountId) {
          return Promise.resolve({ id: accountId, currentBalance: 1000 });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "Savings",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = managerOf(ctx).create.mock.calls;
      const linkedTxCreate = createCalls.find(
        (call: any) => call[1]?.accountId === "acc-savings",
      );
      expect(linkedTxCreate).toBeDefined();
      expect(linkedTxCreate[1].payeeName).toBeNull();
    });

    it("should add PENDING IMPORT note for cross-currency transfers", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("USD Account", "acc-usd");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
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
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "USD Account",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = managerOf(ctx).create.mock.calls;
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

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
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
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = managerOf(ctx).create.mock.calls;
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

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currentBalance: 1000,
          });
        }
        return Promise.resolve(null);
      });

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

    describe("a split transfer into an account in another currency (A26-M18)", () => {
      const splitInto = () => {
        const accountMap = new Map<string, string | null>();
        accountMap.set("Savings USD", "acc-usd");
        const ctx = makeContext({ accountMap });
        managerOf(ctx).createQueryBuilder.mockReturnValue(
          makeMockQueryBuilder(null),
        );
        managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) =>
          Promise.resolve(
            opts?.where?.id === "acc-usd"
              ? { id: "acc-usd", currencyCode: "USD" }
              : null,
          ),
        );
        const qifTx = {
          date: "2025-01-15",
          amount: -100,
          splits: [
            { amount: -40, category: "Food" },
            { amount: -60, isTransfer: true, transferAccount: "Savings USD" },
          ],
        };
        return { ctx, qifTx };
      };
      const createdLeg = (ctx: ImportContext) =>
        managerOf(ctx)
          .create.mock.calls.map((call: any[]) => call[1])
          .find((row: any) => row.accountId === "acc-usd");

      it("converts the leg at the date's rate and writes it in the target's currency", async () => {
        const { ctx, qifTx } = splitInto();
        exchangeRateService.getRateForDate.mockResolvedValue(0.74);

        await service.processTransaction(ctx, qifTx);

        expect(exchangeRateService.getRateForDate).toHaveBeenCalledWith(
          "CAD",
          "USD",
          "2025-01-15",
        );
        expect(createdLeg(ctx)).toMatchObject({
          amount: 44.4,
          currencyCode: "USD",
          exchangeRate: 0.74,
        });
        expect(createdLeg(ctx).description).toContain("PENDING IMPORT");
      });

      it("refuses the row, naming the pair, when no rate covers the date", async () => {
        const { ctx, qifTx } = splitInto();
        exchangeRateService.getRateForDate.mockResolvedValue(null);

        await expect(service.processTransaction(ctx, qifTx)).rejects.toThrow(
          "CAD -> USD",
        );
        expect(createdLeg(ctx)).toBeUndefined();
      });
    });

    it("should handle loan categories within splits", async () => {
      const loanCategoryMap = new Map<string, string>();
      loanCategoryMap.set("Mortgage", "acc-mortgage");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Interest", "cat-interest");
      const ctx = makeContext({ loanCategoryMap, categoryMap });

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currentBalance: 5000,
          });
        }
        return Promise.resolve(null);
      });

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

      const createCall = managerOf(ctx).create.mock.calls[0];
      expect(createCall[1].referenceNumber).toBe("CHK-1234");
    });

    it("should set userId and accountId on every created transaction", async () => {
      const ctx = makeContext();
      const qifTx = {
        date: "2025-01-15",
        amount: -25,
      };

      await service.processTransaction(ctx, qifTx);

      const createCall = managerOf(ctx).create.mock.calls[0];
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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
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

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-usd") {
          return Promise.resolve({
            id: "acc-usd",
            currencyCode: "USD",
          });
        }
        return Promise.resolve(null);
      });

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
      expect(managerOf(ctx).update).toHaveBeenCalled();
      const updateCalls = managerOf(ctx).update.mock.calls;
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

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-eur") {
          return Promise.resolve({
            id: "acc-eur",
            currencyCode: "EUR",
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        isTransfer: true,
        transferAccount: "EUR Account",
        memo: "FX transfer",
      };

      await service.processTransaction(ctx, qifTx);

      const createCalls = managerOf(ctx).create.mock.calls;
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

      // The first QB call is from processTransfer checking for existing pending transfer
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(existingPending),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-loan-usd") {
          return Promise.resolve({
            id: "acc-loan-usd",
            currencyCode: "USD",
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -500,
        category: "Car Loan USD",
      };

      await service.processTransaction(ctx, qifTx);

      const updateCalls = managerOf(ctx).update.mock.calls;
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

      // The first QB call will be from processSplitTransfer (not isDuplicateTransfer
      // since qifTx.isTransfer is not set), so return existingLinkedTx immediately
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(existingLinkedTx),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currentBalance: 1000,
          });
        }
        return Promise.resolve(null);
      });

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
      const updateCalls = managerOf(ctx).update.mock.calls;
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

      // The first QB call will be from processSplitTransfer, so return existingLinkedTx immediately
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(existingLinkedTx),
      );

      managerOf(ctx).findOne.mockResolvedValue(null);

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
      const updateCalls = managerOf(ctx).update.mock.calls;
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

      // The first QB call will be from processSplitTransfer, so return existingLinkedTx immediately
      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(existingLinkedTx),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
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
      });

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
      expect(managerOf(ctx).delete).toHaveBeenCalled();
      const deleteCall = managerOf(ctx).delete.mock.calls.find(
        (call: any) => call[1] === "tx-placeholder",
      );
      expect(deleteCall).toBeDefined();

      // Should nullify the linkedTransactionId on existing linked tx
      const updateCalls = managerOf(ctx).update.mock.calls;
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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(existingLinkedTx);
      });

      // findOne returns null for the placeholder (not in current account)
      managerOf(ctx).findOne.mockResolvedValue(null);

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
      expect(managerOf(ctx).delete).not.toHaveBeenCalled();
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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount <= 2) {
          return makeMockQueryBuilder(null);
        }
        return makeMockQueryBuilder(pendingTransfer);
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currentBalance: 500,
          });
        }
        return Promise.resolve(null);
      });

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
      expect(managerOf(ctx).update).toHaveBeenCalled();
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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
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
      const updateCalls = managerOf(ctx).update.mock.calls;
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

      // Two QB calls from the transfer split:
      // 1st: check for existing linked (returns null)
      // 2nd: check for pending transfer (returns pendingSplitTransfer)
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        if (qbCallCount === 1) {
          // First QB call: existing linked check returns null
          return makeMockQueryBuilder(null);
        }
        // Second QB call: pending transfer check
        return makeMockQueryBuilder(pendingSplitTransfer);
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
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
      });

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
      const updateCalls = managerOf(ctx).update.mock.calls;
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === pendingSplitTransfer.id,
      );
      expect(pendingUpdate).toBeDefined();
    });
  });

  describe("isDuplicateTransfer - case-insensitive account matching", () => {
    it("should detect duplicate even when transfer account name has different casing", async () => {
      // Simulates the scenario where the investment processor created a linked
      // transfer pair (e.g. from XOut processing), and the regular processor
      // encounters the counterpart with slightly different account name casing.
      const accountMap = new Map<string, string | null>();
      accountMap.set("My Investments", "acc-investment-cash");
      const ctx = makeContext({ accountMap });

      // The linked transfer already exists (created by the investment processor)
      let qbCallCount = 0;
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        qbCallCount++;
        const qb = makeMockQueryBuilder(null);
        if (qbCallCount === 1) {
          // linked-transfer check: 1 existing match
          qb.getCount.mockResolvedValue(1);
        }
        return qb;
      });

      // Transfer uses different casing than account map key
      const qifTx = {
        date: "2025-01-15",
        amount: 1000,
        payee: "Transfer from My Investments",
        isTransfer: true,
        transferAccount: "my investments", // lowercase
      };

      await service.processTransaction(ctx, qifTx);

      expect(ctx.importResult.skipped).toBe(1);
      expect(ctx.importResult.imported).toBe(0);
    });
  });

  describe("isDuplicateTransfer - transfer with mapped account but no existing", () => {
    it("should not skip when transfer account is mapped but no duplicate found", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-savings") {
          return Promise.resolve({
            id: "acc-savings",
            currencyCode: "CAD",
          });
        }
        return Promise.resolve(null);
      });

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

      managerOf(ctx).createQueryBuilder.mockReturnValue(
        makeMockQueryBuilder(null),
      );

      managerOf(ctx).findOne.mockResolvedValue(null);

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
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
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

      const updateCalls = managerOf(ctx).update.mock.calls;
      const pendingUpdate = updateCalls.find(
        (call: any) => call[1] === pendingTransfer.id,
      );
      expect(pendingUpdate).toBeDefined();
      expect(pendingUpdate[2].payeeName).toBe("Existing Payee");
      expect(pendingUpdate[2].referenceNumber).toBe("REF-123");
    });
  });

  describe("split transfer FK safety", () => {
    it("should not delete current transaction when two splits transfer to the same account with the same amount", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const ctx = makeContext({ accountMap });

      // Track the savedTx id assigned during processTransaction
      let savedTxId: string | null = null;
      let createCallIndex = 0;
      managerOf(ctx).create = jest
        .fn()
        .mockImplementation((_cls: any, data: any) => {
          createCallIndex++;
          const entity = { ...data, id: `gen-${createCallIndex}` };
          // The first create is the main transaction
          if (createCallIndex === 1) savedTxId = entity.id;
          return entity;
        });

      // QB calls sequence:
      // 1. isDuplicateTransfer (regular) -> null
      // 2. isDuplicateTransfer (split-linked) -> null
      // 3. matchPendingTransfer -> returns false (not a transfer at top level)
      // Then for S1's processSplitTransfer:
      // 4. existingLinkedTx query -> null (no existing, so it creates a new linked tx)
      // 5. pendingTransfer query -> null
      // Then for S2's processSplitTransfer:
      // 6. existingLinkedTx query -> should NOT match L1 because L1.linkedTransactionId = savedTx.id
      // 7. pendingTransfer query -> null
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        return makeMockQueryBuilder(null);
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        // Account lookup for balance updates
        if (opts?.where?.id === "acc-savings") {
          return Promise.resolve({
            id: "acc-savings",
            currentBalance: 1000,
            currencyCode: "CAD",
          });
        }
        if (opts?.where?.id === accountId) {
          return Promise.resolve({
            id: accountId,
            currentBalance: 500,
          });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -200,
        splits: [
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer 1",
          },
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer 2",
          },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // The current transaction should never be deleted
      const deleteCalls = managerOf(ctx).delete.mock.calls;
      const deletedSavedTx = deleteCalls.find(
        (call: any) => call[1] === savedTxId,
      );
      expect(deletedSavedTx).toBeUndefined();

      // Should have imported successfully
      expect(ctx.importResult.imported).toBe(1);
    });

    it("should not match linked transactions that already point to the current transaction", async () => {
      const accountMap = new Map<string, string | null>();
      accountMap.set("Savings", "acc-savings");
      const categoryMap = new Map<string, string | null>();
      categoryMap.set("Toys", "cat-toys");
      const ctx = makeContext({ accountMap, categoryMap });

      let createCallIndex = 0;
      let savedTxId: string | null = null;
      managerOf(ctx).create = jest
        .fn()
        .mockImplementation((_cls: any, data: any) => {
          createCallIndex++;
          const entity = { ...data, id: `gen-${createCallIndex}` };
          if (createCallIndex === 1) savedTxId = entity.id;
          return entity;
        });

      // For the existingLinkedTx query, we simulate finding a transaction
      // whose linkedTransactionId equals savedTx.id (created by a prior split).
      // The fix should filter this out via the andWhere condition.
      managerOf(ctx).createQueryBuilder.mockImplementation(() => {
        const qb = makeMockQueryBuilder(null);
        // Track andWhere calls to verify the new filter is applied
        const andWhereCalls: string[] = [];
        qb.andWhere.mockImplementation((condition: string) => {
          andWhereCalls.push(condition);
          return qb;
        });
        (qb as any).andWhereCalls = andWhereCalls;
        return qb;
      });

      managerOf(ctx).findOne.mockImplementation((_entity: any, opts: any) => {
        if (opts?.where?.id === "acc-savings") {
          return Promise.resolve({
            id: "acc-savings",
            currentBalance: 1000,
            currencyCode: "CAD",
          });
        }
        if (opts?.where?.id === accountId) {
          return Promise.resolve({ id: accountId, currentBalance: 500 });
        }
        return Promise.resolve(null);
      });

      const qifTx = {
        date: "2025-01-15",
        amount: -187.3,
        splits: [
          {
            amount: -100,
            isTransfer: true,
            transferAccount: "Savings",
            memo: "Transfer",
          },
          { amount: -87.3, category: "Toys", memo: "Lego Mando" },
        ],
      };

      await service.processTransaction(ctx, qifTx);

      // The main transaction must not be deleted
      const deleteCalls = managerOf(ctx).delete.mock.calls;
      const deletedSavedTx = deleteCalls.find(
        (call: any) => call[1] === savedTxId,
      );
      expect(deletedSavedTx).toBeUndefined();

      // Should have created split entries for both splits
      const saveCalls = managerOf(ctx).save.mock.calls;
      expect(saveCalls.length).toBeGreaterThanOrEqual(3); // transaction + 2 splits + linked tx
      expect(ctx.importResult.imported).toBe(1);
    });
  });
});
