jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);
import { Test, TestingModule } from "@nestjs/testing";
import { PayeesController } from "./payees.controller";
import { PayeesService } from "./payees.service";
import { PayeeDetailService } from "./payee-detail.service";
import { PayeeAutoMergeService } from "./payee-auto-merge.service";
import { PayeeContactLookupService } from "./lookup/payee-contact-lookup.service";
import { PayeeContactEnrichmentService } from "./lookup/payee-contact-enrichment.service";
import { DelegationService } from "../delegation/delegation.service";

describe("PayeesController", () => {
  let controller: PayeesController;
  let mockPayeesService: Record<string, jest.Mock>;
  let mockPayeeDetailService: Record<string, jest.Mock>;
  let mockAutoMergeService: Record<string, jest.Mock>;
  let mockContactLookupService: Record<string, jest.Mock>;
  let mockContactEnrichmentService: Record<string, jest.Mock>;
  let mockDelegationService: { readableAccountIds: jest.Mock };
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockContactLookupService = { lookup: jest.fn() };
    mockContactEnrichmentService = { dispatchAfterCreate: jest.fn() };
    mockAutoMergeService = {
      previewAutoMerge: jest.fn(),
      applyAutoMerge: jest.fn(),
      previewCategoryImpact: jest.fn(),
    };
    mockPayeeDetailService = {
      getDetail: jest.fn(),
    };
    mockDelegationService = { readableAccountIds: jest.fn() };
    mockPayeesService = {
      create: jest.fn(),
      findAll: jest.fn(),
      search: jest.fn(),
      autocomplete: jest.fn(),
      getMostUsed: jest.fn(),
      getRecentlyUsed: jest.fn(),
      getSummary: jest.fn(),
      getAllAliases: jest.fn(),
      createAlias: jest.fn(),
      removeAlias: jest.fn(),
      getAliases: jest.fn(),
      mergePayees: jest.fn(),
      calculateCategorySuggestions: jest.fn(),
      applyCategorySuggestions: jest.fn(),
      previewCategorySuggestionsImpact: jest.fn(),
      previewDeactivation: jest.fn(),
      deactivatePayees: jest.fn(),
      reactivatePayee: jest.fn(),
      findInactiveByName: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      previewCategoryImpact: jest.fn(),
      remove: jest.fn(),
      previewRemoval: jest.fn(),
      getLogo: jest.fn(),
      refreshLogo: jest.fn(),
      lookupContactForPayee: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayeesController],
      providers: [
        {
          provide: PayeesService,
          useValue: mockPayeesService,
        },
        {
          provide: PayeeDetailService,
          useValue: mockPayeeDetailService,
        },
        {
          provide: PayeeAutoMergeService,
          useValue: mockAutoMergeService,
        },
        {
          provide: PayeeContactLookupService,
          useValue: mockContactLookupService,
        },
        {
          provide: PayeeContactEnrichmentService,
          useValue: mockContactEnrichmentService,
        },
        { provide: DelegationService, useValue: mockDelegationService },
      ],
    }).compile();

    controller = module.get<PayeesController>(PayeesController);
  });

  it("previews category impact for the authenticated user and exact update payload", async () => {
    const dto = {
      defaultCategoryId: "category-1",
      applyCategoryToTransactions: "all" as const,
    };
    const expected = {
      fingerprint: null,
      transactionIds: [],
      impacts: [],
      categoryId: "category-1",
      mode: "all",
      transactionsCategorized: 0,
    };
    mockPayeesService.previewCategoryImpact.mockResolvedValue(expected);
    expect(
      await controller.previewCategoryImpact(mockReq, "payee-1", dto),
    ).toEqual(expected);
    expect(mockPayeesService.previewCategoryImpact).toHaveBeenCalledWith(
      "user-1",
      "payee-1",
      dto,
    );
  });

  it("forwards both backfill previews and a suggestion confirmation with the authenticated identity", async () => {
    const dto = {
      assignments: [
        { payeeId: "p1", categoryId: "c1", backfillTransactions: true },
      ],
      accrualImpactFingerprint: "a".repeat(64),
    };
    await controller.previewCategorySuggestionsImpact(mockReq, dto);
    expect(
      mockPayeesService.previewCategorySuggestionsImpact,
    ).toHaveBeenCalledWith("user-1", dto.assignments);
    await controller.applyCategorySuggestions(mockReq, dto);
    expect(mockPayeesService.applyCategorySuggestions).toHaveBeenCalledWith(
      "user-1",
      dto.assignments,
      dto.accrualImpactFingerprint,
    );
    const group = {
      canonicalPayeeId: "p1",
      sourcePayeeIds: ["p2"],
      defaultCategoryId: "c1",
      backfillTransactions: true,
    };
    await controller.previewAutoMergeCategoryImpact(mockReq, group);
    expect(mockAutoMergeService.previewCategoryImpact).toHaveBeenCalledWith(
      "user-1",
      group,
    );
  });

  it("forwards reviewed payee deletion using the authenticated owner", async () => {
    await controller.previewRemoval(mockReq, "payee-1");
    expect(mockPayeesService.previewRemoval).toHaveBeenCalledWith(
      "user-1",
      "payee-1",
    );
    const dto = { accrualImpactFingerprint: "a".repeat(64) };
    await controller.remove(mockReq, "payee-1", dto);
    expect(mockPayeesService.remove).toHaveBeenCalledWith(
      "user-1",
      "payee-1",
      dto.accrualImpactFingerprint,
    );
  });

  describe("create()", () => {
    it("delegates to payeesService.create with userId and dto", async () => {
      const dto = { name: "Grocery Store" };
      const expected = { id: "payee-1", name: "Grocery Store" };
      mockPayeesService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.create).toHaveBeenCalledWith("user-1", dto, {
        deferContactLookup: undefined,
      });
    });

    it("passes deferContactLookup as an option, never as a payee field", async () => {
      // It says what the caller will do, not what the payee is: reaching the
      // service's DTO it would be spread onto the entity insert.
      mockPayeesService.create.mockResolvedValue({ id: "payee-1" });

      await controller.create(mockReq, {
        name: "Grocery Store",
        deferContactLookup: true,
      } as any);

      expect(mockPayeesService.create).toHaveBeenCalledWith(
        "user-1",
        { name: "Grocery Store" },
        { deferContactLookup: true },
      );
    });
  });

  describe("findAll()", () => {
    it("delegates to payeesService.findAll with userId and status", async () => {
      const expected = [{ id: "payee-1", name: "Store" }];
      mockPayeesService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq, "active");

      expect(result).toEqual(expected);
      expect(mockPayeesService.findAll).toHaveBeenCalledWith(
        "user-1",
        "active",
      );
    });

    it("delegates to payeesService.findAll with undefined status", async () => {
      const expected = [{ id: "payee-1", name: "Store" }];
      mockPayeesService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockPayeesService.findAll).toHaveBeenCalledWith(
        "user-1",
        undefined,
      );
    });
  });

  describe("search()", () => {
    it("delegates to payeesService.search with userId, query, and limit", async () => {
      const expected = [{ id: "payee-1", name: "Store" }];
      mockPayeesService.search.mockResolvedValue(expected);

      const result = await controller.search(mockReq, "Store", 10);

      expect(result).toEqual(expected);
      expect(mockPayeesService.search).toHaveBeenCalledWith(
        "user-1",
        "Store",
        10,
      );
    });
  });

  describe("autocomplete()", () => {
    it("delegates to payeesService.autocomplete with userId and query", async () => {
      const expected = [{ id: "payee-1", name: "Store" }];
      mockPayeesService.autocomplete.mockResolvedValue(expected);

      const result = await controller.autocomplete(mockReq, "Sto");

      expect(result).toEqual(expected);
      expect(mockPayeesService.autocomplete).toHaveBeenCalledWith(
        "user-1",
        "Sto",
      );
    });
  });

  describe("getMostUsed()", () => {
    it("delegates to payeesService.getMostUsed with userId and limit", async () => {
      const expected = [{ id: "payee-1", name: "Frequent Store" }];
      mockPayeesService.getMostUsed.mockResolvedValue(expected);

      const result = await controller.getMostUsed(mockReq, 10);

      expect(result).toEqual(expected);
      expect(mockPayeesService.getMostUsed).toHaveBeenCalledWith("user-1", 10);
    });
  });

  describe("getRecentlyUsed()", () => {
    it("delegates to payeesService.getRecentlyUsed with userId and limit", async () => {
      const expected = [{ id: "payee-1", name: "Recent Store" }];
      mockPayeesService.getRecentlyUsed.mockResolvedValue(expected);

      const result = await controller.getRecentlyUsed(mockReq, 5);

      expect(result).toEqual(expected);
      expect(mockPayeesService.getRecentlyUsed).toHaveBeenCalledWith(
        "user-1",
        5,
      );
    });
  });

  describe("getSummary()", () => {
    it("delegates to payeesService.getSummary with userId", async () => {
      const expected = { totalPayees: 10, withCategory: 7 };
      mockPayeesService.getSummary.mockResolvedValue(expected);

      const result = await controller.getSummary(mockReq);

      expect(result).toEqual(expected);
      expect(mockPayeesService.getSummary).toHaveBeenCalledWith("user-1");
    });
  });

  describe("getCategorySuggestions()", () => {
    it("delegates to payeesService.calculateCategorySuggestions with parsed parameters", async () => {
      const expected = [{ payeeId: "p1", categoryId: "c1" }];
      mockPayeesService.calculateCategorySuggestions.mockResolvedValue(
        expected,
      );

      const result = await controller.getCategorySuggestions(
        mockReq,
        5,
        75,
        true,
      );

      expect(result).toEqual(expected);
      expect(
        mockPayeesService.calculateCategorySuggestions,
      ).toHaveBeenCalledWith("user-1", 5, 75, true);
    });

    it("passes false for onlyWithoutCategory when false", async () => {
      mockPayeesService.calculateCategorySuggestions.mockResolvedValue([]);

      await controller.getCategorySuggestions(mockReq, 3, 80, false);

      expect(
        mockPayeesService.calculateCategorySuggestions,
      ).toHaveBeenCalledWith("user-1", 3, 80, false);
    });
  });

  describe("applyCategorySuggestions()", () => {
    it("delegates to payeesService.applyCategorySuggestions with userId and assignments", async () => {
      const assignments = [{ payeeId: "p1", categoryId: "c1" }];
      const expected = { applied: 1 };
      mockPayeesService.applyCategorySuggestions.mockResolvedValue(expected);

      const result = await controller.applyCategorySuggestions(mockReq, {
        assignments,
      });

      expect(result).toEqual(expected);
      expect(mockPayeesService.applyCategorySuggestions).toHaveBeenCalledWith(
        "user-1",
        assignments,
      );
    });
  });

  describe("getDetail()", () => {
    it("delegates to payeeDetailService.getDetail with userId and id", async () => {
      const expected = { payee: { id: "payee-1" }, stats: {} };
      mockPayeeDetailService.getDetail.mockResolvedValue(expected);

      const result = await controller.getDetail(mockReq, "payee-1");

      expect(result).toEqual(expected);
      expect(mockPayeeDetailService.getDetail).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
        undefined,
      );
      expect(mockDelegationService.readableAccountIds).not.toHaveBeenCalled();
    });

    it("scopes an acting delegate to their READ-granted accounts", async () => {
      mockPayeeDetailService.getDetail.mockResolvedValue({});
      mockDelegationService.readableAccountIds.mockResolvedValue(["acc-a"]);

      await controller.getDetail(
        { user: { id: "owner-1", isActing: true, delegationId: "g1" } },
        "payee-1",
      );

      expect(mockDelegationService.readableAccountIds).toHaveBeenCalledWith(
        "g1",
      );
      expect(mockPayeeDetailService.getDetail).toHaveBeenCalledWith(
        "owner-1",
        "payee-1",
        ["acc-a"],
      );
    });
  });

  describe("findOne()", () => {
    it("delegates to payeesService.findOne with userId and id", async () => {
      const expected = { id: "payee-1", name: "Store" };
      mockPayeesService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "payee-1");

      expect(result).toEqual(expected);
      expect(mockPayeesService.findOne).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
    });
  });

  describe("update()", () => {
    it("delegates to payeesService.update with userId, id, and dto", async () => {
      const dto = { name: "Updated Store" };
      const expected = { id: "payee-1", name: "Updated Store" };
      mockPayeesService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "payee-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.update).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
        dto,
      );
    });
  });

  describe("remove()", () => {
    it("delegates to payeesService.remove with userId and id", async () => {
      mockPayeesService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "payee-1");

      expect(result).toBeUndefined();
      expect(mockPayeesService.remove).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
    });
  });

  // ─── Deactivation endpoints ───────────────────────────────────────

  describe("previewDeactivation()", () => {
    it("delegates to payeesService.previewDeactivation with userId and params", async () => {
      const expected = [
        {
          payeeId: "p1",
          payeeName: "Old Store",
          transactionCount: 1,
          lastUsedDate: "2023-01-01",
        },
      ];
      mockPayeesService.previewDeactivation.mockResolvedValue(expected);

      const result = await controller.previewDeactivation(mockReq, 5, 12);

      expect(result).toEqual(expected);
      expect(mockPayeesService.previewDeactivation).toHaveBeenCalledWith(
        "user-1",
        5,
        12,
      );
    });

    it("clamps maxTransactions to valid range", async () => {
      mockPayeesService.previewDeactivation.mockResolvedValue([]);

      await controller.previewDeactivation(mockReq, -5, 12);

      expect(mockPayeesService.previewDeactivation).toHaveBeenCalledWith(
        "user-1",
        0,
        12,
      );
    });

    it("clamps monthsUnused to valid range", async () => {
      mockPayeesService.previewDeactivation.mockResolvedValue([]);

      await controller.previewDeactivation(mockReq, 5, 999);

      expect(mockPayeesService.previewDeactivation).toHaveBeenCalledWith(
        "user-1",
        5,
        120,
      );
    });
  });

  describe("deactivatePayees()", () => {
    it("delegates to payeesService.deactivatePayees with userId and payeeIds", async () => {
      const dto = { payeeIds: ["p1", "p2"] };
      const expected = { deactivated: 2 };
      mockPayeesService.deactivatePayees.mockResolvedValue(expected);

      const result = await controller.deactivatePayees(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.deactivatePayees).toHaveBeenCalledWith(
        "user-1",
        ["p1", "p2"],
      );
    });
  });

  describe("reactivatePayee()", () => {
    it("delegates to payeesService.reactivatePayee with userId and id", async () => {
      const expected = { id: "payee-1", name: "Store", isActive: true };
      mockPayeesService.reactivatePayee.mockResolvedValue(expected);

      const result = await controller.reactivatePayee(mockReq, "payee-1");

      expect(result).toEqual(expected);
      expect(mockPayeesService.reactivatePayee).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
    });
  });

  // ─── Alias endpoints ─────────────────────────────────────────────

  describe("getAllAliases()", () => {
    it("delegates to payeesService.getAllAliases with userId", async () => {
      const expected = [{ id: "a1", alias: "STARBUCKS*" }];
      mockPayeesService.getAllAliases.mockResolvedValue(expected);

      const result = await controller.getAllAliases(mockReq);

      expect(result).toEqual(expected);
      expect(mockPayeesService.getAllAliases).toHaveBeenCalledWith("user-1");
    });
  });

  describe("createAlias()", () => {
    it("delegates to payeesService.createAlias with userId and dto", async () => {
      const dto = { payeeId: "payee-1", alias: "STARBUCKS*" };
      const expected = { id: "a1", ...dto };
      mockPayeesService.createAlias.mockResolvedValue(expected);

      const result = await controller.createAlias(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.createAlias).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("removeAlias()", () => {
    it("delegates to payeesService.removeAlias with userId and aliasId", async () => {
      mockPayeesService.removeAlias.mockResolvedValue(undefined);

      const result = await controller.removeAlias(mockReq, "alias-1");

      expect(result).toBeUndefined();
      expect(mockPayeesService.removeAlias).toHaveBeenCalledWith(
        "user-1",
        "alias-1",
      );
    });
  });

  describe("getAliases()", () => {
    it("delegates to payeesService.getAliases with userId and payeeId", async () => {
      const expected = [{ id: "a1", alias: "TEST" }];
      mockPayeesService.getAliases.mockResolvedValue(expected);

      const result = await controller.getAliases(mockReq, "payee-1");

      expect(result).toEqual(expected);
      expect(mockPayeesService.getAliases).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
    });
  });

  // ─── Merge endpoint ────────────────────────────────────────────────

  describe("mergePayees()", () => {
    it("delegates to payeesService.mergePayees with userId and dto", async () => {
      const dto = {
        targetPayeeId: "payee-1",
        sourcePayeeId: "payee-2",
        addAsAlias: true,
      };
      const expected = {
        transactionsMigrated: 5,
        aliasAdded: true,
        sourcePayeeDeleted: true,
      };
      mockPayeesService.mergePayees.mockResolvedValue(expected);

      const result = await controller.mergePayees(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.mergePayees).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findInactiveByName()", () => {
    it("delegates to payeesService.findInactiveByName with userId and name", async () => {
      const expected = { id: "payee-1", name: "Store", isActive: false };
      mockPayeesService.findInactiveByName.mockResolvedValue(expected);

      const result = await controller.findInactiveByName(mockReq, "Store");

      expect(result).toEqual(expected);
      expect(mockPayeesService.findInactiveByName).toHaveBeenCalledWith(
        "user-1",
        "Store",
      );
    });

    it("returns null when no inactive match found", async () => {
      mockPayeesService.findInactiveByName.mockResolvedValue(null);

      const result = await controller.findInactiveByName(mockReq, "Unknown");

      expect(result).toBeNull();
    });

    it("truncates long names to 255 chars", async () => {
      mockPayeesService.findInactiveByName.mockResolvedValue(null);
      const longName = "A".repeat(300);

      await controller.findInactiveByName(mockReq, longName);

      expect(mockPayeesService.findInactiveByName).toHaveBeenCalledWith(
        "user-1",
        "A".repeat(255),
      );
    });

    it("substitutes empty string when name is undefined", async () => {
      mockPayeesService.findInactiveByName.mockResolvedValue(null);

      await controller.findInactiveByName(mockReq, undefined as any);

      expect(mockPayeesService.findInactiveByName).toHaveBeenCalledWith(
        "user-1",
        "",
      );
    });
  });

  describe("search() input handling", () => {
    it("substitutes empty string when query is undefined", async () => {
      mockPayeesService.search.mockResolvedValue([]);

      await controller.search(mockReq, undefined as any, 10);

      expect(mockPayeesService.search).toHaveBeenCalledWith("user-1", "", 10);
    });

    it("truncates query to 200 characters", async () => {
      mockPayeesService.search.mockResolvedValue([]);
      const longQuery = "x".repeat(500);

      await controller.search(mockReq, longQuery, 10);

      expect(mockPayeesService.search).toHaveBeenCalledWith(
        "user-1",
        "x".repeat(200),
        10,
      );
    });

    it("clamps limit below 1 to 1", async () => {
      mockPayeesService.search.mockResolvedValue([]);

      await controller.search(mockReq, "q", 0);

      expect(mockPayeesService.search).toHaveBeenCalledWith("user-1", "q", 1);
    });

    it("clamps limit above 200 to 200", async () => {
      mockPayeesService.search.mockResolvedValue([]);

      await controller.search(mockReq, "q", 500);

      expect(mockPayeesService.search).toHaveBeenCalledWith("user-1", "q", 200);
    });
  });

  describe("autocomplete() input handling", () => {
    it("substitutes empty string when query is undefined", async () => {
      mockPayeesService.autocomplete.mockResolvedValue([]);

      await controller.autocomplete(mockReq, undefined as any);

      expect(mockPayeesService.autocomplete).toHaveBeenCalledWith("user-1", "");
    });

    it("truncates long autocomplete queries", async () => {
      mockPayeesService.autocomplete.mockResolvedValue([]);

      await controller.autocomplete(mockReq, "a".repeat(500));

      expect(mockPayeesService.autocomplete).toHaveBeenCalledWith(
        "user-1",
        "a".repeat(200),
      );
    });
  });

  describe("getMostUsed() / getRecentlyUsed() limit clamping", () => {
    it("clamps getMostUsed limit below 1 to 1", async () => {
      mockPayeesService.getMostUsed.mockResolvedValue([]);
      await controller.getMostUsed(mockReq, -5);
      expect(mockPayeesService.getMostUsed).toHaveBeenCalledWith("user-1", 1);
    });

    it("clamps getMostUsed limit above 200 to 200", async () => {
      mockPayeesService.getMostUsed.mockResolvedValue([]);
      await controller.getMostUsed(mockReq, 999);
      expect(mockPayeesService.getMostUsed).toHaveBeenCalledWith("user-1", 200);
    });

    it("clamps getRecentlyUsed limit below 1 to 1", async () => {
      mockPayeesService.getRecentlyUsed.mockResolvedValue([]);
      await controller.getRecentlyUsed(mockReq, 0);
      expect(mockPayeesService.getRecentlyUsed).toHaveBeenCalledWith(
        "user-1",
        1,
      );
    });

    it("clamps getRecentlyUsed limit above 200 to 200", async () => {
      mockPayeesService.getRecentlyUsed.mockResolvedValue([]);
      await controller.getRecentlyUsed(mockReq, 9999);
      expect(mockPayeesService.getRecentlyUsed).toHaveBeenCalledWith(
        "user-1",
        200,
      );
    });
  });

  describe("previewAutoMerge()", () => {
    it("delegates with clamped options", async () => {
      mockAutoMergeService.previewAutoMerge.mockResolvedValue({ groups: [] });

      await controller.previewAutoMerge(
        mockReq,
        2,
        0.85,
        3,
        false,
        "off",
        false,
        5,
      );

      expect(mockAutoMergeService.previewAutoMerge).toHaveBeenCalledWith(
        "user-1",
        {
          minGroupSize: 2,
          similarityThreshold: 0.85,
          minTokenLength: 3,
          includeInactive: false,
          categoryMatch: "off",
          ignoreCommonWords: false,
          commonWordMinVariants: 5,
        },
      );
    });

    it("clamps out-of-range knobs into safe bounds", async () => {
      mockAutoMergeService.previewAutoMerge.mockResolvedValue({ groups: [] });

      await controller.previewAutoMerge(
        mockReq,
        1,
        0.1,
        99,
        true,
        "subcategory",
        true,
        99,
      );

      expect(mockAutoMergeService.previewAutoMerge).toHaveBeenCalledWith(
        "user-1",
        {
          minGroupSize: 2,
          similarityThreshold: 0.5,
          minTokenLength: 10,
          includeInactive: true,
          categoryMatch: "subcategory",
          ignoreCommonWords: true,
          commonWordMinVariants: 50,
        },
      );
    });

    it("falls back to 'off' for an unknown categoryMatch value", async () => {
      mockAutoMergeService.previewAutoMerge.mockResolvedValue({ groups: [] });

      await controller.previewAutoMerge(
        mockReq,
        2,
        0.85,
        3,
        false,
        "bogus",
        false,
        5,
      );

      expect(mockAutoMergeService.previewAutoMerge).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ categoryMatch: "off" }),
      );
    });
  });

  describe("applyAutoMerge()", () => {
    it("delegates groups to the auto-merge service", async () => {
      const groups = [
        {
          canonicalPayeeId: "payee-1",
          sourcePayeeIds: ["payee-2"],
          alias: "*LIDL*",
        },
      ];
      const expected = {
        groupsMerged: 1,
        payeesMerged: 1,
        transactionsMigrated: 3,
        aliasesCreated: 1,
        skippedAliases: 0,
      };
      mockAutoMergeService.applyAutoMerge.mockResolvedValue(expected);

      const result = await controller.applyAutoMerge(mockReq, {
        groups,
      } as any);

      expect(result).toEqual(expected);
      expect(mockAutoMergeService.applyAutoMerge).toHaveBeenCalledWith(
        "user-1",
        groups,
      );
    });
  });
  describe("brand favicon routes", () => {
    it("streams the cached bytes with a private cache header", async () => {
      const data = Buffer.from([1, 2, 3]);
      mockPayeesService.getLogo.mockResolvedValue({
        data,
        contentType: "image/png",
      });
      const res = { set: jest.fn(), end: jest.fn() } as any;

      await controller.getLogo(mockReq, "payee-1", res);

      expect(mockPayeesService.getLogo).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
      expect(res.set).toHaveBeenCalledWith({
        "Content-Type": "image/png",
        "Content-Length": "3",
        // The image is one user's cached copy, so it must not land in a
        // shared cache.
        "Cache-Control": "private, max-age=86400",
      });
      expect(res.end).toHaveBeenCalledWith(data);
    });

    it("delegates a refresh with the caller's id", async () => {
      mockPayeesService.refreshLogo.mockResolvedValue({ id: "payee-1" });

      await controller.refreshLogo(mockReq, "payee-1");

      expect(mockPayeesService.refreshLogo).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
    });
  });

  describe("lookupContact()", () => {
    it("looks the name up without persisting, ignoring the opt-in preference", async () => {
      const outcome = { reason: "none", suggestion: null };
      mockContactLookupService.lookup.mockResolvedValue(outcome);

      const result = await controller.lookupContact(mockReq, { name: "Acme" });

      expect(result).toBe(outcome);
      expect(mockContactLookupService.lookup).toHaveBeenCalledWith(
        "user-1",
        { name: "Acme", known: undefined },
        { ignorePreference: true },
      );
    });

    it("passes the form's own values through as context, and stores none of them", async () => {
      mockContactLookupService.lookup.mockResolvedValue({
        reason: "none",
        suggestion: null,
      });

      await controller.lookupContact(mockReq, {
        name: "Acme",
        address: "Toronto",
        notes: "the Dundas branch",
      });

      expect(mockContactLookupService.lookup).toHaveBeenCalledWith(
        "user-1",
        {
          name: "Acme",
          known: { address: "Toronto", notes: "the Dundas branch" },
        },
        { ignorePreference: true },
      );
    });
  });

  describe("lookupContactForPayee()", () => {
    it("returns the candidates for the payee and writes nothing", async () => {
      const outcome = {
        reason: "ok",
        suggestions: [{ label: null, website: "https://acme.example" }],
      };
      mockPayeesService.lookupContactForPayee.mockResolvedValue(outcome);

      await expect(
        controller.lookupContactForPayee(mockReq, "payee-1"),
      ).resolves.toBe(outcome);
      expect(mockPayeesService.lookupContactForPayee).toHaveBeenCalledWith(
        "user-1",
        "payee-1",
      );
      // The write is the user's own confirmed edit, through PATCH /payees/:id.
      expect(
        mockContactEnrichmentService.dispatchAfterCreate,
      ).not.toHaveBeenCalled();
    });
  });
});
