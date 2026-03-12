import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TagsService } from "./tags.service";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";

describe("TagsService", () => {
  let service: TagsService;
  let tagsRepository: Record<string, jest.Mock>;
  let transactionTagsRepository: Record<string, jest.Mock>;
  let transactionSplitTagsRepository: Record<string, jest.Mock>;
  let mockDataSource: Record<string, any>;

  const userId = "user-1";

  const mockTag: Tag = {
    id: "tag-1",
    userId,
    name: "Groceries",
    color: "#FF5733",
    icon: "cart",
    createdAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-01-01"),
  };

  const mockTag2: Tag = {
    id: "tag-2",
    userId,
    name: "Travel",
    color: null,
    icon: null,
    createdAt: new Date("2025-01-02"),
    updatedAt: new Date("2025-01-02"),
  };

  let queryBuilderMock: Record<string, jest.Mock>;

  const mockManager = {
    find: jest.fn(),
    delete: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };

  beforeEach(async () => {
    queryBuilderMock = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
    };

    tagsRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilderMock),
    };

    transactionTagsRepository = {
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    transactionSplitTagsRepository = {};

    mockDataSource = {
      manager: mockManager,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagsService,
        {
          provide: getRepositoryToken(Tag),
          useValue: tagsRepository,
        },
        {
          provide: getRepositoryToken(TransactionTag),
          useValue: transactionTagsRepository,
        },
        {
          provide: getRepositoryToken(TransactionSplitTag),
          useValue: transactionSplitTagsRepository,
        },
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
      ],
    }).compile();

    service = module.get<TagsService>(TagsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("findAll()", () => {
    it("returns all tags for a user ordered by name", async () => {
      const tags = [mockTag, mockTag2];
      tagsRepository.find.mockResolvedValue(tags);

      const result = await service.findAll(userId);

      expect(result).toEqual(tags);
      expect(tagsRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { name: "ASC" },
      });
    });

    it("returns empty array when user has no tags", async () => {
      tagsRepository.find.mockResolvedValue([]);

      const result = await service.findAll(userId);

      expect(result).toEqual([]);
    });
  });

  describe("findOne()", () => {
    it("returns a tag by id and userId", async () => {
      tagsRepository.findOne.mockResolvedValue(mockTag);

      const result = await service.findOne(userId, "tag-1");

      expect(result).toEqual(mockTag);
      expect(tagsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "tag-1", userId },
      });
    });

    it("throws NotFoundException when tag not found", async () => {
      tagsRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.findOne(userId, "nonexistent")).rejects.toThrow(
        "Tag with ID nonexistent not found",
      );
    });
  });

  describe("create()", () => {
    it("creates a new tag successfully", async () => {
      const dto = { name: "Groceries", color: "#FF5733", icon: "cart" };
      queryBuilderMock.getOne.mockResolvedValue(null);
      tagsRepository.create.mockReturnValue(mockTag);
      tagsRepository.save.mockResolvedValue(mockTag);

      const result = await service.create(userId, dto);

      expect(result).toEqual(mockTag);
      expect(tagsRepository.createQueryBuilder).toHaveBeenCalledWith("tag");
      expect(queryBuilderMock.where).toHaveBeenCalledWith(
        "tag.userId = :userId",
        { userId },
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "LOWER(tag.name) = LOWER(:name)",
        { name: "Groceries" },
      );
      expect(tagsRepository.create).toHaveBeenCalledWith({
        name: "Groceries",
        color: "#FF5733",
        icon: "cart",
        userId,
      });
      expect(tagsRepository.save).toHaveBeenCalledWith(mockTag);
    });

    it("creates a tag with null color and icon when not provided", async () => {
      const dto = { name: "Simple Tag" };
      queryBuilderMock.getOne.mockResolvedValue(null);
      const createdTag = { ...mockTag, name: "Simple Tag", color: null, icon: null };
      tagsRepository.create.mockReturnValue(createdTag);
      tagsRepository.save.mockResolvedValue(createdTag);

      await service.create(userId, dto);

      expect(tagsRepository.create).toHaveBeenCalledWith({
        name: "Simple Tag",
        color: null,
        icon: null,
        userId,
      });
    });

    it("throws ConflictException when tag name already exists (case-insensitive)", async () => {
      const dto = { name: "Groceries" };
      queryBuilderMock.getOne.mockResolvedValue(mockTag);

      await expect(service.create(userId, dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(userId, dto)).rejects.toThrow(
        'A tag named "Groceries" already exists',
      );
    });
  });

  describe("update()", () => {
    it("updates a tag successfully", async () => {
      const dto = { name: "Updated Groceries" };
      tagsRepository.findOne.mockResolvedValue({ ...mockTag });
      queryBuilderMock.getOne.mockResolvedValue(null);
      const updatedTag = { ...mockTag, name: "Updated Groceries" };
      tagsRepository.save.mockResolvedValue(updatedTag);

      const result = await service.update(userId, "tag-1", dto);

      expect(result).toEqual(updatedTag);
      expect(tagsRepository.save).toHaveBeenCalled();
    });

    it("updates color and icon to null when empty strings provided", async () => {
      const dto = { color: "", icon: "" };
      tagsRepository.findOne.mockResolvedValue({ ...mockTag });
      const updatedTag = { ...mockTag, color: null, icon: null };
      tagsRepository.save.mockResolvedValue(updatedTag);

      const result = await service.update(userId, "tag-1", dto);

      expect(result).toEqual(updatedTag);
    });

    it("checks for duplicate name when name is changed", async () => {
      const dto = { name: "Travel" };
      tagsRepository.findOne.mockResolvedValue({ ...mockTag });
      queryBuilderMock.getOne.mockResolvedValue(null);
      tagsRepository.save.mockResolvedValue({ ...mockTag, name: "Travel" });

      await service.update(userId, "tag-1", dto);

      expect(tagsRepository.createQueryBuilder).toHaveBeenCalledWith("tag");
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "LOWER(tag.name) = LOWER(:name)",
        { name: "Travel" },
      );
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith(
        "tag.id != :id",
        { id: "tag-1" },
      );
    });

    it("does not check for duplicate when name is unchanged (case-insensitive)", async () => {
      const dto = { name: "groceries" };
      tagsRepository.findOne.mockResolvedValue({ ...mockTag });
      tagsRepository.save.mockResolvedValue({ ...mockTag, name: "groceries" });

      await service.update(userId, "tag-1", dto);

      // createQueryBuilder should not be called for duplicate check
      // since the name matches case-insensitively
      expect(tagsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("throws ConflictException when updated name conflicts with existing tag", async () => {
      const dto = { name: "Travel" };
      tagsRepository.findOne.mockResolvedValue({ ...mockTag });
      queryBuilderMock.getOne.mockResolvedValue(mockTag2);

      await expect(service.update(userId, "tag-1", dto)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.update(userId, "tag-1", dto)).rejects.toThrow(
        'A tag named "Travel" already exists',
      );
    });

    it("throws NotFoundException when tag does not exist", async () => {
      tagsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, "nonexistent", { name: "New" }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove()", () => {
    it("removes a tag successfully", async () => {
      tagsRepository.findOne.mockResolvedValue(mockTag);
      tagsRepository.remove.mockResolvedValue(mockTag);

      await service.remove(userId, "tag-1");

      expect(tagsRepository.remove).toHaveBeenCalledWith(mockTag);
    });

    it("throws NotFoundException when tag does not exist", async () => {
      tagsRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(userId, "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("getTransactionCount()", () => {
    it("returns the number of transactions using a tag", async () => {
      tagsRepository.findOne.mockResolvedValue(mockTag);
      transactionTagsRepository.count.mockResolvedValue(5);

      const result = await service.getTransactionCount(userId, "tag-1");

      expect(result).toBe(5);
      expect(transactionTagsRepository.count).toHaveBeenCalledWith({
        where: { tagId: "tag-1" },
      });
    });

    it("returns 0 when tag has no transactions", async () => {
      tagsRepository.findOne.mockResolvedValue(mockTag);
      transactionTagsRepository.count.mockResolvedValue(0);

      const result = await service.getTransactionCount(userId, "tag-1");

      expect(result).toBe(0);
    });

    it("throws NotFoundException when tag does not exist", async () => {
      tagsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.getTransactionCount(userId, "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getAllTransactionCounts()", () => {
    it("returns transaction counts keyed by tag ID", async () => {
      const ttQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([
          { tag_id: "tag-1", count: "5" },
          { tag_id: "tag-2", count: "3" },
        ]),
      };
      transactionTagsRepository.createQueryBuilder.mockReturnValue(
        ttQueryBuilder,
      );

      const result = await service.getAllTransactionCounts(userId);

      expect(result).toEqual({ "tag-1": 5, "tag-2": 3 });
      expect(ttQueryBuilder.innerJoin).toHaveBeenCalledWith(
        Tag,
        "t",
        "t.id = tt.tag_id AND t.user_id = :userId",
        { userId },
      );
    });

    it("returns empty object when no tags have transactions", async () => {
      const ttQueryBuilder = {
        select: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        innerJoin: jest.fn().mockReturnThis(),
        groupBy: jest.fn().mockReturnThis(),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      transactionTagsRepository.createQueryBuilder.mockReturnValue(
        ttQueryBuilder,
      );

      const result = await service.getAllTransactionCounts(userId);

      expect(result).toEqual({});
    });
  });

  describe("setTransactionTags()", () => {
    const transactionId = "txn-1";

    beforeEach(() => {
      mockManager.find.mockReset();
      mockManager.delete.mockReset();
      mockManager.create.mockReset();
      mockManager.save.mockReset();
    });

    it("sets tags for a transaction using default manager", async () => {
      const tagIds = ["tag-1", "tag-2"];
      mockManager.find.mockResolvedValue([mockTag, mockTag2]);
      mockManager.delete.mockResolvedValue(undefined);
      mockManager.create.mockImplementation((_entity, data) => data);
      mockManager.save.mockResolvedValue(undefined);

      await service.setTransactionTags(transactionId, tagIds, userId);

      expect(mockManager.find).toHaveBeenCalledWith(Tag, {
        where: { id: expect.anything(), userId },
      });
      expect(mockManager.delete).toHaveBeenCalledWith(TransactionTag, {
        transactionId,
      });
      expect(mockManager.save).toHaveBeenCalledWith(TransactionTag, [
        { transactionId, tagId: "tag-1" },
        { transactionId, tagId: "tag-2" },
      ]);
    });

    it("clears all tags when empty array provided", async () => {
      mockManager.delete.mockResolvedValue(undefined);

      await service.setTransactionTags(transactionId, [], userId);

      expect(mockManager.delete).toHaveBeenCalledWith(TransactionTag, {
        transactionId,
      });
      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when some tags do not belong to user", async () => {
      const tagIds = ["tag-1", "tag-nonexistent"];
      mockManager.find.mockResolvedValue([mockTag]); // only 1 found out of 2

      await expect(
        service.setTransactionTags(transactionId, tagIds, userId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.setTransactionTags(transactionId, tagIds, userId),
      ).rejects.toThrow("One or more tags not found");
    });

    it("uses queryRunner manager when provided", async () => {
      const tagIds = ["tag-1"];
      const qrManager = {
        find: jest.fn().mockResolvedValue([mockTag]),
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const queryRunner = { manager: qrManager } as any;

      await service.setTransactionTags(
        transactionId,
        tagIds,
        userId,
        queryRunner,
      );

      expect(qrManager.find).toHaveBeenCalled();
      expect(qrManager.delete).toHaveBeenCalled();
      expect(qrManager.save).toHaveBeenCalled();
      expect(mockManager.find).not.toHaveBeenCalled();
    });
  });

  describe("setSplitTags()", () => {
    const splitId = "split-1";

    beforeEach(() => {
      mockManager.find.mockReset();
      mockManager.delete.mockReset();
      mockManager.create.mockReset();
      mockManager.save.mockReset();
    });

    it("sets tags for a transaction split using default manager", async () => {
      const tagIds = ["tag-1", "tag-2"];
      mockManager.find.mockResolvedValue([mockTag, mockTag2]);
      mockManager.delete.mockResolvedValue(undefined);
      mockManager.create.mockImplementation((_entity, data) => data);
      mockManager.save.mockResolvedValue(undefined);

      await service.setSplitTags(splitId, tagIds, userId);

      expect(mockManager.find).toHaveBeenCalledWith(Tag, {
        where: { id: expect.anything(), userId },
      });
      expect(mockManager.delete).toHaveBeenCalledWith(TransactionSplitTag, {
        transactionSplitId: splitId,
      });
      expect(mockManager.save).toHaveBeenCalledWith(TransactionSplitTag, [
        { transactionSplitId: splitId, tagId: "tag-1" },
        { transactionSplitId: splitId, tagId: "tag-2" },
      ]);
    });

    it("clears all split tags when empty array provided", async () => {
      mockManager.delete.mockResolvedValue(undefined);

      await service.setSplitTags(splitId, [], userId);

      expect(mockManager.delete).toHaveBeenCalledWith(TransactionSplitTag, {
        transactionSplitId: splitId,
      });
      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when some tags do not belong to user", async () => {
      const tagIds = ["tag-1", "tag-nonexistent"];
      mockManager.find.mockResolvedValue([mockTag]);

      await expect(
        service.setSplitTags(splitId, tagIds, userId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.setSplitTags(splitId, tagIds, userId),
      ).rejects.toThrow("One or more tags not found");
    });

    it("uses queryRunner manager when provided", async () => {
      const tagIds = ["tag-1"];
      const qrManager = {
        find: jest.fn().mockResolvedValue([mockTag]),
        delete: jest.fn().mockResolvedValue(undefined),
        create: jest.fn().mockImplementation((_entity, data) => data),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const queryRunner = { manager: qrManager } as any;

      await service.setSplitTags(splitId, tagIds, userId, queryRunner);

      expect(qrManager.find).toHaveBeenCalled();
      expect(qrManager.delete).toHaveBeenCalled();
      expect(qrManager.save).toHaveBeenCalled();
      expect(mockManager.find).not.toHaveBeenCalled();
    });
  });
});
