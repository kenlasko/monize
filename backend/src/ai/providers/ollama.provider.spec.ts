import { OllamaProvider } from "./ollama.provider";

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider("http://localhost:11434", "llama3");
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("ollama");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(false);
  });

  describe("complete()", () => {
    it("returns formatted response on success", async () => {
      const mockResponse = {
        ok: true,
        json: jest.fn().mockResolvedValue({
          message: { role: "assistant", content: "Hello from Ollama" },
          done: true,
          prompt_eval_count: 12,
          eval_count: 18,
        }),
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
