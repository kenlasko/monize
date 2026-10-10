import { ForbiddenException } from "@nestjs/common";
import { AccountDelegateGuard } from "./account-delegate.guard";
import {
  ALLOW_DELEGATE_KEY,
  DELEGATED_ACCOUNT_PARAM_KEY,
  DELEGATED_BODY_ACCOUNTS_KEY,
  DELEGATED_TRANSACTION_PARAM_KEY,
  DELEGATED_TRANSFER_BODY_KEY,
  DELEGATED_TRANSFER_PARAM_KEY,
  DELEGATED_SCHEDULED_PARAM_KEY,
  DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY,
  DELEGATE_OPERATION_KEY,
  DELEGATE_CAPABILITY_KEY,
  DELEGATE_SECTION_KEY,
  DELEGATE_FULL_SCOPE_KEY,
} from "../decorators/delegate-access.decorator";

describe("AccountDelegateGuard", () => {
  let guard: AccountDelegateGuard;
  let reflector: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let delegationService: Record<string, jest.Mock>;
  let crossOwnerAccess: Record<string, jest.Mock>;

  const makeContext = (req: any) =>
    ({
      getType: () => "http",
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as any;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    jwtService = { verify: jest.fn() };
    delegationService = {
      hasAccountPermission: jest.fn(),
      accountIdForTransaction: jest.fn(),
      accountIdsForTransfer: jest.fn(),
      accountIdsForScheduled: jest.fn(),
      hasCapability: jest.fn(),
      hasSection: jest.fn(),
      grantsWholeLedger: jest.fn(),
    };
    crossOwnerAccess = {
      isAccountOwnedBy: jest.fn().mockResolvedValue(false),
    };
    guard = new AccountDelegateGuard(
      reflector as any,
      jwtService as any,
      delegationService as any,
      crossOwnerAccess as any,
    );
  });

  it("allows requests with no token (normal AuthGuard handles auth)", async () => {
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtService.verify).not.toHaveBeenCalled();
  });

  it("allows when the token is invalid (AuthGuard will reject)", async () => {
    jwtService.verify.mockImplementation(() => {
      throw new Error("bad token");
    });
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("allows a normal (non-delegate) token unchanged", async () => {
    jwtService.verify.mockReturnValue({
      sub: "11111111-1111-4111-8111-111111111111",
    });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it("blocks a delegate on a route not annotated @AllowDelegate (fail closed)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("allows a delegate on an @AllowDelegate route with no account param", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) =>
      key === ALLOW_DELEGATE_KEY ? true : undefined,
    );
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("blocks a delegate without READ access to the account", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "id";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(false);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "acc-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "acc-1",
      "read",
    );
  });

  it("allows a delegate with READ access to the account", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "id";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(true);
    const ctx = makeContext({
      headers: {},
      cookies: { auth_token: "ck" },
      params: { id: "acc-1" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("resolves a transaction's account and enforces the edit grant", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSACTION_PARAM_KEY) return "id";
      if (key === DELEGATE_OPERATION_KEY) return "edit";
      return undefined;
    });
    delegationService.accountIdForTransaction.mockResolvedValue("acc-9");
    delegationService.hasAccountPermission.mockResolvedValue(false);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "tx-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.accountIdForTransaction).toHaveBeenCalledWith(
      "tx-1",
    );
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "acc-9",
      "edit",
    );
  });

  it("lets an unknown transaction fall through to the service (404)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSACTION_PARAM_KEY) return "id";
      return undefined;
    });
    delegationService.accountIdForTransaction.mockResolvedValue(null);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "tx-missing" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
  });

  it("requires the operation on BOTH accounts of a transfer body", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSFER_BODY_KEY)
        return ["fromAccountId", "toAccountId"];
      if (key === DELEGATE_OPERATION_KEY) return "create";
      return undefined;
    });
    // from-account allowed, to-account denied -> overall denied
    delegationService.hasAccountPermission.mockImplementation(
      async (_g: string, accId: string) => accId === "from-acc",
    );
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      body: { fromAccountId: "from-acc", toAccountId: "to-acc" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "to-acc",
      "create",
    );
  });

  it("allows a transfer body when both accounts are permitted", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSFER_BODY_KEY)
        return ["fromAccountId", "toAccountId"];
      if (key === DELEGATE_OPERATION_KEY) return "create";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(true);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      body: { fromAccountId: "a1", toAccountId: "a2" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("requires the operation on both legs of a transfer-by-id", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSFER_PARAM_KEY) return "id";
      if (key === DELEGATE_OPERATION_KEY) return "delete";
      return undefined;
    });
    delegationService.accountIdsForTransfer.mockResolvedValue(["a1", "a2"]);
    delegationService.hasAccountPermission.mockImplementation(
      async (_g: string, accId: string) => accId === "a1",
    );
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "tx-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets an unknown transfer fall through (404)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_TRANSFER_PARAM_KEY) return "id";
      return undefined;
    });
    delegationService.accountIdsForTransfer.mockResolvedValue([]);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "tx-missing" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
  });

  it("blocks a delegate lacking the required manage capability", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATE_CAPABILITY_KEY)
        return { resource: "payees", operation: "edit" };
      return undefined;
    });
    delegationService.hasCapability.mockResolvedValue(false);
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasCapability).toHaveBeenCalledWith(
      "g1",
      "payees",
      "edit",
    );
  });

  it("allows a delegate with the required manage capability", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATE_CAPABILITY_KEY)
        return { resource: "tags", operation: "delete" };
      return undefined;
    });
    delegationService.hasCapability.mockResolvedValue(true);
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("requires the operation on every account of a scheduled-by-id", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
      if (key === DELEGATE_OPERATION_KEY) return "edit";
      return undefined;
    });
    delegationService.accountIdsForScheduled.mockResolvedValue(["a1", "a2"]);
    delegationService.hasAccountPermission.mockImplementation(
      async (_g: string, accId: string) => accId === "a1",
    );
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "s-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets an unknown scheduled txn fall through (404)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
      return undefined;
    });
    delegationService.accountIdsForScheduled.mockResolvedValue([]);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "s-missing" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
  });

  it("READ of a scheduled transfer only gates the primary account", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
      // no DELEGATE_OPERATION_KEY -> defaults to "read"
      return undefined;
    });
    delegationService.accountIdsForScheduled.mockResolvedValue(["a1", "a2"]);
    delegationService.hasAccountPermission.mockImplementation(
      async (_g: string, accId: string) => accId === "a1",
    );
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "s-1" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).toHaveBeenCalledTimes(1);
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "a1",
      "read",
    );
  });

  it("READ of a scheduled txn that discloses its other accounts' figures gates every account", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
      if (key === DELEGATED_SCHEDULED_READS_EVERY_ACCOUNT_KEY) return true;
      return undefined;
    });
    // READ on the chequing account that pays, none on the mortgage.
    delegationService.accountIdsForScheduled.mockResolvedValue([
      "chequing",
      "mortgage",
    ]);
    delegationService.hasAccountPermission.mockImplementation(
      async (_g: string, accId: string) => accId === "chequing",
    );
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      params: { id: "s-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "mortgage",
      "read",
    );
    // Strict: an account the delegate owns is no licence to read the loan.
    expect(crossOwnerAccess.isAccountOwnedBy).not.toHaveBeenCalled();
  });

  it("blocks a delegate lacking the required section grant", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATE_SECTION_KEY) return "bills";
      return undefined;
    });
    delegationService.hasSection.mockResolvedValue(false);
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasSection).toHaveBeenCalledWith("g1", "bills");
  });

  it("allows a delegate with the required section grant", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATE_SECTION_KEY) return "budgets";
      return undefined;
    });
    delegationService.hasSection.mockResolvedValue(true);
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("ignores 2fa_pending tokens", async () => {
    jwtService.verify.mockReturnValue({
      sub: "11111111-1111-4111-8111-111111111111",
      type: "2fa_pending",
    });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("allows non-http execution contexts", async () => {
    const ctx = {
      getType: () => "ws",
      switchToHttp: () => ({ getRequest: () => ({}) }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("treats a token with actingAsUserId but no delegationId as non-delegate", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
    });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it("resolves the account id from the request body", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "accountId";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(true);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      body: { accountId: "acc-body" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "acc-body",
      "read",
    );
  });

  it("resolves the account id from the query string", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "accountId";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(true);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      query: { accountId: "acc-query" },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "acc-query",
      "read",
    );
  });

  it("enforces the required write operation (create)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "accountId";
      if (key === DELEGATE_OPERATION_KEY) return "create";
      return undefined;
    });
    delegationService.hasAccountPermission.mockResolvedValue(false);
    const ctx = makeContext({
      headers: { authorization: "Bearer x" },
      body: { accountId: "acc-1" },
    });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
      "g1",
      "acc-1",
      "create",
    );
  });

  describe("cross-owner relaxation (own-account bypass)", () => {
    const delegateSub = "d1111111-1111-4111-8111-111111111111";

    const actingToken = () => {
      jwtService.verify.mockReturnValue({
        sub: delegateSub,
        actingAsUserId: "01111111-1111-4111-8111-111111111111",
        delegationId: "g1",
      });
    };

    it("passes a transfer-body account owned by the real user without a grant row", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_TRANSFER_BODY_KEY)
          return ["fromAccountId", "toAccountId"];
        if (key === DELEGATE_OPERATION_KEY) return "create";
        return undefined;
      });
      // from-acc is the owner's (grant present); own-acc belongs to the
      // delegate personally (no grant row exists, ownership bypasses).
      crossOwnerAccess.isAccountOwnedBy.mockImplementation(
        async (accId: string) => accId === "own-acc",
      );
      delegationService.hasAccountPermission.mockImplementation(
        async (_g: string, accId: string) => accId === "from-acc",
      );
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: { fromAccountId: "from-acc", toAccountId: "own-acc" },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(crossOwnerAccess.isAccountOwnedBy).toHaveBeenCalledWith(
        "own-acc",
        delegateSub,
      );
      // The owned account never reaches the grant check.
      expect(delegationService.hasAccountPermission).not.toHaveBeenCalledWith(
        "g1",
        "own-acc",
        "create",
      );
    });

    it("passes a transfer-param leg owned by the real user without a grant row", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_TRANSFER_PARAM_KEY) return "id";
        if (key === DELEGATE_OPERATION_KEY) return "edit";
        return undefined;
      });
      delegationService.accountIdsForTransfer.mockResolvedValue([
        "owner-acc",
        "own-acc",
      ]);
      crossOwnerAccess.isAccountOwnedBy.mockImplementation(
        async (accId: string) => accId === "own-acc",
      );
      delegationService.hasAccountPermission.mockImplementation(
        async (_g: string, accId: string) => accId === "owner-acc",
      );
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        params: { id: "tx-1" },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("passes a scheduled-write leg owned by the real user without a grant row", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
        if (key === DELEGATE_OPERATION_KEY) return "edit";
        return undefined;
      });
      delegationService.accountIdsForScheduled.mockResolvedValue([
        "owner-acc",
        "own-acc",
      ]);
      crossOwnerAccess.isAccountOwnedBy.mockImplementation(
        async (accId: string) => accId === "own-acc",
      );
      delegationService.hasAccountPermission.mockImplementation(
        async (_g: string, accId: string) => accId === "owner-acc",
      );
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        params: { id: "s-1" },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("scheduled READ keeps the strict check (no ownership probe)", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_SCHEDULED_PARAM_KEY) return "id";
        return undefined;
      });
      delegationService.accountIdsForScheduled.mockResolvedValue(["a1", "a2"]);
      delegationService.hasAccountPermission.mockResolvedValue(true);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        params: { id: "s-1" },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(crossOwnerAccess.isAccountOwnedBy).not.toHaveBeenCalled();
    });

    it("does NOT relax @DelegatedAccountParam for the delegate's own account", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "accountId";
        if (key === DELEGATE_OPERATION_KEY) return "create";
        return undefined;
      });
      crossOwnerAccess.isAccountOwnedBy.mockResolvedValue(true);
      delegationService.hasAccountPermission.mockResolvedValue(false);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: { accountId: "own-acc" },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(crossOwnerAccess.isAccountOwnedBy).not.toHaveBeenCalled();
    });

    it("does NOT relax @DelegatedTransactionParam for the delegate's own account", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_TRANSACTION_PARAM_KEY) return "id";
        if (key === DELEGATE_OPERATION_KEY) return "edit";
        return undefined;
      });
      delegationService.accountIdForTransaction.mockResolvedValue("own-acc");
      crossOwnerAccess.isAccountOwnedBy.mockResolvedValue(true);
      delegationService.hasAccountPermission.mockResolvedValue(false);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        params: { id: "tx-1" },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(crossOwnerAccess.isAccountOwnedBy).not.toHaveBeenCalled();
    });

    it("still denies a transfer account that is neither owned nor granted", async () => {
      actingToken();
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_TRANSFER_BODY_KEY)
          return ["fromAccountId", "toAccountId"];
        if (key === DELEGATE_OPERATION_KEY) return "create";
        return undefined;
      });
      crossOwnerAccess.isAccountOwnedBy.mockResolvedValue(false);
      delegationService.hasAccountPermission.mockImplementation(
        async (_g: string, accId: string) => accId === "from-acc",
      );
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: { fromAccountId: "from-acc", toAccountId: "third-party" },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it("skips the grant check when the account id is absent", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1111111-1111-4111-8111-111111111111",
      actingAsUserId: "01111111-1111-4111-8111-111111111111",
      delegationId: "g1",
    });
    reflector.getAllAndOverride.mockImplementation((key: string) => {
      if (key === ALLOW_DELEGATE_KEY) return true;
      if (key === DELEGATED_ACCOUNT_PARAM_KEY) return "id";
      return undefined;
    });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
  });

  describe("@DelegatedBodyAccounts", () => {
    const actingWithPaths = (paths: string[], operation = "edit") => {
      jwtService.verify.mockReturnValue({
        sub: "d1111111-1111-4111-8111-111111111111",
        actingAsUserId: "01111111-1111-4111-8111-111111111111",
        delegationId: "g1",
      });
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATED_BODY_ACCOUNTS_KEY) return paths;
        if (key === DELEGATE_OPERATION_KEY) return operation;
        return undefined;
      });
      delegationService.hasAccountPermission.mockImplementation(
        async (_g: string, accountId: string) => accountId === "granted",
      );
    };

    it("refuses an ungranted account named in any element of an array path", async () => {
      actingWithPaths(["splits[].transferAccountId"]);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: {
          splits: [
            { transferAccountId: "granted" },
            { categoryId: "c1" },
            { transferAccountId: "ungranted" },
          ],
        },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(delegationService.hasAccountPermission).toHaveBeenCalledWith(
        "g1",
        "ungranted",
        "edit",
      );
    });

    it("allows when every named account is granted, checking each id once", async () => {
      actingWithPaths(["accountId", "splits[].transferAccountId"]);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: {
          accountId: "granted",
          splits: [
            { transferAccountId: "granted" },
            { transferAccountId: "granted" },
          ],
        },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(delegationService.hasAccountPermission).toHaveBeenCalledTimes(1);
    });

    it("does not relax a body account the delegate owns", async () => {
      actingWithPaths(["accountId"]);
      crossOwnerAccess.isAccountOwnedBy.mockResolvedValue(true);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: { accountId: "delegates-own" },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(crossOwnerAccess.isAccountOwnedBy).not.toHaveBeenCalled();
    });

    it("reads only the body, never a same-named route or query value", async () => {
      actingWithPaths(["accountId"]);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        params: { accountId: "granted" },
        query: { accountId: "granted" },
        body: { accountId: "ungranted" },
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it("skips absent, null and non-string values (the DTO rejects the malformed ones)", async () => {
      actingWithPaths(["accountId", "splits[].transferAccountId"]);
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: {
          splits: [{ transferAccountId: null }, null, 7, { amount: 1 }],
        },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
    });

    it("leaves a normal (non-delegate) request untouched", async () => {
      jwtService.verify.mockReturnValue({
        sub: "11111111-1111-4111-8111-111111111111",
      });
      const ctx = makeContext({
        headers: { authorization: "Bearer x" },
        body: { accountId: "ungranted" },
      });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(delegationService.hasAccountPermission).not.toHaveBeenCalled();
    });
  });

  describe("@DelegateRequiresFullScope", () => {
    const actingOnFullScopeRoute = () => {
      jwtService.verify.mockReturnValue({
        sub: "d1111111-1111-4111-8111-111111111111",
        actingAsUserId: "01111111-1111-4111-8111-111111111111",
        delegationId: "g1",
      });
      reflector.getAllAndOverride.mockImplementation((key: string) => {
        if (key === ALLOW_DELEGATE_KEY) return true;
        if (key === DELEGATE_FULL_SCOPE_KEY) return true;
        return undefined;
      });
    };

    it("refuses a delegate whose grants do not cover the whole ledger", async () => {
      actingOnFullScopeRoute();
      delegationService.grantsWholeLedger.mockResolvedValue(false);
      const ctx = makeContext({ headers: { authorization: "Bearer x" } });
      await expect(guard.canActivate(ctx)).rejects.toThrow(
        /reads across all of the account owner's accounts and sections/,
      );
      expect(delegationService.grantsWholeLedger).toHaveBeenCalledWith("g1");
    });

    it("allows a delegate who can read every account and section", async () => {
      actingOnFullScopeRoute();
      delegationService.grantsWholeLedger.mockResolvedValue(true);
      const ctx = makeContext({ headers: { authorization: "Bearer x" } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
    });

    it("leaves the owner's own request untouched", async () => {
      jwtService.verify.mockReturnValue({
        sub: "01111111-1111-4111-8111-111111111111",
      });
      const ctx = makeContext({ headers: { authorization: "Bearer x" } });
      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(delegationService.grantsWholeLedger).not.toHaveBeenCalled();
    });
  });
});
