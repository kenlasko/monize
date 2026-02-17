export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionRequest {
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
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

export interface AiToolResponse {
  content: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
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
