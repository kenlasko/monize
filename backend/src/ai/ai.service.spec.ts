import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { AiService } from "./ai.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiUsageService } from "./ai-usage.service";

describe("AiService", () => {
  let service: AiService;
  let mockConfigRepository: Record<string, jest.Mock>;
  let mockEncryptionService: Partial<
    Record<keyof AiEncryptionService, jest.Mock>
  >;
  let mockProviderFactory: Partial<Record<keyof AiProviderFactory, jest.Mock>>;
  let mockUsageService: Partial<Record<keyof AiUsageService, jest.Mock>>;
  let mockConfigService: Partial<Record<keyof ConfigService, jest.Mock>>;

  const userId = "user-1";

  function makeConfig(
    overrides: Partial<AiProviderConfig> = {},
  ): AiProviderConfig {
    const config = new AiProviderConfig();
    config.id = "config-1";
    config.userId = userId;
    config.provider = "anthropic";
    config.displayName = "My Claude";
    config.isActive = true;
    config.priority = 0;
    config.model = "claude-sonnet-4-20250514";
    config.apiKeyEnc = "encrypted-key";
    config.baseUrl = null;
    config.config = {};
    config.createdAt = new Date("2024-01-01");
    config.updatedAt = new Date("2024-01-01");
    Object.assign(config, overrides);
    return config;
  }

  beforeEach(async () => {
    mockConfigRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) =>
        Promise.resolve({
          ...data,
          id: data.id || "new-id",
          createdAt: data.createdAt || new Date("2024-01-01"),
          updatedAt: new Date("2024-01-01"),
        }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    mockEncryptionService = {
      encrypt: jest.fn().mockReturnValue("encrypted-value"),
      decrypt: jest.fn().mockReturnValue("sk-decrypted-key"),
      isConfigured: jest.fn().mockReturnValue(true),
      maskApiKey: jest.fn().mockReturnValue("****dkey"),
    };

    mockProviderFactory = {
      createProvider: jest.fn().mockReturnValue({
        name: "anthropic",
        isAvailable: jest.fn().mockResolvedValue(true),
        complete: jest.fn().mockResolvedValue({
          content: "Response text",
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
        }),
      }),
    };

    mockUsageService = {
      logUsage: jest.fn().mockResolvedValue({ id: "log-1" }),
      getUsageSummary: jest.fn().mockResolvedValue({
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        byProvider: [],
        byFeature: [],
        recentLogs: [],
      }),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        {
          provide: getRepositoryToken(AiProviderConfig),
          useValue: mockConfigRepository,
        },
        { provide: AiEncryptionService, useValue: mockEncryptionService },
        { provide: AiProviderFactory, useValue: mockProviderFactory },
        { provide: AiUsageService, useValue: mockUsageService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  describe("getConfigs()", () => {
    it("returns configs for user with masked API keys", async () => {
      const config = makeConfig();
      mockConfigRepository.find.mockResolvedValue([config]);

      const result = await service.getConfigs(userId);

      expect(result).toHaveLength(1);
      expect(result[0].apiKeyMasked).toBe("****");
      expect(result[0].provider).toBe("anthropic");
      expect(mockConfigRepository.find).toHaveBeenCalledWith({
        where: { userId },
        order: { priority: "ASC", createdAt: "ASC" },
      });
    });

    it("returns null apiKeyMasked when no API key", async () => {
      const config = makeConfig({ apiKeyEnc: null });
      mockConfigRepository.find.mockResolvedValue([config]);

      const result = await service.getConfigs(userId);

      expect(result[0].apiKeyMasked).toBeNull();
    });

    it("returns **** when decryption fails", async () => {
      const config = makeConfig();
      mockConfigRepository.find.mockResolvedValue([config]);
      mockEncryptionService.decrypt!.mockImplementation(() => {
        throw new Error("Decryption failed");
      });

      const result = await service.getConfigs(userId);

      expect(result[0].apiKeyMasked).toBe("****");
    });
  });

  describe("getConfig()", () => {
    it("returns config when found", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      const result = await service.getConfig(userId, "config-1");
      expect(result.id).toBe("config-1");
    });

    it("throws NotFoundException when not found", async () => {
      mockConfigRepository.findOne.mockResolvedValue(null);
      await expect(service.getConfig(userId, "missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("createConfig()", () => {
    it("creates config and encrypts API key", async () => {
      const result = await service.createConfig(userId, {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        apiKey: "sk-ant-plaintext-key",
        displayName: "Test",
      });

      expect(mockEncryptionService.encrypt).toHaveBeenCalledWith(
        "sk-ant-plaintext-key",
      );
      expect(mockConfigRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId, provider: "anthropic" }),
      );
      expect(mockConfigRepository.save).toHaveBeenCalled();
      expect(result.provider).toBe("anthropic");
    });

    it("throws when encryption not configured and API key provided", async () => {
      mockEncryptionService.isConfigured!.mockReturnValue(false);

      await expect(
        service.createConfig(userId, {
          provider: "anthropic",
          apiKey: "sk-key",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("creates config without API key for Ollama", async () => {
      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      });

      expect(mockEncryptionService.encrypt).not.toHaveBeenCalled();
      expect(mockConfigRepository.save).toHaveBeenCalled();
    });
  });

  describe("updateConfig()", () => {
    it("updates config fields", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      await service.updateConfig(userId, "config-1", {
        displayName: "Updated Name",
        model: "claude-haiku-4-20250414",
      });

      expect(mockConfigRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          displayName: "Updated Name",
          model: "claude-haiku-4-20250414",
        }),
      );
    });

    it("re-encrypts API key when new key provided", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      await service.updateConfig(userId, "config-1", {
        apiKey: "new-api-key",
      });

      expect(mockEncryptionService.encrypt).toHaveBeenCalledWith("new-api-key");
    });

    it("clears API key when empty string provided", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      await service.updateConfig(userId, "config-1", {
        apiKey: "",
      });

      expect(mockConfigRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ apiKeyEnc: null }),
      );
    });
  });

  describe("deleteConfig()", () => {
    it("deletes config", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      await service.deleteConfig(userId, "config-1");

      expect(mockConfigRepository.remove).toHaveBeenCalledWith(config);
    });

    it("throws when config not found", async () => {
      mockConfigRepository.findOne.mockResolvedValue(null);
      await expect(service.deleteConfig(userId, "missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("testConnection()", () => {
    it("returns available: true when provider is available", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);

      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(true);
    });

    it("returns available: false with error on failure", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest
          .fn()
          .mockRejectedValue(new Error("Connection refused")),
      });

      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(false);
      expect(result.error).toBe(
        "Connection test failed. Check your provider settings.",
      );
    });
  });

  describe("complete()", () => {
    it("routes to first active provider and logs usage", async () => {
      const config = makeConfig();
      mockConfigRepository.find.mockResolvedValue([config]);

      const request = {
        systemPrompt: "You are helpful.",
        messages: [{ role: "user" as const, content: "Hello" }],
      };

      const result = await service.complete(userId, request, "query");

      expect(result.content).toBe("Response text");
      expect(mockUsageService.logUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          provider: "anthropic",
          feature: "query",
          inputTokens: 100,
          outputTokens: 50,
        }),
      );
    });

    it("falls back to next provider on failure", async () => {
      const config1 = makeConfig({ id: "c1", priority: 0 });
      const config2 = makeConfig({ id: "c2", priority: 1, provider: "openai" });
      mockConfigRepository.find.mockResolvedValue([config1, config2]);

      let callCount = 0;
      mockProviderFactory.createProvider!.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            complete: jest.fn().mockRejectedValue(new Error("Rate limited")),
          };
        }
        return {
          complete: jest.fn().mockResolvedValue({
            content: "Fallback response",
            usage: { inputTokens: 80, outputTokens: 40 },
            model: "gpt-4o",
            provider: "openai",
          }),
        };
      });

      const result = await service.complete(
        userId,
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        "query",
      );

      expect(result.content).toBe("Fallback response");
      expect(mockUsageService.logUsage).toHaveBeenCalledTimes(2);
    });

    it("throws when no providers configured", async () => {
      mockConfigRepository.find.mockResolvedValue([]);

      await expect(
        service.complete(
          userId,
          { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
          "query",
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws with all errors when all providers fail", async () => {
      const config1 = makeConfig({ id: "c1", provider: "anthropic" });
      const config2 = makeConfig({ id: "c2", provider: "openai" });
      mockConfigRepository.find.mockResolvedValue([config1, config2]);

      mockProviderFactory.createProvider!.mockReturnValue({
        complete: jest.fn().mockRejectedValue(new Error("API error")),
      });

      await expect(
        service.complete(
          userId,
          { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
          "query",
        ),
      ).rejects.toThrow("All AI providers failed");
    });

    it("uses system default when user has no configs", async () => {
      mockConfigRepository.find.mockResolvedValue([]);
      mockConfigService.get!.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        if (key === "AI_DEFAULT_MODEL") return "claude-sonnet-4-20250514";
        if (key === "AI_DEFAULT_API_KEY") return "sk-default-key";
        return undefined;
      });

      const result = await service.complete(
        userId,
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        "query",
      );

      expect(result.content).toBe("Response text");
      expect(mockEncryptionService.encrypt).toHaveBeenCalledWith(
        "sk-default-key",
      );
    });
  });

  describe("getStatus()", () => {
    it("returns status with active provider count", async () => {
      mockConfigRepository.find.mockResolvedValue([makeConfig()]);

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(true);
      expect(result.encryptionAvailable).toBe(true);
      expect(result.activeProviders).toBe(1);
      expect(result.hasSystemDefault).toBe(false);
      expect(result.systemDefaultProvider).toBeNull();
      expect(result.systemDefaultModel).toBeNull();
    });

    it("returns unconfigured when no providers and no system default", async () => {
      mockConfigRepository.find.mockResolvedValue([]);

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(false);
      expect(result.activeProviders).toBe(0);
      expect(result.hasSystemDefault).toBe(false);
      expect(result.systemDefaultProvider).toBeNull();
      expect(result.systemDefaultModel).toBeNull();
    });

    it("returns configured when system default is set and no user providers", async () => {
      mockConfigRepository.find.mockResolvedValue([]);
      mockConfigService.get!.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "openai";
        if (key === "AI_DEFAULT_MODEL") return "gpt-4o";
        return undefined;
      });

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(true);
      expect(result.activeProviders).toBe(0);
      expect(result.hasSystemDefault).toBe(true);
      expect(result.systemDefaultProvider).toBe("openai");
      expect(result.systemDefaultModel).toBe("gpt-4o");
    });

    it("returns both user providers and system default info", async () => {
      mockConfigRepository.find.mockResolvedValue([makeConfig()]);
      mockConfigService.get!.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "anthropic";
        if (key === "AI_DEFAULT_MODEL") return "claude-sonnet-4-20250514";
        return undefined;
      });

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(true);
      expect(result.activeProviders).toBe(1);
      expect(result.hasSystemDefault).toBe(true);
      expect(result.systemDefaultProvider).toBe("anthropic");
      expect(result.systemDefaultModel).toBe("claude-sonnet-4-20250514");
    });

    it("returns null model when system default has no model", async () => {
      mockConfigRepository.find.mockResolvedValue([]);
      mockConfigService.get!.mockImplementation((key: string) => {
        if (key === "AI_DEFAULT_PROVIDER") return "ollama";
        return undefined;
      });

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(true);
      expect(result.hasSystemDefault).toBe(true);
      expect(result.systemDefaultProvider).toBe("ollama");
      expect(result.systemDefaultModel).toBeNull();
    });
  });

  describe("getUsageSummary()", () => {
    it("delegates to usage service", async () => {
      await service.getUsageSummary(userId, 30);
      expect(mockUsageService.getUsageSummary).toHaveBeenCalledWith(userId, 30);
    });
  });

  describe("getToolUseProvider()", () => {
    it("returns first provider that supports tool use", async () => {
      const config = makeConfig({ provider: "anthropic" });
      mockConfigRepository.find.mockResolvedValue([config]);
      mockProviderFactory.createProvider!.mockReturnValue({
        name: "anthropic",
        supportsToolUse: true,
        completeWithTools: jest.fn(),
      });

      const provider = await service.getToolUseProvider(userId);

      expect(provider.name).toBe("anthropic");
      expect(provider.supportsToolUse).toBe(true);
    });

    it("skips providers without tool use support", async () => {
      const ollamaConfig = makeConfig({
        id: "c1",
        provider: "ollama",
        priority: 0,
      });
      const anthropicConfig = makeConfig({
        id: "c2",
        provider: "anthropic",
        priority: 1,
      });
      mockConfigRepository.find.mockResolvedValue([
        ollamaConfig,
        anthropicConfig,
      ]);

      let callCount = 0;
      mockProviderFactory.createProvider!.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return { name: "ollama", supportsToolUse: false };
        }
        return {
          name: "anthropic",
          supportsToolUse: true,
          completeWithTools: jest.fn(),
        };
      });

      const provider = await service.getToolUseProvider(userId);

      expect(provider.name).toBe("anthropic");
    });

    it("throws BadRequestException when no tool-use provider found", async () => {
      const ollamaConfig = makeConfig({ provider: "ollama" });
      mockConfigRepository.find.mockResolvedValue([ollamaConfig]);
      mockProviderFactory.createProvider!.mockReturnValue({
        name: "ollama",
        supportsToolUse: false,
      });

      await expect(service.getToolUseProvider(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequestException when no providers configured at all", async () => {
      mockConfigRepository.find.mockResolvedValue([]);

      await expect(service.getToolUseProvider(userId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("error message mentions Anthropic or OpenAI", async () => {
      mockConfigRepository.find.mockResolvedValue([]);

      await expect(service.getToolUseProvider(userId)).rejects.toThrow(
        /Anthropic.*OpenAI/,
      );
    });
  });
});
