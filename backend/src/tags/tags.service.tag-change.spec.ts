import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TagsService } from "./tags.service";
import { Tag } from "./entities/tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";

/**
 * The tag change an AI edit proposes (previewTagChange), the split-line
 * counterparts of addTransactionTags/removeTransactionTags, and the list the
 * AI tools read (getLlmTags).
 */
describe("TagsService (AI tag changes)", () => {
  const userId = "user-1";
  const tag = (id: string, name: string): Tag =>
    ({ id, userId, name, color: null, icon: null }) as Tag;
  const groceries = tag("tag-g", "Groceries");
  const travel = tag("tag-t", "Travel");

  let service: TagsService;
  let manager: {
    find: jest.Mock;
    count: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let insertChain: Record<string, jest.Mock>;

  beforeEach(() => {
    insertChain = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      find: jest.fn(),
      count: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(insertChain),
    };
    service = new TagsService({} as any, { record: jest.fn() } as any);
    jest
      .spyOn(service, "findByNames")
      .mockImplementation(async (_m, _u, names) =>
        [groceries, travel].filter((t) =>
          names.some((n) => n.trim().toLowerCase() === t.name.toLowerCase()),
        ),
      );
  });

  describe("previewTagChange()", () => {
    const preview = (carried: string[], add: string[], remove: string[] = []) =>
      service.previewTagChange(
        manager as any,
        userId,
        new Set(carried),
        add,
        remove,
      );

    it("adds only names the row does not carry, in the user's spelling", async () => {
      await expect(
        preview(["tag-g"], ["groceries", "TRAVEL", "Gifts"]),
      ).resolves.toEqual({
        tagNames: ["Travel", "Gifts"],
        newTagNames: ["Gifts"],
        removeTagIds: [],
        removeTagNames: [],
      });
    });

    it("removes only carried tags, by id", async () => {
      await expect(
        preview(["tag-g"], [], ["Groceries", "travel"]),
      ).resolves.toEqual({
        tagNames: [],
        newTagNames: [],
        removeTagIds: ["tag-g"],
        removeTagNames: ["Groceries"],
      });
    });

    it("counts a name once however it is spelled", async () => {
      const result = await preview([], ["Gifts", " gifts ", "GIFTS"]);
      expect(result.tagNames).toEqual(["Gifts"]);
    });

    it("refuses a name to remove that is none of the user's tags, naming the closest", async () => {
      manager.find.mockResolvedValue([groceries, travel]);
      await expect(preview(["tag-g"], [], ["Grocerie"])).rejects.toThrow(
        NotFoundException,
      );
      await expect(preview(["tag-g"], [], ["Grocerie"])).rejects.toThrow(
        /Groceries/,
      );
    });

    it("refuses a name both added and removed", async () => {
      await expect(preview([], ["Travel"], ["travel"])).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses more than 100 names in one edit", async () => {
      const names = Array.from({ length: 101 }, (_, i) => `Tag ${i}`);
      await expect(preview([], names)).rejects.toThrow(BadRequestException);
    });

    it("adds a tag missing from any place, and removes one carried on any place", async () => {
      // A transfer: the leg carries Groceries, its split line Travel.
      const result = await service.previewTagChange(
        manager as any,
        userId,
        {
          everywhere: new Set<string>(),
          anywhere: new Set(["tag-g", "tag-t"]),
        },
        ["Groceries"],
        ["Travel"],
      );
      expect(result.tagNames).toEqual(["Groceries"]);
      expect(result.removeTagIds).toEqual(["tag-t"]);
    });

    it("matches a stored name as it is, markup and all, before cleaning it", async () => {
      (service.findByNames as jest.Mock).mockResolvedValue([
        tag("tag-heart", "<3 Coffee"),
      ]);
      const result = await preview(["tag-heart"], ["<3 Coffee"], []);
      expect(result.tagNames).toEqual([]);
      const removal = await preview(["tag-heart"], [], ["<3 coffee"]);
      expect(removal.removeTagIds).toEqual(["tag-heart"]);
    });

    it("strips markup from a name it would create, as a tag's DTO does", async () => {
      const result = await preview([], ["<b>Gifts</b>"]);
      expect(result.newTagNames).toEqual(["bGifts/b"]);
      expect(result.newTagNames?.[0]).not.toMatch(/[<>]/);
    });

    it("reads nothing when nothing is asked", async () => {
      await expect(preview(["tag-g"], [" "], [])).resolves.toEqual({
        tagNames: [],
        newTagNames: [],
        removeTagIds: [],
        removeTagNames: [],
      });
      expect(service.findByNames).not.toHaveBeenCalled();
    });
  });

  describe("addSplitTags() / removeSplitTags()", () => {
    beforeEach(() => {
      manager.find.mockImplementation(
        async (_e: unknown, opts: { where: { id: { value: string[] } } }) =>
          opts.where.id.value.map((id) => ({ id })),
      );
      manager.count.mockImplementation(
        async (_e: unknown, opts: { where: { id: { value: string[] } } }) =>
          opts.where.id.value.length,
      );
    });

    it("adds every split x tag link with ON CONFLICT DO NOTHING", async () => {
      await service.addSplitTags(manager as any, userId, ["s1"], ["t1", "t2"]);
      expect(insertChain.into).toHaveBeenCalledWith(TransactionSplitTag);
      expect(insertChain.values).toHaveBeenCalledWith([
        { transactionSplitId: "s1", tagId: "t1" },
        { transactionSplitId: "s1", tagId: "t2" },
      ]);
      expect(insertChain.orIgnore).toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it("checks the splits belong to the user's transactions", async () => {
      await service.addSplitTags(manager as any, userId, ["s1"], ["t1"]);
      expect(manager.count).toHaveBeenCalledWith(TransactionSplit, {
        where: { id: expect.anything(), transaction: { userId } },
      });
    });

    it("refuses a foreign split before any write", async () => {
      manager.count.mockResolvedValue(0);
      await expect(
        service.addSplitTags(manager as any, userId, ["s-foreign"], ["t1"]),
      ).rejects.toThrow(NotFoundException);
      expect(insertChain.execute).not.toHaveBeenCalled();
    });

    it("refuses a foreign tag before any delete", async () => {
      manager.find.mockResolvedValue([]);
      await expect(
        service.removeSplitTags(manager as any, userId, ["s1"], ["t-foreign"]),
      ).rejects.toThrow(NotFoundException);
      expect(manager.delete).not.toHaveBeenCalled();
    });

    it("removes only the named links", async () => {
      await service.removeSplitTags(manager as any, userId, ["s1"], ["t1"]);
      expect(manager.delete).toHaveBeenCalledWith(TransactionSplitTag, {
        transactionSplitId: expect.objectContaining({ value: ["s1"] }),
        tagId: expect.objectContaining({ value: ["t1"] }),
      });
    });

    it("issues no query when there is nothing to change", async () => {
      await service.addSplitTags(manager as any, userId, [], ["t1"]);
      await service.removeSplitTags(manager as any, userId, ["s1"], []);
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });

  describe("getLlmTags()", () => {
    beforeEach(() => {
      jest
        .spyOn(service, "findAll")
        .mockResolvedValue([groceries, tag("tag-h", "Home: Repairs"), travel]);
      jest.spyOn(service, "getUsage").mockResolvedValue({
        "tag-g": { lastUsed: "2026-10-01", count: 4 },
      });
    });

    it("answers every tag with its use, unused ones at zero", async () => {
      await expect(service.getLlmTags(userId)).resolves.toEqual({
        tags: [
          {
            id: "tag-g",
            name: "Groceries",
            color: null,
            icon: null,
            useCount: 4,
            lastUsed: "2026-10-01",
          },
          {
            id: "tag-h",
            name: "Home: Repairs",
            color: null,
            icon: null,
            useCount: 0,
            lastUsed: null,
          },
          {
            id: "tag-t",
            name: "Travel",
            color: null,
            icon: null,
            useCount: 0,
            lastUsed: null,
          },
        ],
        total: 3,
        truncated: false,
      });
      // The owner's own usage: no delegate scope narrows it.
      expect(service.getUsage).toHaveBeenCalledWith(userId);
    });

    it("keeps names containing the search, case-insensitively", async () => {
      const result = await service.getLlmTags(userId, { search: " REPAIR " });
      expect(result.tags.map((t) => t.name)).toEqual(["Home: Repairs"]);
      expect(result.total).toBe(1);
    });

    it("says when the limit cut the list short", async () => {
      const result = await service.getLlmTags(userId, { limit: 2 });
      expect(result.tags).toHaveLength(2);
      expect(result).toMatchObject({ total: 3, truncated: true });
    });
  });
});
