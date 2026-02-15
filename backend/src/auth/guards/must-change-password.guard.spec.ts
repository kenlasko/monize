import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { MustChangePasswordGuard } from "./must-change-password.guard";

describe("MustChangePasswordGuard", () => {
  let guard: MustChangePasswordGuard;
  let reflector: Reflector;

  const createMockContext = (user: any): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new MustChangePasswordGuard(reflector);
  });

  it("allows access when user does not need to change password", () => {
    const context = createMockContext({
      id: "user-1",
      mustChangePassword: false,
    });
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false);

    expect(guard.canActivate(context)).toBe(true);
  });

  it("blocks access when user must change password", () => {
    const context = createMockContext({
      id: "user-1",
      mustChangePassword: true,
    });
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it("allows access when SkipPasswordCheck decorator is present", () => {
    const context = createMockContext({
      id: "user-1",
      mustChangePassword: true,
    });
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(true);

    expect(guard.canActivate(context)).toBe(true);
  });

  it("allows access when no user is on the request (unauthenticated)", () => {
    const context = createMockContext(null);
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(false);

    expect(guard.canActivate(context)).toBe(true);
  });
});
