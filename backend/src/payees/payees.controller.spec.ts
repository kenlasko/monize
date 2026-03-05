import { Test, TestingModule } from "@nestjs/testing";
import { PayeesController } from "./payees.controller";
import { PayeesService } from "./payees.service";

describe("PayeesController", () => {
  let controller: PayeesController;
  let mockPayeesService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockPayeesService = {
      create: jest.fn(),
      findAll: jest.fn(),
      search: jest.fn(),
      autocomplete: jest.fn(),
      getMostUsed: jest.fn(),
      getRecentlyUsed: jest.fn(),
      getSummary: jest.fn(),
      calculateCategorySuggestions: jest.fn(),
      applyCategorySuggestions: jest.fn(),
      previewDeactivation: jest.fn(),
      deactivatePayees: jest.fn(),
      reactivatePayee: jest.fn(),
      findInactiveByName: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayeesController],
      providers: [
        {
          provide: PayeesService,
          useValue: mockPayeesService,
        },
      ],
    }).compile();

    controller = module.get<PayeesController>(PayeesController);
  });

  describe("create()", () => {
    it("delegates to payeesService.create with userId and dto", async () => {
      const dto = { name: "Grocery Store" };
      const expected = { id: "payee-1", name: "Grocery Store" };
      mockPayeesService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockPayeesService.create).toHaveBeenCalledWith("user-1", dto);
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
  });
});
