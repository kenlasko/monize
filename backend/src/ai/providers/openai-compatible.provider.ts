import {
  AiCompletionRequest,
  AiMessage,
  AiToolCall,
  AiToolDefinition,
  AiToolResponse,
  AiToolStreamChunk,
  ModelVerificationResult,
} from "./ai-provider.interface";
import { OpenAiProvider } from "./openai.provider";

/**
 * Attempt to extract structured tool calls from assistant text content.
 *
 * Some OpenAI-compatible endpoints (notably Cloudflare Workers AI with Llama
 * 3.x) do not translate Llama-format function calls into the OpenAI
 * `tool_calls` field and instead leak the raw JSON as text. This helper
 * tolerantly parses the common shapes so the query engine can still drive a
 * tool loop.
 *
 * Returns `null` if the content does not look like a tool call blob.
 */
export function parseInlineToolCalls(text: string): AiToolCall[] | null {
  if (!text) return null;

  // Strip common wrappers emitted by fine-tuned chat templates. Keep this
  // conservative: only touch patterns we've seen in the wild.
  let candidate = text.trim();

  // <|python_tag|>{ ... } (Llama 3.x tool-call chat template)
  if (candidate.startsWith("<|python_tag|>")) {
    candidate = candidate.slice("<|python_tag|>".length).trim();
  }

  // <function=name>{ "arg": "val" }</function>
  const functionTagMatch = candidate.match(
    /^<function=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/function>\s*$/,
  );
  if (functionTagMatch) {
    const name = functionTagMatch[1];
    let input: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(functionTagMatch[2]);
      if (parsed && typeof parsed === "object") {
        input = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return [{ id: makeToolCallId(), name, input }];
  }

  // Must at least look like JSON from here on.
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  const asArray = Array.isArray(parsed) ? parsed : [parsed];
  const toolCalls: AiToolCall[] = [];
  for (const item of asArray) {
    const tc = normalizeToolCall(item);
    if (!tc) return null;
    toolCalls.push(tc);
  }
  return toolCalls.length > 0 ? toolCalls : null;
}

function normalizeToolCall(item: unknown): AiToolCall | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;

  // OpenAI-ish shape: { type: "function", function: { name, arguments } }
  if (
    obj.type === "function" &&
    obj.function &&
    typeof obj.function === "object"
  ) {
    const fn = obj.function as Record<string, unknown>;
    if (typeof fn.name !== "string") return null;
    const argsRaw = fn.arguments;
    let input: Record<string, unknown> = {};
    if (typeof argsRaw === "string") {
      try {
        const a: unknown = JSON.parse(argsRaw);
        if (a && typeof a === "object") input = a as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (argsRaw && typeof argsRaw === "object") {
      input = argsRaw as Record<string, unknown>;
    }
    return { id: makeToolCallId(), name: fn.name, input };
  }

  // Llama-ish shape: { name, arguments | parameters }
  // Or Cloudflare 70B shape: { type: "function", name, parameters }
  if (typeof obj.name !== "string") return null;
  const argsField = obj.arguments ?? obj.parameters;
  let input: Record<string, unknown> = {};
  if (typeof argsField === "string") {
    try {
      const a: unknown = JSON.parse(argsField);
      if (a && typeof a === "object") input = a as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (argsField && typeof argsField === "object") {
    input = argsField as Record<string, unknown>;
  } else if (argsField !== undefined) {
    return null;
  }
  return { id: makeToolCallId(), name: obj.name, input };
}

let toolCallCounter = 0;
function makeToolCallId(): string {
  toolCallCounter += 1;
  return `call_inline_${Date.now()}_${toolCallCounter}`;
}

/**
 * Flatten OpenAI-style tool-call / tool-result messages into plain
 * user/assistant turns.
 *
 * Cloudflare Workers AI's OpenAI-compatible endpoint (and some other Llama
 * backends) accept the `tools` parameter on input but reject assistant
 * messages carrying `tool_calls` and messages with `role: "tool"` with a
 * bare `400 (no body)`. Since these backends model tool use as
 * regular-content JSON anyway, we round-trip through that representation:
 *
 * - assistant { content, toolCalls } -> assistant { content: "<content?> <json(toolCalls)>" }
 * - tool      { name, content }      -> user      { content: "Tool <name> result:\n<content>" }
 */
export function flattenToolMessages(messages: AiMessage[]): AiMessage[] {
  const result: AiMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const serializedCalls = msg.toolCalls
          .map((tc) =>
            JSON.stringify({
              type: "function",
              name: tc.name,
              parameters: tc.input,
            }),
          )
          .join("\n");
        const content = msg.content
          ? `${msg.content}\n${serializedCalls}`
          : serializedCalls;
        result.push({ role: "assistant", content });
      } else {
        result.push({ role: "assistant", content: msg.content });
      }
    } else if (msg.role === "tool") {
      result.push({
        role: "user",
        content: `Tool ${msg.name} result:\n${msg.content}`,
      });
    } else {
      result.push(msg);
    }
  }
  return result;
}

/**
 * Detect whether an in-progress stream's leading text looks like it is
 * building a tool-call blob, so we can buffer instead of surfacing raw
 * JSON to the UI.
 */
function looksLikeToolCallPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) return false;
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("<|python_tag|>") ||
    trimmed.startsWith("<function=")
  );
}

