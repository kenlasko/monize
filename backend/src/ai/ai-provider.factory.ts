import { Injectable, BadRequestException } from "@nestjs/common";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiProvider } from "./providers/ai-provider.interface";
import { AnthropicProvider } from "./providers/anthropic.provider";
import { OpenAiProvider } from "./providers/openai.provider";
import { OllamaProvider } from "./providers/ollama.provider";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.provider";

@Injectable()
export class AiProviderFactory {
  constructor(private readonly encryptionService: AiEncryptionService) {}

  createProvider(config: AiProviderConfig): AiProvider {
    const apiKey = config.apiKeyEnc
      ? this.encryptionService.decrypt(config.apiKeyEnc)
      : "";

    switch (config.provider) {
      case "anthropic":
        return new AnthropicProvider(apiKey, config.model || undefined);

      case "openai":
        return new OpenAiProvider(
          apiKey,
          config.model || undefined,
          config.baseUrl || undefined,
        );

      case "ollama":
        return new OllamaProvider(
          config.baseUrl || undefined,
          config.model || undefined,
        );

      case "openai-compatible":
        if (!config.baseUrl) {
          throw new BadRequestException(
            "baseUrl is required for openai-compatible provider",
          );
        }
        return new OpenAiCompatibleProvider(
          apiKey,
          config.baseUrl,
          config.model || "gpt-4o",
        );

      default:
        throw new BadRequestException(
          `Unknown AI provider: ${config.provider}`,
        );
    }
  }
}
