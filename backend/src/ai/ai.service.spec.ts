import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { AiService } from "./ai.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiUsageService } from "./ai-usage.service";
import { AiRelayService, RelayTimeoutError } from "./relay/ai-relay.service";

describe("AiService", () => {
  let service: AiService;
  let mockConfigRepository: Record<string, jest.Mock>;
  let mockEncryptionService: Partial<
    Record<keyof AiEncryptionService, jest.Mock>
  >;
  let mockProviderFactory: Partial<Record<keyof AiProviderFactory, jest.Mock>>;
  let mockUsageService: Partial<Record<keyof AiUsageService, jest.Mock>>;
  let mockConfigService: Partial<Record<keyof ConfigService, jest.Mock>>;
  let mockRelayService: Partial<Record<keyof AiRelayService, jest.Mock>>;

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

    mockRelayService = {
      getStatus: jest.fn().mockReturnValue({ state: "offline", queued: 0 }),
      enqueuePrompt: jest.fn().mockResolvedValue({ text: "Relay answer" }),
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
        { provide: AiRelayService, useValue: mockRelayService },
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

    it("routes through the relay agent when the provider is mcp_relay", async () => {
      const relayConfig = makeConfig({
        provider: "mcp_relay",
        apiKeyEnc: null,
        model: null,
      });
      mockConfigRepository.find.mockResolvedValue([relayConfig]);
      mockRelayService.getStatus!.mockReturnValue({
        state: "listening",
        queued: 0,
      });
      mockRelayService.enqueuePrompt!.mockResolvedValue({
        text: '{"insights": []}',
      });

      const result = await service.complete(
        userId,
        {
          systemPrompt: "You analyze spending.",
          messages: [{ role: "user", content: "Currency: USD" }],
          responseFormat: "json",
        },
        "insight",
      );

      expect(result.content).toBe('{"insights": []}');
      expect(result.provider).toBe("mcp_relay");
      expect(mockProviderFactory.createProvider).not.toHaveBeenCalled();
      // The flattened prompt carries the system prompt, the user message,
      // and (for JSON requests) the strict-JSON instruction.
      const [enqueueUserId, prompt, history] =
        mockRelayService.enqueuePrompt!.mock.calls[0];
      expect(enqueueUserId).toBe(userId);
      expect(prompt).toContain("You analyze spending.");
      expect(prompt).toContain("Currency: USD");
      expect(prompt).toContain("Respond with ONLY the JSON");
      expect(history).toEqual([]);
      expect(mockUsageService.logUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId,
          provider: "mcp_relay",
          model: "relay-agent",
          feature: "insight",
        }),
      );
    });

    it("omits the JSON instruction from relay prompts for text requests", async () => {
      const relayConfig = makeConfig({
        provider: "mcp_relay",
        apiKeyEnc: null,
        model: null,
      });
      mockConfigRepository.find.mockResolvedValue([relayConfig]);
      mockRelayService.getStatus!.mockReturnValue({
        state: "listening",
        queued: 0,
      });

      await service.complete(
        userId,
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        "query",
      );

      const [, prompt] = mockRelayService.enqueuePrompt!.mock.calls[0];
      expect(prompt).not.toContain("Respond with ONLY the JSON");
    });

    it("fails fast to the next provider when the relay agent is offline", async () => {
      const relayConfig = makeConfig({
        id: "c1",
        provider: "mcp_relay",
        priority: 0,
        apiKeyEnc: null,
      });
      const anthropicConfig = makeConfig({ id: "c2", priority: 1 });
      mockConfigRepository.find.mockResolvedValue([
        relayConfig,
        anthropicConfig,
      ]);

      const result = await service.complete(
        userId,
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        "insight",
      );

      expect(result.content).toBe("Response text");
      // The relay was never enqueued (offline pre-check), and the native
      // provider served the completion.
      expect(mockRelayService.enqueuePrompt).not.toHaveBeenCalled();
      expect(mockProviderFactory.createProvider).toHaveBeenCalledWith(
        anthropicConfig,
      );
      // The relay failure is logged as a provider error before the fallback.
      expect(mockUsageService.logUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "mcp_relay",
          error: expect.stringContaining("not connected"),
        }),
      );
    });

    it("surfaces the offline error when the only provider is the relay", async () => {
      const relayConfig = makeConfig({
        provider: "mcp_relay",
        apiKeyEnc: null,
      });
      mockConfigRepository.find.mockResolvedValue([relayConfig]);

      await expect(
        service.complete(
          userId,
          { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
          "insight",
        ),
      ).rejects.toThrow(
        "Your MCP relay agent is not connected. Connect your agent and try again.",
      );
    });

    it("surfaces a timeout error when the relay agent does not answer", async () => {
      const relayConfig = makeConfig({
        provider: "mcp_relay",
        apiKeyEnc: null,
      });
      mockConfigRepository.find.mockResolvedValue([relayConfig]);
      mockRelayService.getStatus!.mockReturnValue({
        state: "listening",
        queued: 0,
      });
      mockRelayService.enqueuePrompt!.mockRejectedValue(
        new RelayTimeoutError("no_agent", "prompt-1"),
      );

      await expect(
        service.complete(
          userId,
          { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
          "insight",
        ),
      ).rejects.toThrow("Your MCP relay agent did not answer in time");
    });

    it("falls back to the next provider when the relay times out", async () => {
      const relayConfig = makeConfig({
        id: "c1",
        provider: "mcp_relay",
        priority: 0,
        apiKeyEnc: null,
      });
      const anthropicConfig = makeConfig({ id: "c2", priority: 1 });
      mockConfigRepository.find.mockResolvedValue([
        relayConfig,
        anthropicConfig,
      ]);
      mockRelayService.getStatus!.mockReturnValue({
        state: "listening",
        queued: 0,
      });
      mockRelayService.enqueuePrompt!.mockRejectedValue(
        new RelayTimeoutError("disconnected", "prompt-1"),
      );

      const result = await service.complete(
        userId,
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        "insight",
      );

      expect(result.content).toBe("Response text");
      expect(mockProviderFactory.createProvider).toHaveBeenCalledWith(
        anthropicConfig,
      );
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

    it("reports relayActive when the top-priority provider is the relay", async () => {
      const relayConfig = makeConfig({
        provider: "mcp_relay",
        apiKeyEnc: null,
      });
      mockConfigRepository.find.mockResolvedValue([relayConfig]);

      const result = await service.getStatus(userId);

      expect(result.configured).toBe(true);
      expect(result.relayActive).toBe(true);
    });

    it("does not report relayActive for a native top-priority provider", async () => {
      mockConfigRepository.find.mockResolvedValue([makeConfig()]);

      const result = await service.getStatus(userId);

      expect(result.relayActive).toBe(false);
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
