import { ForbiddenException } from "@nestjs/common";
import { AccountDelegateGuard } from "./account-delegate.guard";
import {
  ALLOW_DELEGATE_KEY,
  DELEGATED_ACCOUNT_PARAM_KEY,
  DELEGATED_TRANSACTION_PARAM_KEY,
  DELEGATED_TRANSFER_BODY_KEY,
  DELEGATED_TRANSFER_PARAM_KEY,
  DELEGATE_OPERATION_KEY,
  DELEGATE_CAPABILITY_KEY,
} from "../decorators/delegate-access.decorator";

describe("AccountDelegateGuard", () => {
  let guard: AccountDelegateGuard;
  let reflector: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let delegationService: Record<string, jest.Mock>;

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
      hasCapability: jest.fn(),
    };
    guard = new AccountDelegateGuard(
      reflector as any,
      jwtService as any,
      delegationService as any,
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
    jwtService.verify.mockReturnValue({ sub: "u1" });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it("blocks a delegate on a route not annotated @AllowDelegate (fail closed)", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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

  it("ignores 2fa_pending tokens", async () => {
    jwtService.verify.mockReturnValue({ sub: "u1", type: "2fa_pending" });
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
    jwtService.verify.mockReturnValue({ sub: "d1", actingAsUserId: "o1" });
    const ctx = makeContext({ headers: { authorization: "Bearer x" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
  });

  it("resolves the account id from the request body", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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
      sub: "d1",
      actingAsUserId: "o1",
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

  it("skips the grant check when the account id is absent", async () => {
    jwtService.verify.mockReturnValue({
      sub: "d1",
      actingAsUserId: "o1",
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
});
