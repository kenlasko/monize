import { Test, TestingModule } from "@nestjs/testing";
import { CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";

describe("CategoriesController", () => {
  let controller: CategoriesController;
  let mockCategoriesService: Partial<
    Record<keyof CategoriesService, jest.Mock>
  >;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockCategoriesService = {
      create: jest.fn(),
      findAll: jest.fn(),
      getTree: jest.fn(),
      getStats: jest.fn(),
      importDefaults: jest.fn(),
      findByType: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      getTransactionCount: jest.fn(),
      reassignTransactions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        {
          provide: CategoriesService,
          useValue: mockCategoriesService,
        },
      ],
    }).compile();

    controller = module.get<CategoriesController>(CategoriesController);
  });

  describe("create()", () => {
    it("delegates to categoriesService.create with userId and dto", () => {
      const dto = { name: "Food" } as any;
      mockCategoriesService.create!.mockReturnValue("created");

      const result = controller.create(mockReq, dto);

      expect(result).toBe("created");
      expect(mockCategoriesService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to categoriesService.findAll with userId and includeSystem", () => {
      mockCategoriesService.findAll!.mockReturnValue("categories");

      const result = controller.findAll(mockReq, true);

      expect(result).toBe("categories");
      expect(mockCategoriesService.findAll).toHaveBeenCalledWith(
        "user-1",
        true,
      );
    });

    it("defaults includeSystem to false when undefined", () => {
      mockCategoriesService.findAll!.mockReturnValue("categories");

      controller.findAll(mockReq, undefined);

      expect(mockCategoriesService.findAll).toHaveBeenCalledWith(
        "user-1",
        false,
      );
    });
  });

  describe("getTree()", () => {
    it("delegates to categoriesService.getTree with userId", () => {
      mockCategoriesService.getTree!.mockReturnValue("tree");

      const result = controller.getTree(mockReq);

      expect(result).toBe("tree");
      expect(mockCategoriesService.getTree).toHaveBeenCalledWith("user-1");
    });
  });

  describe("getStats()", () => {
    it("delegates to categoriesService.getStats with userId", () => {
      mockCategoriesService.getStats!.mockReturnValue("stats");

      const result = controller.getStats(mockReq);

      expect(result).toBe("stats");
      expect(mockCategoriesService.getStats).toHaveBeenCalledWith("user-1");
    });
  });

  describe("importDefaults()", () => {
    it("delegates to categoriesService.importDefaults with userId", () => {
      mockCategoriesService.importDefaults!.mockReturnValue("imported");

      const result = controller.importDefaults(mockReq);

      expect(result).toBe("imported");
      expect(mockCategoriesService.importDefaults).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });

  describe("getIncomeCategories()", () => {
    it("delegates to categoriesService.findByType with userId and isIncome=true", () => {
      mockCategoriesService.findByType!.mockReturnValue("income");

      const result = controller.getIncomeCategories(mockReq);

      expect(result).toBe("income");
      expect(mockCategoriesService.findByType).toHaveBeenCalledWith(
        "user-1",
        true,
      );
    });
  });

  describe("getExpenseCategories()", () => {
    it("delegates to categoriesService.findByType with userId and isIncome=false", () => {
      mockCategoriesService.findByType!.mockReturnValue("expense");

      const result = controller.getExpenseCategories(mockReq);

      expect(result).toBe("expense");
      expect(mockCategoriesService.findByType).toHaveBeenCalledWith(
        "user-1",
        false,
      );
    });
  });

  describe("findOne()", () => {
    it("delegates to categoriesService.findOne with userId and id", () => {
      mockCategoriesService.findOne!.mockReturnValue("category");

      const result = controller.findOne(mockReq, "cat-1");

      expect(result).toBe("category");
      expect(mockCategoriesService.findOne).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
      );
    });
  });

  describe("update()", () => {
    it("delegates to categoriesService.update with userId, id, and dto", () => {
      const dto = { name: "Updated" } as any;
      mockCategoriesService.update!.mockReturnValue("updated");

      const result = controller.update(mockReq, "cat-1", dto);

      expect(result).toBe("updated");
      expect(mockCategoriesService.update).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
        dto,
      );
    });
  });

  describe("remove()", () => {
    it("delegates to categoriesService.remove with userId and id", () => {
      mockCategoriesService.remove!.mockReturnValue("removed");

      const result = controller.remove(mockReq, "cat-1");

      expect(result).toBe("removed");
      expect(mockCategoriesService.remove).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
      );
    });
  });

  describe("getTransactionCount()", () => {
    it("delegates to categoriesService.getTransactionCount with userId and id", () => {
      mockCategoriesService.getTransactionCount!.mockReturnValue("count");

      const result = controller.getTransactionCount(mockReq, "cat-1");

      expect(result).toBe("count");
      expect(mockCategoriesService.getTransactionCount).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
      );
    });
  });

  describe("reassignTransactions()", () => {
    it("delegates to categoriesService.reassignTransactions with userId, id, and toCategoryId", () => {
      const body = { toCategoryId: "cat-2" };
      mockCategoriesService.reassignTransactions!.mockReturnValue("reassigned");

      const result = controller.reassignTransactions(mockReq, "cat-1", body);

      expect(result).toBe("reassigned");
      expect(mockCategoriesService.reassignTransactions).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
        "cat-2",
      );
    });

    it("passes null toCategoryId when uncategorizing", () => {
      const body = { toCategoryId: null };
      mockCategoriesService.reassignTransactions!.mockReturnValue("reassigned");

      controller.reassignTransactions(mockReq, "cat-1", body);

      expect(mockCategoriesService.reassignTransactions).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
        null,
      );
    });
  });
});
