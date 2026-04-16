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
import { randomUUID } from "crypto";
import { longRunningFetch } from "./long-running-fetch";

/**
 * How often to emit a progress log line during a long-running stream so
 * operators can tell whether tokens are still flowing or the stream stalled.
 * 30s is short enough to surface a stall quickly while not spamming the log
 * during normal CPU-only inference (where ttft alone can be a minute+).
 */
const PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * Thrown when Ollama rejects a tool-calling request because the loaded model's
 * Modelfile template does not advertise tool support (e.g. the default
 * `deepseek-r1:latest` in Ollama's registry, which predates DeepSeek's 0528
 * tool-calling update). Retrying is pointless — the user needs to switch to
 * a tool-calling-capable model. The query service surfaces the message of
 * this error verbatim to the user so they know what action to take.
 */
export class OllamaModelDoesNotSupportToolsError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      `The Ollama model "${model}" does not support tool use, so the AI ` +
        `Assistant cannot run queries against your data. Switch to a ` +
        `tool-calling-capable model in your AI provider settings. Models ` +
        `known to work well with Monize: "ministral-3", "qwen3:30b", ` +
        `"gpt-oss:20b", and "MFDoom/deepseek-r1-tool-calling:8b". Small ` +
        `models (under ~7B parameters) often advertise tool support but ` +
        `follow instructions poorly; prefer 8B+ parameter models.`,
    );
    this.name = "OllamaModelDoesNotSupportToolsError";
    this.model = model;
  }
}

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
  readonly name: string = "ollama";
  readonly supportsStreaming = true;
  readonly supportsToolUse = true;

  private readonly logger = new Logger(OllamaProvider.name);
  private readonly baseUrl: string;
  private readonly modelId: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    this.modelId = model || "llama3";
  }

  /**
   * Hook for subclasses (e.g. Ollama Cloud) that need to inject auth headers
   * on every request. Self-hosted Ollama requires no auth, so the default is
   * an empty set.
   */
  protected getAuthHeaders(): Record<string, string> {
    return {};
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
    const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000); // 20 minutes for CPU inference

    const requestStart = Date.now();
    const url = `${this.baseUrl}/api/chat`;
    const requestBody = JSON.stringify({
      model: this.modelId,
      messages,
      stream: true,
      ...(request.responseFormat === "json" && { format: "json" }),
      ...(request.temperature !== undefined && {
        options: { temperature: request.temperature },
      }),
    });
    this.logger.log(
      `complete request url=${url} model=${this.modelId} messages=${messages.length} bodyBytes=${requestBody.length} format=${request.responseFormat ?? "text"} temperature=${request.temperature ?? "default"}`,
    );

    try {
      let response: Response;
      try {
        response = await longRunningFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeaders(),
          },
          signal: controller.signal,
          body: requestBody,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `complete fetch failed url=${url} after=${Date.now() - requestStart}ms: ${message}`,
        );
        throw error;
      }

      this.logger.log(
        `complete response url=${url} status=${response.status} ttfb=${Date.now() - requestStart}ms`,
      );

      if (!response.ok) {
        const bodyText = await this.safeReadBody(response);
        this.logger.error(
          `complete non-OK url=${url} status=${response.status} body=${bodyText.substring(0, 500)}`,
        );
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
      let firstTokenAt: number | null = null;
      let chunkCount = 0;
      let contentChars = 0;
      let lastProgressLogAt = Date.now();

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
            chunkCount++;
            if (chunk.message?.content) {
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
                this.logger.log(
                  `complete first token url=${url} model=${this.modelId} ttft=${firstTokenAt - requestStart}ms`,
                );
              }
              contentParts.push(chunk.message.content);
              contentChars += chunk.message.content.length;
            }
            if (chunk.done) {
              promptTokens = chunk.prompt_eval_count || 0;
              outputTokens = chunk.eval_count || 0;
            }
          }

          // Periodic progress log so we can tell whether a long-running
          // inference is still trickling tokens or has fully stalled.
          if (Date.now() - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS) {
            this.logger.log(
              `complete progress url=${url} model=${this.modelId} elapsedMs=${Date.now() - requestStart} chunks=${chunkCount} contentChars=${contentChars}`,
            );
            lastProgressLogAt = Date.now();
          }
        }
      } finally {
        reader.releaseLock();
      }

      this.logger.log(
        `complete done url=${url} model=${this.modelId} totalMs=${Date.now() - requestStart} chunks=${chunkCount} contentChars=${contentChars} promptTokens=${promptTokens} outputTokens=${outputTokens}`,
      );

      return {
        content: contentParts.join(""),
        usage: {
          inputTokens: promptTokens,
          outputTokens,
        },
        model: this.modelId,
        provider: this.name,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `complete aborted url=${url} after=${Date.now() - requestStart}ms aborted=${controller.signal.aborted} error=${message}`,
      );
      throw error;
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
    const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000);

    try {
      const response = await longRunningFetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
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
    const timeout = setTimeout(() => controller.abort(), 20 * 60 * 1000); // 20 minutes for CPU inference

    const requestStart = Date.now();
    const url = `${this.baseUrl}/api/chat`;
    const requestBody = JSON.stringify({
      model: this.modelId,
      messages,
      tools: ollamaTools,
      stream: true,
      ...(request.temperature !== undefined && {
        options: { temperature: request.temperature },
      }),
    });
    this.logger.log(
      `streamWithTools request url=${url} model=${this.modelId} messages=${messages.length} tools=${ollamaTools.length} bodyBytes=${requestBody.length} temperature=${request.temperature ?? "default"}`,
    );

    try {
      let response: Response;
      try {
        response = await longRunningFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.getAuthHeaders(),
          },
          signal: controller.signal,
          body: requestBody,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `streamWithTools fetch failed url=${url} after=${Date.now() - requestStart}ms: ${message}`,
        );
        throw error;
      }

      this.logger.log(
        `streamWithTools response url=${url} status=${response.status} ttfb=${Date.now() - requestStart}ms`,
      );

      if (!response.ok) {
        const bodyText = await this.safeReadBody(response);
        this.logger.error(
          `streamWithTools non-OK url=${url} status=${response.status} body=${bodyText.substring(0, 500)}`,
        );
        if (this.isModelDoesNotSupportToolsBody(bodyText)) {
          throw new OllamaModelDoesNotSupportToolsError(this.modelId);
        }
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
      let chunkCount = 0;
      let firstTokenAt: number | null = null;
      let lastProgressLogAt = Date.now();

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
            chunkCount++;

            const delta = chunk.message?.content;
            if (delta) {
              if (firstTokenAt === null) {
                firstTokenAt = Date.now();
                this.logger.log(
                  `streamWithTools first token url=${url} model=${this.modelId} ttft=${firstTokenAt - requestStart}ms`,
                );
              }
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

          // Periodic progress log so we can tell whether a long-running
          // inference is still trickling tokens or has fully stalled.
          if (Date.now() - lastProgressLogAt >= PROGRESS_LOG_INTERVAL_MS) {
            this.logger.log(
              `streamWithTools progress url=${url} model=${this.modelId} elapsedMs=${Date.now() - requestStart} chunks=${chunkCount} contentChars=${accumulatedContent.length} toolCalls=${accumulatedToolCalls.length}`,
            );
            lastProgressLogAt = Date.now();
          }
        }
      } finally {
        reader.releaseLock();
      }

      this.logger.log(
        `streamWithTools done url=${url} model=${this.modelId} totalMs=${Date.now() - requestStart} chunks=${chunkCount} contentChars=${accumulatedContent.length} toolCalls=${accumulatedToolCalls.length} promptTokens=${promptTokens} outputTokens=${outputTokens}`,
      );

      yield {
        type: "done",
        content: accumulatedContent,
        toolCalls: accumulatedToolCalls,
        usage: { inputTokens: promptTokens, outputTokens },
        model: this.modelId,
        stopReason: accumulatedToolCalls.length > 0 ? "tool_use" : "end_turn",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `streamWithTools aborted url=${url} after=${Date.now() - requestStart}ms aborted=${controller.signal.aborted} error=${message}`,
      );
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Ollama returns 400 with `{"error":"...does not support tools"}` when the
   * loaded model's Modelfile template doesn't declare tool support. Match the
   * stable substring of that message so we can convert it into a typed error
   * with actionable remediation. Matches both parsed-JSON and raw-text bodies
   * defensively.
   */
  private isModelDoesNotSupportToolsBody(bodyText: string): boolean {
    if (!bodyText) return false;
    if (/does not support tools/i.test(bodyText)) return true;
    try {
      const parsed = JSON.parse(bodyText) as { error?: unknown };
      return (
        typeof parsed.error === "string" &&
        /does not support tools/i.test(parsed.error)
      );
    } catch {
      return false;
    }
  }

  /**
   * Best-effort body read for diagnostic logging on non-OK responses.
   * Defensive against responses that lack a usable .text() (e.g. test mocks)
   * or whose body has already been consumed.
   */
  private async safeReadBody(response: Response): Promise<string> {
    try {
      if (typeof response.text !== "function") return "<unreadable>";
      return await response.text();
    } catch {
      return "<unreadable>";
    }
  }

  private toOllamaMessages(
    messages: AiMessage[],
    systemPrompt: string,
  ): Array<Record<string, unknown>> {
    const result: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === "user") {
        result.push({ role: "user", content: msg.content });
      } else if (msg.role === "assistant") {
        // Ollama Cloud (and stricter backends) validate that tool-result
        // messages reference a tool_call_id produced earlier in the same
        // conversation. If we don't relay the assistant's tool_calls, the
        // cloud rejects the follow-up with "Unexpected tool call id ...".
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          result.push({
            role: "assistant",
            content: msg.content,
            tool_calls: msg.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: tc.input,
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
          name: msg.name,
          content: msg.content,
        });
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
          headers: this.getAuthHeaders(),
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
