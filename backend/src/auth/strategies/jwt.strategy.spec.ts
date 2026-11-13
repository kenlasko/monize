import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "./jwt.strategy";
import { AuthService } from "../auth.service";
import { DelegationService } from "../../delegation/delegation.service";
import { getRequestContext } from "../../common/request-context";
import { admitPat } from "../pat-access/pat-bearer";
import type { ValidatedToken } from "../pat.service";

// Real tokens always carry a UUID `sub` (it is the user's id). jwt.strategy now
// seeds a user context via withUserContext(payload.sub), which validates the id
// is a UUID, so the fixtures below use well-formed UUIDs.
const USER_ID = "11111111-1111-1111-1111-111111111111";
const DELEGATE_ID = "22222222-2222-2222-2222-222222222222";
const OWNER_ID = "33333333-3333-3333-3333-333333333333";
const DELEG_ID = "44444444-4444-4444-4444-444444444444";
const NONEXISTENT_ID = "99999999-9999-9999-9999-999999999999";

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;
  let authService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let delegationService: Record<string, jest.Mock>;

  const mockUser = {
    id: USER_ID,
    isActive: true,
    mustChangePassword: false,
    role: "user",
  };

  beforeEach(async () => {
    authService = {
      getUserStateById: jest.fn(),
    };

    delegationService = {
      validateActingContext: jest.fn(),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "JWT_SECRET")
          return "test-secret-at-least-32-characters-long";
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: AuthService, useValue: authService },
        { provide: ConfigService, useValue: configService },
        { provide: DelegationService, useValue: delegationService },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  it("should be defined", () => {
    expect(strategy).toBeDefined();
  });

  describe("constructor", () => {
    it("throws an error if JWT_SECRET is not configured", () => {
      const noSecretConfig = {
        get: jest.fn().mockReturnValue(undefined),
      };

      expect(() => {
        new JwtStrategy(
          noSecretConfig as any,
          authService as any,
          delegationService as any,
        );
      }).toThrow(
        "JWT_SECRET environment variable must be at least 32 characters",
      );
    });

    it("throws an error if JWT_SECRET is too short", () => {
      const shortSecretConfig = {
        get: jest.fn().mockReturnValue("short-secret"),
      };

      expect(() => {
        new JwtStrategy(
          shortSecretConfig as any,
          authService as any,
          delegationService as any,
        );
      }).toThrow(
        "JWT_SECRET environment variable must be at least 32 characters",
      );
    });

    it.each([
      [
        "the retired .env.example placeholder",
        "your-super-secret-jwt-key-change-in-production",
      ],
      ["one character repeated", "x".repeat(40)],
    ])("starts with a long-enough but weak secret (%s)", (_label, secret) => {
      // Weak is reported (boot warning, admin alert, admin banner), never
      // refused: replacing the secret stops every user's authenticator codes
      // working and forgets trusted devices, so the operator decides when.
      const weakConfig = { get: jest.fn().mockReturnValue(secret) };

      expect(
        () =>
          new JwtStrategy(
            weakConfig as any,
            authService as any,
            delegationService as any,
          ),
      ).not.toThrow();
    });
  });

  describe("validate", () => {
    it("rejects 2fa_pending tokens", async () => {
      const payload = { sub: USER_ID, type: "2fa_pending" };

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(strategy.validate(payload)).rejects.toThrow(
        "2FA verification required",
      );
    });

    // One JWT_SECRET signs every token type; only an access token may act as
    // one. A step-up token or an OIDC re-auth artifact is script-readable, and
    // as a Bearer access token it would outlive the purpose it was minted for
    // (A26-L06).
    it.each(["step_up", "oidc_reauth", "oidc_reauth_pending", "anything-else"])(
      "refuses a %s token as an access token",
      async (type) => {
        authService.getUserStateById.mockResolvedValue(mockUser);

        await expect(strategy.validate({ sub: USER_ID, type })).rejects.toThrow(
          UnauthorizedException,
        );
        expect(authService.getUserStateById).not.toHaveBeenCalled();
      },
    );

    it("accepts a token typed as an access token", async () => {
      authService.getUserStateById.mockResolvedValue(mockUser);

      await expect(
        strategy.validate({ sub: USER_ID, type: "access" }),
      ).resolves.toMatchObject({ realUserId: USER_ID, isActing: false });
    });

    it("accepts a type-less access token minted before the type existed (one-release grace)", async () => {
      authService.getUserStateById.mockResolvedValue(mockUser);

      await expect(strategy.validate({ sub: USER_ID })).resolves.toMatchObject({
        realUserId: USER_ID,
      });
    });

    it("rejects inactive users", async () => {
      const payload = { sub: USER_ID };
      authService.getUserStateById.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(strategy.validate(payload)).rejects.toThrow(
        "User not found or inactive",
      );
    });

    it("rejects when user is not found", async () => {
      const payload = { sub: NONEXISTENT_ID };
      authService.getUserStateById.mockResolvedValue(null);

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns enriched self user for a non-delegate payload", async () => {
      const payload = { sub: USER_ID };
      authService.getUserStateById.mockResolvedValue(mockUser);

      const result = await strategy.validate(payload);

      expect(authService.getUserStateById).toHaveBeenCalledWith(USER_ID);
      expect(result).toEqual({
        ...mockUser,
        realUserId: USER_ID,
        isActing: false,
        delegationId: null,
      });
      expect(delegationService.validateActingContext).not.toHaveBeenCalled();
    });

    it("maps the effective id to the owner when acting as a delegate", async () => {
      const payload = {
        sub: DELEGATE_ID,
        actingAsUserId: OWNER_ID,
        delegationId: DELEG_ID,
      };
      authService.getUserStateById.mockResolvedValue({
        id: DELEGATE_ID,
        isActive: true,
        mustChangePassword: false,
        role: "user",
      });
      delegationService.validateActingContext.mockResolvedValue({});

      const result = await strategy.validate(payload);

      expect(delegationService.validateActingContext).toHaveBeenCalledWith({
        delegateUserId: DELEGATE_ID,
        actingAsUserId: OWNER_ID,
        delegationId: DELEG_ID,
      });
      expect(result).toEqual({
        id: OWNER_ID,
        realUserId: DELEGATE_ID,
        isActing: true,
        delegationId: DELEG_ID,
        isActive: true,
        mustChangePassword: false,
        role: "user",
      });
    });

    it("fails closed when the delegation is no longer valid", async () => {
      const payload = {
        sub: DELEGATE_ID,
        actingAsUserId: OWNER_ID,
        delegationId: DELEG_ID,
      };
      authService.getUserStateById.mockResolvedValue({
        ...mockUser,
        id: DELEGATE_ID,
      });
      delegationService.validateActingContext.mockRejectedValue(
        new UnauthorizedException("Delegated access is no longer valid"),
      );

      await expect(strategy.validate(payload)).rejects.toThrow(
        "Delegated access is no longer valid",
      );
    });

    it("rejects the inactive real user before resolving delegation", async () => {
      const payload = {
        sub: DELEGATE_ID,
        actingAsUserId: OWNER_ID,
        delegationId: DELEG_ID,
      };
      authService.getUserStateById.mockResolvedValue({
        ...mockUser,
        id: DELEGATE_ID,
        isActive: false,
      });

      await expect(strategy.validate(payload)).rejects.toThrow(
        "User not found or inactive",
      );
      expect(delegationService.validateActingContext).not.toHaveBeenCalled();
    });

    // RLS (tasks C1 + R7): the user lookup runs inside a *user* context seeded
    // from the verified token's `sub` -- never a system bypass (this is the
    // highest-QPS query in the system). The delegation re-validation reads the
    // OWNER's rows as well as the delegate's, so it re-seeds both identities.
    // We assert the ambient context at the moment each lookup fires.
    it("seeds the delegate for the user lookup and both ids for the delegation lookup", async () => {
      const payload = {
        sub: DELEGATE_ID,
        actingAsUserId: OWNER_ID,
        delegationId: DELEG_ID,
      };
      let ctxAtUserLookup: ReturnType<typeof getRequestContext>;
      let ctxAtDelegationLookup: ReturnType<typeof getRequestContext>;
      authService.getUserStateById.mockImplementation(() => {
        ctxAtUserLookup = getRequestContext();
        return Promise.resolve({ ...mockUser, id: DELEGATE_ID });
      });
      delegationService.validateActingContext.mockImplementation(() => {
        ctxAtDelegationLookup = getRequestContext();
        return Promise.resolve({});
      });

      await strategy.validate(payload);

      // Seeded from the delegate's own id (the authenticated principal), never
      // a system bypass.
      expect(ctxAtUserLookup).toEqual({ userId: DELEGATE_ID });
      // The acting-context re-validation reads the owner's `users` and
      // `user_preferences` rows (delegateMustEnrollOwn2FA) as well as the
      // delegate's own, so current = owner and real = delegate. Seeding only
      // the delegate here would return zero rows for the owner's half under
      // enforcement -- silently, inside normal request scope.
      expect(ctxAtDelegationLookup).toEqual({
        userId: OWNER_ID,
        realUserId: DELEGATE_ID,
      });
      expect(ctxAtUserLookup?.system).toBeUndefined();
      expect(ctxAtDelegationLookup?.system).toBeUndefined();
    });

    it("rejects a non-UUID sub before hitting the database", async () => {
      const payload = { sub: "not-a-uuid" };

      await expect(strategy.validate(payload)).rejects.toThrow(
        "withUserContext requires a valid UUID",
      );
      expect(authService.getUserStateById).not.toHaveBeenCalled();
    });
  });

  describe("personal access token", () => {
    const PAT: ValidatedToken = {
      userId: USER_ID,
      scopes: "read",
      tokenId: "55555555-5555-5555-5555-555555555555",
    };

    // passport attaches success/fail/error to a per-request copy of the
    // strategy before calling authenticate(); stand in for that here.
    type Passportish = {
      success: jest.Mock;
      fail: jest.Mock;
      error: jest.Mock;
      authenticate(req: unknown): void;
    };
    let hooks: Passportish;

    const patRequest = (extra: Record<string, unknown> = {}) => ({
      headers: { authorization: "Bearer pat_abc" },
      ...extra,
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    beforeEach(() => {
      hooks = strategy as unknown as Passportish;
      hooks.success = jest.fn();
      hooks.fail = jest.fn();
      hooks.error = jest.fn();
    });

    it("fails 401 for a PAT bearer with no admitted record, ignoring the cookie", async () => {
      strategy.authenticate(
        patRequest({ cookies: { auth_token: "valid-looking-cookie" } }) as any,
      );
      await settle();

      expect(hooks.fail).toHaveBeenCalledWith(401);
      expect(hooks.success).not.toHaveBeenCalled();
      expect(hooks.error).not.toHaveBeenCalled();
      expect(authService.getUserStateById).not.toHaveBeenCalled();
    });

    it("succeeds with the owner acting as self for an admitted token", async () => {
      authService.getUserStateById.mockResolvedValue(mockUser);
      const req = patRequest();
      admitPat(req, PAT);

      strategy.authenticate(req as any);
      await settle();

      expect(authService.getUserStateById).toHaveBeenCalledWith(USER_ID);
      expect(hooks.success).toHaveBeenCalledWith({
        ...mockUser,
        id: USER_ID,
        realUserId: USER_ID,
        isActing: false,
        delegationId: null,
        pat: { tokenId: PAT.tokenId, scopes: "read" },
      });
      expect(hooks.fail).not.toHaveBeenCalled();
      expect(hooks.error).not.toHaveBeenCalled();
    });

    it.each([
      ["missing", null],
      ["inactive", { ...mockUser, isActive: false }],
    ])(
      "errors with Unauthorized when the owner is %s",
      async (_label, user) => {
        authService.getUserStateById.mockResolvedValue(user);
        const req = patRequest();
        admitPat(req, PAT);

        strategy.authenticate(req as any);
        await settle();

        expect(hooks.error).toHaveBeenCalledWith(
          expect.any(UnauthorizedException),
        );
        expect(hooks.success).not.toHaveBeenCalled();
      },
    );

    it("delegates a non-PAT request to the parent authenticate", () => {
      const parent = Object.getPrototypeOf(JwtStrategy.prototype);
      const spy = jest.spyOn(parent, "authenticate").mockImplementation();
      try {
        const req = { headers: { authorization: "Bearer eyJhbGciOi.e30.sig" } };

        strategy.authenticate(req as any, { session: false });

        expect(spy).toHaveBeenCalledWith(req, { session: false });
        expect(hooks.fail).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("JWT extraction (jwtFromRequest)", () => {
    function getExtractor(): (req: any) => string | null {
      const fn = (strategy as any)._jwtFromRequest;
      expect(typeof fn).toBe("function");
      return fn;
    }

    it("extracts a Bearer token from the Authorization header", () => {
      const extractor = getExtractor();
      const token = extractor({
        headers: { authorization: "Bearer header-token" },
      });
      expect(token).toBe("header-token");
    });

    it("falls back to the auth_token cookie when no Authorization header is present", () => {
      const extractor = getExtractor();
      const token = extractor({
        headers: {},
        cookies: { auth_token: "cookie-token" },
      });
      expect(token).toBe("cookie-token");
    });

    it("returns null when neither header nor cookie is present", () => {
      const extractor = getExtractor();
      const token = extractor({ headers: {} });
      expect(token).toBeNull();
    });

    it("returns null when cookies object exists but has no auth_token", () => {
      const extractor = getExtractor();
      const token = extractor({ headers: {}, cookies: {} });
      expect(token).toBeNull();
    });

    it("prefers the Authorization header over the cookie", () => {
      const extractor = getExtractor();
      const token = extractor({
        headers: { authorization: "Bearer header-wins" },
        cookies: { auth_token: "ignored-cookie" },
      });
      expect(token).toBe("header-wins");
    });
  });
});
