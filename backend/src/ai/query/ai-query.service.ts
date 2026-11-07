import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { FinancialContextBuilder } from "../context/financial-context.builder";
import { ToolExecutorService } from "./tool-executor.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";
import {
  AiMessage,
  AiUserMessage,
  AiContentBlock,
  AiImageBlock,
  AiProvider,
  AiToolCall,
  AiToolDefinition,
} from "../providers/ai-provider.interface";
import {
  OllamaModelDoesNotSupportToolsError,
  OllamaModelDoesNotSupportImagesError,
} from "../providers/ollama.provider";
import { isImageInputUnsupportedError } from "../providers/content-blocks.util";
import { assessInjectionRisk } from "../context/prompt-injection-detector";
import { QUERY_SAFETY_REMINDER } from "../context/prompt-templates";
import { sanitizeToolResultStrings } from "../../common/sanitization.util";
import { MAX_HISTORY_MESSAGES, AttachmentDto } from "./dto/ai-query.dto";
import { validateAttachments } from "./attachment-validation";
import { tr } from "../../i18n/translate";
import { PendingAiAction } from "../actions/ai-action.types";
import {
  QueryBudgets,
  resolveQueryBudgets,
  resolveQueryBudgetsForConfig,
} from "./query-budgets";
import {
  CONTINUATION_NUDGE,
  MAX_CONTINUATION_NUDGES,
  isDeferredContinuation,
  promisesPendingAction,
} from "./continuation";

/** Per-run limits on what the assistant may call. */
export interface QueryRunOptions {
  /** Tool names withdrawn from this run: not offered, and refused if called anyway. */
  excludeTools?: readonly string[];
  /**
   * The only tool names this run may use: others are not offered, and refused
   * if called anyway. Absent means no limit; an empty list means no tools.
   */
  allowTools?: readonly string[];
}

/**
 * The only tools an acting delegate's run may use. The query routes are
 * `@AllowDelegate` and read-only for a delegate, and the delegate holds READ on
 * every account and section (`DelegateRequiresFullScope`), so a tool is listed
 * here only when it reads what that delegate can already read through REST.
 * A tool is never listed when it writes, shows a confirm card, reads data
 * behind an `@OwnerOnly` or non-`@AllowDelegate` route, or is not yet reviewed:
 * a new tool is withheld from delegates until it is added here on purpose.
 * `search_help` reads only the public user guide, never a user's data.
 */
export const DELEGATE_ALLOWED_AI_TOOLS: readonly string[] = [
  "list_transactions",
  "list_accounts",
  "list_categories",
  "compare_periods",
  "get_portfolio_summary",
  "list_investment_transactions",
  "list_capital_gains",
  "list_upcoming_bills",
  "get_budget_status",
  "calculate",
  "render_chart",
  "list_payees",
  "generate_report",
  "list_warranties",
  "search_help",
];

/**
 * Every other tool, each denied to a delegate. Read by the classification test
 * only (`delegate-ai-tools.guard.spec.ts`); the run decides from the allow-list.
 * - `manage_*`: prepare a confirm card for a write.
 * - `email_receipt_parsers`, `ai_review_requests`: write, and read owner-only
 *   email content.
 * - `fetch_bond_series`: writes the bond catalog.
 * - `list_transaction_rules`: the rules controller is owner-only.
 * - `lookup_securities`: `GET /securities/lookup` is not `@AllowDelegate`, and
 *   the call uses the owner's quote provider.
 */
export const DELEGATE_DENIED_AI_TOOLS: readonly string[] = [
  "manage_transactions",
  "manage_payees",
  "manage_securities",
  "manage_investment_transactions",
  "manage_transaction_rules",
  "list_transaction_rules",
  "email_receipt_parsers",
  "ai_review_requests",
  "fetch_bond_series",
  "lookup_securities",
];

/**
 * Why the tool-calling loop stopped without the model having answered. Four of
 * these are budgets; `stalled` is the model itself, ending turn after turn
 * promising work it cannot do once the turn is over.
 */
export type QueryCutoffReason =
  "iterations" | "toolCalls" | "tokens" | "timeout" | "stalled";

/**
 * The note prefixed to a synthesized answer, one per budget. Each says which
 * limit was hit and that the answer is built from partial data -- a user
 * comparing two runs of the same question needs to know why they differ.
 */
