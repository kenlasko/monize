import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  JointAccountsService,
  JOINT_WRITABLE_ACCOUNT_TYPES,
} from "./joint-accounts.service";
import { CrossOwnerAccessService } from "./cross-owner-access.service";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { Payee } from "../payees/entities/payee.entity";
import { User } from "../users/entities/user.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { DelegateNetWorthExclusion } from "./entities/delegate-net-worth-exclusion.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { Currency } from "../currencies/entities/currency.entity";
import { currencyPlacesRepoMock } from "../test-helpers/currency-places-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("JointAccountsService", () => {
  let service: JointAccountsService;
  let crossOwner: jest.Mocked<
    Pick<CrossOwnerAccessService, "accountAccessFor">
  >;
  let accountsRepo: Record<string, jest.Mock>;
  let delegatesRepo: Record<string, jest.Mock>;
  let grantsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let exclusionsRepo: Record<string, jest.Mock>;
  let categoriesRepo: Record<string, jest.Mock>;
  let payeesRepo: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;

  const GRANTEE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const DELEGATION_ID = "44444444-4444-4444-8444-444444444444";

  const chequing = {
    id: ACCOUNT_ID,
    userId: OWNER,
    accountType: "CHEQUING",
    name: "Household",
    currentBalance: 100,
  } as unknown as Account;
  const investment = {
    ...chequing,
    accountType: "INVESTMENT",
  } as unknown as Account;

  const activeDelegation = {
    id: DELEGATION_ID,
    ownerUserId: OWNER,
    delegateUserId: GRANTEE,
    status: "active",
  } as AccountDelegate;

  function grant(flags: Partial<AccountDelegateGrant> = {}) {
    return {
      id: "g1",
      delegationId: DELEGATION_ID,
      accountId: ACCOUNT_ID,
      canRead: true,
      canCreate: true,
      canEdit: true,
      canDelete: false,
      isJoint: true,
      ...flags,
    } as AccountDelegateGrant;
  }

  const ownerUser = {
    id: OWNER,
    firstName: "Olive",
    lastName: "Owner",
    email: "olive@example.com",
  } as User;

  beforeEach(() => {
    accountsRepo = { findOne: jest.fn(), find: jest.fn(), exists: jest.fn() };
    delegatesRepo = { findOne: jest.fn(), find: jest.fn() };
    grantsRepo = { findOne: jest.fn(), find: jest.fn() };
    usersRepo = { find: jest.fn(), findOne: jest.fn() };
    exclusionsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn((v) => v),
      delete: jest.fn(),
    };
    categoriesRepo = { find: jest.fn().mockResolvedValue([]) };
    payeesRepo = { find: jest.fn().mockResolvedValue([]) };
    const scoped = createScopedDbMocks([
      [Currency, currencyPlacesRepoMock({ BTC: 8 })],
      [Account, accountsRepo as never],
      [AccountDelegate, delegatesRepo as never],
      [AccountDelegateGrant, grantsRepo as never],
      [User, usersRepo as never],
      [DelegateNetWorthExclusion, exclusionsRepo as never],
      [Category, categoriesRepo as never],
      [Payee, payeesRepo as never],
    ]);
    manager = scoped.manager;
    crossOwner = { accountAccessFor: jest.fn() };
    service = new JointAccountsService(
      scoped.dataSource as never,
      crossOwner as never,
    );
  });

  describe("jointGrantsFor / jointAccountIdSetFor", () => {
    it("returns only can_read AND is_joint grants under active delegations", async () => {
      delegatesRepo.find.mockResolvedValue([activeDelegation]);
      grantsRepo.find.mockResolvedValue([grant()]);
      usersRepo.find.mockResolvedValue([ownerUser]);

      const grants = await service.jointGrantsFor(GRANTEE);

      expect([...grants.keys()]).toEqual([ACCOUNT_ID]);
      expect(grants.get(ACCOUNT_ID)).toEqual({
        delegationId: DELEGATION_ID,
        ownerUserId: OWNER,
        ownerLabel: "Olive Owner",
        permissions: { canCreate: true, canEdit: true, canDelete: false },
      });
      // The grant query itself excludes plain (non-joint) grants.
      expect(grantsRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ canRead: true, isJoint: true }),
        }),
      );
    });

    it("returns an empty map with no active delegations, without querying grants", async () => {
      delegatesRepo.find.mockResolvedValue([]);
      expect((await service.jointGrantsFor(GRANTEE)).size).toBe(0);
      expect(grantsRepo.find).not.toHaveBeenCalled();
    });

    it("falls back to the owner id when the owner row is not loadable", async () => {
      delegatesRepo.find.mockResolvedValue([activeDelegation]);
      grantsRepo.find.mockResolvedValue([grant()]);
      usersRepo.find.mockResolvedValue([]);

      const grants = await service.jointGrantsFor(GRANTEE);
      expect(grants.get(ACCOUNT_ID)!.ownerLabel).toBe(OWNER);
    });

    it("jointAccountIdSetFor returns the granted ids without loading owners", async () => {
      delegatesRepo.find.mockResolvedValue([activeDelegation]);
      grantsRepo.find.mockResolvedValue([grant()]);

      const ids = await service.jointAccountIdSetFor(GRANTEE);
      expect([...ids]).toEqual([ACCOUNT_ID]);
      expect(usersRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("jointAccountsFor", () => {
    beforeEach(() => {
      delegatesRepo.find.mockResolvedValue([activeDelegation]);
      usersRepo.find.mockResolvedValue([ownerUser]);
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes("futureSum")) {
          return Promise.resolve([
            { accountId: ACCOUNT_ID, futureSum: "25.5" },
          ]);
        }
        return Promise.resolve([
          { accountId: ACCOUNT_ID, currentBalance: "150.25" },
        ]);
      });
    });

    it("enriches joint rows with owner label, permissions, live balance and overlay", async () => {
      grantsRepo.find.mockResolvedValue([grant()]);
      accountsRepo.find.mockResolvedValue([chequing]);

      const [row] = await service.jointAccountsFor(GRANTEE);

      expect(row.isJoint).toBe(true);
      expect(row.ownerLabel).toBe("Olive Owner");
      expect(row.jointPermissions).toEqual({
        canCreate: true,
        canEdit: true,
        canDelete: false,
      });
      expect(row.currentBalance).toBe(150.25);
      expect(row.futureTransactionsSum).toBe(25.5);
      // Account-object deletability is owner-only.
      expect(row.canDelete).toBe(false);
      // No exclusion row -> included in the grantee's net worth by default.
      expect(row.excludeFromNetWorth).toBe(false);
    });

    it("keeps a joint BTC wallet's balance at its eight places (INV-MONEY-001)", async () => {
      grantsRepo.find.mockResolvedValue([grant()]);
      accountsRepo.find.mockResolvedValue([
        { ...chequing, accountType: "CRYPTO", currencyCode: "BTC" } as never,
      ]);
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes("futureSum")
            ? [{ accountId: ACCOUNT_ID, futureSum: "-0.00002500" }]
            : [{ accountId: ACCOUNT_ID, currentBalance: "0.01249993" }],
        ),
      );

      const [row] = await service.jointAccountsFor(GRANTEE);

      // At four places the wallet read 0.0125 and the pending fee zero.
      expect(row.currentBalance).toBe(0.01249993);
      expect(row.futureTransactionsSum).toBe(-0.000025);
    });

    it("masks write permissions to false for a non-writable account type regardless of the grant", async () => {
      grantsRepo.find.mockResolvedValue([
        grant({ canCreate: true, canEdit: true, canDelete: true }),
      ]);
      accountsRepo.find.mockResolvedValue([investment]);

      const [row] = await service.jointAccountsFor(GRANTEE);
      expect(row.jointPermissions).toEqual({
        canCreate: false,
        canEdit: false,
        canDelete: false,
      });
    });

    it("overlays the grantee's exclusion, not the owner's flag", async () => {
      grantsRepo.find.mockResolvedValue([grant()]);
      accountsRepo.find.mockResolvedValue([
        { ...chequing, excludeFromNetWorth: false } as never,
      ]);
      exclusionsRepo.find.mockResolvedValue([{ accountId: ACCOUNT_ID }]);

      const [row] = await service.jointAccountsFor(GRANTEE);
      expect(row.excludeFromNetWorth).toBe(true);
    });

    it("returns [] with no joint grants", async () => {
      grantsRepo.find.mockResolvedValue([]);
      expect(await service.jointAccountsFor(GRANTEE)).toEqual([]);
      expect(accountsRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("jointAccessFor", () => {
    it("authorizes a joint-granted writable account through the cross-owner check", async () => {
      crossOwner.accountAccessFor.mockResolvedValue({
        account: chequing,
        ownerUserId: OWNER,
        via: "delegation",
      });
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(grant());

      const access = await service.jointAccessFor(
        GRANTEE,
        ACCOUNT_ID,
        "create",
      );
      expect(access.ownerUserId).toBe(OWNER);
      expect(crossOwner.accountAccessFor).toHaveBeenCalledWith(
        GRANTEE,
        ACCOUNT_ID,
        "create",
      );
      // The joint probe demands the flag itself.
      expect(grantsRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ isJoint: true }),
        }),
      );
    });

    it("404s a plain (non-joint) grant even though the cross-owner check passes", async () => {
      crossOwner.accountAccessFor.mockResolvedValue({
        account: chequing,
        ownerUserId: OWNER,
        via: "delegation",
      });
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(null);

      await expect(
        service.jointAccessFor(GRANTEE, ACCOUNT_ID, "read"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("propagates the cross-owner 404 for unknown or unreadable accounts", async () => {
      crossOwner.accountAccessFor.mockRejectedValue(new NotFoundException());
      await expect(
        service.jointAccessFor(GRANTEE, ACCOUNT_ID, "read"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(grantsRepo.findOne).not.toHaveBeenCalled();
    });

    it("propagates the cross-owner 403 when the op flag is missing", async () => {
      crossOwner.accountAccessFor.mockRejectedValue(new ForbiddenException());
      await expect(
        service.jointAccessFor(GRANTEE, ACCOUNT_ID, "delete"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("rejects the joint path for the caller's own account", async () => {
      crossOwner.accountAccessFor.mockResolvedValue({
        account: { ...chequing, userId: GRANTEE } as never,
        ownerUserId: GRANTEE,
        via: "own",
      });
      await expect(
        service.jointAccessFor(GRANTEE, ACCOUNT_ID, "read"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("403s writes on read-only account types while still allowing read", async () => {
      crossOwner.accountAccessFor.mockResolvedValue({
        account: investment,
        ownerUserId: OWNER,
        via: "delegation",
      });
      delegatesRepo.findOne.mockResolvedValue(activeDelegation);
      grantsRepo.findOne.mockResolvedValue(
        grant({ canCreate: true, canEdit: true, canDelete: true }),
      );

      await expect(
        service.jointAccessFor(GRANTEE, ACCOUNT_ID, "edit"),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const read = await service.jointAccessFor(GRANTEE, ACCOUNT_ID, "read");
      expect(read.via).toBe("delegation");
    });
  });

  describe("jointReferenceData", () => {
    beforeEach(() => {
      crossOwner.accountAccessFor.mockResolvedValue({
        account: chequing,
        ownerUserId: OWNER,
        via: "delegation",
      });
      delegatesRepo.findOne.mockResolvedValue({
        ...activeDelegation,
        payeesCanCreate: true,
        categoriesCanCreate: false,
      });
      grantsRepo.findOne.mockResolvedValue(grant());
    });

    it("returns the OWNER's picker lists with the delegation capability flags", async () => {
      categoriesRepo.find.mockResolvedValue([{ id: "c1", name: "Groceries" }]);
      payeesRepo.find.mockResolvedValue([{ id: "p1", name: "Metro" }]);

      const result = await service.jointReferenceData(GRANTEE, ACCOUNT_ID);

      expect(result.categories).toEqual([{ id: "c1", name: "Groceries" }]);
      expect(result.payees).toEqual([{ id: "p1", name: "Metro" }]);
      expect(result.payeesCanCreate).toBe(true);
      expect(result.categoriesCanCreate).toBe(false);
      expect(categoriesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER }),
        }),
      );
      expect(payeesRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER, isActive: true }),
        }),
      );
    });

    it("404s a plain grant before any reference data is read", async () => {
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.jointReferenceData(GRANTEE, ACCOUNT_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(categoriesRepo.find).not.toHaveBeenCalled();
      expect(payeesRepo.find).not.toHaveBeenCalled();
    });
  });

  describe("jointShareCountsForOwner", () => {
    it("returns per-account counts and leaves unshared accounts absent", async () => {
      manager.query.mockResolvedValue([{ accountId: ACCOUNT_ID, n: 2 }]);
      const counts = await service.jointShareCountsForOwner(OWNER);
      expect(counts.get(ACCOUNT_ID)).toBe(2);
      expect(counts.has("other")).toBe(false);
    });
  });

  describe("setNetWorthExclusion", () => {
    beforeEach(() => {
      accountsRepo.exists.mockResolvedValue(false);
      delegatesRepo.find.mockResolvedValue([activeDelegation]);
      grantsRepo.findOne.mockResolvedValue(grant());
    });

    it("rejects the caller's own account with 400 before touching grants", async () => {
      accountsRepo.exists.mockResolvedValue(true);
      await expect(
        service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, true),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(grantsRepo.findOne).not.toHaveBeenCalled();
      expect(exclusionsRepo.save).not.toHaveBeenCalled();
    });

    it("404s without an active joint grant and writes nothing", async () => {
      grantsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, true),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(exclusionsRepo.save).not.toHaveBeenCalled();
    });

    it("creates the overlay row once and is idempotent", async () => {
      exclusionsRepo.findOne.mockResolvedValue(null);
      await service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, true);
      expect(exclusionsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          delegateUserId: GRANTEE,
          accountId: ACCOUNT_ID,
        }),
      );

      exclusionsRepo.save.mockClear();
      exclusionsRepo.findOne.mockResolvedValue({ id: "x1" });
      await service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, true);
      expect(exclusionsRepo.save).not.toHaveBeenCalled();
    });

    it("clears the overlay row and is idempotent when already clear", async () => {
      exclusionsRepo.findOne.mockResolvedValue({ id: "x1" });
      await service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, false);
      expect(exclusionsRepo.delete).toHaveBeenCalledWith({ id: "x1" });

      exclusionsRepo.delete.mockClear();
      exclusionsRepo.findOne.mockResolvedValue(null);
      await service.setNetWorthExclusion(GRANTEE, ACCOUNT_ID, false);
      expect(exclusionsRepo.delete).not.toHaveBeenCalled();
    });
  });

  it("pins the v1 writable type set", () => {
    expect([...JOINT_WRITABLE_ACCOUNT_TYPES].sort()).toEqual([
      "CASH",
      "CHEQUING",
      "CREDIT_CARD",
      "LINE_OF_CREDIT",
      "SAVINGS",
    ]);
  });
});
