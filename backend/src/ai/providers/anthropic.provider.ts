import Anthropic from "@anthropic-ai/sdk";
import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
  AiToolDefinition,
  AiToolResponse,
} from "./ai-provider.interface";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;

  private readonly client: Anthropic;
  private readonly modelId: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.modelId = model || "claude-sonnet-4-20250514";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 1024,
      system: request.systemPrompt,
      messages: request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
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
    const stream = this.client.messages.stream({
      model: this.modelId,
      max_tokens: request.maxTokens || 1024,
      system: request.systemPrompt,
      messages: request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { content: event.delta.text, done: false };
      }
    }

    yield { content: "", done: true };
  }

  async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: request.maxTokens || 1024,
      system: request.systemPrompt,
      messages: request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
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
          name: toolBlock.name,
          input: toolBlock.input as Record<string, unknown>,
        };
      });

    return {
      content: textContent,
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      model: response.model,
      provider: this.name,
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