const CUTOFF_NOTES: Record<QueryCutoffReason, { key: string; text: string }> = {
  iterations: {
    key: "common.aiQuery.cutoff.iterations",
    text: "I reached the maximum number of analysis steps for this question, so this answer is based on the data I gathered before stopping.",
  },
  toolCalls: {
    key: "common.aiQuery.cutoff.toolCalls",
    text: "I reached the maximum number of data lookups for this question, so this answer is based on the data I gathered before stopping.",
  },
  tokens: {
    key: "common.aiQuery.cutoff.tokens",
    text: "I reached the maximum analysis budget for this question, so this answer is based on the data I gathered before stopping.",
  },
  timeout: {
    key: "common.aiQuery.cutoff.timeout",
    text: "This question took longer than the time available, so this answer is based on the data I gathered before stopping.",
  },
  stalled: {
    key: "common.aiQuery.cutoff.stalled",
    text: "I kept saying I would keep working instead of finishing, so this answer is based on the data I gathered before stopping.",
  },
};

const cutoffNote = (reason: QueryCutoffReason): string =>
  tr(CUTOFF_NOTES[reason].key, CUTOFF_NOTES[reason].text);

/**
 * Appended as a final user turn before the tool-free synthesis pass. The model
 * has the tool results in its context but no tools left to call, so it needs
 * telling that gathering is over and an answer is now due.
 */
const FINAL_SYNTHESIS_INSTRUCTION =
  "The data-gathering phase for this question is over and no further tools are available. " +
  "Answer now using only the tool results already in this conversation. " +
  "State plainly which parts of the question you could not answer from that data instead of guessing or estimating.";

/** What the final tool-free pass produced. */
interface FinalSynthesis {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface QueryResult {
  answer: string;
  toolsUsed: Array<{ name: string; summary: string }>;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface StreamEvent {
  type:
    | "thinking"
    | "assistant_text"
    | "tool_start"
    | "tool_result"
    | "chart"
    | "pending_action"
    | "content"
    | "sources"
    | "done"
    | "error";
  [key: string]: unknown;
}

@Injectable()
export class AiQueryService {
  private readonly logger = new Logger(AiQueryService.name);

  /**
   * Per-query resource budgets for the **centrally managed** provider,
   * resolved once at construction from the `AI_QUERY_*` environment. A query
   * answered by a provider the user configured themselves runs on that row's
   * own budgets instead -- resolved per query, because which provider answers
   * is not known until one is selected.
   */
  private readonly centralBudgets: QueryBudgets;

  constructor(
    private readonly aiService: AiService,
    private readonly usageService: AiUsageService,
    private readonly contextBuilder: FinancialContextBuilder,
    private readonly toolExecutor: ToolExecutorService,
    @Optional() configService?: ConfigService,
  ) {
    this.centralBudgets = resolveQueryBudgets(configService, this.logger);
  }

  async executeQuery(
    userId: string,
    query: string,
    conversationHistory?: Array<{
      role: "user" | "assistant";
      content: string;
    }>,
    attachments?: AttachmentDto[],
    options?: QueryRunOptions,
  ): Promise<QueryResult> {
    const events: StreamEvent[] = [];
    for await (const event of this.executeQueryStream(
      userId,
      query,
      conversationHistory,
      attachments,
      options,
    )) {
      events.push(event);
    }

    const contentParts: string[] = [];
    const toolsUsed: Array<{ name: string; summary: string }> = [];
    const sources: Array<{
      type: string;
      description: string;
      dateRange?: string;
    }> = [];
    let usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0 };

    for (const event of events) {
      if (event.type === "content") {
        contentParts.push(event.text as string);
      } else if (event.type === "tool_result") {
        toolsUsed.push({
          name: event.name as string,
          summary: event.summary as string,
        });
      } else if (event.type === "sources") {
        const eventSources = event.sources as Array<{
          type: string;
          description: string;
          dateRange?: string;
        }>;
        sources.push(...eventSources);
      } else if (event.type === "done") {
        usage = event.usage as typeof usage;
      } else if (event.type === "error") {
        throw new BadRequestException(event.message as string);
      }
    }

