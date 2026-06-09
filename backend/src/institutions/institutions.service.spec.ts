import { ConflictException, NotFoundException } from "@nestjs/common";
import { InstitutionsService } from "./institutions.service";

describe("InstitutionsService", () => {
  let service: InstitutionsService;
  let institutionsRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let qrManager: Record<string, jest.Mock>;
  let logoService: { fetchFavicon: jest.Mock };
  let actionHistory: { record: jest.Mock };

  const userId = "user-1";

  const buildInstitution = (overrides: Record<string, unknown> = {}) => ({
    id: "inst-1",
    userId,
    name: "TD Canada Trust",
    website: "https://td.com",
    country: "CA",
    hasLogo: true,
    logoFetchedAt: new Date("2024-01-01"),
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  });

  const chainableQb = (
    result: unknown,
    method: "getRawMany" | "getOne" | "getCount",
  ) => {
    const qb: Record<string, jest.Mock> = {};
    for (const m of ["select", "addSelect", "where", "andWhere", "groupBy"]) {
      qb[m] = jest.fn(() => qb);
    }
    qb[method] = jest.fn().mockResolvedValue(result);
    return qb;
  };

  beforeEach(() => {
    institutionsRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((x) => x),
      save: jest.fn((x) => Promise.resolve({ id: "inst-1", ...x })),
      remove: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(),
    };
    accountsRepo = {
      count: jest.fn().mockResolvedValue(0),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn((x) => Promise.resolve(x)),
      // Default: the logical-account count query resolves to 0. Individual
      // tests override this to assert specific counts.
      createQueryBuilder: jest.fn(() => chainableQb(0, "getCount")),
    };
    logoService = { fetchFavicon: jest.fn().mockResolvedValue(null) };
    actionHistory = { record: jest.fn() };

    qrManager = {
      findOne: jest.fn(),
      save: jest.fn((x) => Promise.resolve(x)),
    };
    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: qrManager,
    };
    const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    service = new InstitutionsService(
      institutionsRepo as any,
      accountsRepo as any,
      dataSource as any,
      logoService as any,
      actionHistory as any,
    );
  });

  describe("create()", () => {
    it("creates an institution, normalises the website, and caches the favicon", async () => {
      institutionsRepo.findOne.mockResolvedValue(null);
      logoService.fetchFavicon.mockResolvedValue({
        data: Buffer.from([1, 2, 3]),
        contentType: "image/png",
      });

      const result = await service.create(userId, {
        name: "TD Canada Trust",
        website: "td.com",
      });

      // Website normalised to absolute https URL before storage + favicon fetch.
      expect(institutionsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ website: "https://td.com", userId }),
      );
      expect(logoService.fetchFavicon).toHaveBeenCalledWith("https://td.com");
      const savedArg = institutionsRepo.save.mock.calls[0][0];
      expect(savedArg.hasLogo).toBe(true);
      expect(savedArg.logoData).toEqual(Buffer.from([1, 2, 3]));
      expect(result.hasLogo).toBe(true);
      expect(result.accountCount).toBe(0);
      // Cached bytes are never part of the client-facing view.
      expect((result as any).logoData).toBeUndefined();
      expect(actionHistory.record).toHaveBeenCalled();
    });

    it("uppercases the country code", async () => {
      institutionsRepo.findOne.mockResolvedValue(null);
      await service.create(userId, {
        name: "Acme",
        website: "https://acme.com",
        country: "ca",
      });
      expect(institutionsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ country: "CA" }),
      );
    });

    it("succeeds with no logo when the favicon cannot be fetched", async () => {
      institutionsRepo.findOne.mockResolvedValue(null);
      logoService.fetchFavicon.mockResolvedValue(null);

      const result = await service.create(userId, {
        name: "Acme",
        website: "https://acme.com",
      });

      expect(result.hasLogo).toBe(false);
    });

    it("throws ConflictException when the name already exists", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      await expect(
        service.create(userId, { name: "TD Canada Trust", website: "td.com" }),
      ).rejects.toThrow(ConflictException);
      expect(institutionsRepo.save).not.toHaveBeenCalled();
    });
  });

  describe("findAll()", () => {
    it("returns [] when the user has no institutions", async () => {
      institutionsRepo.find.mockResolvedValue([]);
      expect(await service.findAll(userId)).toEqual([]);
    });

    it("attaches per-institution account counts", async () => {
      institutionsRepo.find.mockResolvedValue([
        buildInstitution({ id: "inst-1" }),
        buildInstitution({ id: "inst-2", name: "Other" }),
      ]);
      accountsRepo.createQueryBuilder.mockReturnValue(
        chainableQb([{ institution_id: "inst-1", count: "2" }], "getRawMany"),
      );

      const result = await service.findAll(userId);

      expect(result.find((i) => i.id === "inst-1")!.accountCount).toBe(2);
      expect(result.find((i) => i.id === "inst-2")!.accountCount).toBe(0);
    });

    it("excludes the cash half of a linked investment pair from the counts", async () => {
      institutionsRepo.find.mockResolvedValue([buildInstitution({ id: "inst-1" })]);
      const qb = chainableQb(
        [{ institution_id: "inst-1", count: "1" }],
        "getRawMany",
      );
      accountsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll(userId);

      // A linked brokerage/cash pair counts once: the cash sub-account is
      // filtered out so the pair is represented by the brokerage account alone.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("account_sub_type"),
        { cashSubType: "INVESTMENT_CASH" },
      );
    });
  });

  describe("findOne()", () => {
    it("throws NotFoundException when missing", async () => {
      institutionsRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne(userId, "inst-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("returns the institution with its logical account count", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      const qb = chainableQb(4, "getCount");
      accountsRepo.createQueryBuilder.mockReturnValue(qb);
      const result = await service.findOne(userId, "inst-1");
      expect(result.accountCount).toBe(4);
      // The cash half of a linked investment pair is excluded from the count.
      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining("account_sub_type"),
        { cashSubType: "INVESTMENT_CASH" },
      );
    });
  });

  describe("update()", () => {
    it("throws ConflictException on a name clash with a different institution", async () => {
      institutionsRepo.findOne
        .mockResolvedValueOnce(buildInstitution())
        .mockResolvedValueOnce(buildInstitution({ id: "inst-2" }));
      await expect(
        service.update(userId, "inst-1", { name: "Other" }),
      ).rejects.toThrow(ConflictException);
    });

    it("re-fetches the favicon when the website changes", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      logoService.fetchFavicon.mockResolvedValue({
        data: Buffer.from([9]),
        contentType: "image/x-icon",
      });

      await service.update(userId, "inst-1", { website: "newbank.com" });

      expect(logoService.fetchFavicon).toHaveBeenCalledWith(
        "https://newbank.com",
      );
      const saved = institutionsRepo.save.mock.calls[0][0];
      expect(saved.website).toBe("https://newbank.com");
      expect(saved.hasLogo).toBe(true);
    });

    it("does not re-fetch the favicon when the website is unchanged", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      await service.update(userId, "inst-1", { website: "https://td.com" });
      expect(logoService.fetchFavicon).not.toHaveBeenCalled();
    });

    it("updates the country code", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      await service.update(userId, "inst-1", { country: "us" });
      const saved = institutionsRepo.save.mock.calls[0][0];
      expect(saved.country).toBe("US");
    });
  });

  describe("remove()", () => {
    it("removes the institution and records the action", async () => {
      const inst = buildInstitution();
      institutionsRepo.findOne.mockResolvedValue(inst);
      await service.remove(userId, "inst-1");
      expect(institutionsRepo.remove).toHaveBeenCalledWith(inst);
      expect(actionHistory.record).toHaveBeenCalled();
    });

    it("throws NotFoundException when missing", async () => {
      institutionsRepo.findOne.mockResolvedValue(null);
      await expect(service.remove(userId, "inst-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("refreshLogo()", () => {
    it("re-fetches and persists the favicon for the current website", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      logoService.fetchFavicon.mockResolvedValue({
        data: Buffer.from([7]),
        contentType: "image/png",
      });
      const result = await service.refreshLogo(userId, "inst-1");
      expect(logoService.fetchFavicon).toHaveBeenCalledWith("https://td.com");
      expect(result.hasLogo).toBe(true);
    });
  });

  describe("getLogo()", () => {
    it("throws NotFoundException when the institution is missing", async () => {
      institutionsRepo.createQueryBuilder.mockReturnValue(
        chainableQb(null, "getOne"),
      );
      await expect(service.getLogo(userId, "inst-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws NotFoundException when there is no cached logo", async () => {
      institutionsRepo.createQueryBuilder.mockReturnValue(
        chainableQb(
          buildInstitution({ hasLogo: false, logoData: null }),
          "getOne",
        ),
      );
      await expect(service.getLogo(userId, "inst-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("returns the cached bytes and content type", async () => {
      institutionsRepo.createQueryBuilder.mockReturnValue(
        chainableQb(
          buildInstitution({
            hasLogo: true,
            logoData: Buffer.from([5, 6]),
            logoContentType: "image/png",
          }),
          "getOne",
        ),
      );
      const result = await service.getLogo(userId, "inst-1");
      expect(result.data).toEqual(Buffer.from([5, 6]));
      expect(result.contentType).toBe("image/png");
    });

    it("falls back to image/png when content type is missing", async () => {
      institutionsRepo.createQueryBuilder.mockReturnValue(
        chainableQb(
          buildInstitution({
            hasLogo: true,
            logoData: Buffer.from([5]),
            logoContentType: null,
          }),
          "getOne",
        ),
      );
      const result = await service.getLogo(userId, "inst-1");
      expect(result.contentType).toBe("image/png");
    });
  });

  describe("getAccounts()", () => {
    it("lists accounts assigned to the institution", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      accountsRepo.find.mockResolvedValue([{ id: "acc-1" }]);
      const result = await service.getAccounts(userId, "inst-1");
      expect(accountsRepo.find).toHaveBeenCalledWith({
        where: { userId, institutionId: "inst-1" },
        order: { name: "ASC" },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe("assignAccount()", () => {
    it("assigns an owned account to the institution", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne.mockResolvedValue({
        id: "acc-1",
        institutionId: null,
        accountType: "CHEQUING",
        linkedAccountId: null,
      });
      await service.assignAccount(userId, "inst-1", "acc-1");
      const saved = qrManager.save.mock.calls[0][0];
      expect(saved.institutionId).toBe("inst-1");
    });

    it("syncs the linked investment partner when assigning", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne
        .mockResolvedValueOnce({
          id: "acc-1",
          institutionId: null,
          accountType: "INVESTMENT",
          linkedAccountId: "acc-2",
        })
        .mockResolvedValueOnce({
          id: "acc-2",
          institutionId: null,
          accountType: "INVESTMENT",
          linkedAccountId: "acc-1",
        });
      await service.assignAccount(userId, "inst-1", "acc-1");
      const saved = qrManager.save.mock.calls.map((c) => [
        c[0].id,
        c[0].institutionId,
      ]);
      expect(saved).toContainEqual(["acc-1", "inst-1"]);
      expect(saved).toContainEqual(["acc-2", "inst-1"]);
    });

    it("throws NotFoundException when the account does not belong to the user", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne.mockResolvedValue(null);
      await expect(
        service.assignAccount(userId, "inst-1", "acc-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("unassignAccount()", () => {
    it("clears the institution when the account is currently assigned to it", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne.mockResolvedValue({
        id: "acc-1",
        institutionId: "inst-1",
        accountType: "CHEQUING",
        linkedAccountId: null,
      });
      await service.unassignAccount(userId, "inst-1", "acc-1");
      const saved = qrManager.save.mock.calls[0][0];
      expect(saved.institutionId).toBeNull();
    });

    it("clears the linked investment partner too", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne
        .mockResolvedValueOnce({
          id: "acc-1",
          institutionId: "inst-1",
          accountType: "INVESTMENT",
          linkedAccountId: "acc-2",
        })
        .mockResolvedValueOnce({
          id: "acc-2",
          institutionId: "inst-1",
          accountType: "INVESTMENT",
          linkedAccountId: "acc-1",
        });
      await service.unassignAccount(userId, "inst-1", "acc-1");
      const saved = qrManager.save.mock.calls.map((c) => [
        c[0].id,
        c[0].institutionId,
      ]);
      expect(saved).toContainEqual(["acc-1", null]);
      expect(saved).toContainEqual(["acc-2", null]);
    });

    it("leaves the account untouched when assigned to a different institution", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne.mockResolvedValue({
        id: "acc-1",
        institutionId: "other",
        accountType: "CHEQUING",
        linkedAccountId: null,
      });
      await service.unassignAccount(userId, "inst-1", "acc-1");
      expect(qrManager.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the account is missing", async () => {
      institutionsRepo.findOne.mockResolvedValue(buildInstitution());
      qrManager.findOne.mockResolvedValue(null);
      await expect(
        service.unassignAccount(userId, "inst-1", "acc-1"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