export class OpenAiCompatibleProvider extends OpenAiProvider {
  override readonly name = "openai-compatible";

  constructor(apiKey: string, baseUrl: string, model: string) {
    super(apiKey, model, baseUrl);
  }

  override async completeWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): Promise<AiToolResponse> {
    const flattened: AiCompletionRequest = {
      ...request,
      messages: flattenToolMessages(request.messages),
    };
    const response = await super.completeWithTools(flattened, tools);
    if (response.toolCalls.length > 0) return response;

    const inline = parseInlineToolCalls(response.content);
    if (!inline) return response;

    return {
      ...response,
      content: "",
      toolCalls: inline,
      stopReason: "tool_use",
    };
  }

  override async *streamWithTools(
    request: AiCompletionRequest,
    tools: AiToolDefinition[],
  ): AsyncIterable<AiToolStreamChunk> {
    const flattened: AiCompletionRequest = {
      ...request,
      messages: flattenToolMessages(request.messages),
    };
    const source = super.streamWithTools!(flattened, tools);

    // Buffer text chunks only when the leading content looks like a tool
    // call blob. For normal text responses we still stream token-by-token.
    const buffered: string[] = [];
    let decided: "passthrough" | "buffer" | null = null;
    let accumulated = "";

    for await (const chunk of source) {
      if (chunk.type === "text") {
        accumulated += chunk.text;
        if (decided === null) {
          if (looksLikeToolCallPrefix(accumulated)) {
            decided = "buffer";
            buffered.push(chunk.text);
          } else {
            decided = "passthrough";
            yield chunk;
          }
        } else if (decided === "buffer") {
          buffered.push(chunk.text);
        } else {
          yield chunk;
        }
        continue;
      }

      // chunk.type === "done"
      if (chunk.toolCalls.length > 0) {
        // Provider already returned structured tool calls. Flush any text
        // we buffered (unlikely to matter in practice) and pass done along.
        if (decided === "buffer") {
          for (const part of buffered) {
            yield { type: "text", text: part };
          }
        }
        yield chunk;
        return;
      }

      const inline = parseInlineToolCalls(chunk.content);
      if (inline) {
        // Swallow the buffered JSON text; replace with synthesized tool
        // calls so the query engine drives a proper tool loop.
        yield {
          type: "done",
          content: "",
          toolCalls: inline,
          usage: chunk.usage,
          model: chunk.model,
          stopReason: "tool_use",
        };
        return;
      }

      // Plain text response that happened to start with `{` etc. Flush
      // buffered text now so the UI still sees it.
      if (decided === "buffer") {
        for (const part of buffered) {
          yield { type: "text", text: part };
        }
      }
      yield chunk;
      return;
    }
  }

  /**
   * Cloudflare Workers AI (and some other OpenAI-compatible endpoints) do not
   * implement `GET /models`, so the default `client.models.list()` probe used
   * by `OpenAiProvider.isAvailable()` returns 404. Use a minimal chat
   * completion instead -- it exercises the actual code path users care about.
   */
  override async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        await this.client.chat.completions.create(
          {
            model: this.modelId,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 1,
          },
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

  /**
   * Many OpenAI-compatible backends (Cloudflare Workers AI, LM Studio,
   * etc.) either don't implement `/models/:id` or implement it
   * inconsistently. Instead of probing the catalogue, issue a 1-token
   * chat completion with the configured model and treat success as
   * verification. 404 / "model not found" errors are surfaced so the
   * user knows to fix the model id.
   */
  override async verifyModel(): Promise<ModelVerificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      await this.client.chat.completions.create(
        {
          model: this.modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        },
        { signal: controller.signal },
      );
      return { ok: true, model: this.modelId };
    } catch (error) {
      const status = (error as { status?: number })?.status;
      const raw = error instanceof Error ? error.message : String(error);
      if (status === 404 || /model.*(not found|does not exist)/i.test(raw)) {
        return {
          ok: false,
          model: this.modelId,
          reason: `Model "${this.modelId}" was not found at this endpoint. Check the model id and that your key has access to it.`,
        };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          model: this.modelId,
          reason: `Authentication failed (${status}). The API key may be invalid or lack access to this model.`,
        };
      }
      return {
        ok: false,
        model: this.modelId,
        reason: `Could not verify model: ${raw}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
