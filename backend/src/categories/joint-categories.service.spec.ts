jest.mock("../accruals/accrual-taxonomy-operation", () => ({
  beginTaxonomyOperation: async () => undefined,
  recordTaxonomyOperation: async () => undefined,
}));
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { JointCategoriesService } from "./joint-categories.service";
import { AccountDelegate } from "../delegation/entities/account-delegate.entity";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("JointCategoriesService", () => {
  let service: JointCategoriesService;
  let jointAccounts: Record<string, jest.Mock>;
  let categoriesService: Record<string, jest.Mock>;
  let delegatesRepo: Record<string, jest.Mock>;
  /** Whether the RLS bypass was open at each step, in call order. */
  let bypassTrace: Array<[string, boolean]>;

  const GRANTEE = "11111111-1111-4111-8111-111111111111";
  const OWNER = "22222222-2222-4222-8222-222222222222";
  const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
  const CATEGORY_ID = "44444444-4444-4444-8444-444444444444";

  const access = {
    account: { id: ACCOUNT_ID, userId: OWNER, accountType: "CHEQUING" },
    ownerUserId: OWNER,
    via: "delegation" as const,
  };

  const dto = { name: "Daycare" };

  const trace = (step: string) => {
    bypassTrace = [...bypassTrace, [step, !!getRequestContext()?.system]];
  };

  beforeEach(() => {
    bypassTrace = [];
    delegatesRepo = {
      findOne: jest.fn().mockImplementation(() => {
        trace("capability-read");
        return Promise.resolve({ id: "d1", categoriesCanCreate: true });
      }),
    };
    const scoped = createScopedDbMocks([
      [AccountDelegate, delegatesRepo as never],
    ]);
    jointAccounts = {
      jointAccessFor: jest.fn().mockImplementation(() => {
        trace("account-read");
        return Promise.resolve(access);
      }),
    };
    categoriesService = {
      create: jest.fn().mockImplementation(() => {
        trace("write");
        return Promise.resolve({ id: CATEGORY_ID, userId: OWNER, ...dto });
      }),
    };
    service = new JointCategoriesService(
      scoped.dataSource as never,
      jointAccounts as never,
      categoriesService as never,
    );
  });

  it("creates on the OWNER's ledger, not the caller's", async () => {
    const created = await service.create(GRANTEE, ACCOUNT_ID, dto as never);

    expect(categoriesService.create).toHaveBeenCalledWith(OWNER, dto);
    expect(created).toEqual({
      id: CATEGORY_ID,
      userId: OWNER,
      name: "Daycare",
    });
  });

  it("gates the account on READ -- the picker's own gate, not the row-write flags", async () => {
    await service.create(GRANTEE, ACCOUNT_ID, dto as never);

    // "edit" or "create" here would refuse a grantee who may edit the
    // register but not add rows to it, for a capability the owner granted
    // outright; the acting-as POST /categories consults no account grant.
    expect(jointAccounts.jointAccessFor).toHaveBeenCalledWith(
      GRANTEE,
      ACCOUNT_ID,
      "read",
    );
  });

  it("reads the capability for THIS pair of users, under an active delegation", async () => {
    await service.create(GRANTEE, ACCOUNT_ID, dto as never);

    expect(delegatesRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ownerUserId: OWNER,
          delegateUserId: GRANTEE,
          status: "active",
        },
      }),
    );
  });

  it("refuses without categoriesCanCreate, before anything is written", async () => {
    delegatesRepo.findOne.mockResolvedValue({
      id: "d1",
      categoriesCanCreate: false,
    });

    await expect(
      service.create(GRANTEE, ACCOUNT_ID, dto as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(categoriesService.create).not.toHaveBeenCalled();
  });

  it("refuses when the delegation is gone, before anything is written", async () => {
    delegatesRepo.findOne.mockResolvedValue(null);

    await expect(
      service.create(GRANTEE, ACCOUNT_ID, dto as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(categoriesService.create).not.toHaveBeenCalled();
  });

  it("refuses an account that is not shared jointly, before anything is written", async () => {
    jointAccounts.jointAccessFor.mockRejectedValue(new NotFoundException());

    await expect(
      service.create(GRANTEE, ACCOUNT_ID, dto as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(delegatesRepo.findOne).not.toHaveBeenCalled();
    expect(categoriesService.create).not.toHaveBeenCalled();
  });

  it("decides authorization before the RLS bypass opens", async () => {
    await service.create(GRANTEE, ACCOUNT_ID, dto as never);

    // Both authorization reads run under the caller's own identity; only the
    // owner-scoped write is inside withSystemContext.
    expect(bypassTrace).toEqual([
      ["account-read", false],
      ["capability-read", false],
      ["write", true],
    ]);
  });
});
