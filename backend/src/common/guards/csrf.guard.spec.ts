import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { Test, TestingModule } from "@nestjs/testing";
import { CsrfGuard } from "./csrf.guard";
import { SKIP_CSRF_KEY } from "../decorators/skip-csrf.decorator";

describe("CsrfGuard", () => {
  let guard: CsrfGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CsrfGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    guard = module.get<CsrfGuard>(CsrfGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  function createMockContext(overrides: {
    method?: string;
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
  }): ExecutionContext {
    const request = {
      method: overrides.method ?? "POST",
      cookies: overrides.cookies ?? {},
      headers: overrides.headers ?? {},
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  describe("safe HTTP methods", () => {
    it.each(["GET", "HEAD", "OPTIONS"])("skips CSRF check for %s", (method) => {
      const context = createMockContext({ method });
      expect(guard.canActivate(context)).toBe(true);
    });

    it("does not skip for POST", () => {
      const context = createMockContext({ method: "POST" });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("does not skip for PUT", () => {
      const context = createMockContext({ method: "PUT" });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("does not skip for DELETE", () => {
      const context = createMockContext({ method: "DELETE" });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it("handles lowercase method names", () => {
      const context = createMockContext({ method: "get" });
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe("@SkipCsrf() decorator", () => {
    it("skips CSRF check when @SkipCsrf() is set", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);

      const context = createMockContext({ method: "POST" });
      expect(guard.canActivate(context)).toBe(true);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(SKIP_CSRF_KEY, [
        expect.any(Function),
        expect.any(Function),
      ]);
    });

    it("does not skip when @SkipCsrf() is not set", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false);

      const context = createMockContext({ method: "POST" });
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });

  describe("missing tokens", () => {
    it("throws ForbiddenException when both tokens are missing", () => {
      const context = createMockContext({
        method: "POST",
        cookies: {},
        headers: {},
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow("Missing CSRF token");
    });

    it("throws ForbiddenException when cookie token is missing", () => {
      const context = createMockContext({
        method: "POST",
        cookies: {},
        headers: { "x-csrf-token": "some-token" },
      });

      expect(() => guard.canActivate(context)).toThrow("Missing CSRF token");
    });

    it("throws ForbiddenException when header token is missing", () => {
      const context = createMockContext({
        method: "POST",
        cookies: { csrf_token: "some-token" },
        headers: {},
      });

      expect(() => guard.canActivate(context)).toThrow("Missing CSRF token");
    });
  });

  describe("token mismatch", () => {
    it("throws ForbiddenException when tokens do not match", () => {
      const context = createMockContext({
        method: "POST",
        cookies: { csrf_token: "token-from-cookie" },
        headers: { "x-csrf-token": "different-token-from-header" },
      });

      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
      expect(() => guard.canActivate(context)).toThrow("Invalid CSRF token");
    });

    it("throws ForbiddenException when tokens differ by length", () => {
      const context = createMockContext({
        method: "POST",
        cookies: { csrf_token: "short" },
        headers: { "x-csrf-token": "much-longer-token-value" },
      });

      expect(() => guard.canActivate(context)).toThrow("Invalid CSRF token");
    });
  });

  describe("matching tokens", () => {
    it("returns true when cookie and header tokens match", () => {
      const token =
        "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const context = createMockContext({
        method: "POST",
        cookies: { csrf_token: token },
        headers: { "x-csrf-token": token },
      });

      expect(guard.canActivate(context)).toBe(true);
    });

    it("returns true for PATCH requests with matching tokens", () => {
      const token = "matching-csrf-token";
      const context = createMockContext({
        method: "PATCH",
        cookies: { csrf_token: token },
        headers: { "x-csrf-token": token },
      });

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
