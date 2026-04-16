export interface AiUserMessage {
  role: "user";
  content: string;
}

export interface AiAssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: AiToolCall[];
}

export interface AiToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
}

export type AiMessage =
  | AiUserMessage
  | AiAssistantMessage
  | AiToolResultMessage;

export interface AiCompletionRequest {
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
}

export interface AiCompletionResponse {
  content: string;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
}

export interface AiStreamChunk {
  content: string;
  done: boolean;
}

export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AiToolResponse {
  content: string;
  toolCalls: AiToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
}

/**
 * Streaming chunk produced by `streamWithTools()`. Providers emit zero or more
 * `text` chunks as the model generates output, followed by exactly one `done`
 * chunk that carries the fully-assembled tool calls (if any), final usage
 * counters, model id, and stop reason.
 */
export type AiToolStreamChunk =
  | { type: "text"; text: string }
  | {
      type: "done";
      content: string;
      toolCalls: AiToolCall[];
      usage: { inputTokens: number; outputTokens: number };
      model: string;
      stopReason: "end_turn" | "tool_use" | "max_tokens";
    };

export interface AiProvider {
  readonly name: string;
  readonly supportsStreaming: boolean;
  readonly supportsToolUse: boolean;

  complete(request: AiCompletionRequest): Promise<AiCompletionResponse>;

  stream?(request: AiCompletionRequest): AsyncIterable<AiStreamChunk>;

  completeWithTools?(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse>;

  /**
   * Streaming variant of `completeWithTools()` that yields the model's text
   * output incrementally so the caller can surface realtime feedback.
   * Optional — providers that haven't implemented it will fall back to
   * `completeWithTools()` in the query service.
   */
  streamWithTools?(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): AsyncIterable<AiToolStreamChunk>;

  isAvailable(): Promise<boolean>;

  /**
   * Verify that the configured model exists and can be invoked by this
   * provider. Implementations should prefer a cheap probe (e.g. listing
   * available models or retrieving model metadata) over a full inference
   * call, but a minimal 1-token completion is acceptable when the
   * backend doesn't expose a catalogue endpoint.
   *
   * Returning `{ ok: true }` means the configured model works. Returning
   * `{ ok: false, reason }` means the server is reachable but the model
   * won't respond (e.g. typo, model not pulled on an Ollama host, API
   * key lacks access to that model, etc.). The `reason` is surfaced to
   * the user and should be short and actionable.
   *
   * Optional -- callers treat a missing implementation as "can't
   * verify" and skip the model check.
   */
  verifyModel?(): Promise<ModelVerificationResult>;
}

export type ModelVerificationResult =
  | { ok: true; model: string }
  | { ok: false; model: string; reason: string };
