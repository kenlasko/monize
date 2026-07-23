import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "./jwt.strategy";
import { AuthService } from "../auth.service";
import { DelegationService } from "../../delegation/delegation.service";
import { getRequestContext } from "../../common/request-context";

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

    // RLS (task C1): both lookups must run inside a *user* context seeded from
    // the verified token's `sub` -- never a system bypass (this is the
    // highest-QPS query in the system). We assert the ambient context at the
    // moment each downstream lookup fires.
    it("runs both lookups under withUserContext(payload.sub)", async () => {
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
      expect(ctxAtDelegationLookup).toEqual({ userId: DELEGATE_ID });
      expect(ctxAtUserLookup?.system).toBeUndefined();
    });

    it("rejects a non-UUID sub before hitting the database", async () => {
      const payload = { sub: "not-a-uuid" };

      await expect(strategy.validate(payload)).rejects.toThrow(
        "withUserContext requires a valid UUID",
      );
      expect(authService.getUserStateById).not.toHaveBeenCalled();
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
