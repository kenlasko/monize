import OpenAI from "openai";
import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
  AiToolDefinition,
  AiToolResponse,
} from "./ai-provider.interface";

export class OpenAiProvider implements AiProvider {
  readonly name: string = "openai";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;

  protected readonly client: OpenAI;
  protected readonly modelId: string;

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.client = new OpenAI({
      apiKey,
      ...(baseUrl && { baseURL: baseUrl }),
    });
    this.modelId = model || "gpt-4o";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 1024,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    const choice = response.choices[0];

    return {
      content: choice?.message?.content || "",
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
      model: response.model,
      provider: this.name,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];

    const stream = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 1024,
      stream: true,
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        yield { content: delta, done: false };
      }
    }

    yield { content: "", done: true };
  }

  async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      ...request.messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 1024,
      tools: tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      ...(request.temperature !== undefined && {
        temperature: request.temperature,
      }),
    });

    const choice = response.choices[0];
    const toolCalls = (choice?.message?.tool_calls || [])
      .filter(
        (
          tc,
        ): tc is OpenAI.ChatCompletionMessageToolCall & { type: "function" } =>
          tc.type === "function",
      )
      .map((tc) => ({
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
      }));

    return {
      content: choice?.message?.content || "",
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
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
        await this.client.models.list();
        return true;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
}
