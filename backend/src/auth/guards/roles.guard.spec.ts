import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { RolesGuard, ROLES_KEY } from "./roles.guard";

describe("RolesGuard", () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RolesGuard,
        {
          provide: Reflector,
          useValue: {
            getAllAndOverride: jest.fn(),
          },
        },
      ],
    }).compile();

    guard = module.get<RolesGuard>(RolesGuard);
    reflector = module.get<Reflector>(Reflector);
  });

  function createMockContext(user?: { role: string }): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  it("returns true when no roles are required (no metadata)", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);

    const context = createMockContext({ role: "user" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("returns true when user has the required role", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin"]);

    const context = createMockContext({ role: "admin" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("returns true when user has one of multiple required roles", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      "admin",
      "moderator",
    ]);

    const context = createMockContext({ role: "moderator" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("returns false when user lacks the required role", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(["admin"]);

    const context = createMockContext({ role: "user" });
    expect(guard.canActivate(context)).toBe(false);
  });

  it("returns false when user has none of the required roles", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([
      "admin",
      "moderator",
    ]);

    const context = createMockContext({ role: "user" });
    expect(guard.canActivate(context)).toBe(false);
  });

  it("uses Reflector to get ROLES_KEY metadata", () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);

    const context = createMockContext({ role: "user" });
    guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      expect.any(Function),
      expect.any(Function),
    ]);
  });
});