    return {
      answer: contentParts.join(""),
      toolsUsed,
      sources,
      usage,
    };
  }

  async *executeQueryStream(
    userId: string,
    query: string,
    conversationHistory?: Array<{
      role: "user" | "assistant";
      content: string;
    }>,
    attachments?: AttachmentDto[],
    options?: QueryRunOptions,
  ): AsyncGenerator<StreamEvent> {
    yield { type: "thinking", message: "Analyzing your question..." };

    const allowed = options?.allowTools ? new Set(options.allowTools) : null;
    const excluded = new Set(options?.excludeTools ?? []);
    const isOffered = (name: string): boolean =>
      excluded.has(name) ? false : !allowed || allowed.has(name);
    const offeredTools: AiToolDefinition[] = FINANCIAL_TOOLS.filter((t) =>
      isOffered(t.name),
    );

    const startTime = Date.now();
    this.logger.log(`Query start user=${userId} queryLen=${query.length}`);

    // Assess prompt injection risk before proceeding
    const riskAssessment = assessInjectionRisk(query);
    if (riskAssessment.riskLevel === "high") {
      this.logger.warn(
        `High-risk prompt injection detected for user ${userId}: patterns=[${riskAssessment.matchedPatterns.join(", ")}]`,
      );
      yield {
        type: "content",
        text: "I can only answer questions about your financial data. I'm not able to modify my behavior, reveal my instructions, or bypass my guidelines. Please rephrase your question about your finances.",
      };
      yield {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, toolCalls: 0 },
      };
      return;
    }

