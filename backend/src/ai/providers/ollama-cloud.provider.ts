import { ModelVerificationResult } from "./ai-provider.interface";
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
const OLLAMA_CLOUD_BASE_URL = "https://ollama.com";

export class OllamaCloudProvider extends OllamaProvider {
  override readonly name = "ollama-cloud";

  private readonly apiKey: string;

  // The baseUrl argument is intentionally ignored: Ollama Cloud is a fixed
  // SaaS endpoint, so accepting a user-supplied URL here would be a pure
  // SSRF vector with no upside. Kept in the signature so factory callers
  // don't need a special case.
  constructor(apiKey: string, _baseUrl?: string, model?: string) {
    super(OLLAMA_CLOUD_BASE_URL, model);
    this.apiKey = apiKey;
  }

  protected override getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /**
   * Ollama Cloud's `/api/tags` only lists models the user has explicitly
   * pulled into their cloud workspace -- it is NOT the catalogue. Valid
   * cloud models (e.g. `gpt-oss:20b-cloud`) can be used via `/api/chat`
   * without ever appearing in `/api/tags`, so the parent's tags-based
   * check produces false "not installed" errors for working models.
   *
   * Instead, probe via a minimal chat completion with `num_predict: 1`.
   * A 404 / "model not found" response identifies a real typo; everything
   * else (success, rate-limit, auth error) means the model id is at
   * least recognised by the backend.
   */
  override async verifyModel(): Promise<ModelVerificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const model = this.modelId;
    const url = this.buildUrl("/api/chat");
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.getAuthHeaders(),
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
          options: { num_predict: 1 },
        }),
      });

      if (response.ok) {
        return { ok: true, model };
      }

      const bodyText = await this.safeReadBody(response);
      if (
        response.status === 404 ||
        /model.*(not found|does not exist|unknown)/i.test(bodyText)
      ) {
        return {
          ok: false,
          model,
          reason: `Model "${model}" was not found on Ollama Cloud. Check the model id (cloud models use the "-cloud" suffix, e.g. "qwen3:30b-cloud").`,
        };
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          model,
          reason: `Authentication failed (${response.status}). Check that your Ollama Cloud API key is valid and has access to "${model}".`,
        };
      }
      return {
        ok: false,
        model,
        reason: `Probe returned ${response.status}: ${bodyText.slice(0, 200) || response.statusText}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        model,
        reason: `Could not reach Ollama Cloud to verify model: ${message}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
