import OpenAI from "openai";
import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
  AiToolDefinition,
  AiToolResponse,
  AiMessage,
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

  private toOpenAiMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: msg.content || null,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function" as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.input),
              },
            })),
          });
        } else {
          result.push({ role: "assistant", content: msg.content });
        }
      } else if (msg.role === "tool") {
        result.push({
          role: "tool",
          tool_call_id: msg.toolCallId,
          content: msg.content,
        });
      }
    }

    return result;
  }

  private toSimpleMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    return [
      { role: "system", content: systemPrompt },
      ...messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
    ];
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const messages = this.toSimpleMessages(
      request.messages,
      request.systemPrompt,
    );

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
    const messages = this.toSimpleMessages(
      request.messages,
      request.systemPrompt,
    );

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
    const messages = this.toOpenAiMessages(
      request.messages,
      request.systemPrompt,
    );

    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: request.maxTokens || 4096,
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
      .map((tc) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = {};
        }
        return { id: tc.id, name: tc.function.name, input };
      });

    const finishReason = choice?.finish_reason;
    const stopReason =
      finishReason === "tool_calls"
        ? ("tool_use" as const)
        : finishReason === "length"
          ? ("max_tokens" as const)
          : ("end_turn" as const);

    return {
      content: choice?.message?.content || "",
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
      },
      model: response.model,
      provider: this.name,
      stopReason,
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
