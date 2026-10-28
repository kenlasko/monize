jest.mock("../accruals/accrual-tag-guard", () => ({
  guardAccruedTagDeletion: async () => undefined,
  guardLegacyTagRestore: async () => undefined,
}));
import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { TagsService, TAG_LINK_INSERT_BATCH } from "./tags.service";
import { Tag } from "./entities/tag.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { ActionHistoryService } from "../action-history/action-history.service";
import { LEDGER_EXCLUDES_VOID } from "../common/ledger-balance.sql";
import { todayYMD } from "../common/date-utils";
import {
  createScopedDbMocks,
  ManagerMock,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("TagsService", () => {
  let service: TagsService;
  let tagsRepository: Record<string, jest.Mock>;
  let transactionTagsRepository: Record<string, jest.Mock>;
  let mockDataSource: DataSourceMock;

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
  let mockManager: ManagerMock;

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

    ({ manager: mockManager, dataSource: mockDataSource } = createScopedDbMocks(
      [
        [Tag, tagsRepository],
        [TransactionTag, transactionTagsRepository],
      ],
    ));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TagsService,
        {
          provide: DataSource,
          useValue: mockDataSource,
        },
        {
          provide: ActionHistoryService,
          useValue: { record: jest.fn().mockResolvedValue(null) },
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
      const createdTag = {
        ...mockTag,
        name: "Simple Tag",
        color: null,
        icon: null,
      };
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
      expect(queryBuilderMock.andWhere).toHaveBeenCalledWith("tag.id != :id", {
        id: "tag-1",
      });
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

  describe("getUsage()", () => {
    it("returns the latest use date and link count keyed by tag ID", async () => {
      mockManager.query.mockResolvedValue([
        { tag_id: "tag-1", last_used: "2026-09-30", count: "12" },
        { tag_id: "tag-2", last_used: "2008-12-24", count: "40" },
      ]);

      const result = await service.getUsage(userId);

      expect(result).toEqual({
        "tag-1": { lastUsed: "2026-09-30", count: 12 },
        "tag-2": { lastUsed: "2008-12-24", count: 40 },
      });
    });

    it("filters each branch by owner, void status and today, and counts movements", async () => {
      mockManager.query.mockResolvedValue([]);

      await service.getUsage(userId);

      const [sql, params] = mockManager.query.mock.calls[0];
      expect(params).toEqual([userId, todayYMD()]);
      expect(sql.match(/g\.user_id = \$1/g)).toHaveLength(2);
      expect(sql.split(LEDGER_EXCLUDES_VOID)).toHaveLength(3);
      expect(sql.match(/t\.transaction_date <= \$2::date/g)).toHaveLength(2);
      expect(sql).toContain("transaction_split_tags");
      expect(sql).toContain("COUNT(DISTINCT u.use_id)");
      expect(sql).not.toContain("account_id = ANY");
    });

    it("narrows both branches to a delegate's account scope", async () => {
      mockManager.query.mockResolvedValue([]);

      await service.getUsage(userId, ["acc-a", "acc-b"]);

      const [sql, params] = mockManager.query.mock.calls[0];
      expect(params).toEqual([userId, todayYMD(), ["acc-a", "acc-b"]]);
      expect(sql.match(/t\.account_id = ANY\(\$3::uuid\[\]\)/g)).toHaveLength(
        2,
      );
    });

    it("reports nothing for an empty scope without querying", async () => {
      await expect(service.getUsage(userId, [])).resolves.toEqual({});
      expect(mockManager.query).not.toHaveBeenCalled();
    });

    it("returns an empty object when no tag has been used", async () => {
      mockManager.query.mockResolvedValue([]);

      await expect(service.getUsage(userId)).resolves.toEqual({});
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

  describe("addTransactionTags() / removeTransactionTags()", () => {
    let insertChain: Record<string, jest.Mock>;

    beforeEach(() => {
      mockManager.find.mockReset();
      mockManager.count.mockReset();
      mockManager.delete.mockReset();
      mockManager.createQueryBuilder.mockReset();
      insertChain = {
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        orIgnore: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      mockManager.createQueryBuilder.mockReturnValue(insertChain);
      // Every requested tag / transaction id is owned by the caller.
      mockManager.find.mockImplementation(
        async (_e: unknown, opts: { where: { id: { value: string[] } } }) =>
          opts.where.id.value.map((id) => ({ id })),
      );
      mockManager.count.mockImplementation(
        async (_e: unknown, opts: { where: { id: { value: string[] } } }) =>
          opts.where.id.value.length,
      );
    });

    it("adds every transaction x tag link with ON CONFLICT DO NOTHING and never deletes", async () => {
      await service.addTransactionTags(
        mockManager as any,
        userId,
        ["txn-1", "txn-2"],
        ["tag-1", "tag-2"],
      );

      expect(insertChain.into).toHaveBeenCalledWith(TransactionTag);
      expect(insertChain.values).toHaveBeenCalledWith([
        { transactionId: "txn-1", tagId: "tag-1" },
        { transactionId: "txn-1", tagId: "tag-2" },
        { transactionId: "txn-2", tagId: "tag-1" },
        { transactionId: "txn-2", tagId: "tag-2" },
      ]);
      expect(insertChain.orIgnore).toHaveBeenCalledTimes(1);
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("is idempotent: a second call issues the same ignore-conflict insert", async () => {
      const args = [mockManager as any, userId, ["txn-1"], ["tag-1"]] as const;
      await service.addTransactionTags(...args);
      await service.addTransactionTags(...args);

      expect(insertChain.orIgnore).toHaveBeenCalledTimes(2);
      expect(insertChain.values).toHaveBeenNthCalledWith(1, [
        { transactionId: "txn-1", tagId: "tag-1" },
      ]);
      expect(insertChain.values).toHaveBeenNthCalledWith(2, [
        { transactionId: "txn-1", tagId: "tag-1" },
      ]);
    });

    it("dedupes transaction and tag ids", async () => {
      await service.addTransactionTags(
        mockManager as any,
        userId,
        ["txn-1", "txn-1"],
        ["tag-1", "tag-1"],
      );

      expect(insertChain.values).toHaveBeenCalledWith([
        { transactionId: "txn-1", tagId: "tag-1" },
      ]);
    });

    it("checks ownership of tags and transactions against userId", async () => {
      await service.addTransactionTags(
        mockManager as any,
        userId,
        ["txn-1"],
        ["tag-1"],
      );

      expect(mockManager.find).toHaveBeenCalledWith(Tag, {
        where: { id: expect.anything(), userId },
      });
      expect(mockManager.count).toHaveBeenCalledWith(Transaction, {
        where: { id: expect.anything(), userId },
      });
    });

    it("refuses a foreign or missing tag before any write", async () => {
      mockManager.find.mockResolvedValue([mockTag]);

      await expect(
        service.addTransactionTags(
          mockManager as any,
          userId,
          ["txn-1"],
          ["tag-1", "tag-foreign"],
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockManager.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("refuses a foreign transaction before any write", async () => {
      mockManager.count.mockResolvedValue(1);

      await expect(
        service.addTransactionTags(
          mockManager as any,
          userId,
          ["txn-1", "txn-foreign"],
          ["tag-1"],
        ),
      ).rejects.toThrow("One or more transactions not found");
      expect(mockManager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("issues no query for empty transactionIds or tagIds", async () => {
      await service.addTransactionTags(
        mockManager as any,
        userId,
        [],
        ["tag-1"],
      );
      await service.addTransactionTags(
        mockManager as any,
        userId,
        ["txn-1"],
        [],
      );
      await service.removeTransactionTags(
        mockManager as any,
        userId,
        [],
        ["tag-1"],
      );
      await service.removeTransactionTags(
        mockManager as any,
        userId,
        ["txn-1"],
        [],
      );

      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.count).not.toHaveBeenCalled();
      expect(mockManager.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("removes only the named links", async () => {
      await service.removeTransactionTags(
        mockManager as any,
        userId,
        ["txn-1", "txn-2"],
        ["tag-1"],
      );

      expect(mockManager.delete).toHaveBeenCalledTimes(1);
      expect(mockManager.delete).toHaveBeenCalledWith(TransactionTag, {
        transactionId: expect.objectContaining({ value: ["txn-1", "txn-2"] }),
        tagId: expect.objectContaining({ value: ["tag-1"] }),
      });
      expect(mockManager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("refuses removal with a foreign tag without deleting", async () => {
      mockManager.find.mockResolvedValue([]);

      await expect(
        service.removeTransactionTags(
          mockManager as any,
          userId,
          ["txn-1"],
          ["tag-foreign"],
        ),
      ).rejects.toThrow(NotFoundException);
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("rejects more than 100 tags and more than 1000 transactions", async () => {
      const tags = Array.from({ length: 101 }, (_, i) => `tag-${i}`);
      const txns = Array.from({ length: 1001 }, (_, i) => `txn-${i}`);

      await expect(
        service.addTransactionTags(mockManager as any, userId, ["txn-1"], tags),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.removeTransactionTags(mockManager as any, userId, txns, [
          "tag-1",
        ]),
      ).rejects.toThrow(BadRequestException);
      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.createQueryBuilder).not.toHaveBeenCalled();
      expect(mockManager.delete).not.toHaveBeenCalled();
    });

    it("accepts exactly 100 tags and 1000 transactions", async () => {
      const tags = Array.from({ length: 100 }, (_, i) => `tag-${i}`);
      const txns = Array.from({ length: 1000 }, (_, i) => `txn-${i}`);

      await service.addTransactionTags(mockManager as any, userId, txns, tags);

      // 100000 links would bind 200000 parameters in one statement, above
      // PostgreSQL's 65535; they are written in batches that each fit.
      expect(insertChain.execute).toHaveBeenCalledTimes(
        100000 / TAG_LINK_INSERT_BATCH,
      );
      for (const [batch] of insertChain.values.mock.calls) {
        expect(batch.length * 2).toBeLessThanOrEqual(65535);
      }
    });
  });

  describe("setTransactionTagsBulk()", () => {
    beforeEach(() => {
      mockManager.find.mockReset();
      mockManager.delete.mockReset();
      mockManager.create.mockReset();
      mockManager.save.mockReset();
    });

    it("validates once and replaces tags with a single delete + insert", async () => {
      const transactionIds = ["txn-1", "txn-2"];
      const tagIds = ["tag-1", "tag-2"];
      mockManager.find.mockResolvedValue([mockTag, mockTag2]);
      mockManager.delete.mockResolvedValue(undefined);
      mockManager.create.mockImplementation((_entity, data) => data);
      mockManager.save.mockResolvedValue(undefined);

      await service.setTransactionTagsBulk(transactionIds, tagIds, userId);

      // tag set validated exactly once for all transactions
      expect(mockManager.find).toHaveBeenCalledTimes(1);
      // one bulk delete across all transactions
      expect(mockManager.delete).toHaveBeenCalledTimes(1);
      expect(mockManager.delete).toHaveBeenCalledWith(TransactionTag, {
        transactionId: expect.anything(),
      });
      // one save with the full cartesian product (2 txns x 2 tags)
      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(mockManager.save).toHaveBeenCalledWith(TransactionTag, [
        { transactionId: "txn-1", tagId: "tag-1" },
        { transactionId: "txn-1", tagId: "tag-2" },
        { transactionId: "txn-2", tagId: "tag-1" },
        { transactionId: "txn-2", tagId: "tag-2" },
      ]);
    });

    it("clears tags across all transactions when tagIds is empty", async () => {
      mockManager.delete.mockResolvedValue(undefined);

      await service.setTransactionTagsBulk(["txn-1", "txn-2"], [], userId);

      expect(mockManager.delete).toHaveBeenCalledTimes(1);
      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("does nothing when there are no transactions", async () => {
      await service.setTransactionTagsBulk([], ["tag-1"], userId);

      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.delete).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when a tag does not belong to the user", async () => {
      mockManager.find.mockResolvedValue([mockTag]); // 1 of 2 found

      await expect(
        service.setTransactionTagsBulk(
          ["txn-1"],
          ["tag-1", "tag-nope"],
          userId,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("setSplitTagsBulk()", () => {
    beforeEach(() => {
      mockManager.find.mockReset();
      mockManager.delete.mockReset();
      mockManager.create.mockReset();
      mockManager.save.mockReset();
    });

    it("validates once and replaces split tags with a single delete + insert", async () => {
      const splitIds = ["split-1", "split-2"];
      const tagIds = ["tag-1", "tag-2"];
      mockManager.find.mockResolvedValue([mockTag, mockTag2]);
      mockManager.delete.mockResolvedValue(undefined);
      mockManager.create.mockImplementation((_entity, data) => data);
      mockManager.save.mockResolvedValue(undefined);

      await service.setSplitTagsBulk(splitIds, tagIds, userId);

      expect(mockManager.find).toHaveBeenCalledTimes(1);
      expect(mockManager.delete).toHaveBeenCalledTimes(1);
      expect(mockManager.delete).toHaveBeenCalledWith(TransactionSplitTag, {
        transactionSplitId: expect.anything(),
      });
      expect(mockManager.save).toHaveBeenCalledTimes(1);
      expect(mockManager.save).toHaveBeenCalledWith(TransactionSplitTag, [
        { transactionSplitId: "split-1", tagId: "tag-1" },
        { transactionSplitId: "split-1", tagId: "tag-2" },
        { transactionSplitId: "split-2", tagId: "tag-1" },
        { transactionSplitId: "split-2", tagId: "tag-2" },
      ]);
    });

    it("clears tags across all splits when tagIds is empty", async () => {
      mockManager.delete.mockResolvedValue(undefined);

      await service.setSplitTagsBulk(["split-1", "split-2"], [], userId);

      expect(mockManager.delete).toHaveBeenCalledTimes(1);
      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("does nothing when there are no splits", async () => {
      await service.setSplitTagsBulk([], ["tag-1"], userId);

      expect(mockManager.find).not.toHaveBeenCalled();
      expect(mockManager.delete).not.toHaveBeenCalled();
      expect(mockManager.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when a tag does not belong to the user", async () => {
      mockManager.find.mockResolvedValue([mockTag]); // 1 of 2 found

      await expect(
        service.setSplitTagsBulk(["split-1"], ["tag-1", "tag-nope"], userId),
      ).rejects.toThrow(NotFoundException);
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
