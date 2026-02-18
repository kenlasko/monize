import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { FinancialContextBuilder } from "../context/financial-context.builder";
import { ToolExecutorService } from "./tool-executor.service";
import { FINANCIAL_TOOLS } from "./tool-definitions";
import { AiMessage, AiProvider } from "../providers/ai-provider.interface";

const MAX_ITERATIONS = 5;

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

    const messages: AiMessage[] = [{ role: "user", content: query }];
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

        // Add tool result message
        const toolResultMessage: AiMessage = {
          role: "tool",
          toolCallId: toolCall.id,
          name: toolCall.name,
          content: JSON.stringify(result.data),
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
