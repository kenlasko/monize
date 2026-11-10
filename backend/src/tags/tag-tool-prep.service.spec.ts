import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { TagToolPrepService, tagPreviewRow } from "./tag-tool-prep.service";
import { Tag } from "./entities/tag.entity";
import { TransactionTag } from "./entities/transaction-tag.entity";
import { TransactionSplitTag } from "./entities/transaction-split-tag.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("TagToolPrepService", () => {
  const userId = "user-1";
  const tag = (id: string, name: string, color: string | null = null): Tag =>
    ({ id, userId, name, color, icon: null }) as Tag;
  const trip = tag("tag-trip", "Trip", "#ff5733");
  const home = tag("tag-home", "Home");

  let service: TagToolPrepService;
  let manager: ManagerMock;
  let tagsService: { findByNames: jest.Mock };

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    tagsService = {
      findByNames: jest.fn(async (_m, _u, names: string[]) =>
        [trip, home].filter((t) =>
          names.some((n) => n.trim().toLowerCase() === t.name.toLowerCase()),
        ),
      ),
    };
    manager.find.mockResolvedValue([trip, home]);
    service = new TagToolPrepService(
      mocks.dataSource as never,
      tagsService as never,
    );
  });

  describe("create", () => {
    it("previews a new tag, its colour and icon", async () => {
      await expect(
        service.prepareCreate(userId, {
          name: " Gifts ",
          color: "#00AA00",
          icon: "gift",
        }),
      ).resolves.toEqual({ name: "Gifts", color: "#00AA00", icon: "gift" });
    });

    it("refuses a name the user already has, however it is spelled", async () => {
      await expect(
        service.prepareCreate(userId, { name: "TRIP" }),
      ).rejects.toThrow(ConflictException);
    });

    it("refuses a colour that is not #RRGGBB", async () => {
      await expect(
        service.prepareCreate(userId, { name: "Gifts", color: "red" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a blank name", async () => {
      await expect(
        service.prepareCreate(userId, { name: "   " }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("update", () => {
    it("carries only what changes", async () => {
      await expect(
        service.prepareUpdate(userId, { name: "trip", newName: "Travel" }),
      ).resolves.toEqual({
        tagId: "tag-trip",
        currentName: "Trip",
        name: "Travel",
      });
    });

    it("reads an empty colour as clearing it, and the same colour as no change", async () => {
      await expect(
        service.prepareUpdate(userId, { name: "Trip", color: "" }),
      ).resolves.toMatchObject({ color: null });
      await expect(
        service.prepareUpdate(userId, { name: "Trip", color: "#FF5733" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses a rename onto another tag's name", async () => {
      await expect(
        service.prepareUpdate(userId, { name: "Trip", newName: "home" }),
      ).rejects.toThrow(ConflictException);
    });

    it("lets a tag change the case of its own name", async () => {
      await expect(
        service.prepareUpdate(userId, { name: "Trip", newName: "TRIP" }),
      ).resolves.toMatchObject({ name: "TRIP" });
    });

    it("refuses an unknown tag, naming the closest", async () => {
      await expect(
        service.prepareUpdate(userId, { name: "Trp", newName: "X" }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.prepareUpdate(userId, { name: "Trp", newName: "X" }),
      ).rejects.toThrow(/Trip/);
    });
  });

  describe("delete", () => {
    it("counts the transactions and split lines that lose the tag", async () => {
      manager.count.mockImplementation(async (entity: unknown) =>
        entity === TransactionTag ? 3 : entity === TransactionSplitTag ? 2 : 0,
      );
      await expect(
        service.prepareDelete(userId, { name: "trip" }),
      ).resolves.toEqual({ tagId: "tag-trip", name: "Trip", useCount: 5 });
    });
  });

  describe("prepareMany", () => {
    it("skips a row naming a tag an earlier row already creates", async () => {
      const result = await service.prepareMany(userId, "create", [
        { name: "Gifts" },
        { name: "gifts" },
        { name: "Trip" },
      ]);
      expect(result.okRows).toEqual([
        { name: "Gifts", color: null, icon: null },
      ]);
      expect(result.okIndex).toEqual([0]);
      expect(result.skipped.map((s) => s.index)).toEqual([1, 2]);
      expect(result.previewRows.map((r) => r.status)).toEqual([
        "ok",
        "error",
        "error",
      ]);
    });

    it("maps an edit to a batch row of only its changes", async () => {
      const result = await service.prepareMany(userId, "update", [
        { name: "Home", icon: "house" },
      ]);
      expect(result.okRows).toEqual([{ tagId: "tag-home", icon: "house" }]);
    });

    it("maps a deletion to the tag id", async () => {
      manager.count.mockResolvedValue(0);
      const result = await service.prepareMany(userId, "delete", [
        { name: "Home" },
      ]);
      expect(result.okRows).toEqual([{ tagId: "tag-home" }]);
      expect(result.previewRows[0]).toMatchObject({
        name: "Home",
        tagUseCount: 0,
      });
    });
  });

  describe("tagPreviewRow", () => {
    it("names the tag after the edit and the one it had", () => {
      expect(
        tagPreviewRow({
          tagId: "t",
          currentName: "Trip",
          name: "Travel",
          color: null,
        }),
      ).toEqual({
        status: "ok",
        name: "Travel",
        previousName: "Trip",
        tagColor: null,
      });
    });
  });
});
