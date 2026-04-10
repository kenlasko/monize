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
import { randomUUID } from "crypto";

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;

  private readonly baseUrl: string;
  private readonly modelId: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    this.modelId = model || "llama3";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    // Use streaming internally to keep the TCP connection alive during
    // long CPU-only inference. Idle connections get killed by kube-proxy /
    // conntrack after ~120 s, causing "fetch failed" errors.
    const messages = this.toOllamaMessages(
      request.messages,
      request.systemPrompt,
    );

    // H14: Timeout covers both fetch and stream consumption
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000); // 10 minutes for CPU inference

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.modelId,
          messages,
          stream: true,
          ...(request.responseFormat === "json" && { format: "json" }),
          ...(request.temperature !== undefined && {
            options: { temperature: request.temperature },
          }),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama request failed: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body from Ollama");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      const contentParts: string[] = [];
      let promptTokens = 0;
      let outputTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let chunk: OllamaChatResponse;
            try {
              chunk = JSON.parse(line) as OllamaChatResponse;
            } catch {
              continue;
            }
            if (chunk.message?.content) {
              contentParts.push(chunk.message.content);
            }
            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count || 0;
              outputTokens = chunk.eval_count || 0;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return {
        content: contentParts.join(""),
        usage: {
          inputTokens: promptTokens,
          outputTokens,
        },
        model: this.modelId,
        provider: this.name,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const messages = this.toOllamaMessages(
      request.messages,
      request.systemPrompt,
    );

    // H14: Timeout covers both fetch and stream consumption
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.modelId,
          messages,
          stream: true,
          ...(request.temperature !== undefined && {
            options: { temperature: request.temperature },
          }),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama request failed: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body from Ollama");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let chunk: OllamaChatResponse;
            try {
              chunk = JSON.parse(line) as OllamaChatResponse;
            } catch {
              continue;
            }
            if (chunk.message?.content) {
              yield { content: chunk.message.content, done: chunk.done };
            }
            if (chunk.done) {
              return;
            }
          }
        }
      } finally {
        reader.releaseLock();
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
    let content = "";
    let toolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

    for await (const chunk of this.streamWithTools(request, tools)) {
      if (chunk.type === "text") {
        content += chunk.text;
      } else {
        content = chunk.content;
        toolCalls = chunk.toolCalls;
        usage = chunk.usage;
        stopReason = chunk.stopReason;
      }
    }

    return {
      content,
      toolCalls,
      usage,
      model: this.modelId,
      provider: this.name,
      stopReason,
    };
  }

  async *streamWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): AsyncIterable<AiToolStreamChunk> {
    const messages = this.toOllamaMessages(
      request.messages,
      request.systemPrompt,
    );

    const ollamaTools = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    // H14: Timeout covers both fetch and stream consumption
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000); // 15 minutes for CPU inference

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.modelId,
          messages,
          tools: ollamaTools,
          stream: true,
          ...(request.temperature !== undefined && {
            options: { temperature: request.temperature },
          }),
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Ollama request failed: ${response.status} ${response.statusText}`,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body from Ollama");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let accumulatedContent = "";
      const accumulatedToolCalls: {
        id: string;
        name: string;
        input: Record<string, unknown>;
      }[] = [];
      let promptTokens = 0;
      let outputTokens = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let chunk: OllamaChatResponse;
            try {
              chunk = JSON.parse(line) as OllamaChatResponse;
            } catch {
              continue;
            }

            const delta = chunk.message?.content;
            if (delta) {
              accumulatedContent += delta;
              yield { type: "text", text: delta };
            }

            // Ollama emits tool_calls in any chunk; collect them as they appear.
            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                accumulatedToolCalls.push({
                  id: randomUUID(),
                  name: tc.function.name,
                  input: tc.function.arguments,
                });
              }
            }

            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count || 0;
              outputTokens = chunk.eval_count || 0;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      yield {
        type: "done",
        content: accumulatedContent,
        toolCalls: accumulatedToolCalls,
        usage: { inputTokens: promptTokens, outputTokens },
        model: this.modelId,
        stopReason: accumulatedToolCalls.length > 0 ? "tool_use" : "end_turn",
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private toOllamaMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        result.push({ role: "assistant", content: msg.content });
      } else if (msg.role === "tool") {
        result.push({ role: "tool", content: msg.content });
      }
    }

    return result;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return false;
    }
  }
}