    let systemPrompt: string;
    const contextStart = Date.now();
    try {
      systemPrompt = await this.contextBuilder.buildQueryContext(userId);
      this.logger.log(
        `Context built user=${userId} chars=${systemPrompt.length} in ${Date.now() - contextStart}ms`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build context";
      this.logger.error(
        `Context build failed user=${userId}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      yield { type: "error", message };
      return;
    }

    let provider: AiProvider;
    // The budgets belong to whichever provider answers: the operator's
    // environment for the centrally managed one, the user's own row for a
    // provider they configured. Resolved here, once the provider is known.
    let budgets: QueryBudgets;
    try {
      const resolved = await this.aiService.resolveToolUseProvider(userId);
      provider = resolved.provider;
      budgets = resolveQueryBudgetsForConfig(
        resolved.config,
        this.centralBudgets,
        this.logger,
      );
      this.logger.log(
        `Provider selected user=${userId} provider=${provider.name} streaming=${!!provider.streamWithTools} ` +
          `systemDefault=${!!resolved.config.isSystemDefault} maxIterations=${budgets.maxIterations} ` +
          `maxToolCalls=${budgets.maxToolCalls} maxInputTokens=${budgets.maxInputTokens} ` +
          `timeoutMs=${budgets.queryTimeoutMs} maxToolResultChars=${budgets.maxToolResultChars}`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No AI provider available";
      this.logger.warn(`Provider selection failed user=${userId}: ${message}`);
      yield { type: "error", message };
      return;
    }

    // Build the current user turn -- a plain string normally, or a multimodal
    // content array when attachments are present. Validation failures (size,
    // declared-type mismatch, corrupt bytes) surface as an error event so both
    // the stream and non-stream paths report the specific reason.
    let currentUserMessage: AiUserMessage;
    try {
      currentUserMessage = this.buildCurrentUserMessage(query, attachments);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid attachment";
      yield { type: "error", message };
      return;
    }
    if (attachments && attachments.length > 0) {
      this.logger.log(
        `Query attachments user=${userId} count=${attachments.length} kinds=[${attachments
          .map((a) => a.kind)
          .join(",")}]`,
      );
    }
    // Whether this turn carries image/PDF input. Gates the "model can't read
    // images" message so a provider error that merely mentions "image" can't
    // surface it on a text-only turn.
    const hasVisualAttachments = !!attachments?.some(
      (a) => a.kind === "image" || a.kind === "pdf",
    );

    // Build messages: optional history + current query + safety reminder.
    // Conversation history allows the AI to reference prior turns
    // (e.g., "tell me more about that"). Only the current turn carries
    // attachments; history is text-only.
    const historyMessages: AiMessage[] =
      this.buildHistoryMessages(conversationHistory);
    const messages: AiMessage[] = [
      ...historyMessages,
      currentUserMessage,
      { role: "user", content: QUERY_SAFETY_REMINDER },
    ];
    const allToolsUsed: Array<{ name: string; summary: string }> = [];
    const allSources: Array<{
      type: string;
      description: string;
      dateRange?: string;
    }> = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    // A single proposing tool result may emit MANY confirmation cards (e.g.
    // individual-mode bulk manage_transactions), but only ONE proposing tool
    // call is allowed per response so the model can't queue up independent
    // proposals across tool calls.
    let proposingToolResults = 0;
    // Which budget stopped the loop. Set by whichever guard breaks out; stays
    // at the iteration default when the loop simply runs out of passes. The
    // guards record it rather than answering, because the answer is written
    // once below -- by the model, from the data it managed to gather.
    let cutoff: QueryCutoffReason = "iterations";
    // How many times this query has had to tell the model that its turn does
    // not resume. Bounded so a model that will not comply costs two extra
    // passes rather than the whole iteration budget.
    let continuationNudges = 0;

    for (let iteration = 0; iteration < budgets.maxIterations; iteration++) {
      this.logger.log(
        `Iteration ${iteration} start user=${userId} provider=${provider.name} messages=${messages.length} inputTokensSoFar=${totalInputTokens} toolCallsSoFar=${totalToolCalls}`,
      );
      // LLM04-F2: Enforce overall query timeout
      if (Date.now() - startTime > budgets.queryTimeoutMs) {
        this.logger.warn(
          `Query timeout reached for user ${userId} after ${iteration} iterations`,
        );
        cutoff = "timeout";
        break;
      }

      // LLM04-F1: Enforce per-query tool call budget
      if (totalToolCalls >= budgets.maxToolCalls) {
        this.logger.warn(
          `Tool call budget exhausted for user ${userId} (${totalToolCalls} calls)`,
        );
        cutoff = "toolCalls";
        break;
      }

      // LLM04-F3: Enforce token budget
      if (totalInputTokens >= budgets.maxInputTokens) {
        this.logger.warn(
          `Token budget exhausted for user ${userId} (${totalInputTokens} input tokens)`,
        );
        cutoff = "tokens";
        break;
      }

      let iterationContent = "";
      let iterationToolCalls: AiToolCall[] = [];
      let iterationStopReason: "end_turn" | "tool_use" | "max_tokens" =
        "end_turn";
      let iterationModel = "unknown";
      let iterationInputTokens = 0;
      let iterationOutputTokens = 0;
      const providerCallStart = Date.now();
      let firstChunkAt: number | null = null;

      try {
        if (provider.streamWithTools) {
          // Streaming path: emit assistant_text deltas as the model generates
          // them so the UI shows the thinking in realtime.
          for await (const chunk of provider.streamWithTools(
            {
              systemPrompt,
              messages,
              maxTokens: 4096,
              temperature: 0.1,
            },
            offeredTools,
          )) {
            if (chunk.type === "text") {
              if (firstChunkAt === null) {
                firstChunkAt = Date.now();
                this.logger.log(
                  `Provider first chunk user=${userId} provider=${provider.name} iteration=${iteration} ttfb=${firstChunkAt - providerCallStart}ms`,
                );
              }
              yield { type: "assistant_text", text: chunk.text };
            } else {
              iterationContent = chunk.content;
              iterationToolCalls = chunk.toolCalls;
              iterationStopReason = chunk.stopReason;
              iterationModel = chunk.model;
              iterationInputTokens = chunk.usage.inputTokens;
              iterationOutputTokens = chunk.usage.outputTokens;
            }
          }
        } else if (provider.completeWithTools) {
          // Non-streaming fallback for providers that don't implement
          // streamWithTools yet. Emit the full text as a single delta so
          // the UI still shows the thinking buffer populated.
          const response = await provider.completeWithTools(
            {
              systemPrompt,
              messages,
              maxTokens: 4096,
              temperature: 0.1,
            },
            offeredTools,
          );
          iterationContent = response.content;
          iterationToolCalls = response.toolCalls;
          iterationStopReason = response.stopReason;
          iterationModel = response.model;
          iterationInputTokens = response.usage.inputTokens;
          iterationOutputTokens = response.usage.outputTokens;
          if (iterationContent) {
            yield { type: "assistant_text", text: iterationContent };
          }
        } else {
          throw new Error("Configured AI provider does not support tool use");
        }
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "AI provider error";
        const providerCallMs = Date.now() - providerCallStart;
        // Classify user-actionable conditions (retrying without a change is
        // pointless): the model lacks tool support, or it can't read the
        // attached image/PDF. The image case covers both the typed Ollama
        // error and other providers whose SDK error message says so -- gated
        // on hasVisualAttachments so an unrelated error mentioning "image"
        // can't trigger it on a text-only turn.
        const isImagesUnsupported =
          error instanceof OllamaModelDoesNotSupportImagesError ||
          (hasVisualAttachments && isImageInputUnsupportedError(rawMessage));
        const isActionable =
          error instanceof OllamaModelDoesNotSupportToolsError ||
          isImagesUnsupported;
        // Log user-actionable conditions at warn without a stack trace -- they
        // are user-fixable, not system faults -- and keep error + stack for
        // genuine provider failures.
        if (isActionable) {
          this.logger.warn(
            `AI query stopped (user-actionable) user=${userId} provider=${provider.name} iteration=${iteration} after=${providerCallMs}ms: ${rawMessage}`,
          );
        } else {
          this.logger.error(
            `AI query failed user=${userId} provider=${provider.name} iteration=${iteration} after=${providerCallMs}ms: ${rawMessage}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
        // Record the failed attempt in the usage log so failures show up
        // alongside successful queries instead of leaving the dashboard
        // looking idle when AI calls are silently erroring.
        await this.logUsage(
          userId,
          provider.name,
          iterationModel,
          totalInputTokens,
          totalOutputTokens,
          Date.now() - startTime,
          rawMessage,
        );
        // Surface a specific, actionable message instead of the generic
        // "try again" when retrying won't help.
        let userMessage: string;
        if (error instanceof OllamaModelDoesNotSupportToolsError) {
          userMessage = error.message;
        } else if (isImagesUnsupported) {
          userMessage = tr(
            "errors.ai.modelNoImageSupport",
            "The selected AI model can't read images or PDFs. Remove the attachment and ask in text, or switch to a vision-capable model in AI Settings.",
          );
        } else {
          userMessage =
            "The AI provider encountered an error processing your query. Please try again.";
        }
        yield {
          type: "error",
          message: userMessage,
        };
        return;
      }

      const providerCallMs = Date.now() - providerCallStart;
      this.logger.log(
        `Provider call done user=${userId} provider=${provider.name} model=${iterationModel} iteration=${iteration} ms=${providerCallMs} stopReason=${iterationStopReason} inputTokens=${iterationInputTokens} outputTokens=${iterationOutputTokens} toolCalls=${iterationToolCalls.length}`,
      );

      totalInputTokens += iterationInputTokens;
      totalOutputTokens += iterationOutputTokens;

      if (
        iterationStopReason !== "tool_use" ||
        iterationToolCalls.length === 0
      ) {
        // A turn that ends promising more work is not an answer. Nothing runs
        // between turns, so "one moment" is a message the user waits on
        // forever -- the loop has already handed control back by the time they
        // read it. Tell the model its turn does not resume and run another
        // pass; the promise stays in the thinking buffer rather than being
        // promoted into the answer bubble.
        //
        // The second clause is the one that needs no judgement about prose: a
        // confirmation card exists only if a write tool call produced a
        // pending action, so a turn that promises cards while `proposedThisQuery`
        // is still zero has told the user something that is not true.
        const promisedUnproposedCards =
          proposingToolResults === 0 && promisesPendingAction(iterationContent);
        if (
          isDeferredContinuation(iterationContent) ||
          promisedUnproposedCards
        ) {
          if (continuationNudges < MAX_CONTINUATION_NUDGES) {
            continuationNudges++;
            this.logger.warn(
              `Deferred continuation user=${userId} provider=${provider.name} iteration=${iteration} ` +
                `nudge=${continuationNudges}/${MAX_CONTINUATION_NUDGES} unproposedCards=${promisedUnproposedCards}`,
            );
            messages.push({ role: "assistant", content: iterationContent });
            messages.push({ role: "user", content: CONTINUATION_NUDGE });
            continue;
          }
          // Nudged to the limit and still stalling. Withdrawing the tools is
          // the one move the model cannot answer with another promise, so fall
          // through to the synthesis pass rather than shipping the stall text
          // as the answer.
          this.logger.warn(
            `Deferred continuation unresolved user=${userId} provider=${provider.name} iteration=${iteration} nudges=${continuationNudges}`,
          );
          messages.push({ role: "assistant", content: iterationContent });
          cutoff = "stalled";
          break;
        }

        // Final answer — emit canonical content event so the UI promotes the
        // streamed thinking text into the assistant message bubble.
        yield { type: "content", text: iterationContent };

        if (allSources.length > 0) {
          yield { type: "sources", sources: allSources };
        }

        const durationMs = Date.now() - startTime;
        this.logger.log(
          `Query complete user=${userId} provider=${provider.name} model=${iterationModel} totalMs=${durationMs} iterations=${iteration + 1} totalInputTokens=${totalInputTokens} totalOutputTokens=${totalOutputTokens} totalToolCalls=${totalToolCalls}`,
        );
        await this.logUsage(
          userId,
          provider.name,
          iterationModel,
          totalInputTokens,
          totalOutputTokens,
          durationMs,
        );

        yield {
          type: "done",
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            toolCalls: totalToolCalls,
          },
        };
        return;
      }

      // Process tool calls
      const assistantMessage: AiMessage = {
        role: "assistant",
        content: iterationContent,
        toolCalls: iterationToolCalls,
      };
      messages.push(assistantMessage);

      for (const toolCall of iterationToolCalls) {
        totalToolCalls++;

        const toolStart = Date.now();
        this.logger.log(
          `Tool call start user=${userId} tool=${toolCall.name} iteration=${iteration} totalToolCalls=${totalToolCalls} inputKeys=[${Object.keys(toolCall.input).join(",")}]`,
        );

        yield {
          type: "tool_start",
          name: toolCall.name,
          description: this.getToolDescription(toolCall.name),
          input: toolCall.input,
        };

        // A tool outside this run's allow-list is refused even when the model
        // names it anyway (it was never offered, so the call is hallucinated or
        // injected).
        const result: Awaited<ReturnType<ToolExecutorService["execute"]>> =
          !isOffered(toolCall.name)
            ? {
                data: { error: "This tool is not available in this run." },
                summary: `Tool not available: ${toolCall.name}`,
                sources: [],
                isError: true,
              }
            : await this.toolExecutor.execute(
                userId,
                toolCall.name,
                toolCall.input,
                { attachments },
              );

        this.logger.log(
          `Tool call done user=${userId} tool=${toolCall.name} ms=${Date.now() - toolStart} sources=${result.sources.length}`,
        );

        allToolsUsed.push({ name: toolCall.name, summary: result.summary });
        allSources.push(...result.sources);

        yield {
          type: "tool_result",
          name: toolCall.name,
          summary: result.summary,
          isError: result.isError === true,
        };

        // Chart tool: emit the structured payload as a separate event so the
        // frontend can render it with recharts. Keeping this distinct from
        // tool_result means the existing tools-used pill list still populates
        // for render_chart without any store-reducer changes.
        if (
          toolCall.name === "render_chart" &&
          result.isError !== true &&
          result.data
        ) {
          yield {
            type: "chart",
            chart: result.data,
          };
        }

        // Human-in-the-loop write tools: emit the signed action(s) so the
        // frontend can render confirmation card(s). The model never sees the
        // signature -- result.data holds the LLM-safe status. A single tool
        // result may carry many cards (individual-mode bulk), but only one
        // proposing tool call is allowed per response.
        let llmFacingData = result.data;
        const proposed: PendingAiAction[] = [
          ...(result.pendingAction ? [result.pendingAction] : []),
          ...(result.pendingActions ?? []),
        ];
        if (proposed.length > 0) {
          if (proposingToolResults >= 1) {
            llmFacingData = {
              status: "not_proposed",
              message:
                "Another action has already been proposed in this response. Ask the user to confirm the pending card(s) before proposing more.",
            };
          } else {
            proposingToolResults++;
            for (const action of proposed) {
              yield {
                type: "pending_action",
                action,
              };
            }
          }
        }

        // Add tool result message with sanitized string values
        const sanitizedData = sanitizeToolResultStrings(llmFacingData);
        // LLM08-F2: Truncate oversized tool results to prevent context bloat
        let toolResultContent = JSON.stringify(sanitizedData);
        if (toolResultContent.length > budgets.maxToolResultChars) {
          toolResultContent =
            toolResultContent.substring(0, budgets.maxToolResultChars) +
            '... [truncated, data too large]"';
        }
        const toolResultMessage: AiMessage = {
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: toolResultContent,
        };
        messages.push(toolResultMessage);
      }
    }

