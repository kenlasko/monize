import { Test, TestingModule } from "@nestjs/testing";
import { TagsController } from "./tags.controller";
import { TagsService } from "./tags.service";

describe("TagsController", () => {
  let controller: TagsController;
  let mockTagsService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockTagsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      getTransactionCount: jest.fn(),
      getAllTransactionCounts: jest.fn(),
      setTransactionTags: jest.fn(),
      setSplitTags: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TagsController],
      providers: [
        {
          provide: TagsService,
          useValue: mockTagsService,
        },
      ],
    }).compile();

    controller = module.get<TagsController>(TagsController);
  });

  describe("findAll()", () => {
    it("delegates to tagsService.findAll with userId", async () => {
      const expected = [
        { id: "tag-1", name: "Groceries" },
        { id: "tag-2", name: "Travel" },
      ];
      mockTagsService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockTagsService.findAll).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findOne()", () => {
    it("delegates to tagsService.findOne with userId and id", async () => {
      const expected = { id: "tag-1", name: "Groceries" };
      mockTagsService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "tag-1");

      expect(result).toEqual(expected);
      expect(mockTagsService.findOne).toHaveBeenCalledWith("user-1", "tag-1");
    });
  });

  describe("getTransactionCount()", () => {
    it("delegates to tagsService.getTransactionCount with userId and id", async () => {
      mockTagsService.getTransactionCount.mockResolvedValue(5);

      const result = await controller.getTransactionCount(mockReq, "tag-1");

      expect(result).toBe(5);
      expect(mockTagsService.getTransactionCount).toHaveBeenCalledWith(
        "user-1",
        "tag-1",
      );
    });
  });

  describe("getAllTransactionCounts()", () => {
    it("delegates to tagsService.getAllTransactionCounts with userId", async () => {
      const expected = { "tag-1": 5, "tag-2": 3 };
      mockTagsService.getAllTransactionCounts.mockResolvedValue(expected);

      const result = await controller.getAllTransactionCounts(mockReq);

      expect(result).toEqual(expected);
      expect(mockTagsService.getAllTransactionCounts).toHaveBeenCalledWith(
        "user-1",
      );
    });
  });

  describe("create()", () => {
    it("delegates to tagsService.create with userId and dto", async () => {
      const dto = { name: "Groceries", color: "#FF5733", icon: "cart" };
      const expected = { id: "tag-1", ...dto };
      mockTagsService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockTagsService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("update()", () => {
    it("delegates to tagsService.update with userId, id, and dto", async () => {
      const dto = { name: "Updated Groceries" };
      const expected = { id: "tag-1", name: "Updated Groceries" };
      mockTagsService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "tag-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockTagsService.update).toHaveBeenCalledWith(
        "user-1",
        "tag-1",
        dto,
      );
    });
  });

  describe("remove()", () => {
    it("delegates to tagsService.remove with userId and id", async () => {
      mockTagsService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "tag-1");

      expect(result).toBeUndefined();
      expect(mockTagsService.remove).toHaveBeenCalledWith("user-1", "tag-1");
    });
  });
});
