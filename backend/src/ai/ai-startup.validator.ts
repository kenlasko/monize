import { Injectable, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AiProviderConfig,
  AiProviderType,
} from "./entities/ai-provider-config.entity";
import { AiProviderFactory } from "./ai-provider.factory";
import { AiEncryptionService } from "./ai-encryption.service";

/**
 * Validates connectivity to the system-default AI provider on backend startup
 * and logs the result. The system default is configured via the AI_DEFAULT_*
 * env vars; if none is set, validation is skipped.
 *
 * Failures are logged as warnings but never abort startup.
 */
@Injectable()
export class AiStartupValidator implements OnApplicationBootstrap {
  private readonly logger = new Logger(AiStartupValidator.name);

  constructor(
    private readonly providerFactory: AiProviderFactory,
    private readonly encryptionService: AiEncryptionService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const config = this.buildSystemDefaultConfig();

    if (!config) {
      this.logger.log(
        "No system-default AI provider configured (AI_DEFAULT_PROVIDER unset); skipping startup validation.",
      );
      return;
    }

    const label = this.formatLabel(config);
    this.logger.log(`Validating connection to AI provider: ${label}`);

    try {
      const provider = this.providerFactory.createProvider(config);
      const available = await provider.isAvailable();
      if (available) {
        this.logger.log(`AI provider OK: ${label}`);
      } else {
        this.logger.warn(`AI provider FAILED: ${label}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI provider FAILED: ${label} -- ${message}`);
    }
  }

  private formatLabel(config: AiProviderConfig): string {
    return config.model
      ? `${config.provider}:${config.model}`
      : config.provider;
  }

  private buildSystemDefaultConfig(): AiProviderConfig | null {
    const provider = this.configService.get<string>("AI_DEFAULT_PROVIDER");
    if (!provider) return null;

    const config = new AiProviderConfig();
    config.provider = provider as AiProviderType;
    config.model = this.configService.get<string>("AI_DEFAULT_MODEL") || null;
    config.baseUrl =
      this.configService.get<string>("AI_DEFAULT_BASE_URL") || null;
    config.isActive = true;
    config.priority = 0;
    config.config = {};
    config.displayName = "System Default";
    config.apiKeyEnc = null;

    const defaultApiKey = this.configService.get<string>("AI_DEFAULT_API_KEY");
    if (defaultApiKey && this.encryptionService.isConfigured()) {
      config.apiKeyEnc = this.encryptionService.encrypt(defaultApiKey);
    }

    return config;
  }
}