    // The loop ended mid-investigation -- a budget stopped it, or the model
    // kept promising work instead of doing it. The tool results gathered so
    // far are still the only material an answer could be built from, and they
    // are all sitting in `messages` -- so hand them back to the model with the
    // tools withdrawn and let it write the answer, rather than discarding the
    // work and apologising. Withdrawing the tools is what makes this
    // terminate: the model has nothing left to call, so it must reply with
    // text.
    this.logger.warn(
      `Loop stopped without an answer user=${userId} provider=${provider.name} cutoff=${cutoff} totalToolCalls=${totalToolCalls} totalInputTokens=${totalInputTokens}`,
    );

    const synthesis = yield* this.streamFinalSynthesis(
      userId,
      provider,
      systemPrompt,
      messages,
    );
    if (synthesis) {
      totalInputTokens += synthesis.inputTokens;
      totalOutputTokens += synthesis.outputTokens;
    }

    // The note comes first: the user has to know the answer was built from a
    // truncated investigation before they read it, not after.
    const answer = synthesis?.text.trim();
    yield {
      type: "content",
      text: answer
        ? `${cutoffNote(cutoff)}\n\n${answer}`
        : tr(
            "common.aiQuery.synthesisFailed",
            "I gathered data for this question but couldn't complete the analysis, so I don't have a reliable answer. Try asking something narrower.",
          ),
    };

