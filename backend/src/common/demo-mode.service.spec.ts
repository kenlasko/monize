import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DemoModeService } from "./demo-mode.service";

describe("DemoModeService", () => {
  function createService(demoModeValue: string | undefined) {
    return Test.createTestingModule({
      providers: [
        DemoModeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue: string) => {
              if (key === "DEMO_MODE") return demoModeValue ?? defaultValue;
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sets isDemo to true when DEMO_MODE is "true"', async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const module = await createService("true");
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(true);
  });

  it('sets isDemo to true when DEMO_MODE is "TRUE" (case-insensitive)', async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const module = await createService("TRUE");
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(true);
  });

  it('sets isDemo to true when DEMO_MODE is "True" (mixed case)', async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const module = await createService("True");
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(true);
  });

  it('sets isDemo to false when DEMO_MODE is "false"', async () => {
    const module = await createService("false");
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(false);
  });

  it("sets isDemo to false when DEMO_MODE is not set (defaults)", async () => {
    const module = await createService(undefined);
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(false);
  });

  it('sets isDemo to false for arbitrary values like "yes"', async () => {
    const module = await createService("yes");
    const service = module.get<DemoModeService>(DemoModeService);
    expect(service.isDemo).toBe(false);
  });

  it("logs a message when demo mode is active", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await createService("true");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Demo mode is ACTIVE"),
    );
  });

  it("does not log when demo mode is inactive", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await createService("false");
    expect(logSpy).not.toHaveBeenCalled();
  });
});
