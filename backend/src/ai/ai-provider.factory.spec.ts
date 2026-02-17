import { BadRequestException } from "@nestjs/common";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AnthropicProvider } from "./providers/anthropic.provider";
import { OpenAiProvider } from "./providers/openai.provider";
import { OllamaProvider } from "./providers/ollama.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

describe("AiProviderFactory", () => {
  let factory: AiProviderFactory;
  let mockEncryptionService: Partial<
    Record<keyof AiEncryptionService, jest.Mock>
  >;

  beforeEach(() => {
    mockEncryptionService = {
      decrypt: jest.fn().mockReturnValue("decrypted-api-key"),
      encrypt: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      maskApiKey: jest.fn(),
    };

    factory = new AiProviderFactory(
      mockEncryptionService as unknown as AiEncryptionService,
    );
  });

  function makeConfig(
    overrides: Partial<AiProviderConfig> = {},
  ): AiProviderConfig {
    const config = new AiProviderConfig();
    config.id = "config-1";
    config.userId = "user-1";
    config.provider = "anthropic";
    config.model = null;
    config.apiKeyEnc = "encrypted-key";
    config.baseUrl = null;
    config.isActive = true;
    config.priority = 0;
    config.config = {};
    config.displayName = null;
    config.createdAt = new Date();
    config.updatedAt = new Date();
    Object.assign(config, overrides);
    return config;
  }

  it("creates AnthropicProvider for anthropic", () => {
    const provider = factory.createProvider(
      makeConfig({ provider: "anthropic" }),
    );
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic");
    expect(mockEncryptionService.decrypt).toHaveBeenCalledWith("encrypted-key");
  });

  it("creates OpenAiProvider for openai", () => {
    const provider = factory.createProvider(makeConfig({ provider: "openai" }));
    expect(provider).toBeInstanceOf(OpenAiProvider);
    expect(provider.name).toBe("openai");
  });

  it("creates OllamaProvider for ollama", () => {
    const provider = factory.createProvider(
      makeConfig({ provider: "ollama", apiKeyEnc: null }),
    );
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe("ollama");
    expect(mockEncryptionService.decrypt).not.toHaveBeenCalled();
  });

  it("creates OpenAiCompatibleProvider for openai-compatible", () => {
    const provider = factory.createProvider(
      makeConfig({
        provider: "openai-compatible",
        baseUrl: "https://api.example.com",
      }),
    );
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider.name).toBe("openai-compatible");
  });

  it("throws BadRequestException for openai-compatible without baseUrl", () => {
    expect(() =>
      factory.createProvider(
        makeConfig({ provider: "openai-compatible", baseUrl: null }),
      ),
    ).toThrow(BadRequestException);
  });

  it("throws BadRequestException for unknown provider", () => {
    expect(() =>
      factory.createProvider(makeConfig({ provider: "unknown" as any })),
    ).toThrow(BadRequestException);
  });

  it("does not decrypt when apiKeyEnc is null", () => {
    factory.createProvider(makeConfig({ provider: "ollama", apiKeyEnc: null }));
    expect(mockEncryptionService.decrypt).not.toHaveBeenCalled();
  });
});
