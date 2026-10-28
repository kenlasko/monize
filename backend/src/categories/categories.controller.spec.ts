jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);
import { Test, TestingModule } from "@nestjs/testing";
import { CategoriesController } from "./categories.controller";
import { CategoriesService } from "./categories.service";
import { CategoryDetailService } from "./category-detail.service";
import { JointCategoriesService } from "./joint-categories.service";
import { DelegationService } from "../delegation/delegation.service";
import { DEFAULT_CATEGORY_COUNTRY_CODES } from "./country-category-additions";

describe("CategoriesController", () => {
  let controller: CategoriesController;
  let mockCategoriesService: Partial<
    Record<keyof CategoriesService, jest.Mock>
  >;
  let mockCategoryDetailService: Partial<
    Record<keyof CategoryDetailService, jest.Mock>
  >;
  let mockJointCategoriesService: Partial<
    Record<keyof JointCategoriesService, jest.Mock>
  >;
  let mockDelegationService: { readableAccountIds: jest.Mock };
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
      previewCategoryUpdate: jest.fn(),
      previewCategoryReassignment: jest.fn(),
    };
    mockCategoryDetailService = {
      getDetail: jest.fn(),
    };
    mockJointCategoriesService = {
      create: jest.fn(),
    };
    mockDelegationService = { readableAccountIds: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriesController],
      providers: [
        {
          provide: CategoriesService,
          useValue: mockCategoriesService,
        },
        {
          provide: CategoryDetailService,
          useValue: mockCategoryDetailService,
        },
        {
          provide: JointCategoriesService,
          useValue: mockJointCategoriesService,
        },
        { provide: DelegationService, useValue: mockDelegationService },
      ],
    }).compile();

    controller = module.get<CategoriesController>(CategoriesController);
  });

  it("forwards category previews and confirmed reassignment using the authenticated owner", async () => {
    const dto = { isIncome: true };
    await controller.previewCategoryUpdate(mockReq, "cat-1", dto);
    expect(mockCategoriesService.previewCategoryUpdate).toHaveBeenCalledWith(
      "user-1",
      "cat-1",
      dto,
    );
    const reassign = {
      toCategoryId: "cat-2",
      accrualImpactFingerprint: "a".repeat(64),
    };
    await controller.previewCategoryReassignment(mockReq, "cat-1", reassign);
    expect(
      mockCategoriesService.previewCategoryReassignment,
    ).toHaveBeenCalledWith("user-1", "cat-1", "cat-2");
    await controller.reassignTransactions(mockReq, "cat-1", reassign);
    expect(mockCategoriesService.reassignTransactions).toHaveBeenCalledWith(
      "user-1",
      "cat-1",
      "cat-2",
      reassign.accrualImpactFingerprint,
    );
  });

  describe("getDetail()", () => {
    it("delegates to categoryDetailService.getDetail with userId and id, unscoped for the owner", async () => {
      mockCategoryDetailService.getDetail!.mockResolvedValue("detail");

      const result = await controller.getDetail(mockReq, "cat-1");

      expect(result).toBe("detail");
      expect(mockCategoryDetailService.getDetail).toHaveBeenCalledWith(
        "user-1",
        "cat-1",
        undefined,
      );
      expect(mockDelegationService.readableAccountIds).not.toHaveBeenCalled();
    });

    it("scopes an acting delegate to their READ-granted accounts", async () => {
      mockCategoryDetailService.getDetail!.mockResolvedValue("detail");
      mockDelegationService.readableAccountIds.mockResolvedValue(["acc-a"]);

      await controller.getDetail(
        { user: { id: "owner-1", isActing: true, delegationId: "g1" } },
        "cat-1",
      );

      expect(mockDelegationService.readableAccountIds).toHaveBeenCalledWith(
        "g1",
      );
      expect(mockCategoryDetailService.getDetail).toHaveBeenCalledWith(
        "owner-1",
        "cat-1",
        ["acc-a"],
      );
    });
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
    it("delegates to categoriesService.importDefaults with userId and options", () => {
      mockCategoriesService.importDefaults!.mockReturnValue("imported");
      const dto = { country: "CA", language: "fr" };

      const result = controller.importDefaults(mockReq, dto);

      expect(result).toBe("imported");
      expect(mockCategoriesService.importDefaults).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });

    it("passes an empty body through unchanged", () => {
      mockCategoriesService.importDefaults!.mockReturnValue("imported");

      controller.importDefaults(mockReq, {});

      expect(mockCategoriesService.importDefaults).toHaveBeenCalledWith(
        "user-1",
        {},
      );
    });
  });

  describe("getDefaultCountries()", () => {
    it("returns the supported country codes", () => {
      expect(controller.getDefaultCountries()).toEqual({
        countries: [...DEFAULT_CATEGORY_COUNTRY_CODES],
      });
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

  describe("createForJointAccount()", () => {
    it("delegates to jointCategories.create with the account and dto", () => {
      const dto = { name: "Daycare" };
      mockJointCategoriesService.create!.mockReturnValue("created");

      const result = controller.createForJointAccount(
        mockReq,
        "account-1",
        dto as never,
      );

      expect(result).toBe("created");
      expect(mockJointCategoriesService.create).toHaveBeenCalledWith(
        "user-1",
        "account-1",
        dto,
      );
      // The owner-ledger create never runs through the caller-scoped service.
      expect(mockCategoriesService.create).not.toHaveBeenCalled();
    });

    it("passes the REAL user, so an acting session cannot borrow the owner's identity", () => {
      const actingReq = {
        user: { id: "owner-1", realUserId: "delegate-1" },
      };
      mockJointCategoriesService.create!.mockReturnValue("created");

      controller.createForJointAccount(actingReq, "account-1", {
        name: "Daycare",
      } as never);

      expect(mockJointCategoriesService.create).toHaveBeenCalledWith(
        "delegate-1",
        "account-1",
        { name: "Daycare" },
      );
    });
  });
});
