import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";

import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { resolvePositiveInt } from "../common/env-number.util";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { EncryptionService } from "../common/encryption/encryption.service";
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
  AiWebSearchOptions,
  AiWebSearchResponse,
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
import { User } from "../users/entities/user.entity";
import { privateBaseUrlAllowlist } from "./validators/private-base-url-allowlist";
import {
  AiBaseUrlRefusedError,
  assertBaseUrlAllowed,
  egressPolicyForConfig,
} from "./ai-base-url-policy";

const DEFAULT_MAX_AI_PROVIDERS_PER_USER = 10;

/**
 * Model label recorded in usage logs for completions answered by the user's
 * own agent through the reverse MCP relay. The relay has no model of its own
 * and never learns which model the agent runs.
 */
const RELAY_MODEL_LABEL = "relay-agent";

/**
 * The relay agent is a chat-style assistant with tools of its own. A
 * web-search completion cannot switch its search on, so it is asked to.
 */
function withRelaySearchInstruction(
  systemPrompt: string,
  search: AiWebSearchOptions,
): string {
  const instruction =
    `If you have a web search tool, use it (at most ${search.maxUses} ` +
    "searches) to verify your answer rather than answering from memory.";
  return systemPrompt ? `${systemPrompt}\n\n${instruction}` : instruction;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly maxProvidersPerUser: number;
  // M28: Cache the encrypted default API key to avoid re-encrypting on every call
  private cachedDefaultApiKeyEnc: string | null = null;
  private validatedDefaultBaseUrl: string | null = null;
  private defaultBaseUrlValidated = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    private readonly providerFactory: AiProviderFactory,
    private readonly usageService: AiUsageService,
    private readonly configService: ConfigService,
    private readonly relayService: AiRelayService,
  ) {
    // `ConfigService` returns the raw string, so `Number.isInteger` on it is
    // always false and every configured cap silently became the default.
    const maxProviders = resolvePositiveInt(
      this.configService.get("AI_MAX_PROVIDERS_PER_USER"),
      DEFAULT_MAX_AI_PROVIDERS_PER_USER,
    );
    if (maxProviders.invalid) {
      this.logger.warn(
        `AI_MAX_PROVIDERS_PER_USER must be a positive integer; using ${DEFAULT_MAX_AI_PROVIDERS_PER_USER}`,
      );
    }
    this.maxProvidersPerUser = maxProviders.value;

    // An entry that cannot be read allows nothing; say so once, at boot.
    const allowlist = privateBaseUrlAllowlist();
    if (allowlist.invalid.length > 0) {
      this.logger.warn(
        `AI_PRIVATE_BASE_URL_ALLOWLIST: ignoring ${allowlist.invalid.length} unreadable entr${allowlist.invalid.length === 1 ? "y" : "ies"}; expected comma-separated host or host:port values`,
      );
    }

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
    const configs = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AiProviderConfig).find({
        where: { userId },
        order: { priority: "ASC", createdAt: "ASC" },
      }),
    );
    return configs.map((c) => this.toResponseDto(c));
  }

  async getConfig(userId: string, configId: string): Promise<AiProviderConfig> {
    const config = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AiProviderConfig).findOne({
        where: { id: configId, userId },
      }),
    );
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
    // Validate the URL the provider will call: a public host for every cloud
    // provider, and for a self-hosted one unless its owner is an admin or the
    // operator allowlisted the address. An Ollama with no baseUrl is loopback.
    await this.validateBaseUrl(userId, dto.provider, dto.baseUrl);

    // One transaction, and the owner's row locked inside it. The per-user cap is
    // a read-modify-write, and the transaction alone is not the fix: two
    // concurrent creates each count the rows committed before either started, so
    // neither sees the other's insert and both pass. Serializing on the `users`
    // row is what makes the count binding.
    const saved = await withScopedDb(this.dataSource, async (manager) => {
      await manager.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
        userId,
      ]);

      const repo = manager.getRepository(AiProviderConfig);

      const existingCount = await repo.count({
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

      const config = repo.create({
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
        queryMaxIterations: dto.queryMaxIterations ?? null,
        queryMaxToolCalls: dto.queryMaxToolCalls ?? null,
        queryTimeoutMinutes: dto.queryTimeoutMinutes ?? null,
        queryMaxInputTokens: dto.queryMaxInputTokens ?? null,
        queryMaxToolResultChars: dto.queryMaxToolResultChars ?? null,
        isActive: true,
      });

      if (dto.apiKey) {
        if (!this.encryptionService.isConfigured()) {
          throw new BadRequestException(
            tr(
              "errors.ai.encryptionKeyNotConfigured",
              "ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
            ),
          );
        }
        config.apiKeyEnc = this.encryptionService.encrypt(dto.apiKey);
      }

      return repo.save(config);
    });
    return this.toResponseDto(saved);
  }

  async updateConfig(
    userId: string,
    configId: string,
    dto: UpdateAiConfigDto,
  ): Promise<AiProviderConfigResponse> {
    const config = await this.getConfig(userId, configId);

    // Same policy as createConfig, for a baseUrl the request changes (a
    // cleared one included: an Ollama without a baseUrl is loopback). An
    // unchanged stored URL is checked where it is used.
    if (dto.baseUrl !== undefined) {
      await this.validateBaseUrl(userId, config.provider, dto.baseUrl);
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
    // A budget the user cleared is sent as null and stored as null, which is
    // what "use the default" is spelled as; only an omitted field is left alone.
    if (dto.queryMaxIterations !== undefined)
      config.queryMaxIterations = dto.queryMaxIterations;
    if (dto.queryMaxToolCalls !== undefined)
      config.queryMaxToolCalls = dto.queryMaxToolCalls;
    if (dto.queryTimeoutMinutes !== undefined)
      config.queryTimeoutMinutes = dto.queryTimeoutMinutes;
    if (dto.queryMaxInputTokens !== undefined)
      config.queryMaxInputTokens = dto.queryMaxInputTokens;
    if (dto.queryMaxToolResultChars !== undefined)
      config.queryMaxToolResultChars = dto.queryMaxToolResultChars;

    if (dto.apiKey !== undefined) {
      if (dto.apiKey) {
        if (!this.encryptionService.isConfigured()) {
          throw new BadRequestException(
            tr(
              "errors.ai.encryptionKeyNotConfigured",
              "ENCRYPTION_KEY is not configured. Cannot store API keys securely.",
            ),
          );
        }
        config.apiKeyEnc = this.encryptionService.encrypt(dto.apiKey);
      } else {
        config.apiKeyEnc = null;
      }
    }

    const saved = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AiProviderConfig).save(config),
    );
    return this.toResponseDto(saved);
  }

  async deleteConfig(userId: string, configId: string): Promise<void> {
    // Read-modify-write: the ownership check and the delete are one unit.
    await withScopedDb(this.dataSource, async (manager) => {
      const config = await this.getConfig(userId, configId);
      await manager.getRepository(AiProviderConfig).remove(config);
    });
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
    await this.validateBaseUrl(userId, dto.provider, dto.baseUrl);

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

    // A stored key this instance cannot decrypt is its own diagnosis, and it is
    // one the generic message below actively hides. It happens when a backup is
    // restored onto an instance with a different ENCRYPTION_KEY, or after
    // that variable is rotated: the column is populated, so the provider row
    // shows a masked key and every "is a key configured?" check says yes, while
    // `createProvider` throws an AES-GCM authentication failure that reads as
    // "check your provider settings" -- settings that are, in fact, correct.
    // Say what is actually wrong and what fixes it.
    if (
      config.apiKeyEnc &&
      !this.encryptionService.canDecrypt(config.apiKeyEnc)
    ) {
      this.logger.warn(
        `Stored API key for ${logLabel} cannot be decrypted with this instance's ENCRYPTION_KEY`,
      );
      return {
        available: false,
        error: tr(
          "errors.ai.apiKeyUndecryptable",
          "The stored API key cannot be read by this server. This happens when a backup is restored onto a different instance, or after ENCRYPTION_KEY changes. Enter the API key again to fix it.",
        ),
      };
    }

    let provider;
    try {
      provider = await this.buildProvider(config);
    } catch (error) {
      if (error instanceof AiBaseUrlRefusedError) {
        this.logger.warn(
          `Test connection refused for ${logLabel}: base URL outside the owner's egress policy`,
        );
        return { available: false, error: error.message };
      }
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
    /**
     * `skipRelay` leaves the MCP relay out of the fall-through, for a background
     * job that must not put a prompt in front of the user's own agent when the
     * providers ahead of it fail.
     */
    options: { skipRelay?: boolean } = {},
  ): Promise<AiCompletionResponse> {
    return this.completeAcrossProviders(
      userId,
      feature,
      async (config, isRelay) =>
        isRelay
          ? this.completeViaRelay(userId, request)
          : (await this.buildProvider(config)).complete(request),
      undefined,
      options.skipRelay,
    );
  }

  /**
   * A single tool-free completion that may consult the web, served by every
   * provider the user has configured, in priority order with fallthrough --
   * the same loop as `complete()`:
   *
   * - a provider with its own server-side search (Anthropic, OpenAI) runs it
   *   through `completeWithWebSearch`;
   * - the MCP relay hands the prompt to the user's own agent, told to use its
   *   web search if it has one, and the answer is marked `viaRelay` because
   *   the agent cannot report whether it searched;
   * - any other provider answers from model knowledge through `complete()`
   *   in JSON mode, with `searched: false`.
   *
   * The caller decides how much to trust each of those three answers.
   */
  async completeWithWebSearch(
    userId: string,
    request: AiCompletionRequest,
    search: AiWebSearchOptions,
    feature: string,
    /**
     * Restrict the attempt to ONE of the user's providers, by config id.
     *
     * The payee contact lookup passes it: the fall-through across providers is
     * right for a chat turn and wrong for a lookup the user pays per call for,
     * where "whichever answers" can silently be the expensive one. Omitted
     * everywhere else, which keeps the priority-order behaviour untouched.
     */
    onlyConfigId?: string,
  ): Promise<AiWebSearchResponse> {
    const jsonRequest: AiCompletionRequest = {
      ...request,
      responseFormat: "json",
    };
    return this.completeAcrossProviders(
      userId,
      feature,
      async (config, isRelay): Promise<AiWebSearchResponse> => {
        if (isRelay) {
          const relayed = await this.completeViaRelay(userId, {
            ...jsonRequest,
            systemPrompt: withRelaySearchInstruction(
              jsonRequest.systemPrompt,
              search,
            ),
          });
          return {
            ...relayed,
            searched: false,
            searchCount: 0,
            viaRelay: true,
          };
        }
        const provider = await this.buildProvider(config);
        if (provider.supportsWebSearch && provider.completeWithWebSearch) {
          return provider.completeWithWebSearch(jsonRequest, search);
        }
        const plain = await provider.complete(jsonRequest);
        return { ...plain, searched: false, searchCount: 0 };
      },
      onlyConfigId,
    );
  }

  /**
   * The one provider loop: try each active config in priority order, log
   * usage for every attempt (success or failure), fall through on failure,
   * and surface the relay's own error when the relay was the only option.
   * `complete()` and `completeWithWebSearch()` differ only in what one
   * attempt does, so that is the parameter.
   */
  private async completeAcrossProviders<T extends AiCompletionResponse>(
    userId: string,
    feature: string,
    attempt: (config: AiProviderConfig, isRelay: boolean) => Promise<T>,
    onlyConfigId?: string,
    skipRelay = false,
  ): Promise<T> {
    const active = await this.getActiveConfigs(userId, onlyConfigId);
    const configs = skipRelay
      ? active.filter((c) => c.provider !== "mcp_relay")
      : active;

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
    let baseUrlRefusal: AiBaseUrlRefusedError | null = null;

    for (const config of configs) {
      const isRelay = config.provider === "mcp_relay";
      const startTime = Date.now();
      try {
        // mcp_relay is not a directly callable LLM -- route the completion
        // through the user's own agent, the same prompt/response round-trip
        // the chat uses. Failures (agent offline, timed out) fall through to
        // the next provider like any other provider failure.
        const response = await attempt(config, isRelay);
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
        if (error instanceof AiBaseUrlRefusedError && !baseUrlRefusal) {
          baseUrlRefusal = error;
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

    // A provider refused for the address its base URL points at names its own
    // repair (an admin, or the operator's allowlist); the generic message
    // below would send the user looking at settings that are not the problem.
    if (baseUrlRefusal) {
      throw baseUrlRefusal;
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
    const tunnel = await this.relayService.getStatus(userId);
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
    const configs = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AiProviderConfig).find({
        where: { userId, isActive: true },
        order: { priority: "ASC" },
      }),
    );

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

  /**
   * Whether an in-app completion can be answered RIGHT NOW: a provider is
   * configured and, when the user's top provider is the MCP relay (their own
   * agent), that agent is connected (`listening` or `busy`, not `offline`). The
   * server-side twin of the frontend's `assistantCanAnswerNow`
   * (`lib/assistant-ready.ts`), so a background job decides as the page does. A
   * read that fails is "no", never "yes": the caller then takes its
   * "wait for an agent" path.
   */
  async canAnswerNow(userId: string): Promise<boolean> {
    let status: AiStatusResponse;
    try {
      status = await this.getStatus(userId);
    } catch {
      return false;
    }
    if (!status.configured) return false;
    if (!status.relayActive) return true;
    try {
      const tunnel = await this.relayService.getStatus(userId);
      return tunnel.state === "listening" || tunnel.state === "busy";
    } catch {
      return false;
    }
  }

  async getToolUseProvider(userId: string): Promise<AiProvider> {
    return (await this.resolveToolUseProvider(userId)).provider;
  }

  /**
   * The provider that will answer a tool-using query, together with the
   * configuration it was built from.
   *
   * Callers need the configuration as well as the provider because settings
   * that belong to *this* provider -- the per-query budgets -- live on the
   * row, and the transient system-default config is marked so those callers
   * can tell the operator's provider from one the user owns.
   */
  async resolveToolUseProvider(
    userId: string,
  ): Promise<{ provider: AiProvider; config: AiProviderConfig }> {
    const configs = await this.getActiveConfigs(userId);
    let refusal: AiBaseUrlRefusedError | undefined;

    for (const config of configs) {
      // Relay is not an LLM; never instantiate it as one.
      if (config.provider === "mcp_relay") {
        continue;
      }
      let provider: AiProvider;
      try {
        provider = await this.buildProvider(config);
      } catch (error) {
        // A provider whose base URL its owner may not use is skipped like one
        // without tool support -- and named if nothing else answers, because
        // "configure a provider" is not the fix for it.
        if (error instanceof AiBaseUrlRefusedError) {
          refusal ??= error;
          continue;
        }
        throw error;
      }
      if (provider.supportsToolUse) {
        return { provider, config };
      }
    }

    if (refusal) throw refusal;

    throw new BadRequestException(
      tr(
        "errors.ai.noToolUseProvider",
        "No AI provider with tool use support configured. Natural language queries require Anthropic, OpenAI, or Ollama. Please configure one in AI Settings.",
      ),
    );
  }

  async getActiveConfigs(
    userId: string,
    /**
     * Narrow the answer to one of the user's own providers.
     *
     * An id that matches nothing active yields an EMPTY list rather than the
     * full one: the caller pinned a provider, and quietly answering from a
     * different one is the outcome a pin exists to prevent. Callers surface
     * that as "no provider", which names a repair the user can act on.
     */
    onlyConfigId?: string,
  ): Promise<AiProviderConfig[]> {
    const userConfigs = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AiProviderConfig).find({
        where: { userId, isActive: true },
        order: { priority: "ASC" },
      }),
    );

    if (userConfigs.length > 0) {
      return onlyConfigId
        ? userConfigs.filter((config) => config.id === onlyConfigId)
        : userConfigs;
    }

    // The centrally managed provider is the deployment's, not one of the
    // user's rows, so it can carry no pin -- and a pin naming a row that no
    // longer exists must not resolve to it.
    if (onlyConfigId) return [];
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
    // Marks the operator's provider: it has no row, cannot be edited in AI
    // Settings, and takes its per-query budgets from the AI_QUERY_* variables
    // rather than from the per-provider fields below.
    config.isSystemDefault = true;
    config.queryMaxIterations = null;
    config.queryMaxToolCalls = null;
    config.queryTimeoutMinutes = null;
    config.queryMaxInputTokens = null;
    config.queryMaxToolResultChars = null;

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

  /** The save-time (and draft-test) check; see `assertBaseUrlAllowed`. */
  private validateBaseUrl(
    userId: string,
    provider: AiProviderType,
    baseUrl: string | null | undefined,
  ): Promise<void> {
    return assertBaseUrlAllowed(provider, baseUrl, () =>
      this.ownerIsAdmin(userId),
    );
  }

  /**
   * Whether the owner of a provider config is an admin, read from their row
   * rather than from a request: the same answer serves the save, a test, and a
   * completion a background job runs with no request at all.
   */
  private async ownerIsAdmin(userId: string): Promise<boolean> {
    const owner = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(User).findOne({
        where: { id: userId },
        select: { id: true, role: true },
      }),
    );
    return owner?.role === "admin";
  }

  /**
   * The one way this service builds a provider from a config: the stored base
   * URL is checked against its owner's policy at USE time -- a row saved before
   * the policy existed, or by an admin since demoted, is refused here with a
   * message that names the fix -- and the provider is built with that policy,
   * which its fetch enforces again on the connection it makes.
   */
  private async buildProvider(config: AiProviderConfig): Promise<AiProvider> {
    const policy = await egressPolicyForConfig(config, () =>
      this.ownerIsAdmin(config.userId),
    );
    return this.providerFactory.createProvider(config, policy);
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
      queryMaxIterations: config.queryMaxIterations ?? null,
      queryMaxToolCalls: config.queryMaxToolCalls ?? null,
      queryTimeoutMinutes: config.queryTimeoutMinutes ?? null,
      queryMaxInputTokens: config.queryMaxInputTokens ?? null,
      queryMaxToolResultChars: config.queryMaxToolResultChars ?? null,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };
  }
}