    if (allSources.length > 0) {
      yield { type: "sources", sources: allSources };
    }

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Query incomplete user=${userId} provider=${provider.name} cutoff=${cutoff} synthesized=${!!answer} totalMs=${durationMs} totalInputTokens=${totalInputTokens} totalOutputTokens=${totalOutputTokens} totalToolCalls=${totalToolCalls}`,
    );
    await this.logUsage(
      userId,
      provider.name,
      synthesis?.model ?? "unknown",
      totalInputTokens,
      totalOutputTokens,
      durationMs,
    );

    yield {
      type: "done",
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        toolCalls: totalToolCalls,
      },
    };
  }

  /**
   * Ask the model for a final answer with the tools withdrawn, from the tool
   * results already in `messages`.
   *
   * Yields `assistant_text` deltas so the UI keeps streaming, and returns the
   * assembled text plus its usage -- or `null` when the provider cannot answer,
   * which the caller reports honestly rather than dressing up as an answer.
   *
   * The tool list is empty rather than absent-by-omission at the call site:
   * `toolsField` drops the field from the provider request, which is why this
   * cannot simply use `provider.complete()`. That path maps messages through
   * `toSimpleMessages`, which filters `role: "tool"` out entirely -- it would
   * send a conversation stripped of every tool result and get back a confident
   * summary of nothing.
   */
  private async *streamFinalSynthesis(
    userId: string,
    provider: AiProvider,
    systemPrompt: string,
    messages: AiMessage[],
  ): AsyncGenerator<StreamEvent, FinalSynthesis | null> {
    const request = {
      systemPrompt,
      messages: [
        ...messages,
        { role: "user" as const, content: FINAL_SYNTHESIS_INSTRUCTION },
      ],
      maxTokens: 4096,
      temperature: 0.1,
    };
    const noTools: AiToolDefinition[] = [];
    const startedAt = Date.now();

    let streamed = "";
    let content = "";
    let model = "unknown";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      if (provider.streamWithTools) {
        for await (const chunk of provider.streamWithTools(request, noTools)) {
          if (chunk.type === "text") {
            streamed += chunk.text;
            yield { type: "assistant_text", text: chunk.text };
          } else {
            content = chunk.content;
            model = chunk.model;
            inputTokens = chunk.usage.inputTokens;
            outputTokens = chunk.usage.outputTokens;
          }
        }
      } else if (provider.completeWithTools) {
        const response = await provider.completeWithTools(request, noTools);
        content = response.content;
        model = response.model;
        inputTokens = response.usage.inputTokens;
        outputTokens = response.usage.outputTokens;
        if (content) {
          yield { type: "assistant_text", text: content };
        }
      } else {
        return null;
      }
    } catch (error) {
      // A failed synthesis is not a failed query: the budget guard already
      // decided this response is partial, so degrade to the honest message
      // rather than replacing a partial answer with an error.
      this.logger.warn(
        `Final synthesis failed user=${userId} provider=${provider.name} after=${Date.now() - startedAt}ms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }

