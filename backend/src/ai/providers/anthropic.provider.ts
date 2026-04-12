import Anthropic from "@anthropic-ai/sdk";
import { Logger } from "@nestjs/common";
import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
  AiToolDefinition,
  AiToolResponse,
  AiToolStreamChunk,
  AiMessage,
} from "./ai-provider.interface";
import { longRunningFetch } from "./long-running-fetch";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;

  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly client: Anthropic;
  private readonly modelId: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({
      apiKey,
      // Inject our long-running fetch wrapper so SDK calls inherit the
      // disabled bodyTimeout/headersTimeout. See long-running-fetch.ts.
      fetch: longRunningFetch,
    });
    this.modelId = model || "claude-sonnet-4-20250514";
  }

  private toAnthropicMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          const content: Anthropic.ContentBlockParam[] = [];
          if (msg.content) {
            content.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.toolCalls) {
            content.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.input,
            });
          }
          result.push({ role: "assistant", content });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      } else if (msg.role === "tool") {
        // Anthropic expects tool results as user messages with tool_result blocks
        // Group consecutive tool results into a single user message
        const lastResult = result[result.length - 1];
        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: msg.content,
        };

        if (
          lastResult &&
          lastResult.role === "user" &&
          Array.isArray(lastResult.content) &&
          lastResult.content.length > 0 &&
          (lastResult.content[0] as Anthropic.ToolResultBlockParam).type ===
            "tool_result"
        ) {
          (lastResult.content as Anthropic.ToolResultBlockParam[]).push(
            toolResultBlock,
          );
        } else {
          result.push({ role: "user", content: [toolResultBlock] });
        }
      }
    }

    return result;
  }

  private toSimpleMessages(messages: AiMessage[]): Anthropic.MessageParam[] {
    return messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.role === "assistant" ? m.content : m.content,
      }));
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 1024,
      system: request.systemPrompt,
      messages: this.toSimpleMessages(request.messages),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    const textContent = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("");

    return {
      content: textContent,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.name,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const stream = this.client.messages.stream(
        {
          model: this.modelId,
          max_tokens: request.maxTokens || 1024,
          system: request.systemPrompt,
          messages: this.toSimpleMessages(request.messages),
          ...(request.temperature !== undefined && {
            temperature: request.temperature,
          }),
        },
        { signal: controller.signal },
      );

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield { content: event.delta.text, done: false };
        }
      }

      yield { content: "", done: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 4096,
      system: request.systemPrompt,
      messages: this.toAnthropicMessages(request.messages),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      })),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    const textContent = response.content
      .filter((block) => block.type === "text")
      .map((block) => ("text" in block ? block.text : ""))
      .join("");

    const toolCalls = response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => {
        const toolBlock = block as Anthropic.ToolUseBlock;
        return {
          id: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input as Record<string, unknown>,
        };
      });

    const stopReason =
      response.stop_reason === "tool_use"
        ? ("tool_use" as const)
        : response.stop_reason === "max_tokens"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.name,
      stopReason,
    };
  }

  async *streamWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): AsyncIterable<AiToolStreamChunk> {
    const requestStart = Date.now();
    this.logger.log(
      `streamWithTools request model=${this.modelId} messages=${request.messages.length} tools=${tools.length}`,
    );

    let stream: ReturnType<Anthropic["messages"]["stream"]>;
    try {
      stream = this.client.messages.stream({
        model: this.modelId,
        max_tokens: request.maxTokens || 4096,
        system: request.systemPrompt,
        messages: this.toAnthropicMessages(request.messages),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        })),
        ...(request.temperature !== undefined && {
          temperature: request.temperature,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `streamWithTools open failed model=${this.modelId} after=${Date.now() - requestStart}ms: ${message}`,
      );
      throw error;
    }

    let accumulatedContent = "";
    let firstTokenAt: number | null = null;
    // Per content block index: tool-use metadata + accumulated JSON arg string
    const toolBlocks = new Map<
      number,
      { id: string; name: string; jsonBuffer: string }
    >();

    try {
      for await (const event of stream) {
        if (event.type === "content_block_start") {
          if (event.content_block.type === "tool_use") {
            toolBlocks.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              jsonBuffer: "",
            });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              this.logger.log(
                `streamWithTools first token model=${this.modelId} ttft=${firstTokenAt - requestStart}ms`,
              );
            }
            accumulatedContent += event.delta.text;
            yield { type: "text", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.jsonBuffer += event.delta.partial_json;
            }
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `streamWithTools stream failed model=${this.modelId} after=${Date.now() - requestStart}ms: ${message}`,
      );
      throw error;
    }

    // Use the SDK helper to get the final message with all metadata.
    const finalMessage = await stream.finalMessage();

    const toolCalls = finalMessage.content
      .filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      )
      .map((block) => ({
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      }));

    const stopReason: "end_turn" | "tool_use" | "max_tokens" =
      finalMessage.stop_reason === "tool_use"
        ? "tool_use"
        : finalMessage.stop_reason === "max_tokens"
          ? "max_tokens"
          : "end_turn";

    this.logger.log(
      `streamWithTools done model=${finalMessage.model} totalMs=${Date.now() - requestStart} contentChars=${accumulatedContent.length} toolCalls=${toolCalls.length} inputTokens=${finalMessage.usage.input_tokens} outputTokens=${finalMessage.usage.output_tokens} stopReason=${stopReason}`,
    );

    yield {
      type: "done",
      content: accumulatedContent,
      toolCalls,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      model: finalMessage.model,
      stopReason,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await this.client.models.list(
          { limit: 1 },
          { signal: controller.signal },
        );
        return true;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
}
