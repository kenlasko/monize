import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { AiStartupValidator } from "./ai-startup.validator";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiEncryptionService } from "./ai-encryption.service";

describe("AiStartupValidator", () => {
  let validator: AiStartupValidator;
  let mockProviderFactory: { createProvider: jest.Mock };
  let mockEncryptionService: { encrypt: jest.Mock; isConfigured: jest.Mock };
  let mockConfigService: { get: jest.Mock };
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    mockProviderFactory = {
      createProvider: jest.fn(),
    };

    mockEncryptionService = {
      encrypt: jest.fn().mockReturnValue("encrypted-default"),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiStartupValidator,
        { provide: AiProviderFactory, useValue: mockProviderFactory },
        { provide: AiEncryptionService, useValue: mockEncryptionService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    validator = module.get<AiStartupValidator>(AiStartupValidator);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("onApplicationBootstrap()", () => {
    it("logs and skips when AI_DEFAULT_PROVIDER is not set", async () => {
      await validator.onApplicationBootstrap();

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("No system-default AI provider configured"),
      );
      expect(mockProviderFactory.createProvider).not.toHaveBeenCalled();
    });

    it("validates the system default provider and logs success", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        if (key === "AI_DEFAULT_MODEL") return "claude-sonnet-4-20250514";
        if (key === "AI_DEFAULT_API_KEY") return "sk-default";
        return undefined;
      });

      const isAvailable = jest.fn().mockResolvedValue(true);
      mockProviderFactory.createProvider.mockReturnValue({ isAvailable });

      await validator.onApplicationBootstrap();

      expect(mockEncryptionService.encrypt).toHaveBeenCalledWith("sk-default");
      expect(mockProviderFactory.createProvider).toHaveBeenCalledTimes(1);
      expect(mockProviderFactory.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          apiKeyEnc: "encrypted-default",
        }),
      );
      expect(isAvailable).toHaveBeenCalled();

      const successCall = logSpy.mock.calls.find((c) =>
        String(c[0]).startsWith("AI provider OK:"),
      );
      expect(successCall).toBeDefined();
      expect(successCall![0]).toContain("anthropic:claude-sonnet-4-20250514");
    });

    it("logs a warning when the provider is unreachable", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        return undefined;
      });

      mockProviderFactory.createProvider.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(false),
      });

      await validator.onApplicationBootstrap();

      const failureCall = warnSpy.mock.calls.find((c) =>
        String(c[0]).startsWith("AI provider FAILED:"),
      );
      expect(failureCall).toBeDefined();
      expect(failureCall![0]).toContain("anthropic");
    });

    it("captures the error message when isAvailable throws", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        return undefined;
      });

      mockProviderFactory.createProvider.mockReturnValue({
        isAvailable: jest.fn().mockRejectedValue(new Error("Boom")),
      });

      await validator.onApplicationBootstrap();

      const failureCall = warnSpy.mock.calls.find((c) =>
        String(c[0]).startsWith("AI provider FAILED:"),
      );
      expect(failureCall).toBeDefined();
      expect(failureCall![0]).toContain("Boom");
    });

    it("captures the error message when createProvider throws", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "openai-compatible";
        return undefined;
      });

      mockProviderFactory.createProvider.mockImplementation(() => {
        throw new Error("baseUrl is required");
      });

      await validator.onApplicationBootstrap();

      const failureCall = warnSpy.mock.calls.find((c) =>
        String(c[0]).startsWith("AI provider FAILED:"),
      );
      expect(failureCall).toBeDefined();
      expect(failureCall![0]).toContain("baseUrl is required");
    });

    it("does not encrypt the default API key when encryption is not configured", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        if (key === "AI_DEFAULT_API_KEY") return "sk-default";
        return undefined;
      });
      mockEncryptionService.isConfigured.mockReturnValue(false);

      mockProviderFactory.createProvider.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
      });

      await validator.onApplicationBootstrap();

      expect(mockEncryptionService.encrypt).not.toHaveBeenCalled();
      expect(mockProviderFactory.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyEnc: null }),
      );
    });

    it("omits the model from the label when AI_DEFAULT_MODEL is unset", async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "ollama";
        return undefined;
      });

      mockProviderFactory.createProvider.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
      });

      await validator.onApplicationBootstrap();

      const successCall = logSpy.mock.calls.find((c) =>
        String(c[0]).startsWith("AI provider OK:"),
      );
      expect(successCall).toBeDefined();
      expect(successCall![0]).toMatch(/AI provider OK: ollama$/);
    });
  });
});
