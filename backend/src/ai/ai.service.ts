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
import {
  CreateAiConfigDto,
  UpdateAiConfigDto,
  TestAiConfigDto,
} from "./dto/ai-config.dto";
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
  AiTextBlock,
} from "./providers/ai-provider.interface";
import { AiRelayService, RelayTimeoutError } from "./relay/ai-relay.service";
import {
  validateUrlIsSafe,
  validateUrlBasicSafety,
} from "./validators/safe-url.validator";
import { tr } from "../i18n/translate";
import {
  SELF_HOSTED_PROVIDERS,
  AiProviderType,
} from "./entities/ai-provider-config.entity";

const DEFAULT_MAX_AI_PROVIDERS_PER_USER = 10;

/**
 * Model label recorded in usage logs for completions answered by the user's
 * own agent through the reverse MCP relay. The relay has no model of its own
 * and never learns which model the agent runs.
 */
const RELAY_MODEL_LABEL = "relay-agent";

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
    private readonly relayService: AiRelayService,
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
      throw new NotFoundException(
        tr(
          "errors.ai.providerConfigNotFound",
          "AI provider configuration not found",
        ),
      );
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
        tr(
          "errors.ai.maxProvidersExceeded",
          `Maximum of ${this.maxProvidersPerUser} AI provider configurations per user`,
          { maxProvidersPerUser: this.maxProvidersPerUser },
        ),
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
      inputCostPer1M: dto.inputCostPer1M ?? null,
      outputCostPer1M: dto.outputCostPer1M ?? null,
      costCurrency: dto.costCurrency || "USD",
      isActive: true,
    });

    if (dto.apiKey) {
      if (!this.encryptionService.isConfigured()) {
        throw new BadRequestException(
          tr(
            "errors.ai.encryptionKeyNotConfigured",
            "AI_ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
          ),
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
    if (dto.inputCostPer1M !== undefined)
      config.inputCostPer1M = dto.inputCostPer1M;
    if (dto.outputCostPer1M !== undefined)
      config.outputCostPer1M = dto.outputCostPer1M;
    if (dto.costCurrency !== undefined) config.costCurrency = dto.costCurrency;

    if (dto.apiKey !== undefined) {
      if (dto.apiKey) {
        if (!this.encryptionService.isConfigured()) {
          throw new BadRequestException(
            tr(
              "errors.ai.encryptionKeyNotConfigured",
              "AI_ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
            ),
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
    return this.probeProvider(config, `config ${configId}`);
  }

  /**
   * Test an in-progress provider configuration without persisting it --
   * powers the inline Test button in the New / Edit Provider form so
   * users can validate model ids and credentials before saving.
   *
   * When `configId` is supplied and `apiKey` is omitted, we fall back
   * to the stored (encrypted) API key for that config: the form never
   * echoes the saved key back to the client, so editing an existing
   * provider without changing the key should still be testable.
   */
  async testDraftConnection(
    userId: string,
    dto: TestAiConfigDto,
  ): Promise<AiConnectionTestResponse> {
    if (dto.baseUrl) {
      await this.validateBaseUrl(dto.baseUrl, dto.provider);
    }

    // Build a transient, non-persisted config from the draft values.
    const transient = new AiProviderConfig();
    transient.userId = userId;
    transient.provider = dto.provider;
    transient.model = dto.model ?? null;
    transient.baseUrl = dto.baseUrl ?? null;
    transient.isActive = true;
    transient.priority = 0;
    transient.config = {};
    transient.inputCostPer1M = null;
    transient.outputCostPer1M = null;
    transient.costCurrency = "USD";
    transient.displayName = null;

    if (dto.apiKey) {
      transient.apiKeyEnc = this.encryptionService.encrypt(dto.apiKey);
    } else if (dto.configId) {
      // Load the stored key so the user doesn't have to retype it just
      // to run a test. Still scoped to userId so one user can't probe
      // another user's credentials.
      const existing = await this.getConfig(userId, dto.configId);
      transient.apiKeyEnc = existing.apiKeyEnc;
    } else {
      transient.apiKeyEnc = null;
    }

    return this.probeProvider(transient, `draft ${dto.provider}`);
  }

  private async probeProvider(
    config: AiProviderConfig,
    logLabel: string,
  ): Promise<AiConnectionTestResponse> {
    // Relay has no credentials/endpoint to probe; its live connection state is
    // shown in the chat and provider row, so there's nothing to test here.
    if (config.provider === "mcp_relay") {
      return { available: true };
    }
    let provider;
    try {
      provider = this.providerFactory.createProvider(config);
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Test connection failed for ${logLabel}: ${rawMessage}`);
      return {
        available: false,
        error: "Connection test failed. Check your provider settings.",
      };
    }

    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Test connection failed for ${logLabel}: ${rawMessage}`);
      return {
        available: false,
        error: "Connection test failed. Check your provider settings.",
      };
    }

    if (!available) {
      return { available: false };
    }

    // Server is reachable -- now verify the configured model actually
    // works so we can warn the user about typos, un-pulled Ollama
    // models, or keys that lack access to the requested model.
    if (!provider.verifyModel || !config.model) {
      return { available: true, model: config.model ?? undefined };
    }

    try {
      const verification = await provider.verifyModel();
      if (verification.ok) {
        return {
          available: true,
          modelAvailable: true,
          model: verification.model,
        };
      }
      return {
        available: true,
        modelAvailable: false,
        model: verification.model,
        modelError: verification.reason,
      };
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Model verification failed for ${logLabel}: ${rawMessage}`,
      );
      return {
        available: true,
        modelAvailable: false,
        model: config.model ?? undefined,
        modelError: "Could not verify the configured model.",
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
        tr(
          "errors.ai.noActiveProviders",
          "No active AI providers configured. Please configure a provider in AI Settings.",
        ),
      );
    }

    const errors: string[] = [];
    let relayError: BadRequestException | null = null;

    for (const config of configs) {
      const isRelay = config.provider === "mcp_relay";
      const startTime = Date.now();
      try {
        // mcp_relay is not a directly callable LLM -- route the completion
        // through the user's own agent, the same prompt/response round-trip
        // the chat uses. Failures (agent offline, timed out) fall through to
        // the next provider like any other provider failure.
        const response = isRelay
          ? await this.completeViaRelay(userId, request)
          : await this.providerFactory.createProvider(config).complete(request);
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

        if (isRelay && error instanceof BadRequestException && !relayError) {
          relayError = error;
        }

        this.logger.warn(`AI provider ${config.provider} failed: ${message}`);

        await this.usageService.logUsage({
          userId,
          provider: config.provider,
          model: config.model || (isRelay ? RELAY_MODEL_LABEL : "unknown"),
          feature,
          inputTokens: 0,
          outputTokens: 0,
          durationMs,
          error: message,
        });
      }
    }

    this.logger.error(`All AI providers failed: ${errors.join("; ")}`);

    // A relay-only setup has no other provider to fall back to: surface the
    // relay's own failure (agent offline / did not answer), which the user can
    // act on, instead of the generic message that suggests a misconfiguration.
    if (relayError && configs.every((c) => c.provider === "mcp_relay")) {
      throw relayError;
    }

    throw new BadRequestException(
      tr(
        "errors.ai.allProvidersFailed",
        "All AI providers failed. Please check your provider configuration and try again.",
      ),
    );
  }

  /**
   * Serve a completion through the reverse MCP relay: enqueue the prompt to
   * the user's own agent and await its answer, the same round-trip the chat
   * uses. Used by non-chat features (insights, forecast) when the user's
   * provider list reaches an mcp_relay config.
   *
   * Fails fast when no agent is connected -- enqueueing would otherwise park
   * the request for the full queue wait (minutes) with nothing listening.
   */
  private async completeViaRelay(
    userId: string,
    request: AiCompletionRequest,
  ): Promise<AiCompletionResponse> {
    const tunnel = this.relayService.getStatus(userId);
    if (tunnel.state === "offline") {
      throw new BadRequestException(
        tr(
          "errors.ai.relayAgentOffline",
          "Your MCP relay agent is not connected. Connect your agent and try again.",
        ),
      );
    }

    try {
      const response = await this.relayService.enqueuePrompt(
        userId,
        this.buildRelayPrompt(request),
        [],
      );
      return {
        content: response.text,
        usage: { inputTokens: 0, outputTokens: 0 },
        model: RELAY_MODEL_LABEL,
        provider: "mcp_relay",
      };
    } catch (error) {
      if (error instanceof RelayTimeoutError) {
        throw new BadRequestException(
          tr(
            "errors.ai.relayCompletionTimedOut",
            "Your MCP relay agent did not answer in time. Make sure it is connected, then try again.",
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Flatten an AiCompletionRequest into the single prompt string the relay
   * hands the agent. The agent is a chat-style assistant, so JSON-format
   * requests get an explicit trailing instruction to answer with raw JSON
   * only -- the analysis parsers reject prose and markdown fences.
   */
  private buildRelayPrompt(request: AiCompletionRequest): string {
    const parts: string[] = [];
    if (request.systemPrompt) {
      parts.push(request.systemPrompt);
    }
    for (const message of request.messages) {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block): block is AiTextBlock => block.type === "text")
              .map((block) => block.text)
              .join("\n");
      if (text) {
        parts.push(text);
      }
    }
    if (request.responseFormat === "json") {
      parts.push(
        "This is an automated analysis request from Monize, not a chat " +
          "message from the user. Respond with ONLY the JSON described " +
          "above -- no prose, no markdown code fences, and no commentary " +
          "before or after the JSON.",
      );
    }
    return parts.join("\n\n");
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
      order: { priority: "ASC" },
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
      // The chat routes to the reverse MCP relay when the highest-priority
      // active provider is mcp_relay (priority ASC -> [0] is top).
      relayActive: configs[0]?.provider === "mcp_relay",
    };
  }

  async getToolUseProvider(userId: string): Promise<AiProvider> {
    const configs = await this.getActiveConfigs(userId);

    for (const config of configs) {
      // Relay is not an LLM; never instantiate it as one.
      if (config.provider === "mcp_relay") {
        continue;
      }
      const provider = this.providerFactory.createProvider(config);
      if (provider.supportsToolUse) {
        return provider;
      }
    }

    throw new BadRequestException(
      tr(
        "errors.ai.noToolUseProvider",
        "No AI provider with tool use support configured. Natural language queries require Anthropic, OpenAI, or Ollama. Please configure one in AI Settings.",
      ),
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
          tr(
            "errors.ai.baseUrlInvalidBasic",
            "baseUrl must be a valid HTTP or HTTPS URL",
          ),
        );
      }
    } else {
      const isSafe = await validateUrlIsSafe(baseUrl);
      if (!isSafe) {
        throw new BadRequestException(
          tr(
            "errors.ai.baseUrlInvalidExternal",
            "baseUrl must be a valid HTTP/HTTPS URL pointing to an external host",
          ),
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
      inputCostPer1M: config.inputCostPer1M,
      outputCostPer1M: config.outputCostPer1M,
      costCurrency: config.costCurrency ?? "USD",
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
