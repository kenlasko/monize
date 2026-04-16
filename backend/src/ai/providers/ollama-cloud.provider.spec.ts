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

  it("honors a custom baseUrl when provided", async () => {
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
      "https://alt.ollama.example/api/chat",
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
});
