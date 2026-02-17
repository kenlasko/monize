import { AnthropicProvider } from "./anthropic.provider";

const mockCreate = jest.fn().mockResolvedValue({
  content: [{ type: "text", text: "Hello from Claude" }],
  usage: { input_tokens: 10, output_tokens: 20 },
  model: "claude-sonnet-4-20250514",
});

const mockStreamEvents = [
  { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
  {
    type: "content_block_delta",
    delta: { type: "text_delta", text: " world" },
  },
  { type: "message_stop" },
];

const mockStream = jest.fn().mockReturnValue({
  [Symbol.asyncIterator]: () => {
    let idx = 0;
    return {
      next: () => {
        if (idx < mockStreamEvents.length) {
          return Promise.resolve({
            value: mockStreamEvents[idx++],
            done: false,
          });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  },
});

const mockList = jest.fn().mockResolvedValue({ data: [] });

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
    models: {
      list: mockList,
    },
  })),
}));

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new AnthropicProvider(
      "test-api-key",
      "claude-sonnet-4-20250514",
    );
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("anthropic");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  describe("complete()", () => {
    it("returns formatted response", async () => {
      const result = await provider.complete({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.content).toBe("Hello from Claude");
      expect(result.usage.inputTokens).toBe(10);
      expect(result.usage.outputTokens).toBe(20);
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-sonnet-4-20250514");
    });
  });

  describe("stream()", () => {
    it("yields text delta chunks and a final done chunk", async () => {
      const chunks: { content: string; done: boolean }[] = [];
      for await (const chunk of provider.stream({
        systemPrompt: "Be helpful.",
        messages: [{ role: "user", content: "Hi" }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toEqual([
        { content: "Hello", done: false },
        { content: " world", done: false },
        { content: "", done: true },
      ]);
      expect(mockStream).toHaveBeenCalled();
    });
  });

  describe("completeWithTools()", () => {
    it("returns text content and tool calls", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "I'll categorize that." },
          {
            type: "tool_use",
            id: "tu_1",
            name: "categorize",
            input: { category: "food" },
          },
        ],
        usage: { input_tokens: 15, output_tokens: 25 },
        model: "claude-sonnet-4-20250514",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "Categorize.",
          messages: [{ role: "user", content: "Pizza" }],
        },
        [
          {
            name: "categorize",
            description: "Categorize a transaction",
            inputSchema: {
              type: "object",
              properties: { category: { type: "string" } },
            },
          },
        ],
      );

      expect(result.content).toBe("I'll categorize that.");
      expect(result.toolCalls).toEqual([
        { name: "categorize", input: { category: "food" } },
      ]);
      expect(result.usage.inputTokens).toBe(15);
      expect(result.usage.outputTokens).toBe(25);
      expect(result.provider).toBe("anthropic");
    });
  });

  describe("isAvailable()", () => {
    it("returns true when API responds", async () => {
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when API throws", async () => {
      mockList.mockRejectedValueOnce(new Error("Unauthorized"));
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });
});
