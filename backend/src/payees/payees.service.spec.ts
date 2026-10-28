jest.mock("../accruals/accrual-taxonomy-operation", () => ({
  beginTaxonomyOperation: async () => undefined,
  recordTaxonomyOperation: async () => undefined,
}));
jest.mock("../accruals/accrual-relationship-history", () => ({
  beginPayeeRelationshipHistory: async () => undefined,
  recordRelationshipHistory: async () => undefined,
}));
import { Test, TestingModule } from "@nestjs/testing";
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { DataSource, In, QueryFailedError } from "typeorm";
import { PayeesService } from "./payees.service";
import { Payee } from "./entities/payee.entity";
import { PayeeAlias } from "./entities/payee-alias.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { Category } from "../categories/entities/category.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";
import { FaviconService } from "../common/favicon/favicon.service";
import { PayeeContactLookupService } from "./lookup/payee-contact-lookup.service";
import { ContactLookupSuggestions } from "./lookup/payee-contact-lookup.types";
import { PayeeContactEnrichmentService } from "./lookup/payee-contact-enrichment.service";
import { getActiveScopedManager, withScopedDb } from "../common/db/scoped-db";
import { UserPreference } from "../users/entities/user-preference.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("PayeesService", () => {
  let service: PayeesService;
  let payeesRepository: Record<string, jest.Mock>;
  let aliasRepository: Record<string, any>;
  let transactionsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let categoriesRepository: Record<string, jest.Mock>;
  /**
   * The row `resolveUserPhoneRegion` reads to place a phone number written
   * without a country code. `en-US` is the column default, so an unset test
   * resolves the region a real user with no saved preferences would.
   */
  let preferencesRepository: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;
  let mockQueryRunner: any;
  let txManager: Record<string, jest.Mock>;

  const userId = "user-1";

  const mockPayee: Payee = {
    id: "payee-1",
    userId,
    name: "Starbucks",
    defaultCategoryId: "cat-1",
    notes: "Coffee shop",
    website: null,
    logoData: null,
    logoContentType: null,
    hasLogo: false,
    logoFetchedAt: null,
    address: null,
    email: null,
    phone: null,
    contactLookupAt: null,
    contactLookupSource: null,
    defaultCategory: { id: "cat-1", name: "Food & Drink" } as any,
    isActive: true,
    createdAt: new Date("2025-01-01"),
  };

  const mockPayeeNoCategory: Payee = {
    id: "payee-2",
    userId,
    name: "Amazon",
    defaultCategoryId: null,
    notes: "" as any,
    website: null,
    logoData: null,
    logoContentType: null,
    hasLogo: false,
    logoFetchedAt: null,
    address: null,
    email: null,
    phone: null,
    contactLookupAt: null,
    contactLookupSource: null,
    defaultCategory: null as any,
    isActive: true,
    createdAt: new Date("2025-01-02"),
  };

  let queryBuilderMock: Record<string, jest.Mock>;
  let categoryQueryBuilderMock: Record<string, jest.Mock>;
  // Typed against the real service so a signature change breaks the double
  // rather than leaving it describing a contract nothing has any more.
  let faviconService: jest.Mocked<Pick<FaviconService, "fetchFavicon">>;
  let contactLookup: jest.Mocked<Pick<PayeeContactLookupService, "lookup">>;
  let contactEnrichment: jest.Mocked<
    Pick<PayeeContactEnrichmentService, "dispatchAfterCreate">
  >;

  let backfillSourceCount = 3;

  beforeEach(async () => {
    backfillSourceCount = 3;
    faviconService = { fetchFavicon: jest.fn().mockResolvedValue(null) };
    contactLookup = {
      lookup: jest
        .fn()
        .mockResolvedValue({ reason: "disabled", suggestion: null }),
    };
    contactEnrichment = { dispatchAfterCreate: jest.fn() };
    (getActiveScopedManager as jest.Mock).mockReturnValue(undefined);
    queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      having: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    };

    payeesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      create: jest
        .fn()
        .mockImplementation((data) => ({ ...data, id: "new-payee" })),
      remove: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
      createQueryBuilder: jest.fn(() => ({ ...queryBuilderMock })),
      // The uncategorized-count backfill helper queries through the entity
      // manager; default it to an empty result set.
      manager: {
        createQueryBuilder: jest.fn(() => ({ ...queryBuilderMock })),
      } as any,
    };

    transactionsRepository = {
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    };

    scheduledTransactionsRepository = {
      update: jest.fn(),
    };

    categoryQueryBuilderMock = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    };

    categoriesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => categoryQueryBuilderMock),
    };

    preferencesRepository = {
      findOne: jest
        .fn()
        .mockResolvedValue({ userId, numberFormat: "en-US", language: "en" }),
    };

    const aliasQueryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
      select: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    };

    aliasRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      save: jest.fn().mockImplementation((data) => ({
        id: "alias-new",
        ...data,
      })),
      create: jest
        .fn()
        .mockImplementation((data) => ({ id: "alias-new", ...data })),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({ ...aliasQueryBuilderMock })),
      manager: {
        find: jest.fn().mockResolvedValue([]),
      },
    };

    const { manager, dataSource } = createScopedDbMocks([
      [Payee, payeesRepository],
      [PayeeAlias, aliasRepository],
      [Transaction, transactionsRepository],
      [ScheduledTransaction, scheduledTransactionsRepository],
      [Category, categoriesRepository],
      [UserPreference, preferencesRepository],
    ]);
    mockDataSource = dataSource;
    txManager = manager;
    // The locked scalar read returns the same stored fixture as ownership lookup;
    // it is independent of the separate relation re-fetch sequence.
    txManager.findOne.mockImplementation(
      async (entity: unknown, options: { where: { id: string } }) => {
        if (entity !== Payee) return null;
        for (const result of [
          ...payeesRepository.findOne.mock.results,
        ].reverse()) {
          const value = await result.value;
          if (value?.id === options.where.id) return { ...value };
        }
        return null;
      },
    );

    // Stored cash-only source fixtures for the locked metadata writer.
    txManager.query.mockImplementation((sql: string, args?: unknown[]) => {
      if (sql.includes('payee_id AS "payeeId"')) {
        return Promise.resolve(
          (args?.[1] as string[]).flatMap((payeeId) =>
            Array.from({ length: backfillSourceCount }, (_, index) => ({
              id: `${payeeId}-tx-${index}`,
              payeeId,
            })),
          ),
        );
      }
      if (sql.includes("FROM payees p") && sql.includes("id=ANY"))
        return Promise.resolve(
          (args?.[1] as string[]).map((id) => ({
            id,
            snapshot: JSON.stringify({ id }),
          })),
        );
      if (sql.includes("FROM categories WHERE user_id=$1 AND id=ANY"))
        return Promise.resolve((args?.[1] as string[]).map((id) => ({ id })));
      if (sql.includes("SELECT id,to_jsonb(t)::text"))
        return Promise.resolve(
          (args?.[1] as string[]).map((id) => ({
            id,
            snapshot: JSON.stringify({ id }),
          })),
        );
      if (
        sql.includes(
          "SELECT id FROM transactions WHERE user_id=$1 AND payee_id=ANY",
        )
      )
        return Promise.resolve(
          (args?.[1] as string[]).flatMap((payeeId) =>
            Array.from({ length: 3 }, (_, index) => ({
              id: `${payeeId}-tx-${index}`,
            })),
          ),
        );
      if (sql.includes("FROM payees p"))
        return Promise.resolve([
          { defaultCategoryId: null, snapshot: "stored payee fixture" },
        ]);
      if (sql.includes("SELECT id FROM categories"))
        return Promise.resolve([{ id: args?.[0] }]);
      if (sql.includes("to_jsonb(t)::text AS snapshot"))
        return Promise.resolve(
          (args?.[1] as string[]).map((id) => ({
            id,
            categoryId: null,
            isSplit: false,
            isTransfer: false,
            status: "UNRECONCILED",
            snapshot: JSON.stringify({ id }),
          })),
        );
      if (sql.includes('SELECT id,is_split AS "isSplit",status'))
        return Promise.resolve(
          (args?.[1] as string[]).map((id) => ({
            id,
            isSplit: false,
            status: "UNRECONCILED",
          })),
        );
      if (sql.includes("FROM scheduled_transactions st"))
        return Promise.resolve([]);
      if (sql.includes("FROM accrual_schedules")) return Promise.resolve([]);
      return Promise.resolve([]);
    });

    txManager.find.mockResolvedValue([]);
    txManager.update.mockResolvedValue({ affected: 0 });
    txManager.create.mockImplementation((_, data) => data);
    txManager.save.mockImplementation((data) => data);
    txManager.createQueryBuilder.mockImplementation(() => ({
      ...queryBuilderMock,
      getOne: jest.fn().mockResolvedValue(null),
    }));
    // Transaction-block tests address the manager through this legacy alias;
    // savepoint SQL (insertPayeeAliasIgnoringDuplicate) also runs through the
    // manager's query() now.
    mockQueryRunner = { manager: txManager, query: txManager.query };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayeesService,
        { provide: DataSource, useValue: mockDataSource },
        {
          provide: ActionHistoryService,
          useValue: { record: jest.fn().mockResolvedValue(null) },
        },
        { provide: FaviconService, useValue: faviconService },
        { provide: PayeeContactLookupService, useValue: contactLookup },
        { provide: PayeeContactEnrichmentService, useValue: contactEnrichment },
      ],
    }).compile();

    service = module.get<PayeesService>(PayeesService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  // ─── contact lookup on create / preview ──────────────────────────────

  describe("create: background contact lookup", () => {
    const suggestion = {
      website: "https://acme.example",
      address: "1 Main St",
      email: "hi@acme.example",
      phone: "+1 206 448 8762",
      label: null,
      source: "ai-web-search" as const,
      confidence: "high" as const,
      notes: null,
      refined: [],
    };

    beforeEach(() => {
      payeesRepository.findOne.mockResolvedValue(null);
    });

    it("dispatches after the create's transaction resolved and history was recorded", async () => {
      const order: string[] = [];
      (withScopedDb as jest.Mock).mockImplementationOnce(
        async (_ds: unknown, fn: (m: unknown) => Promise<unknown>) => {
          order.push("tx-start");
          const result = await fn(txManager);
          order.push("tx-end");
          return result;
        },
      );
      payeesRepository.save.mockImplementation((data) => {
        order.push("save");
        return data;
      });
      contactEnrichment.dispatchAfterCreate.mockImplementation(() => {
        order.push("dispatch");
      });

      await service.create(userId, { name: "Acme" });

      expect(order).toEqual(["tx-start", "save", "tx-end", "dispatch"]);
      expect(contactEnrichment.dispatchAfterCreate).toHaveBeenCalledWith(
        userId,
        "new-payee",
        "Acme",
        undefined,
      );
    });

    it("carries a note into the background lookup as context", async () => {
      await service.create(userId, {
        name: "Acme",
        notes: "the Dundas branch",
      });

      expect(contactEnrichment.dispatchAfterCreate).toHaveBeenCalledWith(
        userId,
        "new-payee",
        "Acme",
        { notes: "the Dundas branch" },
      );
    });

    it("does not dispatch when the caller will offer the lookup itself", async () => {
      // The transaction page's quick-create runs the lookup and shows the
      // confirmation dialogue. A background write here would pay for a second
      // lookup and store values before the user has seen them.
      await service.create(
        userId,
        { name: "Acme" },
        {
          deferContactLookup: true,
        },
      );

      expect(contactEnrichment.dispatchAfterCreate).not.toHaveBeenCalled();
    });

    it.each([
      ["website", { website: "acme.example" }],
      ["address", { address: "1 Main St" }],
      ["email", { email: "hi@acme.example" }],
      ["phone", { phone: "+1 206 448 8762" }],
    ])("does not dispatch when %s was supplied", async (_field, extra) => {
      await service.create(userId, { name: "Acme", ...extra });

      expect(contactEnrichment.dispatchAfterCreate).not.toHaveBeenCalled();
    });

    it("does not dispatch when the preview already looked up, and stores that stamp", async () => {
      const attemptedAt = new Date("2026-09-02T10:00:00Z");

      await service.create(
        userId,
        { name: "Acme" },
        { contactLookup: { source: "ai-web-search", attemptedAt } },
      );

      expect(contactEnrichment.dispatchAfterCreate).not.toHaveBeenCalled();
      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contactLookupAt: attemptedAt,
          contactLookupSource: "ai-web-search",
        }),
      );
    });

    it("stores a found-nothing stamp with a null source", async () => {
      const attemptedAt = new Date("2026-09-02T10:00:00Z");

      await service.create(
        userId,
        { name: "Acme" },
        { contactLookup: { source: null, attemptedAt } },
      );

      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contactLookupAt: attemptedAt,
          contactLookupSource: null,
        }),
      );
    });

    it("does not dispatch inside an ambient transaction, where the row is not yet visible", async () => {
      (getActiveScopedManager as jest.Mock).mockReturnValue(txManager);

      await service.create(userId, { name: "Acme" });

      expect(contactEnrichment.dispatchAfterCreate).not.toHaveBeenCalled();
    });

    it("leaves the stamp columns alone on a plain create", async () => {
      await service.create(userId, { name: "Acme" });

      const created = payeesRepository.create.mock.calls[0][0];
      expect(created).not.toHaveProperty("contactLookupAt");
      expect(created).not.toHaveProperty("contactLookupSource");
    });

    describe("previewCreate", () => {
      it("does not look up unless asked", async () => {
        await service.previewCreate(userId, { name: "Acme" });

        expect(contactLookup.lookup).not.toHaveBeenCalled();
      });

      it("does not look up when the row carries any contact detail", async () => {
        await service.previewCreate(
          userId,
          { name: "Acme", email: "hi@acme.example" },
          { lookupContact: true },
        );

        expect(contactLookup.lookup).not.toHaveBeenCalled();
      });

      it("merges a found suggestion and returns the stamp the commit will store", async () => {
        contactLookup.lookup.mockResolvedValue({
          reason: "ok",
          suggestions: [suggestion],
        });

        const preview = await service.previewCreate(
          userId,
          { name: "Acme" },
          { lookupContact: true },
        );

        expect(contactLookup.lookup).toHaveBeenCalledWith(userId, {
          name: "Acme",
        });
        expect(preview).toMatchObject({
          name: "Acme",
          website: "https://acme.example",
          address: "1 Main St",
          email: "hi@acme.example",
          phone: "+1 206 448 8762",
          contactLookup: {
            source: "ai-web-search",
            attemptedAt: expect.any(Date),
          },
        });
      });

      it("returns a null-source stamp when the lookup answered with nothing", async () => {
        contactLookup.lookup.mockResolvedValue({
          reason: "none",
          suggestions: [],
        });

        const preview = await service.previewCreate(
          userId,
          { name: "Acme" },
          { lookupContact: true },
        );

        expect(preview.contactLookup).toEqual({
          source: null,
          attemptedAt: expect.any(Date),
        });
        expect(preview.website).toBeUndefined();
      });

      it.each(["disabled", "no_provider", "failed"] as const)(
        "returns no stamp for %s, so the commit may still look up in the background",
        async (reason) => {
          contactLookup.lookup.mockResolvedValue({ reason, suggestions: [] });

          const preview = await service.previewCreate(
            userId,
            { name: "Acme" },
            { lookupContact: true },
          );

          expect(preview).not.toHaveProperty("contactLookup");
        },
      );

      it("previewCreatePayee passes the option through", async () => {
        contactLookup.lookup.mockResolvedValue({
          reason: "ok",
          suggestions: [suggestion],
        });

        const preview = await service.previewCreatePayee(
          userId,
          { name: "Acme" },
          { lookupContact: true },
        );

        expect(preview.contactLookup?.source).toBe("ai-web-search");
      });
    });
  });

  // ─── lookupContactForPayee ───────────────────────────────────────────

  describe("lookupContactForPayee", () => {
    it("looks the stored payee up with its own details as context, and writes nothing", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        name: "Acme",
        address: "Toronto",
        notes: "the Dundas branch",
      });
      const outcome = {
        reason: "ok" as const,
        suggestions: [
          {
            label: null,
            website: "https://acme.example",
            address: null,
            email: null,
            phone: null,
            source: "ai-web-search" as const,
            confidence: "high" as const,
            notes: null,
            refined: [],
          },
        ] as ContactLookupSuggestions,
      };
      contactLookup.lookup.mockResolvedValue(outcome);

      await expect(
        service.lookupContactForPayee(userId, "payee-1"),
      ).resolves.toBe(outcome);
      expect(contactLookup.lookup).toHaveBeenCalledWith(
        userId,
        {
          name: "Acme",
          known: { address: "Toronto", notes: "the Dundas branch" },
        },
        { ignorePreference: true },
      );
      // The detail screen's button proposes; the user's confirmation is an
      // ordinary update, so nothing here touches the row.
      expect(payeesRepository.save).not.toHaveBeenCalled();
      expect(txManager.query).not.toHaveBeenCalled();
    });

    it("throws NotFound for a payee the caller does not own", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.lookupContactForPayee(userId, "payee-1"),
      ).rejects.toThrow(NotFoundException);
      expect(contactLookup.lookup).not.toHaveBeenCalled();
    });
  });

  // ─── create ──────────────────────────────────────────────────────────

  describe("create", () => {
    it("should create a payee successfully", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      const dto = { name: "NewPayee", defaultCategoryId: "cat-1" };
      const result = await service.create(userId, dto);

      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { userId, name: "NewPayee" },
      });
      expect(payeesRepository.create).toHaveBeenCalledWith({
        ...dto,
        website: null,
        address: null,
        email: null,
        phone: null,
        userId,
      });
      expect(payeesRepository.save).toHaveBeenCalled();
      expect(result).toMatchObject({ name: "NewPayee", userId });
    });

    it("should throw ConflictException when payee name already exists", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await expect(
        service.create(userId, { name: "Starbucks" }),
      ).rejects.toThrow(ConflictException);
    });

    it("stores a schemeless website as https", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      await service.create(userId, {
        name: "Starbucks",
        website: "starbucks.com",
      });

      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ website: "https://starbucks.com" }),
      );
    });

    it("keeps an explicit http website rather than upgrading it", async () => {
      // Someone who typed http:// usually did so for a host that serves
      // nothing else; upgrading them yields a link that fails to connect.
      payeesRepository.findOne.mockResolvedValue(null);
      await service.create(userId, {
        name: "Corner Shop",
        website: "http://corner.example",
      });

      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ website: "http://corner.example" }),
      );
    });

    it("should create a payee without optional fields", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      const dto = { name: "MinimalPayee" };
      await service.create(userId, dto);

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "MinimalPayee",
        website: null,
        address: null,
        email: null,
        phone: null,
        userId,
      });
    });
  });

  // ─── getLlmPayees ────────────────────────────────────────────────────

  describe("getLlmPayees", () => {
    /** Four payees whose fields differ in exactly what the filters test. */
    const roster = [
      {
        ...mockPayee,
        id: "p-amazon",
        name: "Amazon",
        website: "https://amazon.com",
        hasLogo: true,
        address: "1 Main St",
        email: null,
        phone: null,
        isActive: true,
        defaultCategoryId: "cat-1",
      },
      {
        ...mockPayee,
        id: "p-zellers",
        name: "Zellers",
        website: null,
        hasLogo: false,
        address: null,
        email: "hi@zellers.test",
        phone: "555",
        isActive: true,
        defaultCategoryId: null,
      },
      {
        ...mockPayee,
        id: "p-corner",
        name: "corner shop",
        website: null,
        hasLogo: false,
        address: null,
        email: null,
        phone: null,
        isActive: true,
        defaultCategoryId: null,
      },
      {
        ...mockPayee,
        id: "p-old",
        name: "Old Amazonian Books",
        website: null,
        hasLogo: false,
        address: null,
        email: null,
        phone: null,
        isActive: true,
        defaultCategoryId: null,
      },
    ];

    const stats: Record<string, { count: number; lastUsed: string | null }> = {
      "p-amazon": { count: 12, lastUsed: "2026-08-01" },
      "p-zellers": { count: 3, lastUsed: "2026-01-05" },
      "p-corner": { count: 40, lastUsed: null },
      "p-old": { count: 1, lastUsed: "2026-09-01" },
    };

    beforeEach(() => {
      payeesRepository.find.mockResolvedValue(roster);
      payeesRepository.createQueryBuilder.mockReturnValue({
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue(
          roster.map((p) => ({
            id: p.id,
            count: String(stats[p.id].count),
            last_used_date: stats[p.id].lastUsed,
          })),
        ),
      });
    });

    const names = (result: { payees: { name: string }[] }) =>
      result.payees.map((p) => p.name);

    it("matches a name substring without regard to case", async () => {
      // The defect: `search` used SQL LIKE, which Postgres evaluates
      // case-sensitively, so a lowercase query matched nothing and the tool
      // looked as though it accepted only exact names.
      const lower = await service.getLlmPayees(userId, { search: "amazon" });
      const upper = await service.getLlmPayees(userId, { search: "AMAZON" });

      expect(names(lower)).toEqual(["Amazon", "Old Amazonian Books"]);
      expect(names(upper)).toEqual(names(lower));
    });

    it("matches inside the name, not only at its start", async () => {
      const result = await service.getLlmPayees(userId, { search: "shop" });
      expect(names(result)).toEqual(["corner shop"]);
    });

    it("sorts by name case-insensitively by default", async () => {
      const result = await service.getLlmPayees(userId);
      expect(names(result)).toEqual([
        "Amazon",
        "corner shop",
        "Old Amazonian Books",
        "Zellers",
      ]);
    });

    it("sorts by transaction count, busiest first", async () => {
      const result = await service.getLlmPayees(userId, {
        sortBy: "transactionCount",
      });
      expect(names(result)).toEqual([
        "corner shop",
        "Amazon",
        "Zellers",
        "Old Amazonian Books",
      ]);
    });

    it("sorts by last used, most recent first, and puts a never-used payee last", async () => {
      // Never used is unknown, not oldest: a null date must not sort as if it
      // were the beginning of time.
      const result = await service.getLlmPayees(userId, { sortBy: "lastUsed" });
      expect(names(result)).toEqual([
        "Old Amazonian Books",
        "Amazon",
        "Zellers",
        "corner shop",
      ]);
    });

    it("keeps only payees carrying a detail, or only those missing it", async () => {
      const withEmail = await service.getLlmPayees(userId, { hasEmail: true });
      const withoutEmail = await service.getLlmPayees(userId, {
        hasEmail: false,
      });

      expect(names(withEmail)).toEqual(["Zellers"]);
      expect(names(withoutEmail)).toEqual([
        "Amazon",
        "corner shop",
        "Old Amazonian Books",
      ]);
    });

    it("filters on every detail a payee can carry", async () => {
      expect(
        names(await service.getLlmPayees(userId, { hasWebsite: true })),
      ).toEqual(["Amazon"]);
      expect(
        names(await service.getLlmPayees(userId, { hasLogo: true })),
      ).toEqual(["Amazon"]);
      expect(
        names(await service.getLlmPayees(userId, { hasAddress: true })),
      ).toEqual(["Amazon"]);
      expect(
        names(await service.getLlmPayees(userId, { hasPhone: true })),
      ).toEqual(["Zellers"]);
      expect(
        names(await service.getLlmPayees(userId, { hasDefaultCategory: true })),
      ).toEqual(["Amazon"]);
    });

    it("hands the model a phone in the form a person reads", async () => {
      // A model quotes these rows back to the reader, so the same number must
      // not read "+12064488762" in the assistant and "+1 206 448 8762" on the
      // payee page. The stored form is how the column compares two numbers; it
      // is not an answer to "what is their number?".
      payeesRepository.find.mockResolvedValue([
        { ...roster[0], phone: "+12064488762" },
      ]);

      const result = await service.getLlmPayees(userId);

      expect(result.payees[0].phone).toBe("+1 206 448 8762");
    });

    it("passes a legacy value through rather than blanking it", async () => {
      // Rows written before normalization are not backfilled, and a stored
      // "call the shop" is worth quoting even though nobody can dial it.
      payeesRepository.find.mockResolvedValue([
        { ...roster[0], phone: "call the shop" },
      ]);

      const result = await service.getLlmPayees(userId);

      expect(result.payees[0].phone).toBe("call the shop");
    });

    it("leaves a payee with no phone holding null, not an empty string", async () => {
      // Absent is not blank: `hasPhone: false` and every consumer downstream
      // read this as "there is no number", and "" is a number-shaped nothing.
      const result = await service.getLlmPayees(userId);

      expect(result.payees.find((p) => p.name === "Amazon")?.phone).toBeNull();
    });

    it("combines filters with the search", async () => {
      const result = await service.getLlmPayees(userId, {
        search: "amazon",
        hasWebsite: false,
      });
      expect(names(result)).toEqual(["Old Amazonian Books"]);
    });

    it("reports a truncated list as a page of the matches, not as all of them", async () => {
      const result = await service.getLlmPayees(userId, { limit: 2 });

      expect(result.payees).toHaveLength(2);
      expect(result.totalCount).toBe(4);
      expect(result.truncated).toBe(true);
    });

    it("counts what matched, not what the user owns", async () => {
      const result = await service.getLlmPayees(userId, {
        search: "amazon",
        limit: 5,
      });

      expect(result.totalCount).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it("asks findAll for the status it was given", async () => {
      await service.getLlmPayees(userId, { status: "inactive" });
      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: false }),
        }),
      );
    });
  });

  // ─── findAll ─────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return payees with transaction counts", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee, mockPayeeNoCategory]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          { id: "payee-1", count: "5" },
          { id: "payee-2", count: "3" },
        ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: "payee-1", transactionCount: 5 });
      expect(result[1]).toMatchObject({ id: "payee-2", transactionCount: 3 });
    });

    it("should return empty array when no payees exist", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
      expect(payeesRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should default transactionCount to 0 for payees without transactions", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0].transactionCount).toBe(0);
      expect(result[0].uncategorizedCount).toBe(0);
    });

    it("should include each payee's uncategorized transaction count", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee, mockPayeeNoCategory]);
      payeesRepository.createQueryBuilder.mockReturnValue({
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      });
      // The backfill-scope count query runs through the transaction manager.
      txManager.createQueryBuilder.mockReturnValue({
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payeeId: "payee-2", cnt: "4" }]),
      });

      const result = await service.findAll(userId);

      expect(result[0].uncategorizedCount).toBe(0);
      expect(result[1]).toMatchObject({
        id: "payee-2",
        uncategorizedCount: 4,
      });
    });
  });

  // ─── findOne ─────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return a payee with defaultCategory", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findOne(userId, "payee-1");

      expect(result).toEqual(mockPayee);
      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "payee-1", userId },
        relations: ["defaultCategory"],
      });
    });

    it("should throw NotFoundException when payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── search ──────────────────────────────────────────────────────────

  describe("search", () => {
    it("should search payees with ILIKE pattern", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.search(userId, "star");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId }),
          take: 10,
        }),
      );
    });

    it("should respect custom limit", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.search(userId, "test", 5);

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });

    it("should return empty array when no matches found", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.search(userId, "zzz");

      expect(result).toEqual([]);
    });
  });

  // ─── autocomplete ────────────────────────────────────────────────────

  describe("autocomplete", () => {
    it("should return payees matching prefix", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.autocomplete(userId, "Star");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 10,
          relations: ["defaultCategory"],
          order: { name: "ASC" },
        }),
      );
    });

    it("should return empty array when no prefix matches", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.autocomplete(userId, "zzz");

      expect(result).toEqual([]);
    });
  });

  // ─── findByName ──────────────────────────────────────────────────────

  describe("findByName", () => {
    it("should return a payee by exact name match", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findByName(userId, "Starbucks");

      expect(result).toEqual(mockPayee);
      expect(payeesRepository.findOne).toHaveBeenCalledWith({
        where: { userId, name: "Starbucks" },
        relations: ["defaultCategory"],
      });
    });

    it("should return null when payee not found", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      const result = await service.findByName(userId, "Unknown");

      expect(result).toBeNull();
    });
  });

  // ─── findOrCreate ────────────────────────────────────────────────────

  describe("findOrCreate", () => {
    it("should return existing payee if found by name", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const result = await service.findOrCreate(userId, "Starbucks");

      expect(result).toEqual(mockPayee);
      // Should not call create when found
      expect(payeesRepository.create).not.toHaveBeenCalled();
    });

    it("should create a new payee if not found", async () => {
      // First call: findByName returns null; second call: duplicate check returns null
      payeesRepository.findOne.mockResolvedValue(null);

      await service.findOrCreate(userId, "NewPlace", "cat-2");

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "NewPlace",
        defaultCategoryId: "cat-2",
        website: null,
        address: null,
        email: null,
        phone: null,
        userId,
      });
      expect(payeesRepository.save).toHaveBeenCalled();
    });

    it("should create without defaultCategoryId when not provided", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await service.findOrCreate(userId, "NewPlace");

      expect(payeesRepository.create).toHaveBeenCalledWith({
        name: "NewPlace",
        defaultCategoryId: undefined,
        website: null,
        address: null,
        email: null,
        phone: null,
        userId,
      });
    });
  });

  // ─── update ──────────────────────────────────────────────────────────

  describe("update", () => {
    /**
     * The two findOne calls an update makes when the name is unchanged: the
     * ownership check and the re-fetch afterwards. The name-conflict lookup in
     * between only runs when the name actually changes.
     */
    function mockUpdateLookups(payee = mockPayee) {
      payeesRepository.findOne
        .mockResolvedValueOnce({ ...payee })
        .mockResolvedValueOnce({ ...payee });
    }

    it("normalises a website on the way in", async () => {
      mockUpdateLookups();
      await service.update(userId, "payee-1", { website: "starbucks.com" });

      // Giving a payee an address it did not have is a change, so the brand
      // icon is resolved alongside it (see the "brand favicon" block).
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        expect.objectContaining({ website: "https://starbucks.com" }),
      );
    });

    it("clears the website when the form sends an emptied field", async () => {
      // react-hook-form gives "" for an input the user cleared, not null, so
      // reading only null would leave the old address in place.
      mockUpdateLookups();
      await service.update(userId, "payee-1", { website: "" });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { website: null },
      );
    });

    it("leaves the website alone when the field is absent", async () => {
      mockUpdateLookups();
      await service.update(userId, "payee-1", { notes: "just notes" });

      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { notes: "just notes" },
      );
    });

    it("should update payee properties", async () => {
      const existingPayee = { ...mockPayee };
      const refreshedPayee = {
        ...mockPayee,
        name: "New Name",
        notes: "Updated notes",
      };
      // First findOne: ownership check; second: name conflict check; third: re-fetch after save
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        name: "New Name",
        notes: "Updated notes",
      });

      expect(result.name).toBe("New Name");
      expect(result.notes).toBe("Updated notes");
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { name: "New Name", notes: "Updated notes" },
      );
    });

    it("should throw NotFoundException when payee not found", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, "nonexistent", { name: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw ConflictException when new name already exists", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce({ id: "payee-other", name: "Taken Name" });

      await expect(
        service.update(userId, "payee-1", { name: "Taken Name" }),
      ).rejects.toThrow(ConflictException);
    });

    it("should cascade name change to transactions and scheduled transactions", async () => {
      const existingPayee = { ...mockPayee, name: "OldName" };
      const refreshedPayee = { ...mockPayee, name: "NewName" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(refreshedPayee);

      await service.update(userId, "payee-1", { name: "NewName" });

      const manager = mockQueryRunner.manager;
      expect(manager.update).toHaveBeenCalledWith(
        Transaction,
        {
          payeeId: "payee-1",
          userId,
          id: In(["payee-1-tx-0", "payee-1-tx-1", "payee-1-tx-2"]),
        },
        { payeeName: "NewName" },
      );
      expect(manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        { payeeId: "payee-1", userId },
        { payeeName: "NewName" },
      );
    });

    it("should not cascade when name is not changed", async () => {
      const existingPayee = { ...mockPayee };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      await service.update(userId, "payee-1", { notes: "Just updating notes" });

      // The payee row itself is updated, but the name-change cascade to
      // transactions and scheduled transactions must not run.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { notes: "Just updating notes" },
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
        expect.anything(),
      );
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        ScheduledTransaction,
        expect.anything(),
        expect.anything(),
      );
    });

    it("should skip name conflict check when name is unchanged", async () => {
      const existingPayee = { ...mockPayee };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      await service.update(userId, "payee-1", { name: "Starbucks" });

      // findOne called twice: once for ownership check, once for re-fetch; no conflict check
      expect(payeesRepository.findOne).toHaveBeenCalledTimes(2);
    });

    it("applies the new default category to uncategorized transactions when requested", async () => {
      backfillSourceCount = 4;
      const existingPayee = {
        ...mockPayee,
        defaultCategoryId: null,
        defaultCategory: null,
      };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: "cat-99" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 4 });

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: "cat-99",
        applyCategoryToTransactions: "uncategorized",
      });

      expect(result.transactionsCategorized).toBe(4);
      // The resolver freezes uncategorized ordinary rows; the update uses
      // exactly those IDs, excluding transfers and split parents.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        {
          userId,
          payeeId: "payee-1",
          id: In(
            Array.from({ length: 4 }, (_, index) => `payee-1-tx-${index}`),
          ),
          isTransfer: false,
          isSplit: false,
        },
        { categoryId: "cat-99" },
      );
    });

    it("applies the new default category to all transactions when requested", async () => {
      backfillSourceCount = 9;
      const existingPayee = {
        ...mockPayee,
        defaultCategoryId: null,
        defaultCategory: null,
      };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: "cat-99" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 9 });

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: "cat-99",
        applyCategoryToTransactions: "all",
      });

      expect(result.transactionsCategorized).toBe(9);
      // "all" writes the complete locked ordinary-row selection.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        {
          userId,
          payeeId: "payee-1",
          id: In(
            Array.from({ length: 9 }, (_, index) => `payee-1-tx-${index}`),
          ),
          isTransfer: false,
          isSplit: false,
        },
        { categoryId: "cat-99" },
      );
    });

    it("does not touch transactions when no apply mode is given", async () => {
      const existingPayee = {
        ...mockPayee,
        defaultCategoryId: null,
        defaultCategory: null,
      };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: "cat-99" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: "cat-99",
      });

      expect(result.transactionsCategorized).toBe(0);
      // The payee row is updated, but no backfill runs against transactions.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
        expect.anything(),
      );
    });

    it("does not apply a category when the payee ends up without one", async () => {
      const existingPayee = { ...mockPayee };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: null };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: null,
        applyCategoryToTransactions: "all",
      });

      expect(result.transactionsCategorized).toBe(0);
      // Clearing the category writes null to the payee but runs no backfill.
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
        expect.anything(),
      );
    });

    it("should update defaultCategoryId via explicit mapping", async () => {
      // Existing payee already has a loaded relation pointing at the old
      // category -- this is the scenario that exposed the persistence bug.
      const existingPayee = {
        ...mockPayee,
        defaultCategoryId: "cat-1",
        defaultCategory: { id: "cat-1", name: "Food" },
      };
      const refreshedPayee = { ...mockPayee, defaultCategoryId: "cat-99" };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: "cat-99",
      });

      expect(result.defaultCategoryId).toBe("cat-99");
      // Persist with a column-level update keyed by id+userId so the FK is
      // written from the scalar. save() on the loaded entity would re-derive
      // the FK from its hydrated defaultCategory relation and clobber it.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { defaultCategoryId: "cat-99" },
      );
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("should clear defaultCategoryId when set to null", async () => {
      const existingPayee = {
        ...mockPayee,
        defaultCategory: { id: "cat-1", name: "Food" },
      };
      const refreshedPayee = {
        ...mockPayee,
        defaultCategoryId: null,
        defaultCategory: null,
      };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        defaultCategoryId: null,
      });

      expect(result.defaultCategoryId).toBeNull();
      // Clearing writes null to the FK column directly.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { defaultCategoryId: null },
      );
    });
  });

  // ─── remove ──────────────────────────────────────────────────────────

  describe("remove", () => {
    it("should remove a payee after ownership verification", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await service.remove(userId, "payee-1");

      expect(payeesRepository.remove).toHaveBeenCalledWith(mockPayee);
    });

    it("should throw NotFoundException when payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── getMostUsed ─────────────────────────────────────────────────────

  describe("getMostUsed", () => {
    it("should return most used payees ordered by transaction count", async () => {
      queryBuilderMock.getMany.mockResolvedValue([mockPayee]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.getMostUsed(userId);

      expect(result).toEqual([mockPayee]);
      expect(queryBuilderMock.leftJoinAndSelect).toHaveBeenCalled();
      expect(queryBuilderMock.leftJoin).toHaveBeenCalled();
      expect(queryBuilderMock.where).toHaveBeenCalled();
      expect(queryBuilderMock.groupBy).toHaveBeenCalled();
      expect(queryBuilderMock.orderBy).toHaveBeenCalled();
      expect(queryBuilderMock.limit).toHaveBeenCalledWith(10);
    });

    it("should respect custom limit parameter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getMostUsed(userId, 5);

      expect(queryBuilderMock.limit).toHaveBeenCalledWith(5);
    });
  });

  // ─── getRecentlyUsed ────────────────────────────────────────────────

  describe("getRecentlyUsed", () => {
    it("should return recently used payees ordered by most recent transaction date", async () => {
      queryBuilderMock.getMany.mockResolvedValue([mockPayee]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.getRecentlyUsed(userId);

      expect(result).toEqual([mockPayee]);
      expect(queryBuilderMock.orderBy).toHaveBeenCalled();
      expect(queryBuilderMock.limit).toHaveBeenCalledWith(10);
    });

    it("should respect custom limit parameter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getRecentlyUsed(userId, 3);

      expect(queryBuilderMock.limit).toHaveBeenCalledWith(3);
    });
  });

  // ─── getSummary ──────────────────────────────────────────────────────

  describe("getSummary", () => {
    it("should return counts of total, with category, without category, active, and inactive", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(10) // totalPayees
        .mockResolvedValueOnce(6) // payeesWithCategory
        .mockResolvedValueOnce(8); // activePayees

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 10,
        payeesWithCategory: 6,
        payeesWithoutCategory: 4,
        activePayees: 8,
        inactivePayees: 2,
      });
    });

    it("should return all zeros when no payees exist", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0);

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 0,
        payeesWithCategory: 0,
        payeesWithoutCategory: 0,
        activePayees: 0,
        inactivePayees: 0,
      });
    });

    it("should handle all payees having categories", async () => {
      payeesRepository.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(5);

      const result = await service.getSummary(userId);

      expect(result).toEqual({
        totalPayees: 5,
        payeesWithCategory: 5,
        payeesWithoutCategory: 0,
        activePayees: 5,
        inactivePayees: 0,
      });
    });
  });

  // ─── findByCategory ──────────────────────────────────────────────────

  describe("findByCategory", () => {
    it("should return payees with the given default category", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);

      const result = await service.findByCategory(userId, "cat-1");

      expect(result).toEqual([mockPayee]);
      expect(payeesRepository.find).toHaveBeenCalledWith({
        where: { userId, defaultCategoryId: "cat-1" },
        relations: ["defaultCategory"],
        order: { name: "ASC" },
      });
    });

    it("should return empty array when no payees match category", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.findByCategory(userId, "cat-unknown");

      expect(result).toEqual([]);
    });
  });

  // ─── calculateCategorySuggestions ────────────────────────────────────

  describe("calculateCategorySuggestions", () => {
    it("should return suggestions for payees meeting thresholds", async () => {
      // Query 1: category usage per payee
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-shopping",
            category_name: "Shopping",
            category_count: "8",
          },
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-electronics",
            category_name: "Electronics",
            category_count: "2",
          },
        ]),
      };

      // Query 2: total counts per payee
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-2", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);

      // Query 3: payees with categories (for current category map)
      payeesRepository.find.mockResolvedValue([mockPayeeNoCategory]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        payeeId: "payee-2",
        payeeName: "Amazon",
        suggestedCategoryId: "cat-shopping",
        suggestedCategoryName: "Shopping",
        transactionCount: 10,
        categoryCount: 8,
        percentage: 80,
      });
    });

    it("should skip payees below minimum transaction threshold", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "3",
          },
        ]),
      };

      // Total count is below minTransactions threshold
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 10, 50);

      expect(result).toHaveLength(0);
    });

    it("should skip payees below minimum percentage threshold", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "3",
          },
          {
            payee_id: "payee-2",
            payee_name: "Amazon",
            current_category_id: null,
            category_id: "cat-2",
            category_name: "Electronics",
            category_count: "7",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-2", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      // minPercentage = 80, but top category is 70% (7/10)
      const result = await service.calculateCategorySuggestions(userId, 5, 80);

      expect(result).toHaveLength(0);
    });

    it("should skip payees that already have the suggested category assigned", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-1",
            payee_name: "Starbucks",
            current_category_id: "cat-1",
            category_id: "cat-1",
            category_name: "Food & Drink",
            category_count: "10",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-1", total_count: "10" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([
        {
          ...mockPayee,
          defaultCategoryId: "cat-1",
          defaultCategory: { id: "cat-1", name: "Food & Drink" },
        },
      ]);

      const result = await service.calculateCategorySuggestions(
        userId,
        5,
        50,
        false,
      );

      expect(result).toHaveLength(0);
    });

    it("should include current category info for payees that have one", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-1",
            payee_name: "Starbucks",
            current_category_id: "cat-1",
            category_id: "cat-new",
            category_name: "Coffee",
            category_count: "15",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([{ payee_id: "payee-1", total_count: "15" }]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([
        {
          ...mockPayee,
          defaultCategoryId: "cat-1",
          defaultCategory: { id: "cat-1", name: "Food & Drink" },
        },
      ]);

      const result = await service.calculateCategorySuggestions(
        userId,
        5,
        50,
        false,
      );

      expect(result).toHaveLength(1);
      expect(result[0].currentCategoryId).toBe("cat-1");
      expect(result[0].currentCategoryName).toBe("Food & Drink");
      expect(result[0].suggestedCategoryId).toBe("cat-new");
    });

    it("should return empty array when no category usage data exists", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toEqual([]);
    });

    it("should sort suggestions by payee name", async () => {
      const qb1 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          {
            payee_id: "payee-z",
            payee_name: "Zebra Store",
            current_category_id: null,
            category_id: "cat-1",
            category_name: "Shopping",
            category_count: "10",
          },
          {
            payee_id: "payee-a",
            payee_name: "Apple Store",
            current_category_id: null,
            category_id: "cat-2",
            category_name: "Tech",
            category_count: "8",
          },
        ]),
      };

      const qb2 = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([
          { payee_id: "payee-z", total_count: "10" },
          { payee_id: "payee-a", total_count: "8" },
        ]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.calculateCategorySuggestions(userId, 5, 50);

      expect(result).toHaveLength(2);
      expect(result[0].payeeName).toBe("Apple Store");
      expect(result[1].payeeName).toBe("Zebra Store");
    });

    it("should add onlyWithoutCategory filter when flag is true", async () => {
      const qb1: Record<string, jest.Mock> = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      const qb2: Record<string, jest.Mock> = {
        ...queryBuilderMock,
        getRawMany: jest.fn().mockResolvedValue([]),
      };

      payeesRepository.createQueryBuilder
        .mockReturnValueOnce(qb1)
        .mockReturnValueOnce(qb2);
      payeesRepository.find.mockResolvedValue([]);

      await service.calculateCategorySuggestions(userId, 5, 50, true);

      // Both query builders should have andWhere called with the null check
      expect(qb1.andWhere).toHaveBeenCalledWith(
        "payee.default_category_id IS NULL",
      );
      expect(qb2.andWhere).toHaveBeenCalledWith(
        "payee.default_category_id IS NULL",
      );
    });
  });

  // ─── applyCategorySuggestions ────────────────────────────────────────

  describe("applyCategorySuggestions", () => {
    it("should bulk update payee categories and return count", async () => {
      mockQueryRunner.manager.find.mockResolvedValue([
        { ...mockPayeeNoCategory },
        { ...mockPayee },
      ]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-food" },
        { id: "cat-coffee" },
      ]);

      const assignments = [
        { payeeId: "payee-2", categoryId: "cat-food" },
        { payeeId: "payee-1", categoryId: "cat-coffee" },
      ];

      const result = await service.applyCategorySuggestions(
        userId,
        assignments,
      );

      expect(result).toEqual({ updated: 2, transactionsBackfilled: 0 });
      expect(mockQueryRunner.manager.update).toHaveBeenCalledTimes(2);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-2", userId },
        { defaultCategoryId: "cat-food" },
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { defaultCategoryId: "cat-coffee" },
      );
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should skip assignments for payees not belonging to user", async () => {
      // Batch find only returns payees belonging to the user (not "other-user-payee")
      mockQueryRunner.manager.find.mockResolvedValue([{ ...mockPayee }]);
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-1" },
        { id: "cat-2" },
      ]);

      const assignments = [
        { payeeId: "other-user-payee", categoryId: "cat-1" },
        { payeeId: "payee-1", categoryId: "cat-2" },
      ];

      const result = await service.applyCategorySuggestions(
        userId,
        assignments,
      );

      expect(result).toEqual({ updated: 1, transactionsBackfilled: 0 });
      expect(mockQueryRunner.manager.update).toHaveBeenCalledTimes(1);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { defaultCategoryId: "cat-2" },
      );
    });

    it("should return zero updated when no valid assignments", async () => {
      // Batch find returns empty: no payees match the requested IDs for this user
      mockQueryRunner.manager.find.mockResolvedValue([]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-1" }]);

      const result = await service.applyCategorySuggestions(userId, [
        { payeeId: "bad-1", categoryId: "cat-1" },
      ]);

      expect(result).toEqual({ updated: 0, transactionsBackfilled: 0 });
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("should handle empty assignments array", async () => {
      mockQueryRunner.manager.find.mockResolvedValue([]);

      const result = await service.applyCategorySuggestions(userId, []);

      expect(result).toEqual({ updated: 0, transactionsBackfilled: 0 });
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("writes the scalar default without saving a hydrated payee relation", async () => {
      const payee = { ...mockPayeeNoCategory, defaultCategoryId: null };
      mockQueryRunner.manager.find.mockResolvedValue([payee]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-new" }]);

      await service.applyCategorySuggestions(userId, [
        { payeeId: "payee-2", categoryId: "cat-new" },
      ]);

      expect(payee.defaultCategoryId).toBeNull();
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-2", userId },
        { defaultCategoryId: "cat-new" },
      );
      expect(mockQueryRunner.manager.save).not.toHaveBeenCalled();
    });

    it("should backfill uncategorized transactions when requested and report the count", async () => {
      const payee = { ...mockPayeeNoCategory, defaultCategoryId: null };
      mockQueryRunner.manager.find.mockResolvedValue([payee]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-new" }]);
      // The backfill update reports three rows affected.
      mockQueryRunner.manager.update.mockResolvedValue({ affected: 3 });

      const result = await service.applyCategorySuggestions(userId, [
        {
          payeeId: "payee-2",
          categoryId: "cat-new",
          backfillTransactions: true,
        },
      ]);

      expect(result).toEqual({ updated: 1, transactionsBackfilled: 3 });
      // The transaction update is scoped to the payee with no existing category.
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Transaction,
        expect.objectContaining({
          userId,
          payeeId: "payee-2",
          isTransfer: false,
          isSplit: false,
        }),
        { categoryId: "cat-new" },
      );
    });

    it("should not backfill transactions when the flag is omitted", async () => {
      const payee = { ...mockPayeeNoCategory, defaultCategoryId: null };
      mockQueryRunner.manager.find.mockResolvedValue([payee]);
      categoriesRepository.find.mockResolvedValue([{ id: "cat-new" }]);

      const result = await service.applyCategorySuggestions(userId, [
        { payeeId: "payee-2", categoryId: "cat-new" },
      ]);

      expect(result).toEqual({ updated: 1, transactionsBackfilled: 0 });
      expect(mockQueryRunner.manager.update).not.toHaveBeenCalledWith(
        Transaction,
        expect.anything(),
        expect.anything(),
      );
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-2", userId },
        { defaultCategoryId: "cat-new" },
      );
    });

    it("should roll back when the category ownership check fails", async () => {
      // No owned categories returned -> invalid category id -> throws.
      categoriesRepository.find.mockResolvedValue([]);

      await expect(
        service.applyCategorySuggestions(userId, [
          { payeeId: "payee-2", categoryId: "not-mine" },
        ]),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── findAll with status filter ───────────────────────────────────

  describe("findAll with status filter", () => {
    it("should filter by active status when status is 'active'", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "5", last_used_date: "2025-01-15" },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      await service.findAll(userId, "active");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, isActive: true },
        }),
      );
    });

    it("should filter by inactive status when status is 'inactive'", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.findAll(userId, "inactive");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, isActive: false },
        }),
      );
    });

    it("should not filter by isActive when status is 'all'", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.findAll(userId, "all");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId },
        }),
      );
    });

    it("should include lastUsedDate in results", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "5", last_used_date: "2025-06-15" },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0]).toMatchObject({
        id: "payee-1",
        transactionCount: 5,
        lastUsedDate: "2025-06-15",
      });
    });

    it("should return null lastUsedDate for payees without transactions", async () => {
      payeesRepository.find.mockResolvedValue([mockPayee]);
      const qb = {
        ...queryBuilderMock,
        getRawMany: jest
          .fn()
          .mockResolvedValue([
            { id: "payee-1", count: "0", last_used_date: null },
          ]),
      };
      payeesRepository.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll(userId);

      expect(result[0].lastUsedDate).toBeNull();
    });
  });

  // ─── findInactiveByName ────────────────────────────────────────────

  describe("findInactiveByName", () => {
    it("should find an inactive payee by case-insensitive name", async () => {
      const inactivePayee = { ...mockPayee, isActive: false };
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(inactivePayee);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.findInactiveByName(userId, "starbucks");

      expect(result).toEqual(inactivePayee);
      expect(queryBuilderMock.where).toHaveBeenCalledWith(
        "payee.user_id = :userId",
        { userId },
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = false",
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "LOWER(payee.name) = LOWER(:name)",
        { name: "starbucks" },
      );
    });

    it("should return null when no inactive match found", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.findInactiveByName(userId, "Unknown");

      expect(result).toBeNull();
    });
  });

  // ─── resolveByName ─────────────────────────────────────────────────

  describe("resolveByName", () => {
    it("matches an existing payee by case-insensitive name", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(mockPayee);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.resolveByName(userId, "  starbucks ");

      expect(result).toEqual(mockPayee);
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "LOWER(payee.name) = LOWER(:name)",
        { name: "starbucks" },
      );
      // Direct name match short-circuits the alias lookup.
      expect(txManager.find).not.toHaveBeenCalled();
    });

    it("falls back to alias matching when no name matches", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([{ alias: "SBUX*", payee: mockPayee }]);

      const result = await service.resolveByName(userId, "SBUX #123");

      expect(result).toEqual(mockPayee);
    });

    it("returns null when neither name nor alias matches", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);
      payeesRepository.find.mockResolvedValue([
        { ...mockPayee, name: "Amazon" },
      ]);

      const result = await service.resolveByName(userId, "Unknown Vendor");

      expect(result).toBeNull();
    });

    it("matches a single active payee by partial name (abbreviation)", async () => {
      const fullPayee = { ...mockPayee, name: "Buon Gusto Restaurant" };
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);
      payeesRepository.find.mockResolvedValue([
        fullPayee,
        { ...mockPayee, id: "payee-z", name: "Amazon" },
      ]);

      const result = await service.resolveByName(userId, "Buon Gusto");

      expect(result).toEqual(fullPayee);
      expect(payeesRepository.find).toHaveBeenCalledWith({
        where: { userId, isActive: true },
        relations: ["defaultCategory"],
      });
    });

    it("matches across apostrophe differences (Zehrs -> Zehr's Supermarket)", async () => {
      const zehrs = { ...mockPayee, name: "Zehr's Supermarket" };
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);
      payeesRepository.find.mockResolvedValue([zehrs]);

      const result = await service.resolveByName(userId, "Zehrs");

      expect(result).toEqual(zehrs);
    });

    it("prefers an exact normalized match over a longer sibling", async () => {
      const exact = { ...mockPayee, name: "Zehr's Supermarket" };
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);
      payeesRepository.find.mockResolvedValue([
        exact,
        { ...mockPayee, id: "payee-y", name: "Zehr's Supermarket Pharmacy" },
      ]);

      const result = await service.resolveByName(userId, "Zehrs Supermarket");

      expect(result).toEqual(exact);
    });

    it("does not guess when multiple payees match a partial name", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);
      payeesRepository.find.mockResolvedValue([
        { ...mockPayee, name: "Buon Gusto Restaurant" },
        { ...mockPayee, id: "payee-x", name: "Buon Gusto Pizzeria" },
      ]);

      const result = await service.resolveByName(userId, "Buon Gusto");

      expect(result).toBeNull();
    });

    it("does not partial-match input shorter than 3 characters", async () => {
      queryBuilderMock.getOne = jest.fn().mockResolvedValue(null);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);
      txManager.find.mockResolvedValue([]);

      const result = await service.resolveByName(userId, "AB");

      expect(result).toBeNull();
      // A 2-char term must not even scan the payee list.
      expect(payeesRepository.find).not.toHaveBeenCalled();
    });

    it("returns null for a blank name without querying", async () => {
      const result = await service.resolveByName(userId, "   ");

      expect(result).toBeNull();
      expect(payeesRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  // ─── previewDeactivation ──────────────────────────────────────────

  describe("previewDeactivation", () => {
    it("should return payees matching deactivation criteria", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([
        {
          payee_id: "payee-1",
          payee_name: "Old Store",
          transaction_count: "2",
          last_used_date: "2024-01-01",
          default_category_name: "Shopping",
        },
      ]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 5, 12);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        payeeId: "payee-1",
        payeeName: "Old Store",
        transactionCount: 2,
        lastUsedDate: "2024-01-01",
        defaultCategoryName: "Shopping",
      });
    });

    it("should return payees that were never used", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([
        {
          payee_id: "payee-2",
          payee_name: "Never Used",
          transaction_count: "0",
          last_used_date: null,
          default_category_name: null,
        },
      ]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 3, 6);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        transactionCount: 0,
        lastUsedDate: null,
        defaultCategoryName: null,
      });
    });

    it("should return empty array when no payees match criteria", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      const result = await service.previewDeactivation(userId, 0, 1);

      expect(result).toEqual([]);
    });

    it("should only consider active payees", async () => {
      queryBuilderMock.andHaving = jest.fn().mockReturnThis();
      queryBuilderMock.getRawMany = jest.fn().mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.previewDeactivation(userId, 5, 12);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  // ─── deactivatePayees ─────────────────────────────────────────────

  describe("deactivatePayees", () => {
    it("should bulk deactivate payees and return count", async () => {
      const payee1 = { ...mockPayee, isActive: true };
      const payee2 = { ...mockPayeeNoCategory, isActive: true };
      payeesRepository.find.mockResolvedValue([payee1, payee2]);

      const result = await service.deactivatePayees(userId, [
        "payee-1",
        "payee-2",
      ]);

      expect(result).toEqual({ deactivated: 2 });
      expect(payee1.isActive).toBe(false);
      expect(payee2.isActive).toBe(false);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: "payee-1", isActive: false }),
          expect.objectContaining({ id: "payee-2", isActive: false }),
        ]),
      );
    });

    it("should handle empty payeeIds array", async () => {
      const result = await service.deactivatePayees(userId, []);

      expect(result).toEqual({ deactivated: 0 });
      expect(payeesRepository.find).not.toHaveBeenCalled();
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should skip payees not belonging to user", async () => {
      payeesRepository.find.mockResolvedValue([{ ...mockPayee }]);

      const result = await service.deactivatePayees(userId, [
        "payee-1",
        "other-user-payee",
      ]);

      expect(result).toEqual({ deactivated: 1 });
    });

    it("should only deactivate currently active payees", async () => {
      payeesRepository.find.mockResolvedValue([]);

      const result = await service.deactivatePayees(userId, [
        "already-inactive",
      ]);

      expect(result).toEqual({ deactivated: 0 });
      expect(payeesRepository.find).toHaveBeenCalledWith({
        where: expect.objectContaining({ isActive: true }),
      });
    });

    it("should deduplicate payee IDs", async () => {
      payeesRepository.find.mockResolvedValue([{ ...mockPayee }]);

      await service.deactivatePayees(userId, ["payee-1", "payee-1", "payee-1"]);

      // Should only query for unique IDs
      const findCall = payeesRepository.find.mock.calls[0][0];
      expect(findCall.where.id).toBeDefined();
    });
  });

  // ─── reactivatePayee ──────────────────────────────────────────────

  describe("reactivatePayee", () => {
    it("should reactivate an inactive payee", async () => {
      const inactivePayee = { ...mockPayee, isActive: false };
      payeesRepository.findOne.mockResolvedValue(inactivePayee);

      const result = await service.reactivatePayee(userId, "payee-1");

      expect(inactivePayee.isActive).toBe(true);
      expect(payeesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: "payee-1", isActive: true }),
      );
      expect(result.isActive).toBe(true);
    });

    it("should return payee unchanged if already active", async () => {
      const activePayee = { ...mockPayee, isActive: true };
      payeesRepository.findOne.mockResolvedValue(activePayee);

      const result = await service.reactivatePayee(userId, "payee-1");

      expect(result.isActive).toBe(true);
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("should throw NotFoundException for non-existent payee", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.reactivatePayee(userId, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── update with isActive ─────────────────────────────────────────

  describe("update with isActive", () => {
    it("should update isActive field via update DTO", async () => {
      const existingPayee = { ...mockPayee, isActive: true };
      const refreshedPayee = { ...mockPayee, isActive: false };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(refreshedPayee);

      const result = await service.update(userId, "payee-1", {
        isActive: false,
      });

      expect(result.isActive).toBe(false);
      expect(mockQueryRunner.manager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        { isActive: false },
      );
    });

    it("should not modify isActive when not included in DTO", async () => {
      const existingPayee = { ...mockPayee, isActive: true };
      payeesRepository.findOne
        .mockResolvedValueOnce(existingPayee)
        .mockResolvedValueOnce(existingPayee);

      const result = await service.update(userId, "payee-1", {
        notes: "Updated",
      });

      expect(result.isActive).toBe(true);
    });
  });

  // ─── search and autocomplete filter active ────────────────────────

  describe("search filters active payees", () => {
    it("should include isActive: true in search query", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.search(userId, "test");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe("autocomplete filters active payees", () => {
    it("should include isActive: true in autocomplete query", async () => {
      payeesRepository.find.mockResolvedValue([]);

      await service.autocomplete(userId, "test");

      expect(payeesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isActive: true }),
        }),
      );
    });
  });

  describe("getMostUsed filters active payees", () => {
    it("should include is_active = true filter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getMostUsed(userId);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  describe("getRecentlyUsed filters active payees", () => {
    it("should include is_active = true filter", async () => {
      queryBuilderMock.getMany.mockResolvedValue([]);
      payeesRepository.createQueryBuilder.mockReturnValue(queryBuilderMock);

      await service.getRecentlyUsed(userId);

      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "payee.is_active = true",
      );
    });
  });

  // ─── Alias Methods ─────────────────────────────────────────────────

  describe("getAliases", () => {
    it("should return aliases for a specific payee", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);
      const mockAliases = [
        { id: "a1", payeeId: "payee-1", userId, alias: "STARBUCKS*" },
      ];
      aliasRepository.find.mockResolvedValue(mockAliases);

      const result = await service.getAliases(userId, "payee-1");

      expect(result).toEqual(mockAliases);
      expect(aliasRepository.find).toHaveBeenCalledWith({
        where: { payeeId: "payee-1", userId },
        order: { alias: "ASC" },
      });
    });

    it("should throw NotFoundException if payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(service.getAliases(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getAllAliases", () => {
    it("should return all aliases for the user", async () => {
      const mockAliases = [
        { id: "a1", payeeId: "payee-1", userId, alias: "STARBUCKS*" },
        { id: "a2", payeeId: "payee-2", userId, alias: "AMZN*" },
      ];
      aliasRepository.find.mockResolvedValue(mockAliases);

      const result = await service.getAllAliases(userId);

      expect(result).toEqual(mockAliases);
      expect(aliasRepository.find).toHaveBeenCalledWith({
        where: { userId },
        relations: ["payee"],
        order: { alias: "ASC" },
      });
    });
  });

  describe("createAlias", () => {
    it("should create an alias successfully", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);
      aliasRepository.find.mockResolvedValue([]);

      await service.createAlias(userId, {
        payeeId: "payee-1",
        alias: "STARBUCKS #*",
      });

      expect(aliasRepository.create).toHaveBeenCalledWith({
        payeeId: "payee-1",
        userId,
        alias: "STARBUCKS #*",
      });
      expect(aliasRepository.save).toHaveBeenCalled();
    });

    it("should throw BadRequestException for empty alias", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      await expect(
        service.createAlias(userId, { payeeId: "payee-1", alias: "   " }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw ConflictException for exact duplicate alias", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          id: "a1",
          alias: "STARBUCKS",
          payee: { name: "Starbucks" },
        }),
      };
      aliasRepository.createQueryBuilder.mockReturnValue(qbMock);

      await expect(
        service.createAlias(userId, {
          payeeId: "payee-1",
          alias: "starbucks",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw ConflictException for overlapping wildcard patterns", async () => {
      payeesRepository.findOne.mockResolvedValue(mockPayee);

      // No exact match
      const qbMock = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      aliasRepository.createQueryBuilder.mockReturnValue(qbMock);

      // Return existing alias with overlapping wildcard
      aliasRepository.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STAR*",
          payee: { name: "Starbucks" },
        },
      ]);

      await expect(
        service.createAlias(userId, {
          payeeId: "payee-2",
          alias: "STARBUCKS #123",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("should throw NotFoundException if payee does not exist", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createAlias(userId, {
          payeeId: "nonexistent",
          alias: "TEST",
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("removeAlias", () => {
    it("should remove an alias successfully", async () => {
      const mockAlias = { id: "a1", payeeId: "payee-1", userId, alias: "TEST" };
      aliasRepository.findOne.mockResolvedValue(mockAlias);

      await service.removeAlias(userId, "a1");

      expect(aliasRepository.remove).toHaveBeenCalledWith(mockAlias);
    });

    it("should throw NotFoundException if alias does not exist", async () => {
      aliasRepository.findOne.mockResolvedValue(null);

      await expect(service.removeAlias(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("findPayeeByAlias", () => {
    it("should find a payee by matching alias pattern", async () => {
      const matchedPayee = { ...mockPayee };
      txManager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STARBUCKS*",
          payee: matchedPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "STARBUCKS #12345");

      expect(result).toEqual(matchedPayee);
    });

    it("should return null when no alias matches", async () => {
      txManager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "STARBUCKS*",
          payee: mockPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "WALMART");

      expect(result).toBeNull();
    });

    it("should match case-insensitively", async () => {
      txManager.find.mockResolvedValue([
        {
          id: "a1",
          alias: "starbucks*",
          payee: mockPayee,
        },
      ]);

      const result = await service.findPayeeByAlias(userId, "STARBUCKS #999");

      expect(result).toEqual(mockPayee);
    });
  });

  // ─── Merge ──────────────────────────────────────────────────────────

  describe("mergePayees", () => {
    it("should merge payees successfully", async () => {
      const sourcePayee = {
        ...mockPayeeNoCategory,
        id: "payee-2",
        name: "Amazon",
      };
      const targetPayee = { ...mockPayee, id: "payee-1", name: "Starbucks" };

      // findOne will be called twice: once for target, once for source
      payeesRepository.findOne
        .mockResolvedValueOnce(targetPayee)
        .mockResolvedValueOnce(sourcePayee);

      const queryRunner = mockQueryRunner;
      queryRunner.manager.update.mockResolvedValue({ affected: 3 });

      const result = await service.mergePayees(userId, {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: true,
      });

      expect(result.transactionsMigrated).toBe(3);
      expect(result.aliasAdded).toBe(true);
      expect(result.sourcePayeeDeleted).toBe(true);
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should throw BadRequestException when merging payee into itself", async () => {
      await expect(
        service.mergePayees(userId, {
          targetPayeeId: "payee-1",
          sourcePayeeId: "payee-1",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("should rollback transaction on error", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce(mockPayeeNoCategory);

      const queryRunner = mockQueryRunner;
      queryRunner.manager.update.mockRejectedValue(new Error("DB error"));

      await expect(
        service.mergePayees(userId, {
          targetPayeeId: "payee-1",
          sourcePayeeId: "payee-2",
        }),
      ).rejects.toThrow("DB error");

      expect(mockDataSource.transaction).toHaveBeenCalled();
    });

    it("should skip alias creation when addAsAlias is false", async () => {
      payeesRepository.findOne
        .mockResolvedValueOnce(mockPayee)
        .mockResolvedValueOnce(mockPayeeNoCategory);

      const queryRunner = mockQueryRunner;
      queryRunner.manager.update.mockResolvedValue({ affected: 0 });

      const result = await service.mergePayees(userId, {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: false,
      });

      expect(result.aliasAdded).toBe(false);
    });

    it("still merges (skips the alias) when the alias races a duplicate constraint", async () => {
      const sourcePayee = {
        ...mockPayeeNoCategory,
        id: "payee-2",
        name: "Amazon",
      };
      const targetPayee = { ...mockPayee, id: "payee-1", name: "Starbucks" };
      payeesRepository.findOne
        .mockResolvedValueOnce(targetPayee)
        .mockResolvedValueOnce(sourcePayee);

      const queryRunner = mockQueryRunner;
      queryRunner.manager.update.mockResolvedValue({ affected: 3 });
      // The alias insert loses a race to a concurrent merge: the DB rejects it
      // with the UNIQUE(user_id, LOWER(alias)) violation. It must be swallowed
      // (savepoint rollback) so the merge itself still commits.
      queryRunner.manager.save.mockRejectedValueOnce(
        new QueryFailedError("insert", undefined, {
          code: "23505",
        } as unknown as Error),
      );

      const result = await service.mergePayees(userId, {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: true,
      });

      expect(result.aliasAdded).toBe(false);
      expect(result.transactionsMigrated).toBe(3);
      expect(result.sourcePayeeDeleted).toBe(true);
      expect(queryRunner.query).toHaveBeenCalledWith(
        "ROLLBACK TO SAVEPOINT merge_payee_alias",
      );
      expect(mockDataSource.transaction).toHaveBeenCalled();
    });
  });

  describe("previewCreate", () => {
    it("resolves the default category and returns a preview without persisting", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      categoriesRepository.findOne.mockResolvedValue({
        id: "cat-1",
        userId,
        name: "Dining",
      });

      const preview = await service.previewCreate(userId, {
        name: "Acme <b>",
        defaultCategoryId: "cat-1",
      });

      expect(preview.name).not.toContain("<");
      expect(preview).toMatchObject({
        defaultCategoryId: "cat-1",
        defaultCategoryName: "Dining",
      });
      expect(payeesRepository.save).not.toHaveBeenCalled();
    });

    it("rejects a duplicate payee name", async () => {
      payeesRepository.findOne.mockResolvedValue({ id: "p1", name: "Acme" });
      await expect(
        service.previewCreate(userId, { name: "Acme" }),
      ).rejects.toThrow();
    });

    it("rejects an unowned default category", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      categoriesRepository.findOne.mockResolvedValue(null);
      await expect(
        service.previewCreate(userId, {
          name: "Acme",
          defaultCategoryId: "cat-x",
        }),
      ).rejects.toThrow();
    });
  });

  describe("manage payee previews", () => {
    it("previewCreatePayee resolves the category by name", async () => {
      payeesRepository.findOne.mockResolvedValue(null); // no duplicate
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-9", name: "Utilities", parentId: null },
      ]);
      // previewCreate re-validates the resolved category id by primary key.
      categoriesRepository.findOne.mockResolvedValue({
        id: "cat-9",
        name: "Utilities",
      });

      const preview = await service.previewCreatePayee(userId, {
        name: "Hydro",
        categoryName: "Utilities",
      });

      expect(preview).toEqual({
        name: "Hydro",
        defaultCategoryId: "cat-9",
        defaultCategoryName: "Utilities",
      });
    });

    it("previewUpdatePayee renames and resolves a new category", async () => {
      payeesRepository.findOne.mockImplementation(
        async ({ where }: { where: { name: string } }) =>
          where.name === "Old"
            ? {
                id: "p1",
                name: "Old",
                defaultCategoryId: null,
                defaultCategory: null,
              }
            : null,
      );
      categoriesRepository.find.mockResolvedValue([
        { id: "cat-2", name: "Bills", parentId: null },
      ]);

      const preview = await service.previewUpdatePayee(userId, {
        name: "Old",
        newName: "New",
        categoryName: "Bills",
      });

      expect(preview).toEqual({
        payeeId: "p1",
        name: "New",
        defaultCategoryId: "cat-2",
        defaultCategoryName: "Bills",
      });
    });

    it("previewUpdatePayee rejects a rename that collides with another payee", async () => {
      payeesRepository.findOne.mockImplementation(
        async ({ where }: { where: { name: string } }) =>
          where.name === "Old"
            ? { id: "p1", name: "Old", defaultCategoryId: null }
            : { id: "p2", name: "Taken" },
      );

      await expect(
        service.previewUpdatePayee(userId, { name: "Old", newName: "Taken" }),
      ).rejects.toThrow();
    });

    it("previewUpdatePayee clears the category for an empty categoryName", async () => {
      payeesRepository.findOne.mockResolvedValue({
        id: "p1",
        name: "Old",
        defaultCategoryId: "cat-1",
        defaultCategory: { id: "cat-1", name: "Food" },
      });

      const preview = await service.previewUpdatePayee(userId, {
        name: "Old",
        categoryName: "",
      });

      expect(preview.defaultCategoryId).toBeNull();
      expect(preview.defaultCategoryName).toBeNull();
    });

    it("previewDeletePayee throws when the payee is not found", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      await expect(
        service.previewDeletePayee(userId, { name: "Ghost" }),
      ).rejects.toThrow();
    });

    it("previewCreatePayee throws when the category name is unknown", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      categoriesRepository.find.mockResolvedValue([]);
      await expect(
        service.previewCreatePayee(userId, {
          name: "Hydro",
          categoryName: "Nonexistent",
        }),
      ).rejects.toThrow();
    });

    describe("two categories sharing a leaf name", () => {
      const duplicateLeaf = [
        { id: "bills", name: "Bills", parentId: null },
        { id: "bills-cell", name: "Cell Phone", parentId: "bills" },
        { id: "biz", name: "Business", parentId: null },
        { id: "biz-cell", name: "Cell Phone", parentId: "biz" },
      ];

      beforeEach(() => {
        payeesRepository.findOne.mockResolvedValue(null);
        categoriesRepository.find.mockResolvedValue(duplicateLeaf);
      });

      it("resolves the parent the caller named", async () => {
        categoriesRepository.findOne.mockResolvedValue({
          id: "biz-cell",
          name: "Cell Phone",
        });

        const preview = await service.previewCreatePayee(userId, {
          name: "Rogers",
          categoryName: "Business: Cell Phone",
        });

        // The spelling the tool descriptions ask for used to miss the
        // qualified lookup and fall through to the other parent's category.
        expect(preview.defaultCategoryId).toBe("biz-cell");
        expect(preview.defaultCategoryName).toBe("Business: Cell Phone");
      });

      it("refuses the bare leaf rather than picking one", async () => {
        await expect(
          service.previewCreatePayee(userId, {
            name: "Rogers",
            categoryName: "Cell Phone",
          }),
        ).rejects.toThrow();
      });
    });
  });
  // ─── contact information ─────────────────────────────────────────────

  describe("contact information", () => {
    describe("create", () => {
      it("stores the contact fields", async () => {
        payeesRepository.findOne.mockResolvedValue(null);

        await service.create(userId, {
          name: "Starbucks",
          address: "1912 Pike Pl, Seattle",
          email: "hello@starbucks.com",
          phone: "+1 206-448-8762",
        } as any);

        expect(payeesRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({
            address: "1912 Pike Pl, Seattle",
            email: "hello@starbucks.com",
            // Stored in the one canonical form, whichever shape was typed.
            phone: "+12064488762",
          }),
        );
      });

      it("places a number written without a country code in the caller's region", async () => {
        // The user stated no country code, so the region their preferences
        // imply is what decides -- not a guess, and not the raw string.
        payeesRepository.findOne.mockResolvedValue(null);
        preferencesRepository.findOne.mockResolvedValue({
          userId,
          numberFormat: "en-GB",
          language: "en",
        });

        await service.create(userId, {
          name: "Acme",
          phone: "020 7946 0958",
        } as any);

        expect(payeesRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ phone: "+442079460958" }),
        );
      });

      it("keeps an extension, in the one form a parser can read back", async () => {
        payeesRepository.findOne.mockResolvedValue(null);

        await service.create(userId, {
          name: "Acme",
          phone: "+44 20 7946 0958 ext. 12",
        } as any);

        expect(payeesRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ phone: "+442079460958;ext=12" }),
        );
      });

      it("refuses a number it cannot read, and writes nothing", async () => {
        payeesRepository.findOne.mockResolvedValue(null);

        await expect(
          service.create(userId, { name: "Acme", phone: "12345" } as any),
        ).rejects.toBeInstanceOf(BadRequestException);
        // The refusal has to precede the write, or a 400 would be describing a
        // row that exists.
        expect(payeesRepository.create).not.toHaveBeenCalled();
        expect(txManager.save).not.toHaveBeenCalled();
      });

      it("asks for a country code when it cannot place a bare number", async () => {
        payeesRepository.findOne.mockResolvedValue(null);
        preferencesRepository.findOne.mockResolvedValue({
          userId,
          numberFormat: "browser",
          language: "en",
        });

        await expect(
          service.create(userId, {
            name: "Acme",
            phone: "020 7946 0958",
          } as any),
        ).rejects.toThrow(/country code/i);
      });

      it("does not read the caller's region when there is no number to place", async () => {
        // A region is one more query and most payees carry no phone at all.
        payeesRepository.findOne.mockResolvedValue(null);

        await service.create(userId, { name: "Acme" } as any);

        expect(preferencesRepository.findOne).not.toHaveBeenCalled();
      });

      it("stores a blank contact field as null rather than an empty string", async () => {
        // "has an address" must not read true for a payee with none, or the
        // detail page renders an empty row and a link to nowhere.
        payeesRepository.findOne.mockResolvedValue(null);

        await service.create(userId, {
          name: "Cash",
          address: "   ",
          email: "",
          phone: "",
        } as any);

        expect(payeesRepository.create).toHaveBeenCalledWith(
          expect.objectContaining({ address: null, email: null, phone: null }),
        );
      });
    });

    describe("update", () => {
      it("stores a changed address", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          address: "1 Old Street",
        });

        await service.update(userId, "payee-1", { address: "2 New Street" });

        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({ address: "2 New Street" }),
        );
      });

      it("normalizes a phone number the edit actually changed", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          phone: "+12064488762",
        });

        await service.update(userId, "payee-1", { phone: "(416) 363-8221" });

        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({ phone: "+14163638221" }),
        );
      });

      it("leaves a legacy number alone when the form resends it unchanged", async () => {
        // Rows written before normalization are not backfilled, and the form
        // resends every field on every save. Validating a value merely PRESENT
        // in the payload would make such a payee impossible to edit at all --
        // the user would be refused over a number they never touched.
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          phone: "call the shop",
        });

        await service.update(userId, "payee-1", {
          notes: "Pay in cash",
          phone: "call the shop",
        });

        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({
            notes: "Pay in cash",
            phone: "call the shop",
          }),
        );
        // ...and it did not even look the region up, since nothing moved.
        expect(preferencesRepository.findOne).not.toHaveBeenCalled();
      });

      it("still refuses an edit that replaces a legacy number with a bad one", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          phone: "call the shop",
        });

        await expect(
          service.update(userId, "payee-1", { phone: "12345" }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(txManager.update).not.toHaveBeenCalled();
      });

      it("clears an emptied address, email and phone", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          address: "1912 Pike Pl",
          email: "hello@example.com",
          phone: "555",
        });

        await service.update(userId, "payee-1", {
          address: "",
          email: "",
          phone: "",
        });

        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({ address: null, email: null, phone: null }),
        );
      });

      it("leaves the contact fields alone when they are absent", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          address: "1912 Pike Pl",
          email: "hello@example.com",
        });

        await service.update(userId, "payee-1", { notes: "Just a note" });

        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.not.objectContaining({ address: expect.anything() }),
        );
      });
    });

    describe("action history", () => {
      it("snapshots the contact fields of a deleted payee", async () => {
        // Undo re-inserts the row from beforeData alone, column by column, so a
        // contact field missing from the snapshot is gone for good.
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          address: "1912 Pike Pl",
          email: "hello@example.com",
          phone: "+1 206-448-8762",
        });

        await service.remove(userId, "payee-1");

        const record = (service as any).actionHistoryService
          .record as jest.Mock;
        const [, params] = record.mock.calls[record.mock.calls.length - 1];
        expect(params.action).toBe("delete");
        expect(params.beforeData).toEqual(
          expect.objectContaining({
            address: "1912 Pike Pl",
            email: "hello@example.com",
            phone: "+1 206-448-8762",
          }),
        );
      });

      it("snapshots the contact fields on both sides of an update", async () => {
        // Undo restores beforeData, so a field missing from it silently
        // survives the undo.
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          address: "1 Old Street",
          email: "old@example.com",
          phone: "111",
        });

        await service.update(userId, "payee-1", { address: "2 New Street" });

        const record = (service as any).actionHistoryService
          .record as jest.Mock;
        const [, params] = record.mock.calls[record.mock.calls.length - 1];
        expect(params.beforeData).toEqual(
          expect.objectContaining({
            address: "1 Old Street",
            email: "old@example.com",
            phone: "111",
          }),
        );
        expect(params.afterData).toEqual(
          expect.objectContaining({
            address: expect.anything(),
            email: expect.anything(),
            phone: expect.anything(),
          }),
        );
      });
    });

    describe("preview", () => {
      it("rejects a malformed email before a card is shown", async () => {
        // A preview has to compute what the commit will do: CreatePayeeDto
        // rejects a bad email, so letting one through here would show the user
        // a card, take their approval, and only then fail the write.
        payeesRepository.findOne.mockResolvedValue(null);

        await expect(
          service.previewCreatePayee(userId, {
            name: "Acme",
            email: "not an email",
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it("carries the contact fields onto the create preview", async () => {
        payeesRepository.findOne.mockResolvedValue(null);

        const preview = await service.previewCreatePayee(userId, {
          name: "Acme",
          address: "  1 Main St  ",
          email: "hi@acme.com",
          phone: " (206) 448-8762 ",
        });

        expect(preview).toEqual(
          expect.objectContaining({
            // Trimmed and normalized here, so the card shows what the commit
            // will store rather than a value the save would then change.
            address: "1 Main St",
            email: "hi@acme.com",
            phone: "+12064488762",
          }),
        );
      });

      it("does not refuse an update preview over a legacy number it resends", async () => {
        // A preview computes what the commit will do, and `update` waives a
        // value that did not move -- so a card must not fail on one either.
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          phone: "call the shop",
        });

        const preview = await service.previewUpdatePayee(userId, {
          name: "Starbucks",
          address: "1 Main St",
          phone: "call the shop",
        });

        expect(preview).toEqual(
          expect.objectContaining({ phone: "call the shop" }),
        );
      });

      it("reads an emptied contact field as a clear, not as absent", async () => {
        payeesRepository.findOne.mockResolvedValue(null);

        const preview = await service.previewCreatePayee(userId, {
          name: "Acme",
          address: "",
        });

        expect(preview.address).toBeNull();
        // A field nobody mentioned stays undefined so the card can tell the
        // two apart.
        expect(preview.phone).toBeUndefined();
      });
    });
  });

  // ─── brand favicon ───────────────────────────────────────────────────

  describe("brand favicon", () => {
    const logo = { data: Buffer.from([1, 2, 3]), contentType: "image/png" };

    it("resolves the favicon for a new payee's website", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      faviconService.fetchFavicon.mockResolvedValue(logo);

      await service.create(userId, {
        name: "Starbucks",
        website: "starbucks.com",
      } as any);

      // The schemeless address the form allows is normalised before it reaches
      // the resolver.
      expect(faviconService.fetchFavicon).toHaveBeenCalledWith(
        "https://starbucks.com",
      );
      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          website: "https://starbucks.com",
          logoData: logo.data,
          logoContentType: "image/png",
          hasLogo: true,
        }),
      );
    });

    it("creates the payee anyway when the favicon cannot be fetched", async () => {
      payeesRepository.findOne.mockResolvedValue(null);
      faviconService.fetchFavicon.mockResolvedValue(null);

      const result = await service.create(userId, {
        name: "Starbucks",
        website: "starbucks.com",
      } as any);

      expect(result).toBeDefined();
      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ hasLogo: false, logoData: null }),
      );
    });

    it("never looks for an icon when the payee has no website", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      await service.create(userId, { name: "Cash" } as any);

      expect(faviconService.fetchFavicon).not.toHaveBeenCalled();
      // Not attempted is not the same as attempted and failed, so the columns
      // are left at their defaults rather than stamped.
      expect(payeesRepository.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ logoFetchedAt: expect.anything() }),
      );
    });

    it("re-resolves the icon when the website changes", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        website: "https://old.example",
      });
      faviconService.fetchFavicon.mockResolvedValue(logo);

      await service.update(userId, "payee-1", { website: "new.example" });

      expect(faviconService.fetchFavicon).toHaveBeenCalledWith(
        "https://new.example",
      );
      expect(txManager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        expect.objectContaining({
          website: "https://new.example",
          logoData: logo.data,
          hasLogo: true,
        }),
      );
    });

    it("leaves a cached icon alone when the form resends the same website", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        website: "https://starbucks.com",
        hasLogo: true,
      });

      await service.update(userId, "payee-1", { website: "starbucks.com" });

      // A re-fetch that failed would clear a perfectly good icon, and the form
      // resends the current address on every save.
      expect(faviconService.fetchFavicon).not.toHaveBeenCalled();
      expect(txManager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        expect.not.objectContaining({ hasLogo: expect.anything() }),
      );
    });

    it("clears the icon when the website is emptied", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        website: "https://starbucks.com",
        hasLogo: true,
      });

      await service.update(userId, "payee-1", { website: "" });

      expect(faviconService.fetchFavicon).not.toHaveBeenCalled();
      expect(txManager.update).toHaveBeenCalledWith(
        Payee,
        { id: "payee-1", userId },
        expect.objectContaining({
          website: null,
          logoData: null,
          hasLogo: false,
        }),
      );
    });

    describe("getLogo", () => {
      // getLogo asks the Payee repository for a builder (it needs addSelect
      // to defeat the entity's `select: false` on the bytes).
      const withLogoQuery = (payee: unknown) => {
        payeesRepository.createQueryBuilder.mockImplementation(() => ({
          ...queryBuilderMock,
          getOne: jest.fn().mockResolvedValue(payee),
        }));
      };

      it("returns the cached bytes", async () => {
        withLogoQuery({
          ...mockPayee,
          hasLogo: true,
          logoData: logo.data,
          logoContentType: "image/png",
        });

        await expect(service.getLogo(userId, "payee-1")).resolves.toEqual({
          data: logo.data,
          contentType: "image/png",
        });
      });

      it("defaults a missing content type to image/png", async () => {
        withLogoQuery({
          ...mockPayee,
          hasLogo: true,
          logoData: logo.data,
          logoContentType: null,
        });

        await expect(service.getLogo(userId, "payee-1")).resolves.toEqual({
          data: logo.data,
          contentType: "image/png",
        });
      });

      it("throws NotFound when the payee does not exist", async () => {
        withLogoQuery(null);

        await expect(service.getLogo(userId, "payee-1")).rejects.toThrow(
          NotFoundException,
        );
      });

      it("throws NotFound when the payee has no cached icon", async () => {
        // The client renders its own fallback badge from this 404.
        withLogoQuery({ ...mockPayee, hasLogo: false, logoData: null });

        await expect(service.getLogo(userId, "payee-1")).rejects.toThrow(
          NotFoundException,
        );
      });
    });

    describe("refreshLogo", () => {
      it("re-fetches for the stored website and persists the result", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          website: "https://starbucks.com",
        });
        faviconService.fetchFavicon.mockResolvedValue(logo);

        await service.refreshLogo(userId, "payee-1");

        expect(faviconService.fetchFavicon).toHaveBeenCalledWith(
          "https://starbucks.com",
        );
        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({ hasLogo: true, logoData: logo.data }),
        );
      });

      it("clears the icon for a payee with no website", async () => {
        payeesRepository.findOne.mockResolvedValue({
          ...mockPayee,
          website: null,
          hasLogo: true,
        });

        await service.refreshLogo(userId, "payee-1");

        expect(faviconService.fetchFavicon).not.toHaveBeenCalled();
        expect(txManager.update).toHaveBeenCalledWith(
          Payee,
          { id: "payee-1", userId },
          expect.objectContaining({ hasLogo: false, logoData: null }),
        );
      });
    });
  });
  describe("preview website (AI/MCP confirmation cards)", () => {
    it("normalises a bare domain so the card shows what will be stored", async () => {
      // A preview computes what the commit will do: the card must not show
      // "acme.com" for a save that writes "https://acme.com".
      payeesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreate(userId, {
        name: "Acme",
        website: "acme.com",
      });

      expect(preview.website).toBe("https://acme.com");
    });

    it("leaves the website undefined when the request said nothing about it", async () => {
      payeesRepository.findOne.mockResolvedValue(null);

      const preview = await service.previewCreate(userId, { name: "Acme" });

      expect(preview.website).toBeUndefined();
    });

    it("previews an edit that clears the website as null", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        website: "https://acme.com",
      });

      const preview = await service.previewUpdatePayee(userId, {
        name: "Starbucks",
        website: "",
      });

      // "" is the clear instruction; null is what the commit will store.
      expect(preview.website).toBeNull();
    });

    it("leaves an edit's website undefined when it was not mentioned", async () => {
      payeesRepository.findOne.mockResolvedValue({
        ...mockPayee,
        website: "https://acme.com",
      });

      // The rename path is exercised elsewhere; here the point is only that
      // an edit which never names the website leaves it untouched.
      const preview = await service.previewUpdatePayee(userId, {
        name: "Starbucks",
      });

      expect(preview.website).toBeUndefined();
    });
  });
});
