import { OllamaProvider } from "./ollama.provider";
import type { AiToolStreamChunk } from "./ai-provider.interface";

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
});
