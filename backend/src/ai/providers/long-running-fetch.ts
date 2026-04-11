import { Agent, fetch as undiciFetch } from "undici";

/**
 * Shared dispatcher used for long-running AI provider requests.
 *
 * Node's built-in fetch (undici under the hood) defaults `bodyTimeout` and
 * `headersTimeout` to 5 minutes. That's far too aggressive for CPU-only
 * inference on slow hardware (e.g. an Intel N100), where the gap between
 * the request and the first generated token can easily exceed 5 minutes
 * for a cold model with a long financial-context prompt. When the timer
 * fires, undici aborts the stream and the caller sees a generic
 * "fetch failed" error.
 *
 * Setting both timeouts to 0 disables them entirely. The provider code
 * still caps the total request time with its own AbortController, so a
 * runaway request can't hang forever.
 */
export const longRunningAgent = new Agent({
  bodyTimeout: 0,
  headersTimeout: 0,
});

/**
 * fetch wrapper that calls undici's fetch directly with our long-running
 * dispatcher. We MUST call `undici.fetch` (from the npm package) rather
 * than `globalThis.fetch` — Node bundles its own internal copy of undici,
 * and its built-in fetch silently ignores or rejects a `dispatcher` option
 * that came from a separately-installed undici package, because the two
 * `Agent` classes have different internal identities. Using undici's own
 * fetch guarantees the dispatcher is honored.
 *
 * The signature is widened to `typeof fetch` so SDK clients (Anthropic,
 * OpenAI) that accept a `fetch` option can use this drop-in replacement.
 * undici's Response type is structurally compatible with the global one
 * but TS sees them as distinct (Symbol.dispose), so we cast through
 * unknown.
 */
export const longRunningFetch: typeof fetch = ((
  input: Parameters<typeof undiciFetch>[0],
  init?: Parameters<typeof undiciFetch>[1],
) =>
  undiciFetch(input, {
    ...init,
    dispatcher: longRunningAgent,
  })) as unknown as typeof fetch;
