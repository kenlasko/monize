import {
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Post,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PatAccessGuard } from "./pat-access.guard";
import { PatService, ValidatedToken } from "../pat.service";
import { admittedPatOf } from "../pat-access/pat-bearer";
import {
  AllowPat,
  NoPat,
  PatScope,
  PatIgnored,
  PatSelfAuthenticated,
} from "../pat-access/pat-access.decorator";
import { RequireStepUp } from "../step-up/require-step-up.decorator";
import { Roles } from "../decorators/roles.decorator";

@Controller("plain")
class PlainController {
  @Get()
  handler() {}
}

@AllowPat()
@Controller("allowed")
class AllowedController {
  @Get()
  handler() {}

  @NoPat()
  @Get("session-only")
  sessionOnly() {}

  @RequireStepUp("personal-access-token")
  @Post("step-up")
  stepUp() {}

  @Roles("admin")
  @Get("admin-handler")
  adminHandler() {}

  @PatScope("read")
  @Post("search")
  search() {}
}

@AllowPat()
@Roles("admin")
@Controller("admin")
class AdminController {
  @Get()
  handler() {}
}

@PatIgnored()
class IgnoredController {
  handler() {}
}

@PatSelfAuthenticated()
@Controller("self")
class SelfController {
  @Get()
  handler() {}
}

type Handler = (...args: never[]) => unknown;

