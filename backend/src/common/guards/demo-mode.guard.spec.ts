import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { DemoModeGuard, DEMO_RESTRICTED_KEY } from "./demo-mode.guard";
import { DemoModeService } from "../demo-mode.service";

describe("DemoModeGuard", () => {
  let guard: DemoModeGuard;
  let reflector: Reflector;
  let demoModeService: DemoModeService;

  function createMockContext(): ExecutionContext {
    return {
      getHandler: () => jest.fn(),
      getClass: () => jest.fn(),
    } as unknown as ExecutionContext;
  }

  describe("when demo mode is disabled", () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DemoModeGuard,
          {
            provide: Reflector,
            useValue: { getAllAndOverride: jest.fn() },
          },
          {
            provide: DemoModeService,
            useValue: { isDemo: false },
          },
        ],
      }).compile();

      guard = module.get<DemoModeGuard>(DemoModeGuard);
      reflector = module.get<Reflector>(Reflector);
      demoModeService = module.get<DemoModeService>(DemoModeService);
    });

    it("allows all requests regardless of decorator", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
      expect(guard.canActivate(createMockContext())).toBe(true);
    });

    it("does not check reflector metadata", () => {
      guard.canActivate(createMockContext());
      expect(reflector.getAllAndOverride).not.toHaveBeenCalled();
    });
  });

  describe("when demo mode is enabled", () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          DemoModeGuard,
          {
            provide: Reflector,
            useValue: { getAllAndOverride: jest.fn() },
          },
          {
            provide: DemoModeService,
            useValue: { isDemo: true },
          },
        ],
      }).compile();

      guard = module.get<DemoModeGuard>(DemoModeGuard);
      reflector = module.get<Reflector>(Reflector);
      demoModeService = module.get<DemoModeService>(DemoModeService);
    });

    it("allows requests to unrestricted endpoints", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false);
      expect(guard.canActivate(createMockContext())).toBe(true);
    });

    it("allows requests when no metadata is set", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
      expect(guard.canActivate(createMockContext())).toBe(true);
    });

    it("throws ForbiddenException for restricted endpoints", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
      expect(() => guard.canActivate(createMockContext())).toThrow(
        ForbiddenException,
      );
    });

    it("throws with correct error message", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(true);
      expect(() => guard.canActivate(createMockContext())).toThrow(
        "This action is not available in demo mode.",
      );
    });

    it("uses DEMO_RESTRICTED_KEY to look up metadata", () => {
      (reflector.getAllAndOverride as jest.Mock).mockReturnValue(false);
      const context = createMockContext();
      guard.canActivate(context);

      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        DEMO_RESTRICTED_KEY,
        [expect.any(Function), expect.any(Function)],
      );
    });
  });
});
