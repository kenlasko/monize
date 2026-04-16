import { OllamaProvider } from "./ollama.provider";

/**
 * Ollama Cloud provider.
 *
 * Ollama Cloud speaks the same native Ollama REST API as a self-hosted Ollama
 * instance (`/api/chat`, `/api/tags`, NDJSON streaming), but is gated behind
 * a bearer token and is hosted at `https://ollama.com`. Model ids are scoped
 * to the hosted catalogue with a `-cloud` suffix (e.g. `qwen3:30b-cloud`).
 *
 * This exists as a separate provider from `openai-compatible` because Ollama
 * Cloud's native protocol fully supports structured tool calls and
 * `tool_call_id` relaying out of the box. The OpenAI-compatible endpoint,
 * by contrast, was designed for LLM clients that don't know anything about
 * Ollama's message format, so our `openai-compatible` provider flattens tool
 * messages into plain JSON text as a workaround for Cloudflare-style
 * backends -- that flattening actively breaks tool calling against Ollama
 * Cloud, which would otherwise handle the native shape correctly.
 */
export class OllamaCloudProvider extends OllamaProvider {
  override readonly name = "ollama-cloud";

  private readonly apiKey: string;

  constructor(apiKey: string, baseUrl?: string, model?: string) {
    super(baseUrl || "https://ollama.com", model);
    this.apiKey = apiKey;
  }

  protected override getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
}
