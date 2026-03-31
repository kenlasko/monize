import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiEncryptionService } from "./ai-encryption.service";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiUsageService } from "./ai-usage.service";
import { CreateAiConfigDto, UpdateAiConfigDto } from "./dto/ai-config.dto";
import {
  AiProviderConfigResponse,
  AiUsageSummary,
  AiStatusResponse,
  AiConnectionTestResponse,
} from "./dto/ai-response.dto";
import {
  AiCompletionRequest,
  AiCompletionResponse,
  AiProvider,
} from "./providers/ai-provider.interface";
import {
  validateUrlIsSafe,
  validateUrlBasicSafety,
} from "./validators/safe-url.validator";
import {
  SELF_HOSTED_PROVIDERS,
  AiProviderType,
} from "./entities/ai-provider-config.entity";

const DEFAULT_MAX_AI_PROVIDERS_PER_USER = 10;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly maxProvidersPerUser: number;
  // M28: Cache the encrypted default API key to avoid re-encrypting on every call
  private cachedDefaultApiKeyEnc: string | null = null;
  private validatedDefaultBaseUrl: string | null = null;
  private defaultBaseUrlValidated = false;

  constructor(
    @InjectRepository(AiProviderConfig)
    private readonly configRepository: Repository<AiProviderConfig>,
    private readonly encryptionService: AiEncryptionService,
    private readonly providerFactory: AiProviderFactory,
    private readonly usageService: AiUsageService,
    private readonly configService: ConfigService,
  ) {
    const envVal = this.configService.get<number>("AI_MAX_PROVIDERS_PER_USER");
    this.maxProvidersPerUser =
      envVal && Number.isInteger(envVal) && envVal > 0
        ? envVal
        : DEFAULT_MAX_AI_PROVIDERS_PER_USER;

    // SECURITY: Validate AI_DEFAULT_BASE_URL at startup.
    // Self-hosted providers (ollama, openai-compatible) only need basic URL
    // safety since they are expected to run on private/local networks.
    const defaultBaseUrl = this.configService.get<string>(
      "AI_DEFAULT_BASE_URL",
    );
    if (defaultBaseUrl) {
      const defaultProvider = this.configService.get<string>(
        "AI_DEFAULT_PROVIDER",
      );
      const isSelfHosted = SELF_HOSTED_PROVIDERS.has(
        defaultProvider as AiProviderType,
      );

      if (isSelfHosted) {
        if (validateUrlBasicSafety(defaultBaseUrl)) {
          this.validatedDefaultBaseUrl = defaultBaseUrl;
        } else {
          this.logger.error(
            `AI_DEFAULT_BASE_URL "${defaultBaseUrl}" is not a valid HTTP/HTTPS URL. ` +
              "The default AI provider base URL will not be used.",
          );
        }
        this.defaultBaseUrlValidated = true;
      } else {
        validateUrlIsSafe(defaultBaseUrl).then((isSafe) => {
          if (isSafe) {
            this.validatedDefaultBaseUrl = defaultBaseUrl;
          } else {
            this.logger.error(
              `AI_DEFAULT_BASE_URL "${defaultBaseUrl}" failed SSRF validation -- ` +
                "it points to a private/internal IP or blocked hostname. " +
                "The default AI provider base URL will not be used.",
            );
          }
          this.defaultBaseUrlValidated = true;
        });
      }
    } else {
      this.defaultBaseUrlValidated = true;
    }
  }

  async getConfigs(userId: string): Promise<AiProviderConfigResponse[]> {
    const configs = await this.configRepository.find({
      where: { userId },
      order: { priority: "ASC", createdAt: "ASC" },
    });
    return configs.map((c) => this.toResponseDto(c));
  }

  async getConfig(userId: string, configId: string): Promise<AiProviderConfig> {
    const config = await this.configRepository.findOne({
      where: { id: configId, userId },
    });
    if (!config) {
      throw new NotFoundException("AI provider configuration not found");
    }
    return config;
  }

  async createConfig(
    userId: string,
    dto: CreateAiConfigDto,
  ): Promise<AiProviderConfigResponse> {
    // Validate baseUrl: self-hosted providers allow private URLs,
    // cloud providers require full SSRF validation
    if (dto.baseUrl) {
      await this.validateBaseUrl(dto.baseUrl, dto.provider);
    }

    const existingCount = await this.configRepository.count({
      where: { userId },
    });
    if (existingCount >= this.maxProvidersPerUser) {
      throw new BadRequestException(
        `Maximum of ${this.maxProvidersPerUser} AI provider configurations per user`,
      );
    }

    const config = this.configRepository.create({
      userId,
      provider: dto.provider,
      displayName: dto.displayName || null,
      model: dto.model || null,
      baseUrl: dto.baseUrl || null,
      priority: dto.priority ?? 0,
      config: dto.config || {},
      isActive: true,
    });

    if (dto.apiKey) {
      if (!this.encryptionService.isConfigured()) {
        throw new BadRequestException(
          "AI_ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
        );
      }
      config.apiKeyEnc = this.encryptionService.encrypt(dto.apiKey);
    }

    const saved = await this.configRepository.save(config);
    return this.toResponseDto(saved);
  }

  async updateConfig(
    userId: string,
    configId: string,
    dto: UpdateAiConfigDto,
  ): Promise<AiProviderConfigResponse> {
    const config = await this.getConfig(userId, configId);

    // Validate baseUrl: self-hosted providers allow private URLs,
    // cloud providers require full SSRF validation
    if (dto.baseUrl) {
      await this.validateBaseUrl(dto.baseUrl, config.provider);
    }

    if (dto.displayName !== undefined)
      config.displayName = dto.displayName || null;
    if (dto.model !== undefined) config.model = dto.model || null;
    if (dto.baseUrl !== undefined) config.baseUrl = dto.baseUrl || null;
    if (dto.priority !== undefined) config.priority = dto.priority;
    if (dto.isActive !== undefined) config.isActive = dto.isActive;
    if (dto.config !== undefined) config.config = dto.config;

    if (dto.apiKey !== undefined) {
      if (dto.apiKey) {
        if (!this.encryptionService.isConfigured()) {
          throw new BadRequestException(
            "AI_ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
          );
        }
        config.apiKeyEnc = this.encryptionService.encrypt(dto.apiKey);
      } else {
        config.apiKeyEnc = null;
      }
    }

    const saved = await this.configRepository.save(config);
    return this.toResponseDto(saved);
  }

  async deleteConfig(userId: string, configId: string): Promise<void> {
    const config = await this.getConfig(userId, configId);
    await this.configRepository.remove(config);
  }

  async testConnection(
    userId: string,
    configId: string,
  ): Promise<AiConnectionTestResponse> {
    const config = await this.getConfig(userId, configId);

    try {
      const provider = this.providerFactory.createProvider(config);
      const available = await provider.isAvailable();
      return { available };
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Test connection failed for config ${configId}: ${rawMessage}`,
      );
      return {
        available: false,
        error: "Connection test failed. Check your provider settings.",
      };
    }
  }

  async complete(
    userId: string,
    request: AiCompletionRequest,
    feature: string,
  ): Promise<AiCompletionResponse> {
    const configs = await this.getActiveConfigs(userId);

    if (configs.length === 0) {
      throw new BadRequestException(
        "No active AI providers configured. Please configure a provider in AI Settings.",
      );
    }

    const errors: string[] = [];

    for (const config of configs) {
      const startTime = Date.now();
      try {
        const provider = this.providerFactory.createProvider(config);
        const response = await provider.complete(request);
        const durationMs = Date.now() - startTime;

        await this.usageService.logUsage({
          userId,
          provider: config.provider,
          model: response.model,
          feature,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          durationMs,
        });

        return response;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const message =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`${config.provider}: ${message}`);

        this.logger.warn(`AI provider ${config.provider} failed: ${message}`);

        await this.usageService.logUsage({
          userId,
          provider: config.provider,
          model: config.model || "unknown",
          feature,
          inputTokens: 0,
          outputTokens: 0,
          durationMs,
          error: message,
        });
      }
    }

    this.logger.error(`All AI providers failed: ${errors.join("; ")}`);
    throw new BadRequestException(
      "All AI providers failed. Please check your provider configuration and try again.",
    );
  }

  async getUsageSummary(
    userId: string,
    days?: number,
  ): Promise<AiUsageSummary> {
    return this.usageService.getUsageSummary(userId, days);
  }

  async getStatus(userId: string): Promise<AiStatusResponse> {
    const configs = await this.configRepository.find({
      where: { userId, isActive: true },
    });

    const defaultConfig = this.buildDefaultConfig(userId);
    const hasSystemDefault = defaultConfig !== null;

    return {
      configured: configs.length > 0 || hasSystemDefault,
      encryptionAvailable: this.encryptionService.isConfigured(),
      activeProviders: configs.length,
      hasSystemDefault,
      systemDefaultProvider: hasSystemDefault ? defaultConfig.provider : null,
      systemDefaultModel: hasSystemDefault ? defaultConfig.model : null,
    };
  }

  async getToolUseProvider(userId: string): Promise<AiProvider> {
    const configs = await this.getActiveConfigs(userId);

    for (const config of configs) {
      const provider = this.providerFactory.createProvider(config);
      if (provider.supportsToolUse) {
        return provider;
      }
    }

    throw new BadRequestException(
      "No AI provider with tool use support configured. Natural language queries require Anthropic, OpenAI, or Ollama. Please configure one in AI Settings.",
    );
  }

  private async getActiveConfigs(userId: string): Promise<AiProviderConfig[]> {
    const userConfigs = await this.configRepository.find({
      where: { userId, isActive: true },
      order: { priority: "ASC" },
    });

    if (userConfigs.length > 0) {
      return userConfigs;
    }

    const defaultConfig = this.buildDefaultConfig(userId);
    return defaultConfig ? [defaultConfig] : [];
  }

  private buildDefaultConfig(userId: string): AiProviderConfig | null {
    const provider = this.configService.get<string>("AI_DEFAULT_PROVIDER");
    if (!provider) return null;

    const config = new AiProviderConfig();
    config.userId = userId;
    config.provider = provider as AiProviderConfig["provider"];
    config.model = this.configService.get<string>("AI_DEFAULT_MODEL") || null;
    // SECURITY: Use the SSRF-validated base URL instead of raw env var
    config.baseUrl = this.validatedDefaultBaseUrl;
    config.isActive = true;
    config.priority = 0;
    config.config = {};
    config.displayName = "System Default";

    const defaultApiKey = this.configService.get<string>("AI_DEFAULT_API_KEY");
    if (defaultApiKey && this.encryptionService.isConfigured()) {
      if (!this.cachedDefaultApiKeyEnc) {
        this.cachedDefaultApiKeyEnc =
          this.encryptionService.encrypt(defaultApiKey);
      }
      config.apiKeyEnc = this.cachedDefaultApiKeyEnc;
    }

    return config;
  }

  private async validateBaseUrl(
    baseUrl: string,
    provider: AiProviderType,
  ): Promise<void> {
    if (SELF_HOSTED_PROVIDERS.has(provider)) {
      if (!validateUrlBasicSafety(baseUrl)) {
        throw new BadRequestException(
          "baseUrl must be a valid HTTP or HTTPS URL",
        );
      }
    } else {
      const isSafe = await validateUrlIsSafe(baseUrl);
      if (!isSafe) {
        throw new BadRequestException(
          "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host",
        );
      }
    }
  }

  private toResponseDto(config: AiProviderConfig): AiProviderConfigResponse {
    const apiKeyMasked: string | null = config.apiKeyEnc ? "****" : null;

    return {
      id: config.id,
      provider: config.provider,
      displayName: config.displayName,
      isActive: config.isActive,
      priority: config.priority,
      model: config.model,
      apiKeyMasked,
      baseUrl: config.baseUrl,
      config: config.config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
