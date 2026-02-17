import { OpenAiProvider } from "./openai.provider";

const mockCreate = jest.fn();
const mockListModels = jest.fn().mockResolvedValue({ data: [] });

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockCreate,
      },
    },
    models: {
      list: mockListModels,
    },
  })),
}));

describe("OpenAiProvider", () => {
  let provider: OpenAiProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OpenAiProvider("test-api-key", "gpt-4o");

    mockCreate.mockResolvedValue({
      choices: [
        {
          message: { content: "Hello from GPT", tool_calls: undefined },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 25 },
      model: "gpt-4o",
    });
  });

  it("has correct provider properties", () => {
    expect(provider.name).toBe("openai");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  describe("complete()", () => {
    it("returns formatted response", async () => {
      const result = await provider.complete({
        systemPrompt: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(result.content).toBe("Hello from GPT");
      expect(result.usage.inputTokens).toBe(15);
      expect(result.usage.outputTokens).toBe(25);
      expect(result.provider).toBe("openai");
      expect(result.model).toBe("gpt-4o");
    });
  });

  describe("stream()", () => {
    it("yields content deltas and a final done chunk", async () => {
      const streamChunks = [
        { choices: [{ delta: { content: "Hi" } }] },
        { choices: [{ delta: { content: " there" } }] },
        { choices: [{ delta: {} }] },
      ];

      mockCreate.mockResolvedValueOnce({
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: () => {
              if (idx < streamChunks.length) {
                return Promise.resolve({
                  value: streamChunks[idx++],
                  done: false,
                });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
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
        { content: "Hi", done: false },
        { content: " there", done: false },
        { content: "", done: true },
      ]);
    });
  });

  describe("completeWithTools()", () => {
    it("returns tool calls from response", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "Let me categorize.",
              tool_calls: [
                {
                  type: "function",
                  function: {
                    name: "categorize",
                    arguments: '{"category":"food"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
        model: "gpt-4o",
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

      expect(result.content).toBe("Let me categorize.");
      expect(result.toolCalls).toEqual([
        { name: "categorize", input: { category: "food" } },
      ]);
      expect(result.usage.inputTokens).toBe(20);
      expect(result.usage.outputTokens).toBe(30);
    });

    it("handles empty tool calls", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "No tools needed.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: "gpt-4o",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "hello" }],
        },
        [],
      );

      expect(result.toolCalls).toEqual([]);
      expect(result.content).toBe("No tools needed.");
    });
  });

  describe("isAvailable()", () => {
    it("returns true when API responds", async () => {
      const result = await provider.isAvailable();
      expect(result).toBe(true);
    });

    it("returns false when API throws", async () => {
      mockListModels.mockRejectedValueOnce(new Error("Unauthorized"));
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });
});
