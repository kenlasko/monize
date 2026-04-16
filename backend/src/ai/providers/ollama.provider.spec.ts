import type { AiToolStreamChunk } from "./ai-provider.interface";
import { OllamaModelDoesNotSupportToolsError } from "./ollama.provider";

// Mock the long-running-fetch helper so tests can keep using `global.fetch`.
// In production, longRunningFetch calls undici.fetch directly with our
// long-running dispatcher (so timeouts are disabled). For tests, we route
// it through globalThis.fetch so the existing test setups (which assign
// jest.fn() to global.fetch) keep working unchanged.
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

import { OllamaProvider } from "./ollama.provider";

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider("http://localhost:11434", "llama3");
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("ollama");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  describe("constructor baseUrl validation", () => {
    // Defence-in-depth: the service layer validates the URL before it
    // reaches this constructor, but the provider still rejects anything
    // that isn't a plain http(s) origin so a malformed value can never
    // reach fetch(). CodeQL needs this inline guard to see the SSRF
    // sink as safe.
    it("rejects non-http(s) protocols", () => {
      expect(() => new OllamaProvider("file:///etc/passwd")).toThrow(
        /Invalid Ollama baseUrl/,
      );
      expect(() => new OllamaProvider("javascript:alert(1)")).toThrow(
        /Invalid Ollama baseUrl/,
      );
    });

    it("rejects URLs with embedded credentials", () => {
      expect(
        () => new OllamaProvider("http://attacker:pw@localhost:11434"),
      ).toThrow(/Invalid Ollama baseUrl/);
    });

    it("rejects malformed URLs", () => {
      expect(() => new OllamaProvider("not a url")).toThrow(
        /Invalid Ollama baseUrl/,
      );
    });

    it("normalises valid URLs to the origin", () => {
      const p = new OllamaProvider(
        "http://localhost:11434/some/path?x=1",
        "llama3",
      );
      expect((p as unknown as { baseUrl: string }).baseUrl).toBe(
        "http://localhost:11434",
      );
    });
  });

  describe("complete()", () => {
    it("returns formatted response on success", async () => {
      const encoder = new TextEncoder();
      const lines = [
        '{"message":{"role":"assistant","content":"Hello from Ollama"},"done":false}\n',
        '{"message":{"content":""},"done":true,"prompt_eval_count":12,"eval_count":18}\n',
      ];
      let readIdx = 0;

      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (readIdx < lines.length) {
                return Promise.resolve({
                  value: encoder.encode(lines[readIdx++]),
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
            releaseLock: jest.fn(),
          }),
        },
      };
      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await provider.complete({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.content).toBe("Hello from Ollama");
      expect(result.usage.inputTokens).toBe(12);
      expect(result.usage.outputTokens).toBe(18);
      expect(result.provider).toBe("ollama");
      expect(result.model).toBe("llama3");

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    it("throws on non-ok response", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        provider.complete({
          systemPrompt: "test",
          messages: [{ role: "user", content: "hi" }],
        }),
      ).rejects.toThrow("Ollama request failed: 500 Internal Server Error");
    });

    it("calls longRunningFetch (not raw global fetch) so undici timeouts are disabled", async () => {
      // Regression: Node's globalThis.fetch silently rejects an Agent from a
      // separately-installed undici package because the two Agent classes
      // have different identities. The provider must call longRunningFetch
      // which uses undici.fetch directly so the dispatcher is honored.
      mockLongRunningFetch.mockClear();
      const encoder = new TextEncoder();
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: jest
              .fn()
              .mockResolvedValueOnce({
                value: encoder.encode(
                  '{"message":{"content":""},"done":true}\n',
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

      expect(mockLongRunningFetch).toHaveBeenCalledTimes(1);
      expect(mockLongRunningFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  describe("stream()", () => {
    it("yields chunks from NDJSON stream", async () => {
      const lines = [
        '{"message":{"content":"Hello"},"done":false}\n',
        '{"message":{"content":" world"},"done":false}\n',
        '{"message":{"content":""},"done":true}\n',
      ];

      const encoder = new TextEncoder();
      let readIdx = 0;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (readIdx < lines.length) {
                return Promise.resolve({
                  value: encoder.encode(lines[readIdx++]),
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
            releaseLock: jest.fn(),
          }),
        },
      });

      const chunks: { content: string; done: boolean }[] = [];
      for await (const chunk of provider.stream({
        systemPrompt: "Be brief.",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { content: "Hello", done: false },
        { content: " world", done: false },
      ]);
    });

    it("throws on non-ok response", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      const gen = provider.stream({
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
      ).rejects.toThrow("Ollama request failed: 503 Service Unavailable");
    });

    it("throws when response body is null", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: null,
      });

      const gen = provider.stream({
        systemPrompt: "test",
        messages: [{ role: "user", content: "hi" }],
      });

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
      ).rejects.toThrow("No response body from Ollama");
    });
  });

  describe("completeWithTools()", () => {
    const tools = [
      {
        name: "get_account_balances",
        description: "Get account balances",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ];

    /**
     * Helper: build a mock fetch Response whose body streams the given NDJSON
     * chunks. Used by both completeWithTools() (which now delegates internally
     * to streamWithTools()) and the dedicated streamWithTools() tests below.
     */
    const mockStreamingFetch = (ndjsonLines: string[]) => {
      const encoder = new TextEncoder();
      let readIdx = 0;
      return jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (readIdx < ndjsonLines.length) {
                return Promise.resolve({
                  value: encoder.encode(ndjsonLines[readIdx++]),
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
            releaseLock: jest.fn(),
          }),
        },
      });
    };

    it("returns tool calls when model invokes tools", async () => {
      global.fetch = mockStreamingFetch([
        '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"get_account_balances","arguments":{}}}]},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":50,"eval_count":10}\n',
      ]);

      const result = await provider.completeWithTools(
        {
          systemPrompt: "You are a financial assistant.",
          messages: [{ role: "user", content: "What are my balances?" }],
        },
        tools,
      );

      expect(result.stopReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("get_account_balances");
      expect(result.toolCalls[0].id).toBeDefined();
      expect(result.usage.inputTokens).toBe(50);
      expect(result.usage.outputTokens).toBe(10);
      expect(result.provider).toBe("ollama");

      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"tools"'),
        }),
      );
      // Must use stream:true now that completeWithTools delegates to streamWithTools
      const bodyArg = (global.fetch as jest.Mock).mock.calls[0][1].body;
      expect(bodyArg).toContain('"stream":true');
    });

    it("returns end_turn when model responds without tool calls", async () => {
      global.fetch = mockStreamingFetch([
        '{"message":{"role":"assistant","content":"Your total balance is $5,000."},"done":false}\n',
        '{"message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":100,"eval_count":20}\n',
      ]);

      const result = await provider.completeWithTools(
        {
          systemPrompt: "You are a financial assistant.",
          messages: [{ role: "user", content: "Summarize my finances." }],
        },
        tools,
      );

      expect(result.stopReason).toBe("end_turn");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.content).toBe("Your total balance is $5,000.");
      expect(result.usage.inputTokens).toBe(100);
      expect(result.usage.outputTokens).toBe(20);
    });

    it("throws on non-ok response", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        provider.completeWithTools(
          {
            systemPrompt: "test",
            messages: [{ role: "user", content: "hi" }],
          },
          tools,
        ),
      ).rejects.toThrow("Ollama request failed: 500 Internal Server Error");
    });
  });

  describe("streamWithTools()", () => {
    const tools = [
      {
        name: "get_account_balances",
        description: "Get account balances",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    const mockStreamingFetch = (ndjsonLines: string[]) => {
      const encoder = new TextEncoder();
      let readIdx = 0;
      return jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (readIdx < ndjsonLines.length) {
                return Promise.resolve({
                  value: encoder.encode(ndjsonLines[readIdx++]),
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
            releaseLock: jest.fn(),
          }),
        },
      });
    };

    it("yields a text chunk per content delta then a done chunk", async () => {
      global.fetch = mockStreamingFetch([
        '{"message":{"content":"Looking "},"done":false}\n',
        '{"message":{"content":"at "},"done":false}\n',
        '{"message":{"content":"your data."},"done":false}\n',
        '{"message":{"content":""},"done":true,"prompt_eval_count":42,"eval_count":7}\n',
      ]);

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "Be brief.",
          messages: [{ role: "user", content: "What's up?" }],
        },
        tools,
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toEqual({ type: "text", text: "Looking " });
      expect(chunks[1]).toEqual({ type: "text", text: "at " });
      expect(chunks[2]).toEqual({ type: "text", text: "your data." });

      const doneChunk = chunks[3];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.content).toBe("Looking at your data.");
        expect(doneChunk.toolCalls).toEqual([]);
        expect(doneChunk.stopReason).toBe("end_turn");
        expect(doneChunk.usage.inputTokens).toBe(42);
        expect(doneChunk.usage.outputTokens).toBe(7);
        expect(doneChunk.model).toBe("llama3");
      }
    });

    it("collects tool calls across chunks and reports tool_use stop reason", async () => {
      global.fetch = mockStreamingFetch([
        '{"message":{"content":"I need to check that."},"done":false}\n',
        '{"message":{"content":"","tool_calls":[{"function":{"name":"get_transactions","arguments":{"days":30}}}]},"done":false}\n',
        '{"message":{"content":""},"done":true,"prompt_eval_count":100,"eval_count":15}\n',
      ]);

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      )) {
        chunks.push(chunk);
      }

      const doneChunk = chunks[chunks.length - 1];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.stopReason).toBe("tool_use");
        expect(doneChunk.toolCalls).toHaveLength(1);
        expect(doneChunk.toolCalls[0].name).toBe("get_transactions");
        expect(doneChunk.toolCalls[0].input).toEqual({ days: 30 });
        expect(doneChunk.toolCalls[0].id).toBeDefined();
        expect(doneChunk.content).toBe("I need to check that.");
      }
    });

    it("handles fragmented NDJSON spread across reads", async () => {
      // Split a JSON line across two reads to verify the line buffer handles partial input.
      const encoder = new TextEncoder();
      const firstChunk = '{"message":{"content":"par';
      const secondChunk =
        'tial"},"done":false}\n{"message":{"content":""},"done":true}\n';
      let readIdx = 0;
      const reads = [firstChunk, secondChunk];
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        body: {
          getReader: () => ({
            read: () => {
              if (readIdx < reads.length) {
                return Promise.resolve({
                  value: encoder.encode(reads[readIdx++]),
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
            releaseLock: jest.fn(),
          }),
        },
      });

      const textChunks: string[] = [];
      for await (const chunk of provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      )) {
        if (chunk.type === "text") textChunks.push(chunk.text);
      }
      expect(textChunks.join("")).toBe("partial");
    });

    it("sends tools and stream:true in request body", async () => {
      global.fetch = mockStreamingFetch([
        '{"message":{"content":""},"done":true}\n',
      ]);

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of gen) {
        // consume
      }

      const bodyArg = (global.fetch as jest.Mock).mock.calls[0][1].body;
      expect(bodyArg).toContain('"tools"');
      expect(bodyArg).toContain('"stream":true');
      expect(bodyArg).toContain('"get_account_balances"');
    });

    it("calls longRunningFetch (not raw global fetch) so undici timeouts are disabled", async () => {
      // Regression: Node fetch (undici) defaults bodyTimeout to 5 minutes,
      // which kills slow CPU inference. The Ollama provider must call
      // longRunningFetch (which uses undici.fetch directly) instead of
      // globalThis.fetch, so the long-running dispatcher is honored.
      mockLongRunningFetch.mockClear();
      global.fetch = mockStreamingFetch([
        '{"message":{"content":""},"done":true}\n',
      ]);

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _chunk of gen) {
        // consume
      }

      expect(mockLongRunningFetch).toHaveBeenCalledTimes(1);
      expect(mockLongRunningFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/chat",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on non-ok response", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
      ).rejects.toThrow("Ollama request failed: 503 Service Unavailable");
    });

    it("throws a typed error when Ollama reports the model does not support tools", async () => {
      // Ollama returns 400 with this JSON body when the loaded model's
      // Modelfile template doesn't declare tool support (e.g. the default
      // deepseek-r1:latest in Ollama's registry).
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () =>
          Promise.resolve(
            '{"error":"registry.ollama.ai/library/deepseek-r1:latest does not support tools"}',
          ),
      });

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
      ).rejects.toBeInstanceOf(OllamaModelDoesNotSupportToolsError);
    });

    it("includes the model id and remediation advice in the tool-unsupported error", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () =>
          Promise.resolve(
            '{"error":"registry.ollama.ai/library/deepseek-r1:latest does not support tools"}',
          ),
      });

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
        // The provider was instantiated with modelId "llama3" in beforeEach,
        // so that's the id we expect to see reflected in the error.
      ).rejects.toThrow(/llama3.*does not support tool use/s);
    });

    it("throws when response body is null", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });

      const gen = provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      );

      await expect(
        (async () => {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _chunk of gen) {
            // consume
          }
        })(),
      ).rejects.toThrow("No response body from Ollama");
    });
  });

  describe("isAvailable()", () => {
    it("returns true when Ollama responds with ok", async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true });

      const result = await provider.isAvailable();
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns false when Ollama is unreachable", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });

    it("strips trailing slash from base URL", () => {
      const p = new OllamaProvider("http://localhost:11434/", "llama3");
      expect(p.name).toBe("ollama");
    });
  });

  describe("verifyModel()", () => {
    const mockTagsResponse = (
      models: Array<{ name?: string; model?: string }>,
    ) => ({
      ok: true,
      json: () => Promise.resolve({ models }),
    });

    it("returns ok when the exact model tag is in /api/tags", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockTagsResponse([{ name: "llama3" }]));
      const result = await provider.verifyModel();
      expect(result).toEqual({ ok: true, model: "llama3" });
    });

    it("returns ok for `foo` when only `foo:latest` is installed", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockTagsResponse([{ name: "llama3:latest" }]));
      const result = await provider.verifyModel();
      expect(result).toEqual({ ok: true, model: "llama3" });
    });

    it("returns ok for `foo:latest` when only `foo` is installed", async () => {
      const p = new OllamaProvider("http://localhost:11434", "llama3:latest");
      global.fetch = jest
        .fn()
        .mockResolvedValue(mockTagsResponse([{ name: "llama3" }]));
      const result = await p.verifyModel();
      expect(result).toEqual({ ok: true, model: "llama3:latest" });
    });

    it("reports a helpful reason listing available models when the configured model is missing", async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          mockTagsResponse([{ name: "mistral" }, { name: "qwen3:30b" }]),
        );
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.model).toBe("llama3");
        expect(result.reason).toMatch(/not installed/i);
        expect(result.reason).toContain("mistral");
        expect(result.reason).toContain("qwen3:30b");
      }
    });

    it("appends '+N more' when the available-models list exceeds the display cap", async () => {
      // 25 models -- above the 20-item display cap.
      const models = Array.from({ length: 25 }, (_, i) => ({
        name: `model-${String(i).padStart(2, "0")}`,
      }));
      global.fetch = jest.fn().mockResolvedValue(mockTagsResponse(models));

      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("+5 more");
        expect(result.reason).toContain("model-00");
        // The 25th model (sorted) should be excluded from the preview.
        expect(result.reason).not.toContain("model-24");
      }
    });

    it("does not add a '+N more' suffix when all available models fit the cap", async () => {
      const models = [
        { name: "llama3-8b" },
        { name: "mistral" },
        { name: "qwen3:30b" },
      ];
      global.fetch = jest.fn().mockResolvedValue(mockTagsResponse(models));

      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toMatch(/\+\d+ more/);
      }
    });

    it("reports that no models are installed when the host has an empty catalogue", async () => {
      global.fetch = jest.fn().mockResolvedValue(mockTagsResponse([]));
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/no models are installed/i);
      }
    });

    it("reports a not-ok HTTP status with the server's status code", async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("503");
      }
    });

    it("wraps fetch errors (unreachable host, timeout) as the reason", async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("ECONNREFUSED");
      }
    });
  });
});
