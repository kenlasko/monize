import { ImportRegularProcessorService } from "./import-regular-processor.service";
import { ImportContext } from "./import-context";
import { ImportResultDto } from "./dto/import.dto";
import { AccountType } from "../accounts/entities/account.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import {
  AppliedRuleRow,
  TransactionRulesApplierService,
} from "../transaction-rules/transaction-rules-applier.service";
import { RuleEffects } from "../transaction-rules/rule-effects";

/**
 * The rules step of `processTransaction` (design 6.3): it runs last, on the
 * import's manager, with the file's preloaded rules and the raw payee text, and
 * never for a transfer the importer wrote.
 */
describe("ImportRegularProcessorService import rules", () => {
  const userId = "user-1";
  const accountId = "acc-1";
  const rules = [{ id: "rule-1" }] as unknown as TransactionRule[];

  let applier: { applyToNew: jest.Mock };
  let service: ImportRegularProcessorService;
  let events: string[];

  const makeManager = () => ({
    save: jest.fn().mockImplementation((entity: { id?: string }) => {
      events.push("save");
      entity.id = "saved-tx";
      return Promise.resolve(entity);
    }),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    query: jest.fn().mockImplementation(() => {
      events.push("query");
      return Promise.resolve([[], 1]);
    }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    create: jest
      .fn()
      .mockImplementation((_cls: unknown, data: object) => ({ ...data })),
    createQueryBuilder: jest.fn().mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      getMany: jest.fn().mockResolvedValue([]),
      getRawMany: jest.fn().mockResolvedValue([]),
      getCount: jest.fn().mockResolvedValue(0),
    }),
  });

  const makeContext = (over: Partial<ImportContext> = {}): ImportContext => ({
    manager: makeManager() as never,
    userId,
    accountId,
    account: {
      id: accountId,
      currencyCode: "CAD",
      accountType: AccountType.CHEQUING,
    } as never,
    categoryMap: new Map(),
    accountMap: new Map(),
    loanCategoryMap: new Map(),
    securityMap: new Map(),
    tagMap: new Map(),
    importStartTime: new Date(),
    dateCounters: new Map(),
    affectedAccountIds: new Set(),
    importResult: {
      imported: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
      categoriesCreated: 0,
      accountsCreated: 0,
      payeesCreated: 0,
      securitiesCreated: 0,
    } as ImportResultDto,
    transferDupCounts: new Map(),
    importRules: rules,
    ...over,
  });

  const effectsWith = (changes: object): RuleEffects =>
    ({
      changes: { addTagIds: [], removeTagIds: [] },
      trace: [{ ruleId: "rule-1", matched: true, changes }],
      aiReviewRequests: [],
    }) as unknown as RuleEffects;

  const applied = (changes: object): AppliedRuleRow[] => [
    {
      transactionId: "saved-tx",
      effects: effectsWith(changes),
      affectedAccountIds: [],
    },
  ];

  beforeEach(() => {
    events = [];
    applier = {
      applyToNew: jest.fn().mockImplementation(() => {
        events.push("rules");
        return Promise.resolve([]);
      }),
    };
    service = new ImportRegularProcessorService(
      applier as unknown as TransactionRulesApplierService,
    );
  });

  it("applies the preloaded rules to the row it wrote, with the raw payee text, after the row is written", async () => {
    const ctx = makeContext();

    await service.processTransaction(ctx, {
      date: "2025-01-15",
      amount: -50,
      payee: "BIEDRONKA 123",
    });

    expect(applier.applyToNew).toHaveBeenCalledTimes(1);
    const [manager, uid, ids, source, options] =
      applier.applyToNew.mock.calls[0];
    expect(manager).toBe(ctx.manager);
    expect(uid).toBe(userId);
    expect(ids).toEqual(["saved-tx"]);
    expect(source).toBe("import");
    expect(options.rules).toBe(rules);
    expect(options.payeeTextById.get("saved-tx")).toBe("BIEDRONKA 123");
    // The row and its balance are written before the rules run.
    expect(events.indexOf("save")).toBeLessThan(events.indexOf("rules"));
    expect(events.indexOf("query")).toBeLessThan(events.indexOf("rules"));
    expect(ctx.importResult.imported).toBe(1);
  });

  it("passes null payee text when the file row has no payee", async () => {
    await service.processTransaction(makeContext(), {
      date: "2025-01-15",
      amount: -50,
    });
    expect(
      applier.applyToNew.mock.calls[0][4].payeeTextById.get("saved-tx"),
    ).toBeNull();
  });

  it("does nothing when the file has no import rules", async () => {
    await service.processTransaction(makeContext({ importRules: [] }), {
      date: "2025-01-15",
      amount: -50,
    });
    await service.processTransaction(makeContext({ importRules: undefined }), {
      date: "2025-01-15",
      amount: -50,
    });
    expect(applier.applyToNew).not.toHaveBeenCalled();
  });

  it("does not evaluate a transfer the importer wrote", async () => {
    const ctx = makeContext({
      accountMap: new Map([["Savings", "acc-savings"]]),
    });
    (ctx.manager as never as { findOne: jest.Mock }).findOne.mockImplementation(
      (_entity: unknown, opts: { where?: { id?: string } }) =>
        Promise.resolve(
          opts?.where?.id === "acc-savings"
            ? { id: "acc-savings", currencyCode: "CAD" }
            : { id: accountId, currentBalance: 1000 },
        ),
    );

    await service.processTransaction(ctx, {
      date: "2025-01-15",
      amount: -500,
      isTransfer: true,
      transferAccount: "Savings",
      payee: "Transfer",
    });

    expect(ctx.importResult.imported).toBe(1);
    expect(applier.applyToNew).not.toHaveBeenCalled();
  });

  it("does not evaluate the rules for a duplicate transfer that is skipped", async () => {
    const ctx = makeContext({
      accountMap: new Map([["Savings", "acc-savings"]]),
    });
    (
      ctx.manager as never as { createQueryBuilder: jest.Mock }
    ).createQueryBuilder.mockReturnValue({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(1),
    });

    await service.processTransaction(ctx, {
      date: "2025-01-15",
      amount: -500,
      isTransfer: true,
      transferAccount: "Savings",
    });

    expect(ctx.importResult.skipped).toBe(1);
    expect(applier.applyToNew).not.toHaveBeenCalled();
  });

  it("counts a row a rule changed, and only then", async () => {
    const ctx = makeContext();
    applier.applyToNew.mockResolvedValueOnce(applied({ categoryId: {} }));
    await service.processTransaction(ctx, { date: "2025-01-15", amount: -1 });
    expect(ctx.importResult.transactionsChangedByRules).toBe(1);

    applier.applyToNew.mockResolvedValueOnce(applied({}));
    await service.processTransaction(ctx, { date: "2025-01-16", amount: -2 });
    expect(ctx.importResult.transactionsChangedByRules).toBe(1);

    applier.applyToNew.mockResolvedValueOnce(applied({ tagIds: {} }));
    await service.processTransaction(ctx, { date: "2025-01-17", amount: -3 });
    expect(ctx.importResult.transactionsChangedByRules).toBe(2);
    expect(ctx.importResult.imported).toBe(3);
  });

  it("adds the accounts a structural action moved to the import's affected accounts", async () => {
    const ctx = makeContext();
    applier.applyToNew.mockResolvedValueOnce([
      {
        transactionId: "saved-tx",
        effects: effectsWith({}),
        affectedAccountIds: ["loan-account"],
      },
    ]);
    await service.processTransaction(ctx, { date: "2025-01-15", amount: -1 });
    expect(ctx.affectedAccountIds.has("loan-account")).toBe(true);
  });

  it("leaves the counter absent when no rule changed a row", async () => {
    const ctx = makeContext();
    await service.processTransaction(ctx, { date: "2025-01-15", amount: -1 });
    expect(ctx.importResult.transactionsChangedByRules).toBeUndefined();
  });

  it("lets an applier failure reach the caller's savepoint, without counting the row imported", async () => {
    const ctx = makeContext();
    applier.applyToNew.mockRejectedValue(new Error("rule write failed"));

    await expect(
      service.processTransaction(ctx, { date: "2025-01-15", amount: -1 }),
    ).rejects.toThrow("rule write failed");
    expect(ctx.importResult.imported).toBe(0);
    expect(ctx.importResult.transactionsChangedByRules).toBeUndefined();
  });
});
