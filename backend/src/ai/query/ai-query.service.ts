import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { FinancialContextBuilder } from "../context/financial-context.builder";
import { ToolExecutorService } from "./tool-executor.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";
import { AiMessage, AiProvider } from "../providers/ai-provider.interface";
import { assessInjectionRisk } from "../context/prompt-injection-detector";
import { QUERY_SAFETY_REMINDER } from "../context/prompt-templates";
import { sanitizeToolResultStrings } from "../context/prompt-sanitize";

const MAX_ITERATIONS = 5;

/** LLM04-F1: Maximum total tool calls per query across all iterations. */
const MAX_TOOL_CALLS = 15;

/**
 * LLM04-F2: Overall query timeout in milliseconds.
 * This is independent of the per-provider timeout (e.g., Ollama's 10-min timeout).
 * The Ollama provider timeout remains untouched so scheduled tasks
 * (insights/forecasts) that call the provider directly can still use the
 * full provider timeout window.
 */
const QUERY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/** LLM04-F3: Maximum cumulative input tokens before aborting the query. */
const MAX_INPUT_TOKENS = 200_000;

/** LLM08-F2: Maximum size of a single tool result message in characters. */
const MAX_TOOL_RESULT_CHARS = 50_000;

export interface QueryResult {
  answer: string;
  toolsUsed: Array<{ name: string; summary: string }>;
  sources: Array<{ type: string; description: string; dateRange?: string }>;
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

export interface StreamEvent {
  type:
    | "thinking"
    | "tool_start"
    | "tool_result"
    | "content"
    | "sources"
    | "done"
    | "error";
  [key: string]: unknown;
}

@Injectable()
export class AiQueryService {
  private readonly logger = new Logger(AiQueryService.name);

  constructor(
    private readonly aiService: AiService,
    private readonly usageService: AiUsageService,
    private readonly contextBuilder: FinancialContextBuilder,
    private readonly toolExecutor: ToolExecutorService,
  ) {}

  async executeQuery(userId: string, query: string): Promise<QueryResult> {
    const events: StreamEvent[] = [];
    for await (const event of this.executeQueryStream(userId, query)) {
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
  ): AsyncGenerator<StreamEvent> {
    yield { type: "thinking", message: "Analyzing your question..." };

    const startTime = Date.now();

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
    try {
      systemPrompt = await this.contextBuilder.buildQueryContext(userId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build context";
      yield { type: "error", message };
      return;
    }

    let provider: AiProvider;
    try {
      provider = await this.aiService.getToolUseProvider(userId);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "No AI provider available";
      yield { type: "error", message };
      return;
    }

    // Build messages with sandwich defense: user query + safety reminder
    const messages: AiMessage[] = [
      { role: "user", content: query },
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

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // LLM04-F2: Enforce overall query timeout
      if (Date.now() - startTime > QUERY_TIMEOUT_MS) {
        this.logger.warn(
          `Query timeout reached for user ${userId} after ${iteration} iterations`,
        );
        yield {
          type: "content",
          text: "Your query took too long to process. Here is what I found so far.",
        };
        break;
      }

      // LLM04-F1: Enforce per-query tool call budget
      if (totalToolCalls >= MAX_TOOL_CALLS) {
        this.logger.warn(
          `Tool call budget exhausted for user ${userId} (${totalToolCalls} calls)`,
        );
        yield {
          type: "content",
          text: "I've reached the maximum number of data lookups for this query. Here is what I found so far.",
        };
        break;
      }

      // LLM04-F3: Enforce token budget
      if (totalInputTokens >= MAX_INPUT_TOKENS) {
        this.logger.warn(
          `Token budget exhausted for user ${userId} (${totalInputTokens} input tokens)`,
        );
        yield {
          type: "content",
          text: "This query has consumed the maximum analysis budget. Here is what I found so far.",
        };
        break;
      }

      let response;
      try {
        response = await provider.completeWithTools!(
          {
            systemPrompt,
            messages,
            maxTokens: 4096,
            temperature: 0.1,
          },
          FINANCIAL_TOOLS,
        );
      } catch (error) {
        const rawMessage =
          error instanceof Error ? error.message : "AI provider error";
        this.logger.warn(
          `AI query failed on iteration ${iteration}: ${rawMessage}`,
        );
        yield {
          type: "error",
          message:
            "The AI provider encountered an error processing your query. Please try again.",
        };
        return;
      }

      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      if (
        response.stopReason !== "tool_use" ||
        response.toolCalls.length === 0
      ) {
        // Final answer
        yield { type: "content", text: response.content };

        if (allSources.length > 0) {
          yield { type: "sources", sources: allSources };
        }

        const durationMs = Date.now() - startTime;
        await this.logUsage(
          userId,
          provider.name,
          response.model,
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
        content: response.content,
        toolCalls: response.toolCalls,
      };
      messages.push(assistantMessage);

      for (const toolCall of response.toolCalls) {
        totalToolCalls++;

        yield {
          type: "tool_start",
          name: toolCall.name,
          description: this.getToolDescription(toolCall.name),
        };

        const result = await this.toolExecutor.execute(
          userId,
          toolCall.name,
          toolCall.input,
        );

        allToolsUsed.push({ name: toolCall.name, summary: result.summary });
        allSources.push(...result.sources);

        yield {
          type: "tool_result",
          name: toolCall.name,
          summary: result.summary,
        };

        // Add tool result message with sanitized string values
        const sanitizedData = sanitizeToolResultStrings(result.data);
        // LLM08-F2: Truncate oversized tool results to prevent context bloat
        let toolResultContent = JSON.stringify(sanitizedData);
        if (toolResultContent.length > MAX_TOOL_RESULT_CHARS) {
          toolResultContent =
            toolResultContent.substring(0, MAX_TOOL_RESULT_CHARS) +
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

    // Max iterations reached - request a final answer without tools
    yield {
      type: "content",
      text: "I've gathered the data but reached the maximum number of analysis steps. Here's what I found based on the data collected so far.",
    };

    if (allSources.length > 0) {
      yield { type: "sources", sources: allSources };
    }

    const durationMs = Date.now() - startTime;
    await this.logUsage(
      userId,
      provider.name,
      "unknown",
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
      });
    } catch (error) {
      this.logger.warn(`Failed to log usage: ${error}`);
    }
  }
}
