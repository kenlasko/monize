import {
  UnauthorizedException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { DelegationService, DELEGATE_2FA_REQUIRED } from "./delegation.service";

describe("DelegationService", () => {
  let service: DelegationService;
  let delegatesRepo: Record<string, jest.Mock>;
  let grantsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let prefsRepo: Record<string, jest.Mock>;
  let refreshRepo: Record<string, jest.Mock>;
  let accountsRepo: Record<string, jest.Mock>;
  let transactionsRepo: Record<string, jest.Mock>;
  let scheduledTxRepo: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  beforeEach(() => {
    delegatesRepo = { findOne: jest.fn(), find: jest.fn(), save: jest.fn() };
    grantsRepo = { findOne: jest.fn(), find: jest.fn(), count: jest.fn() };
    usersRepo = { findOne: jest.fn(), save: jest.fn() };
    prefsRepo = { findOne: jest.fn() };
    refreshRepo = { update: jest.fn() };
    accountsRepo = { find: jest.fn(), exists: jest.fn(), count: jest.fn() };
    transactionsRepo = { findOne: jest.fn() };
    scheduledTxRepo = { findOne: jest.fn() };
    emailService = { getStatus: jest.fn(), sendMail: jest.fn() };
    configService = { get: jest.fn() };
    dataSource = { transaction: jest.fn() };

    service = new DelegationService(
      delegatesRepo as any,
      grantsRepo as any,
      usersRepo as any,
      prefsRepo as any,
      refreshRepo as any,
      accountsRepo as any,
      transactionsRepo as any,
      scheduledTxRepo as any,
      emailService as any,
      configService as any,
      dataSource as any,
    );
  });

  describe("validateActingContext", () => {
    const args = {
      delegateUserId: "d1",
      actingAsUserId: "o1",
      delegationId: "g1",
    };

    it("rejects when the delegation is missing", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.validateActingContext(args)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects when the delegation is revoked", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "revoked",
        delegateUserId: "d1",
        ownerUserId: "o1",
      });
      await expect(service.validateActingContext(args)).rejects.toThrow(
        "Delegated access is no longer valid",
      );
    });

    it("rejects when the delegate id does not match the token", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: "someone-else",
        ownerUserId: "o1",
      });
      await expect(service.validateActingContext(args)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("rejects when the owner is inactive", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: "d1",
        ownerUserId: "o1",
      });
      usersRepo.findOne.mockResolvedValue({ id: "o1", isActive: false });
      await expect(service.validateActingContext(args)).rejects.toThrow(
        "Delegated access is no longer valid",
      );
    });

    it("throws DELEGATE_2FA_REQUIRED when owner needs 2FA and delegate lacks it", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        status: "active",
        delegateUserId: "d1",
        ownerUserId: "o1",
      });
      // owner active (validateActingContext call) then owner+pref for 2FA
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === "o1"
          ? { id: "o1", isActive: true, twoFactorSecret: "secret" }
          : { id: "d1", twoFactorSecret: null },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === "o1"
          ? { userId: "o1", twoFactorEnabled: true }
          : { userId: "d1", twoFactorEnabled: false },
      );

      await expect(service.validateActingContext(args)).rejects.toThrow(
        DELEGATE_2FA_REQUIRED,
      );
    });

    it("returns the delegation when everything checks out", async () => {
      const delegation = {
        id: "g1",
        status: "active",
        delegateUserId: "d1",
        ownerUserId: "o1",
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      usersRepo.findOne.mockResolvedValue({
        id: "o1",
        isActive: true,
        twoFactorSecret: null,
      });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      await expect(service.validateActingContext(args)).resolves.toBe(
        delegation,
      );
    });
  });

  describe("accountIdForTransaction", () => {
    it("returns the transaction's account id", async () => {
      transactionsRepo.findOne.mockResolvedValue({ accountId: "a1" });
      await expect(service.accountIdForTransaction("t1")).resolves.toBe("a1");
    });

    it("returns null when the transaction does not exist", async () => {
      transactionsRepo.findOne.mockResolvedValue(null);
      await expect(service.accountIdForTransaction("t1")).resolves.toBeNull();
    });
  });

  describe("accountIdsForTransfer", () => {
    it("returns both legs' accounts", async () => {
      transactionsRepo.findOne
        .mockResolvedValueOnce({ accountId: "a1", linkedTransactionId: "t2" })
        .mockResolvedValueOnce({ accountId: "a2" });
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
    });

    it("returns just the one account when there is no linked leg", async () => {
      transactionsRepo.findOne.mockResolvedValueOnce({
        accountId: "a1",
        linkedTransactionId: null,
      });
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([
        "a1",
      ]);
    });

    it("returns [] when the transaction does not exist", async () => {
      transactionsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.accountIdsForTransfer("t1")).resolves.toEqual([]);
    });
  });

  describe("accountIdsForScheduled", () => {
    it("returns [] when the scheduled row does not exist", async () => {
      scheduledTxRepo.findOne.mockResolvedValue(null);
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([]);
    });

    it("returns just the account for a non-transfer", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: false,
        transferAccountId: null,
      });
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
      ]);
    });

    it("returns both accounts for a transfer", async () => {
      scheduledTxRepo.findOne.mockResolvedValue({
        accountId: "a1",
        isTransfer: true,
        transferAccountId: "a2",
      });
      await expect(service.accountIdsForScheduled("s1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
    });
  });

  describe("hasReadAccess", () => {
    it("is true only when a can_read grant exists", async () => {
      grantsRepo.findOne.mockResolvedValue({ id: "x" });
      await expect(service.hasReadAccess("g1", "a1")).resolves.toBe(true);
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(service.hasReadAccess("g1", "a1")).resolves.toBe(false);
    });
  });

  describe("resolveSwitchTarget", () => {
    it("returns null for the delegate's own id (self)", async () => {
      await expect(service.resolveSwitchTarget("d1", "d1")).resolves.toBeNull();
    });

    it("throws when there is no active delegation for the target", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resolveSwitchTarget("d1", "o1"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("setGrants", () => {
    it("rejects accounts that do not belong to the owner", async () => {
      delegatesRepo.findOne.mockResolvedValue({ id: "g1", ownerUserId: "o1" });
      accountsRepo.find.mockResolvedValue([{ id: "a1" }]); // only 1 of 2 owned
      await expect(
        service.setGrants("o1", "g1", [
          { accountId: "a1", canRead: true },
          { accountId: "a2", canRead: true },
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("throws when the delegation is not owned by the caller", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.setGrants("o1", "g1", [])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("rejects CREATE/EDIT/DELETE without READ", async () => {
      delegatesRepo.findOne.mockResolvedValue({ id: "g1", ownerUserId: "o1" });
      await expect(
        service.setGrants("o1", "g1", [
          { accountId: "a1", canRead: false, canCreate: true },
        ]),
      ).rejects.toThrow(/READ access is required/);
    });

    it("persists per-account CRUD flags for readable accounts", async () => {
      delegatesRepo.findOne.mockResolvedValue({ id: "g1", ownerUserId: "o1" });
      accountsRepo.find.mockResolvedValue([{ id: "a1" }]);
      const saved: any[] = [];
      const manager = {
        delete: jest.fn(),
        create: jest.fn((_e, v) => v),
        save: jest.fn((rows) => saved.push(...rows)),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.setGrants("o1", "g1", [
        {
          accountId: "a1",
          canRead: true,
          canCreate: true,
          canEdit: false,
          canDelete: true,
        },
        // canRead=false -> dropped entirely (no access)
        { accountId: "a2", canRead: false },
      ]);

      expect(manager.delete).toHaveBeenCalled();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({
        delegationId: "g1",
        accountId: "a1",
        canRead: true,
        canCreate: true,
        canEdit: false,
        canDelete: true,
      });
    });
  });

  describe("hasAccountPermission", () => {
    it("is false when there is no readable grant", async () => {
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.hasAccountPermission("g1", "a1", "read"),
      ).resolves.toBe(false);
    });

    it("maps each operation to the matching flag", async () => {
      grantsRepo.findOne.mockResolvedValue({
        canRead: true,
        canCreate: true,
        canEdit: false,
        canDelete: true,
      });
      await expect(
        service.hasAccountPermission("g1", "a1", "read"),
      ).resolves.toBe(true);
      await expect(
        service.hasAccountPermission("g1", "a1", "create"),
      ).resolves.toBe(true);
      await expect(
        service.hasAccountPermission("g1", "a1", "edit"),
      ).resolves.toBe(false);
      await expect(
        service.hasAccountPermission("g1", "a1", "delete"),
      ).resolves.toBe(true);
    });
  });

  describe("delegateMustEnrollOwn2FA", () => {
    it("is false when the owner does not require 2FA", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", twoFactorSecret: null });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      await expect(service.delegateMustEnrollOwn2FA("o1", "d1")).resolves.toBe(
        false,
      );
    });

    it("is false when the delegate already has their own 2FA", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === "o1"
          ? { id: "o1", twoFactorSecret: "s" }
          : { id: "d1", twoFactorSecret: "d" },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === "o1"
          ? { twoFactorEnabled: true }
          : { twoFactorEnabled: true },
      );
      await expect(service.delegateMustEnrollOwn2FA("o1", "d1")).resolves.toBe(
        false,
      );
    });
  });

  describe("resolveSwitchTarget", () => {
    it("throws DELEGATE_2FA_REQUIRED when the target owner requires 2FA", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: "d1",
        ownerUserId: "o1",
        status: "active",
      });
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === "o1"
          ? { id: "o1", twoFactorSecret: "s" }
          : { id: "d1", twoFactorSecret: null },
      );
      prefsRepo.findOne.mockImplementation(({ where }: any) =>
        where.userId === "o1"
          ? { twoFactorEnabled: true }
          : { twoFactorEnabled: false },
      );
      await expect(service.resolveSwitchTarget("d1", "o1")).rejects.toThrow(
        DELEGATE_2FA_REQUIRED,
      );
    });

    it("returns the delegation when the switch is allowed", async () => {
      const delegation = {
        id: "g1",
        delegateUserId: "d1",
        ownerUserId: "o1",
        status: "active",
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      usersRepo.findOne.mockResolvedValue({ id: "o1", twoFactorSecret: null });
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });
      await expect(service.resolveSwitchTarget("d1", "o1")).resolves.toBe(
        delegation,
      );
    });
  });

  describe("getAvailableContexts", () => {
    it("returns [] when the user does not exist", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.getAvailableContexts("u1")).resolves.toEqual([]);
    });

    it("returns [] for a user with no delegations", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "u1" });
      delegatesRepo.find.mockResolvedValue([]);
      await expect(service.getAvailableContexts("u1")).resolves.toEqual([]);
    });

    it("includes a self context only when the user owns data", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === "u1"
          ? { id: "u1", firstName: "Del", lastName: "Egate" }
          : {
              id: "o1",
              firstName: "Own",
              lastName: "Er",
              twoFactorSecret: null,
            },
      );
      delegatesRepo.find.mockResolvedValue([
        {
          ownerUserId: "o1",
          owner: { id: "o1", firstName: "Own", lastName: "Er" },
        },
      ]);
      accountsRepo.exists.mockResolvedValue(true);
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      const res = await service.getAvailableContexts("u1");
      expect(res).toHaveLength(2);
      expect(res[0]).toEqual(
        expect.objectContaining({ userId: "u1", isSelf: true }),
      );
      expect(res[1]).toEqual(
        expect.objectContaining({ userId: "o1", isSelf: false }),
      );
    });

    it("omits the self context when the user owns no data", async () => {
      usersRepo.findOne.mockImplementation(({ where }: any) =>
        where.id === "u1" ? { id: "u1" } : { id: "o1", twoFactorSecret: null },
      );
      delegatesRepo.find.mockResolvedValue([
        { ownerUserId: "o1", owner: null },
      ]);
      accountsRepo.exists.mockResolvedValue(false);
      prefsRepo.findOne.mockResolvedValue({ twoFactorEnabled: false });

      const res = await service.getAvailableContexts("u1");
      expect(res).toHaveLength(1);
      expect(res[0].isSelf).toBe(false);
      expect(res[0].label).toBe("o1");
    });
  });

  describe("listDelegates", () => {
    it("maps delegations to a safe summary", async () => {
      delegatesRepo.find.mockResolvedValue([
        {
          id: "g1",
          status: "active",
          createdAt: new Date("2026-01-01"),
          delegateUserId: "d1",
          delegate: {
            email: "d@e.f",
            firstName: "D",
            lastName: null,
            passwordHash: "h",
          },
          payeesCanCreate: true,
          payeesCanEdit: true,
          payeesCanDelete: false,
          categoriesCanCreate: false,
          categoriesCanEdit: false,
          categoriesCanDelete: false,
          tagsCanCreate: true,
          tagsCanEdit: false,
          tagsCanDelete: false,
          grants: [
            {
              accountId: "a1",
              canRead: true,
              canCreate: true,
              canEdit: false,
              canDelete: false,
            },
            { accountId: "a2", canRead: false },
          ],
        },
      ]);
      const res = await service.listDelegates("o1");
      expect(res[0]).toEqual({
        id: "g1",
        status: "active",
        createdAt: new Date("2026-01-01"),
        delegate: {
          id: "d1",
          email: "d@e.f",
          firstName: "D",
          lastName: null,
          hasPassword: true,
        },
        grants: [
          {
            accountId: "a1",
            canRead: true,
            canCreate: true,
            canEdit: false,
            canDelete: false,
          },
        ],
        capabilities: {
          payees: { create: true, edit: true, delete: false },
          categories: { create: false, edit: false, delete: false },
          tags: { create: true, edit: false, delete: false },
        },
        sections: {
          bills: false,
          investments: false,
          budgets: false,
          reports: false,
          ai: false,
        },
      });
    });

    it("includes granted sections in the summary", async () => {
      delegatesRepo.find.mockResolvedValue([
        {
          id: "g1",
          status: "active",
          createdAt: new Date("2026-01-01"),
          delegateUserId: "d1",
          delegate: { email: "d@e.f", passwordHash: "h" },
          billsCanRead: true,
          reportsCanRead: true,
          grants: [],
        },
      ]);
      const res = await service.listDelegates("o1");
      expect(res[0].sections).toEqual({
        bills: true,
        investments: false,
        budgets: false,
        reports: true,
        ai: false,
      });
    });
  });

  describe("hasCapability", () => {
    it("is false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.hasCapability("g1", "payees", "create"),
      ).resolves.toBe(false);
    });

    it("maps resource+operation to the matching flag", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        payeesCanCreate: true,
        payeesCanEdit: false,
        payeesCanDelete: false,
        categoriesCanEdit: true,
        tagsCanDelete: true,
      });
      await expect(
        service.hasCapability("g1", "payees", "create"),
      ).resolves.toBe(true);
      await expect(service.hasCapability("g1", "payees", "edit")).resolves.toBe(
        false,
      );
      await expect(
        service.hasCapability("g1", "categories", "edit"),
      ).resolves.toBe(true);
      await expect(service.hasCapability("g1", "tags", "delete")).resolves.toBe(
        true,
      );
    });
  });

  describe("getCapabilities", () => {
    it("returns the nested capability set for an active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        payeesCanCreate: true,
        payeesCanEdit: false,
        payeesCanDelete: true,
        categoriesCanCreate: false,
        categoriesCanEdit: true,
        categoriesCanDelete: false,
        tagsCanCreate: false,
        tagsCanEdit: false,
        tagsCanDelete: false,
      });
      await expect(service.getCapabilities("g1")).resolves.toEqual({
        payees: { create: true, edit: false, delete: true },
        categories: { create: false, edit: true, delete: false },
        tags: { create: false, edit: false, delete: false },
      });
    });

    it("returns all-false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.getCapabilities("g1")).resolves.toEqual({
        payees: { create: false, edit: false, delete: false },
        categories: { create: false, edit: false, delete: false },
        tags: { create: false, edit: false, delete: false },
      });
    });
  });

  describe("setCapabilities", () => {
    it("throws when the delegation is not owned by the caller", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.setCapabilities("o1", "g1", { payeesCanCreate: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("updates only the provided flags", async () => {
      const delegation = {
        id: "g1",
        ownerUserId: "o1",
        payeesCanCreate: false,
        payeesCanEdit: false,
        categoriesCanEdit: true,
        tagsCanDelete: false,
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      delegatesRepo.save.mockResolvedValue(delegation);

      await service.setCapabilities("o1", "g1", {
        payeesCanCreate: true,
        tagsCanDelete: true,
      });

      expect(delegation.payeesCanCreate).toBe(true);
      expect(delegation.tagsCanDelete).toBe(true);
      expect(delegation.payeesCanEdit).toBe(false); // unchanged
      expect(delegation.categoriesCanEdit).toBe(true); // unchanged
      expect(delegatesRepo.save).toHaveBeenCalledWith(delegation);
    });
  });

  describe("hasSection", () => {
    it("is false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.hasSection("g1", "bills")).resolves.toBe(false);
    });

    it("maps the section to the matching flag", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        billsCanRead: true,
        investmentsCanRead: false,
        budgetsCanRead: true,
      });
      await expect(service.hasSection("g1", "bills")).resolves.toBe(true);
      await expect(service.hasSection("g1", "investments")).resolves.toBe(
        false,
      );
      await expect(service.hasSection("g1", "budgets")).resolves.toBe(true);
      await expect(service.hasSection("g1", "ai")).resolves.toBe(false);
    });
  });

  describe("getSections", () => {
    it("returns the section set for an active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        billsCanRead: true,
        investmentsCanRead: false,
        budgetsCanRead: false,
        reportsCanRead: true,
        aiCanRead: true,
      });
      await expect(service.getSections("g1")).resolves.toEqual({
        bills: true,
        investments: false,
        budgets: false,
        reports: true,
        ai: true,
      });
    });

    it("returns all-false when there is no active delegation", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.getSections("g1")).resolves.toEqual({
        bills: false,
        investments: false,
        budgets: false,
        reports: false,
        ai: false,
      });
    });
  });

  describe("setSectionGrants", () => {
    it("throws when the delegation is not owned by the caller", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.setSectionGrants("o1", "g1", { billsCanRead: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("updates only the provided sections", async () => {
      const delegation = {
        id: "g1",
        ownerUserId: "o1",
        billsCanRead: false,
        investmentsCanRead: true,
        reportsCanRead: false,
      };
      delegatesRepo.findOne.mockResolvedValue(delegation);
      delegatesRepo.save.mockResolvedValue(delegation);

      await service.setSectionGrants("o1", "g1", {
        billsCanRead: true,
        reportsCanRead: true,
      });

      expect(delegation.billsCanRead).toBe(true);
      expect(delegation.reportsCanRead).toBe(true);
      expect(delegation.investmentsCanRead).toBe(true); // unchanged
      expect(delegatesRepo.save).toHaveBeenCalledWith(delegation);
    });
  });

  describe("revokeDelegate", () => {
    it("throws when the delegation is not found", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(service.revokeDelegate("o1", "g1")).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    function managerFor(counts: {
      otherDelegations: number;
      ownsAccounts: number;
      ownsDelegations: number;
      role?: string;
    }) {
      const manager: any = {
        delete: jest.fn(),
        count: jest
          .fn()
          .mockResolvedValueOnce(counts.otherDelegations)
          .mockResolvedValueOnce(counts.ownsAccounts)
          .mockResolvedValueOnce(counts.ownsDelegations),
        findOne: jest
          .fn()
          .mockResolvedValue({ id: "d1", role: counts.role ?? "user" }),
      };
      return manager;
    }

    it("fully deletes a pure delegate with no other ties", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: "o1",
        delegateUserId: "d1",
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 0,
        ownsDelegations: 0,
      });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.revokeDelegate("o1", "g1");

      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "g1",
      });
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "d1",
      });
    });

    it("keeps the user when they delegate for someone else", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: "o1",
        delegateUserId: "d1",
      });
      const manager = managerFor({
        otherDelegations: 1,
        ownsAccounts: 0,
        ownsDelegations: 0,
      });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.revokeDelegate("o1", "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1); // delegation only
      expect(manager.delete).toHaveBeenCalledWith(expect.anything(), {
        id: "g1",
      });
    });

    it("keeps the user when they own data of their own", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: "o1",
        delegateUserId: "d1",
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 3,
        ownsDelegations: 0,
      });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.revokeDelegate("o1", "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1);
    });

    it("keeps an admin delegate", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        ownerUserId: "o1",
        delegateUserId: "d1",
      });
      const manager = managerFor({
        otherDelegations: 0,
        ownsAccounts: 0,
        ownsDelegations: 0,
        role: "admin",
      });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.revokeDelegate("o1", "g1");

      expect(manager.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe("isDelegateUser", () => {
    it("is true when the user has at least one delegation", async () => {
      delegatesRepo.count = jest.fn().mockResolvedValue(2);
      await expect(service.isDelegateUser("d1")).resolves.toBe(true);
    });

    it("is false when the user has no delegations", async () => {
      delegatesRepo.count = jest.fn().mockResolvedValue(0);
      await expect(service.isDelegateUser("d1")).resolves.toBe(false);
    });
  });

  describe("resetDelegatePassword", () => {
    it("throws when the delegation is not found", async () => {
      delegatesRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resetDelegatePassword("o1", "g1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects an SSO delegate", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: "d1",
      });
      usersRepo.findOne.mockResolvedValue({ id: "d1", oidcSubject: "sso" });
      await expect(service.resetDelegatePassword("o1", "g1")).rejects.toThrow(
        /SSO/,
      );
    });

    it("sets a temporary password and revokes sessions", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: "d1",
      });
      const delegate = {
        id: "d1",
        oidcSubject: null,
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60000),
      };
      usersRepo.findOne.mockResolvedValue(delegate);
      usersRepo.save.mockResolvedValue(delegate);
      const res = await service.resetDelegatePassword("o1", "g1");
      expect(res.temporaryPassword).toBeTruthy();
      expect((delegate as any).mustChangePassword).toBe(true);
      // Owner reset must clear any lockout so the delegate can sign in.
      expect((delegate as any).failedLoginAttempts).toBe(0);
      expect((delegate as any).lockedUntil).toBeNull();
      expect(refreshRepo.update).toHaveBeenCalledWith(
        { userId: "d1", isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe("delegateEmailExists", () => {
    it("is true when a user with the (normalized) email exists", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "u1" });
      await expect(service.delegateEmailExists("  Foo@Bar.Com ")).resolves.toBe(
        true,
      );
      expect(usersRepo.findOne).toHaveBeenCalledWith({
        where: { email: "foo@bar.com" },
      });
    });

    it("is false when no user has that email", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.delegateEmailExists("x@y.z")).resolves.toBe(false);
    });
  });

  describe("createDelegate", () => {
    const makeManager = () => {
      const manager: any = {
        findOne: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn((_e: any, v: any) => v),
        save: jest.fn((v: any) => ({ id: "g-new", ...v })),
      };
      return manager;
    };

    it("throws when the owner is not found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.createDelegate("o1", { email: "a@b.c" } as any),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("rejects delegating to your own email", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "me@x.y" });
      await expect(
        service.createDelegate("o1", { email: "ME@x.y" } as any),
      ).rejects.toThrow(/yourself/);
    });

    it("auto-generates a temporary password for a brand-new delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null); // no existing user, no delegation
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      const res = await service.createDelegate("o1", {
        email: "new@x.y",
      } as any);
      expect(res.temporaryPassword).toBeTruthy();
      expect(res.invited).toBe(false);
    });

    it("clears lockout when the owner sets a password for a locked delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const lockedUser = {
        id: "d1",
        email: "new@x.y",
        oidcSubject: null,
        role: "user",
        passwordHash: "old-hash",
        failedLoginAttempts: 5,
        lockedUntil: new Date(Date.now() + 60000),
      };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(lockedUser) // User by email
        .mockResolvedValueOnce(null); // no existing delegation
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      await service.createDelegate("o1", {
        email: "new@x.y",
        password: "StrongPass1!xyz",
      } as any);
      expect(lockedUser.failedLoginAttempts).toBe(0);
      expect(lockedUser.lockedUntil).toBeNull();
      expect(lockedUser.passwordHash).not.toBe("old-hash");
    });

    it("sends an invite when sendInvite is set and SMTP is configured", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: true });
      emailService.sendMail.mockResolvedValue(undefined);
      configService.get.mockReturnValue("http://app");
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      const res = await service.createDelegate("o1", {
        email: "new@x.y",
        sendInvite: true,
      } as any);
      expect(res.invited).toBe(true);
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    it("rejects an invite when SMTP is not configured", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: false });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      await expect(
        service.createDelegate("o1", {
          email: "new@x.y",
          sendInvite: true,
        } as any),
      ).rejects.toThrow(/SMTP/);
    });

    it("uses an owner-supplied password without forcing a change", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValue(null);
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      const res = await service.createDelegate("o1", {
        email: "new@x.y",
        password: "StrongPass1!xyz",
      } as any);
      expect(res.temporaryPassword).toBeUndefined();
      expect(res.invited).toBe(false);
    });

    it("reactivates a previously revoked delegation for an existing user", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const manager = makeManager();
      const existingDelegation = { id: "g1", status: "revoked" };
      manager.findOne
        .mockResolvedValueOnce({ id: "d1" }) // existing user
        .mockResolvedValueOnce(existingDelegation); // existing delegation
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      await service.createDelegate("o1", { email: "new@x.y" } as any);
      expect(existingDelegation.status).toBe("active");
    });

    it("conflicts when the user is already an active delegate", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce({ id: "d1" })
        .mockResolvedValueOnce({ id: "g1", status: "active" });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      await expect(
        service.createDelegate("o1", { email: "new@x.y" } as any),
      ).rejects.toThrow(/already a delegate/);
    });

    it("rejects when the existing user is the owner themselves", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const manager = makeManager();
      manager.findOne.mockResolvedValueOnce({ id: "o1" });
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      await expect(
        service.createDelegate("o1", { email: "new@x.y" } as any),
      ).rejects.toThrow(/yourself/);
    });

    it("sets a password on an existing passwordless pure-delegate (re-link)", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const existing = { id: "d1", passwordHash: null };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(existing) // existing user
        .mockResolvedValueOnce(null); // no delegation yet
      // count(Account)=0, count(AccountDelegate owner)=0 -> pure delegate
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      await service.createDelegate("o1", {
        email: "shared@x.y",
        password: "StrongPass1!xyz",
      } as any);

      expect(existing.passwordHash).toBeTruthy();
      expect(
        await bcrypt.compare("StrongPass1!xyz", existing.passwordHash as any),
      ).toBe(true);
    });

    it("never touches credentials of an existing full user", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      const existing = {
        id: "d1",
        passwordHash: "ORIGINAL",
        oidcSubject: null,
        role: "user",
      };
      const manager = makeManager();
      manager.findOne
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce(null);
      manager.count.mockResolvedValue(2); // owns accounts -> full user
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));

      const res = await service.createDelegate("o1", {
        email: "full@x.y",
        password: "StrongPass1!xyz",
      } as any);

      expect(existing.passwordHash).toBe("ORIGINAL");
      expect(res.temporaryPassword).toBeUndefined();
    });

    it("logs (does not throw) when the invite email fails to send", async () => {
      usersRepo.findOne.mockResolvedValue({ id: "o1", email: "own@x.y" });
      emailService.getStatus.mockReturnValue({ configured: true });
      emailService.sendMail.mockRejectedValue(new Error("smtp down"));
      configService.get.mockReturnValue("http://app");
      const manager: any = {
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn((_e: any, v: any) => v),
        save: jest.fn((v: any) => ({ id: "g-new", ...v })),
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      const res = await service.createDelegate("o1", {
        email: "new@x.y",
        sendInvite: true,
      } as any);
      expect(res.invited).toBe(true);
      await new Promise((r) => setImmediate(r));
      expect(emailService.sendMail).toHaveBeenCalled();
    });
  });

  describe("readableAccountIds", () => {
    it("returns the account ids of READ grants", async () => {
      grantsRepo.find.mockResolvedValue([
        { accountId: "a1" },
        { accountId: "a2" },
      ]);
      await expect(service.readableAccountIds("g1")).resolves.toEqual([
        "a1",
        "a2",
      ]);
      expect(grantsRepo.find).toHaveBeenCalledWith({
        where: { delegationId: "g1", canRead: true },
        select: ["accountId"],
      });
    });
  });

  describe("hasTransactionalAccess", () => {
    it("is false when there are no readable accounts", async () => {
      grantsRepo.find.mockResolvedValue([]);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(false);
      expect(accountsRepo.count).not.toHaveBeenCalled();
    });

    it("is false when every readable account is an investment account", async () => {
      grantsRepo.find.mockResolvedValue([{ accountId: "a1" }]);
      accountsRepo.count.mockResolvedValue(0);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(false);
    });

    it("is true when at least one readable account is non-investment", async () => {
      grantsRepo.find.mockResolvedValue([
        { accountId: "a1" },
        { accountId: "a2" },
      ]);
      accountsRepo.count.mockResolvedValue(1);
      await expect(service.hasTransactionalAccess("g1")).resolves.toBe(true);
    });
  });

  describe("hasAnyAccountAccess", () => {
    it("is false when the delegate has no readable account grant", async () => {
      grantsRepo.count.mockResolvedValue(0);
      await expect(service.hasAnyAccountAccess("g1")).resolves.toBe(false);
      expect(grantsRepo.count).toHaveBeenCalledWith({
        where: { delegationId: "g1", canRead: true },
      });
    });

    it("is true when the delegate can read at least one account", async () => {
      grantsRepo.count.mockResolvedValue(2);
      await expect(service.hasAnyAccountAccess("g1")).resolves.toBe(true);
    });
  });

  describe("resetDelegatePassword (missing delegate user)", () => {
    it("throws when the delegate user no longer exists", async () => {
      delegatesRepo.findOne.mockResolvedValue({
        id: "g1",
        delegateUserId: "d1",
      });
      usersRepo.findOne.mockResolvedValue(null);
      await expect(
        service.resetDelegatePassword("o1", "g1"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
