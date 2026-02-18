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

  isAvailable(): Promise<boolean>;
}
