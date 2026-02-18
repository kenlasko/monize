import {
  AiProvider,
  AiCompletionRequest,
  AiCompletionResponse,
  AiStreamChunk,
} from "./ai-provider.interface";

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements AiProvider {
  readonly name = "ollama";
  readonly supportsStreaming = true;
  readonly supportsToolUse = false;

  private readonly baseUrl: string;
  private readonly modelId: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || "http://localhost:11434").replace(/\/+$/, "");
    this.modelId = model || "llama3";
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResponse> {
    const messages = [
      { role: "system", content: request.systemPrompt },
      ...request.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.modelId,
        messages,
        stream: false,
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

    const data = (await response.json()) as OllamaChatResponse;

    return {
      content: data.message.content,
      usage: {
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
      },
      model: this.modelId,
      provider: this.name,
    };
  }

  async *stream(request: AiCompletionRequest): AsyncIterable<AiStreamChunk> {
    const messages = [
      { role: "system", content: request.systemPrompt },
      ...request.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    ];

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
