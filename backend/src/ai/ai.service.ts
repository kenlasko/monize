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

const MAX_CONFIGS_PER_USER = 10;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiProviderConfig)
    private readonly configRepository: Repository<AiProviderConfig>,
    private readonly encryptionService: AiEncryptionService,
    private readonly providerFactory: AiProviderFactory,
    private readonly usageService: AiUsageService,
    private readonly configService: ConfigService,
  ) {}

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
    const existingCount = await this.configRepository.count({
      where: { userId },
    });
    if (existingCount >= MAX_CONFIGS_PER_USER) {
      throw new BadRequestException(
        `Maximum of ${MAX_CONFIGS_PER_USER} AI provider configurations per user`,
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

    return {
      configured: configs.length > 0,
      encryptionAvailable: this.encryptionService.isConfigured(),
      activeProviders: configs.length,
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
      "No AI provider with tool use support configured. Natural language queries require Anthropic or OpenAI. Please configure one in AI Settings.",
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
    config.baseUrl =
      this.configService.get<string>("AI_DEFAULT_BASE_URL") || null;
    config.isActive = true;
    config.priority = 0;
    config.config = {};
    config.displayName = "System Default";

    const defaultApiKey = this.configService.get<string>("AI_DEFAULT_API_KEY");
    if (defaultApiKey && this.encryptionService.isConfigured()) {
      config.apiKeyEnc = this.encryptionService.encrypt(defaultApiKey);
    }

    return config;
  }

  private toResponseDto(config: AiProviderConfig): AiProviderConfigResponse {
    let apiKeyMasked: string | null = null;
    if (config.apiKeyEnc) {
      try {
        const decrypted = this.encryptionService.decrypt(config.apiKeyEnc);
        apiKeyMasked = this.encryptionService.maskApiKey(decrypted);
      } catch {
        apiKeyMasked = "****";
      }
    }

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