describe("PatAccessGuard", () => {
  let guard: PatAccessGuard;
  let patService: jest.Mocked<Pick<PatService, "validateToken">>;

  const validated = (scopes: string): ValidatedToken => ({
    userId: "11111111-1111-1111-1111-111111111111",
    scopes,
    tokenId: "22222222-2222-2222-2222-222222222222",
  });

  function ctx(
    controller: new () => object,
    handler: Handler,
    req: object,
    type = "http",
  ): ExecutionContext {
    return {
      getType: () => type,
      getClass: () => controller,
      getHandler: () => handler,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  const request = (authorization: string | undefined, method = "GET") => ({
    method,
    headers: authorization === undefined ? {} : { authorization },
  });

  beforeEach(() => {
    patService = { validateToken: jest.fn() };
    guard = new PatAccessGuard(new Reflector(), patService as PatService);
  });

  it("passes a non-http context", async () => {
    const req = request("Bearer pat_abc");
    await expect(
      guard.canActivate(
        ctx(PlainController, PlainController.prototype.handler, req, "rpc"),
      ),
    ).resolves.toBe(true);
    expect(patService.validateToken).not.toHaveBeenCalled();
  });

  it.each([
    ["no authorization header", undefined],
    ["a JWT bearer", "Bearer eyJhbGciOi.e30.sig"],
  ])("passes %s without validating or admitting", async (_label, header) => {
    const req = request(header);
    await expect(
      guard.canActivate(
        ctx(PlainController, PlainController.prototype.handler, req),
      ),
    ).resolves.toBe(true);
    expect(patService.validateToken).not.toHaveBeenCalled();
    expect(admittedPatOf(req)).toBeUndefined();
  });

  it("stands aside for a @PatSelfAuthenticated() route", async () => {
    const req = request("Bearer pat_abc");
    await expect(
      guard.canActivate(
        ctx(SelfController, SelfController.prototype.handler, req),
      ),
    ).resolves.toBe(true);
    expect(patService.validateToken).not.toHaveBeenCalled();
    expect(admittedPatOf(req)).toBeUndefined();
  });

  it("rethrows the 401 for an invalid token", async () => {
    const error = new UnauthorizedException("bad token");
    patService.validateToken.mockRejectedValue(error);
    const req = request("Bearer pat_abc");

    await expect(
      guard.canActivate(
        ctx(AllowedController, AllowedController.prototype.handler, req),
      ),
    ).rejects.toBe(error);
    expect(admittedPatOf(req)).toBeUndefined();
  });

  it("refuses a closed route without looking the token up", async () => {
    await expect(
      guard.canActivate(
        ctx(
          PlainController,
          PlainController.prototype.handler,
          request("Bearer pat_abc"),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(patService.validateToken).not.toHaveBeenCalled();
  });

  it("stands aside on a route that authenticates nobody", async () => {
    const req = request("Bearer pat_abc");

    await expect(
      guard.canActivate(
        ctx(IgnoredController, IgnoredController.prototype.handler, req),
      ),
    ).resolves.toBe(true);
    expect(patService.validateToken).not.toHaveBeenCalled();
    expect(admittedPatOf(req)).toBeUndefined();
  });

  describe("route policy", () => {
    beforeEach(() => {
      patService.validateToken.mockResolvedValue(validated("read,write"));
    });

    it.each([
      [
        "a route without @AllowPat()",
        PlainController,
        PlainController.prototype.handler,
      ],
      [
        "a @NoPat() handler inside an @AllowPat() class",
        AllowedController,
        AllowedController.prototype.sessionOnly,
      ],
      [
        "an @AllowPat() route with @RequireStepUp()",
        AllowedController,
        AllowedController.prototype.stepUp,
      ],
      [
        "an @AllowPat() handler with @Roles()",
        AllowedController,
        AllowedController.prototype.adminHandler,
      ],
      [
        "an @AllowPat() class with @Roles()",
        AdminController,
        AdminController.prototype.handler,
      ],
    ])("refuses %s", async (_label, controller, handler) => {
      const req = request("Bearer pat_abc", "GET");

      await expect(
        guard.canActivate(ctx(controller, handler as Handler, req)),
      ).rejects.toThrow(ForbiddenException);
      expect(admittedPatOf(req)).toBeUndefined();
    });
  });

  describe("scope", () => {
    it.each([
      ["read", "GET", true],
      ["read", "HEAD", true],
      ["read", "OPTIONS", true],
      ["read", "POST", false],
      ["read", "PUT", false],
      ["read", "PATCH", false],
      ["read", "DELETE", false],
      ["write", "GET", false],
      ["write", "POST", true],
      ["write", "DELETE", true],
      ["read,write", "GET", true],
      ["read,write", "PATCH", true],
    ])(
      "token scopes %p on %s: admitted=%s",
      async (scopes, method, admitted) => {
        const token = validated(scopes);
        patService.validateToken.mockResolvedValue(token);
        const req = request("Bearer pat_abc", method);
        const run = guard.canActivate(
          ctx(AllowedController, AllowedController.prototype.handler, req),
        );

        if (admitted) {
          await expect(run).resolves.toBe(true);
          expect(admittedPatOf(req)).toBe(token);
        } else {
          await expect(run).rejects.toThrow(ForbiddenException);
          expect(admittedPatOf(req)).toBeUndefined();
        }
      },
    );

    it('admits a read token on a POST marked @PatScope("read")', async () => {
      const token = validated("read");
      patService.validateToken.mockResolvedValue(token);
      const req = request("Bearer pat_abc", "POST");

      await expect(
        guard.canActivate(
          ctx(AllowedController, AllowedController.prototype.search, req),
        ),
      ).resolves.toBe(true);
      expect(admittedPatOf(req)).toBe(token);
    });

    it('refuses a write-only token on a @PatScope("read") POST', async () => {
      patService.validateToken.mockResolvedValue(validated("write"));

      await expect(
        guard.canActivate(
          ctx(
            AllowedController,
            AllowedController.prototype.search,
            request("Bearer pat_abc", "POST"),
          ),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it("validates the raw token taken from the header", async () => {
    patService.validateToken.mockResolvedValue(validated("read"));

    await guard.canActivate(
      ctx(
        AllowedController,
        AllowedController.prototype.handler,
        request("bearer pat_secret"),
      ),
    );

    expect(patService.validateToken).toHaveBeenCalledWith("pat_secret");
  });
});
