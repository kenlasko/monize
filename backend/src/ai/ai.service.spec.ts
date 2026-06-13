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
    config.inputCostPer1M = null;
    config.outputCostPer1M = null;
    config.costCurrency = "USD";
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

    it("allows private/local baseUrl for self-hosted providers", async () => {
      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: "http://192.168.1.100:11434",
      });
      expect(mockConfigRepository.save).toHaveBeenCalled();
    });

    it("rejects private baseUrl for cloud providers", async () => {
      await expect(
        service.createConfig(userId, {
          provider: "anthropic",
          apiKey: "sk-key",
          baseUrl: "http://localhost:8080",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects invalid URL scheme for self-hosted providers", async () => {
      await expect(
        service.createConfig(userId, {
          provider: "ollama",
          baseUrl: "ftp://localhost:11434",
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("auto-assigns priority when omitted", async () => {
      const existingConfig = makeConfig({ provider: "ollama", priority: 2 });
      mockConfigRepository.findOne.mockResolvedValue(existingConfig);

      await service.createConfig(userId, {
        provider: "ollama",
        baseUrl: "http://localhost:11434",
      });

      expect(mockConfigRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ priority: 3 }),
      );
    });

    it("throws BadRequestException when custom priority is duplicated", async () => {
      const existingConfig = makeConfig({ provider: "openai", priority: 0 });
      mockConfigRepository.findOne.mockResolvedValue(existingConfig);

      await expect(
        service.createConfig(userId, {
          provider: "openai",
          priority: 0,
          apiKey: "sk-key",
        }),
      ).rejects.toThrow(BadRequestException);
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

    it("throws BadRequestException when updating to a duplicated priority", async () => {
      const config = makeConfig({ id: "config-1", provider: "openai", priority: 0 });
      const otherConfig = makeConfig({ id: "config-2", provider: "openai", priority: 1 });
      
      mockConfigRepository.findOne
        .mockResolvedValueOnce(config)
        .mockResolvedValueOnce(otherConfig);

      await expect(
        service.updateConfig(userId, "config-1", {
          priority: 1,
        }),
      ).rejects.toThrow(BadRequestException);
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

    it("reports modelAvailable: true when verifyModel succeeds", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        verifyModel: jest
          .fn()
          .mockResolvedValue({ ok: true, model: "claude-sonnet-4-20250514" }),
      });

      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(true);
      expect(result.modelAvailable).toBe(true);
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });

    it("reports modelAvailable: false with the provider-supplied reason when the model is missing", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        verifyModel: jest.fn().mockResolvedValue({
          ok: false,
          model: "claude-sonnet-4-20250514",
          reason: 'Model "claude-sonnet-4-20250514" was not found.',
        }),
      });

      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(true);
      expect(result.modelAvailable).toBe(false);
      expect(result.modelError).toBe(
        'Model "claude-sonnet-4-20250514" was not found.',
      );
    });

    it("skips model verification when the provider doesn't implement verifyModel", async () => {
      const config = makeConfig();
      mockConfigRepository.findOne.mockResolvedValue(config);
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        // no verifyModel method
      });

      const result = await service.testConnection(userId, "config-1");
      expect(result.available).toBe(true);
      expect(result.modelAvailable).toBeUndefined();
    });
  });

  describe("testDraftConnection()", () => {
    it("probes a transient provider built from the draft body without saving", async () => {
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        verifyModel: jest.fn().mockResolvedValue({ ok: true, model: "gpt-4o" }),
      });
      mockEncryptionService.encrypt!.mockReturnValue("enc-drafted-key");

      const result = await service.testDraftConnection(userId, {
        provider: "openai",
        model: "gpt-4o",
        apiKey: "sk-test-draft",
      });

      expect(result).toEqual({
        available: true,
        modelAvailable: true,
        model: "gpt-4o",
      });
      // Nothing should be persisted -- the repository's save is never called.
      expect(mockConfigRepository.save).not.toHaveBeenCalled();
      // The draft's API key must be encrypted before handing it to the
      // provider factory, just like a real saved config.
      expect(mockEncryptionService.encrypt).toHaveBeenCalledWith(
        "sk-test-draft",
      );
      const factoryArg = mockProviderFactory.createProvider!.mock.calls[0][0];
      expect(factoryArg.provider).toBe("openai");
      expect(factoryArg.model).toBe("gpt-4o");
      expect(factoryArg.apiKeyEnc).toBe("enc-drafted-key");
    });

    it("falls back to the stored API key when apiKey is omitted and configId is provided", async () => {
      const existing = makeConfig({
        id: "existing-1",
        apiKeyEnc: "stored-enc-key",
      });
      mockConfigRepository.findOne.mockResolvedValue(existing);
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        verifyModel: jest
          .fn()
          .mockResolvedValue({ ok: true, model: "claude-haiku-4-20250414" }),
      });

      await service.testDraftConnection(userId, {
        provider: "anthropic",
        model: "claude-haiku-4-20250414",
        configId: "existing-1",
      });

      // No new encryption because we're reusing the stored key.
      expect(mockEncryptionService.encrypt).not.toHaveBeenCalled();
      const factoryArg = mockProviderFactory.createProvider!.mock.calls[0][0];
      expect(factoryArg.apiKeyEnc).toBe("stored-enc-key");
    });

    it("surfaces model-level failures with the provider's reason", async () => {
      mockProviderFactory.createProvider!.mockReturnValue({
        isAvailable: jest.fn().mockResolvedValue(true),
        verifyModel: jest.fn().mockResolvedValue({
          ok: false,
          model: "typo-4o",
          reason: 'Model "typo-4o" was not found.',
        }),
      });
      mockEncryptionService.encrypt!.mockReturnValue("enc");

      const result = await service.testDraftConnection(userId, {
        provider: "openai",
        model: "typo-4o",
        apiKey: "sk-test",
      });

      expect(result.available).toBe(true);
      expect(result.modelAvailable).toBe(false);
      expect(result.modelError).toBe('Model "typo-4o" was not found.');
    });

    it("reports available: false with a sanitised error when the factory rejects the draft", async () => {
      mockProviderFactory.createProvider!.mockImplementation(() => {
        throw new Error("baseUrl is required for openai-compatible provider");
      });

      const result = await service.testDraftConnection(userId, {
        provider: "openai-compatible",
        // no baseUrl
      });

      expect(result.available).toBe(false);
      expect(result.error).toBe(
        "Connection test failed. Check your provider settings.",
      );
    });

    it("does not let a user probe another user's stored credentials", async () => {
      // getConfig uses where { id, userId } -- a missing row for this
      // userId throws NotFoundException, which must propagate so the
      // test endpoint can't be used to harvest other users' keys.
      mockConfigRepository.findOne.mockResolvedValue(null);

      await expect(
        service.testDraftConnection(userId, {
          provider: "openai",
          configId: "someone-elses-config",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when encryption is not configured and apiKey is provided in draft", async () => {
      mockEncryptionService.isConfigured!.mockReturnValue(false);

      await expect(
        service.testDraftConnection(userId, {
          provider: "openai",
          apiKey: "sk-test",
        }),
      ).rejects.toThrow(BadRequestException);
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

  describe("parseFinancialData() & getStatus() prompt customization", () => {
    it("injects user custom rules from user preferences into system prompt", async () => {
      const userPrefs = {
        userId,
        aiImportInstructions: "Always map McDonald's to Category Restaurant.",
      };
      mockConfigRepository.manager = {
        findOne: jest.fn().mockResolvedValue(userPrefs),
      } as any;

      mockConfigRepository.find.mockResolvedValue([makeConfig()]);

      const mockComplete = jest.spyOn(service, "complete").mockResolvedValue({
        content: JSON.stringify({
          transactions: [],
          accounts: [],
          securities: [],
          confidence: "high",
          notes: "ok",
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "model",
        provider: "anthropic",
      });

      await service.parseFinancialData(userId, "McDonalds $10");

      expect(mockComplete).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          systemPrompt: expect.stringContaining("Always map McDonald's to Category Restaurant."),
        }),
        "ai-import",
      );
    });

    it("coerces account types to valid Monize types or defaults to OTHER", async () => {
      mockConfigRepository.manager = {
        findOne: jest.fn().mockResolvedValue(null),
      } as any;

      mockConfigRepository.find.mockResolvedValue([makeConfig()]);

      jest.spyOn(service, "complete").mockResolvedValue({
        content: JSON.stringify({
          transactions: [],
          accounts: [
            { name: "Checking Account", type: "checking" },
            { name: "Savings Account", type: "SAVINGS" },
            { name: "Unknown Account", type: "INVALID_TYPE" },
          ],
          securities: [],
          confidence: "high",
          notes: "ok",
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "model",
        provider: "anthropic",
      });

      const parsed = await service.parseFinancialData(userId, "some raw data");
      expect(parsed.accounts[0].type).toBe("CHEQUING");
      expect(parsed.accounts[1].type).toBe("SAVINGS");
      expect(parsed.accounts[2].type).toBe("OTHER");
    });

    it("sanitizes date formats", async () => {
      mockConfigRepository.manager = {
        findOne: jest.fn().mockResolvedValue(null),
      } as any;

      mockConfigRepository.find.mockResolvedValue([makeConfig()]);

      jest.spyOn(service, "complete").mockResolvedValue({
        content: JSON.stringify({
          transactions: [
            { date: "2026/06/13", payee: "Cafe", amount: -5, type: "expense" },
            { date: "null", payee: "Fee", amount: -1, type: "fee" },
          ],
          accounts: [],
          securities: [],
          confidence: "high",
          notes: "ok",
        }),
        usage: { inputTokens: 10, outputTokens: 10 },
        model: "model",
        provider: "anthropic",
      });

      const parsed = await service.parseFinancialData(userId, "some raw data");
      expect(parsed.transactions[0].date).toBe("2026-06-13");
      expect(parsed.transactions[1].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("returns defaultSystemPrompt in getStatus", async () => {
      mockConfigRepository.find.mockResolvedValue([makeConfig()]);
      const status = await service.getStatus(userId);
      expect(status.defaultSystemPrompt).toBeDefined();
      expect(status.defaultSystemPrompt).toContain("You are a financial data parser.");
    });
  });
});

