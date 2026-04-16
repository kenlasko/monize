// Mock the long-running-fetch helper so tests can keep using `global.fetch`.
// Matches the setup used by ollama.provider.spec.ts.
const mockLongRunningFetch = jest.fn(
  async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => global.fetch(input, init),
);
jest.mock("./long-running-fetch", () => ({
  longRunningAgent: { __mock: "agent" },
  longRunningFetch: (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => mockLongRunningFetch(input, init),
}));

import { OllamaCloudProvider } from "./ollama-cloud.provider";

describe("OllamaCloudProvider", () => {
  let provider: OllamaCloudProvider;

  beforeEach(() => {
    provider = new OllamaCloudProvider(
      "ollama-test-key",
      undefined,
      "qwen3:30b-cloud",
    );
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("ollama-cloud");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  it("defaults baseUrl to https://ollama.com", async () => {
    const encoder = new TextEncoder();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              value: encoder.encode('{"message":{"content":""},"done":true}\n'),
              done: false,
            })
            .mockResolvedValueOnce({ value: undefined, done: true }),
          releaseLock: jest.fn(),
        }),
      },
    });

    await provider.complete({
      systemPrompt: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://ollama.com/api/chat",
      expect.anything(),
    );
  });

  it("ignores a user-supplied baseUrl (SSRF guard)", async () => {
    // Ollama Cloud is a fixed SaaS endpoint. Allowing a user-supplied
    // baseUrl to override that would be a pure SSRF vector with no
    // legitimate use case, so the constructor must silently drop it.
    const custom = new OllamaCloudProvider(
      "k",
      "https://alt.ollama.example",
      "qwen3:30b-cloud",
    );
    const encoder = new TextEncoder();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              value: encoder.encode('{"message":{"content":""},"done":true}\n'),
              done: false,
            })
            .mockResolvedValueOnce({ value: undefined, done: true }),
          releaseLock: jest.fn(),
        }),
      },
    });

    await custom.complete({
      systemPrompt: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(global.fetch).toHaveBeenCalledWith(
      "https://ollama.com/api/chat",
      expect.anything(),
    );
  });

  it("sends an Authorization: Bearer header on complete()", async () => {
    const encoder = new TextEncoder();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              value: encoder.encode(
                '{"message":{"content":"ok"},"done":false}\n{"message":{"content":""},"done":true}\n',
              ),
              done: false,
            })
            .mockResolvedValueOnce({ value: undefined, done: true }),
          releaseLock: jest.fn(),
        }),
      },
    });

    await provider.complete({
      systemPrompt: "test",
      messages: [{ role: "user", content: "hi" }],
    });

    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer ollama-test-key",
    });
  });

  it("sends an Authorization: Bearer header on streamWithTools()", async () => {
    const encoder = new TextEncoder();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: jest
            .fn()
            .mockResolvedValueOnce({
              value: encoder.encode('{"message":{"content":""},"done":true}\n'),
              done: false,
            })
            .mockResolvedValueOnce({ value: undefined, done: true }),
          releaseLock: jest.fn(),
        }),
      },
    });

    const gen = provider.streamWithTools(
      { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
      [{ name: "t", description: "", inputSchema: { type: "object" } }],
    );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of gen) {
      // consume
    }

    const init = (global.fetch as jest.Mock).mock.calls[0][1];
    expect(init.headers).toMatchObject({
      Authorization: "Bearer ollama-test-key",
    });
  });

  it("isAvailable() probes /api/tags with the bearer token", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });

    const available = await provider.isAvailable();
    expect(available).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://ollama.com/api/tags",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ollama-test-key",
        }),
      }),
    );
  });

  describe("verifyModel()", () => {
    // Ollama Cloud probes via /api/chat instead of /api/tags because
    // /api/tags only reflects the user's locally-pulled models, not the
    // cloud catalogue. Valid cloud models like "gpt-oss:20b-cloud"
    // routinely succeed on /api/chat while being absent from /api/tags.

    it("returns ok when the /api/chat probe succeeds", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const result = await provider.verifyModel();
      expect(result).toEqual({ ok: true, model: "qwen3:30b-cloud" });

      expect(global.fetch).toHaveBeenCalledWith(
        "https://ollama.com/api/chat",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer ollama-test-key",
            "Content-Type": "application/json",
          }),
        }),
      );
      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body as string,
      );
      expect(body).toMatchObject({
        model: "qwen3:30b-cloud",
        stream: false,
        options: { num_predict: 1 },
      });
    });

    it("does not false-negative on models that work but are absent from /api/tags", async () => {
      // Regression: "gpt-oss:20b-cloud" is a real, working model that
      // /api/tags did not list. The completion probe must not classify
      // it as "not installed" just because the catalogue endpoint is
      // missing it.
      const p = new OllamaCloudProvider("k", undefined, "gpt-oss:20b-cloud");
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(""),
      });

      const result = await p.verifyModel();
      expect(result).toEqual({ ok: true, model: "gpt-oss:20b-cloud" });
    });

    it("reports a not-found reason when the probe returns 404", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: () => Promise.resolve('{"error":"model not found"}'),
      });

      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not found/i);
        expect(result.reason).toContain("-cloud");
      }
    });

    it("reports a not-found reason when a 400 body mentions 'does not exist'", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () =>
          Promise.resolve('{"error":"model \\"foo\\" does not exist"}'),
      });

      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not found/i);
      }
    });

    it("reports an auth-failure reason on 401", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: () => Promise.resolve(""),
      });

      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/authentication/i);
      }
    });

    it("wraps fetch errors as the reason", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("ECONNREFUSED");
      }
    });
  });
});