    // Prefer the assembled content from the terminating chunk; fall back to
    // the concatenated deltas for a provider that only reports them there.
    const text = content || streamed;
    this.logger.log(
      `Final synthesis done user=${userId} provider=${provider.name} model=${model} ms=${Date.now() - startedAt} chars=${text.length} inputTokens=${inputTokens} outputTokens=${outputTokens}`,
    );
    return { text, model, inputTokens, outputTokens };
  }

  /**
   * Build the current user turn. With no attachments it is the plain query
   * string (unchanged from the text-only path). With attachments it becomes an
   * ordered content array: PDFs first (Anthropic requires document-before-text;
   * harmless for other providers), then images, then the typed query, then any
   * CSV/plain-text files decoded and inlined as text. Throws BadRequestException
   * on a validation failure.
   */
  private buildCurrentUserMessage(
    query: string,
    attachments?: AttachmentDto[],
  ): AiUserMessage {
    if (!attachments || attachments.length === 0) {
      return { role: "user", content: query };
    }

    validateAttachments(attachments);

    const documentBlocks: AiContentBlock[] = [];
    const imageBlocks: AiContentBlock[] = [];
    const textBlocks: AiContentBlock[] = [];

    for (const att of attachments) {
      // Strip any stray whitespace/newlines from the base64 -- Anthropic
      // rejects newlines in image/document data.
      const data = att.data.replace(/\s+/g, "");
      if (att.kind === "image") {
        imageBlocks.push({
          type: "image",
          mediaType: att.mediaType as AiImageBlock["mediaType"],
          data,
        });
      } else if (att.kind === "pdf") {
        documentBlocks.push({
          type: "document",
          mediaType: "application/pdf",
          data,
          filename: att.filename,
        });
      } else {
        const decoded = Buffer.from(data, "base64").toString("utf-8");
        textBlocks.push({
          type: "text",
          text: `Attached file "${att.filename}":\n${decoded}`,
        });
      }
    }

    const content: AiContentBlock[] = [
      ...documentBlocks,
      ...imageBlocks,
      { type: "text", text: query },
      ...textBlocks,
    ];
    return { role: "user", content };
  }

  /**
   * Convert client-supplied conversation history into AiMessage format.
   * Enforces MAX_HISTORY_MESSAGES limit and strips tool-related messages
   * (those are internal to a single query's agentic loop, not meaningful
   * across turns).
   */
  private buildHistoryMessages(
    history?: Array<{ role: "user" | "assistant"; content: string }>,
  ): AiMessage[] {
    if (!history || history.length === 0) return [];

    // Truncate to limit — take the most recent messages
    const truncated = history.slice(-MAX_HISTORY_MESSAGES);

    return truncated.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  private getToolDescription(name: string): string {
    const tool = FINANCIAL_TOOLS.find((t) => t.name === name);
    return tool?.description || name;
  }

  private async logUsage(
    userId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    try {
      await this.usageService.logUsage({
        userId,
        provider,
        model,
        feature: "query",
        inputTokens,
        outputTokens,
        durationMs,
        ...(error && { error }),
      });
      this.logger.log(
        `Usage logged user=${userId} provider=${provider} model=${model} inputTokens=${inputTokens} outputTokens=${outputTokens} ms=${durationMs}${error ? ` error="${error}"` : ""}`,
      );
    } catch (logErr) {
      this.logger.warn(
        `Failed to log usage user=${userId}: ${logErr instanceof Error ? logErr.message : logErr}`,
      );
    }
  }
}
