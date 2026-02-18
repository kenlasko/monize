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
                  id: "call_cat_1",
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
        {
          id: expect.any(String),
          name: "categorize",
          input: { category: "food" },
        },
      ]);
      expect(result.usage.inputTokens).toBe(20);
      expect(result.usage.outputTokens).toBe(30);
      expect(result.stopReason).toBe("tool_use");
    });

    it("returns id from tool calls", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "get_balance",
                    arguments: "{}",
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
          systemPrompt: "test",
          messages: [{ role: "user", content: "balance?" }],
        },
        [
          {
            name: "get_balance",
            description: "Get balance",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );

      expect(result.toolCalls[0].id).toBe("call_abc123");
    });

    it("maps finish_reason to stopReason correctly", async () => {
      // stop -> end_turn
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Done.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        model: "gpt-4o",
      });

      let result = await provider.completeWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        [],
      );
      expect(result.stopReason).toBe("end_turn");

      // length -> max_tokens
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Truncated...", tool_calls: undefined },
            finish_reason: "length",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1024 },
        model: "gpt-4o",
      });

      result = await provider.completeWithTools(
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "write a lot" }],
        },
        [],
      );
      expect(result.stopReason).toBe("max_tokens");
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
      expect(result.stopReason).toBe("end_turn");
    });

    it("handles multi-turn messages with tool results", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Based on the data...", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 30 },
        model: "gpt-4o",
      });

      await provider.completeWithTools(
        {
          systemPrompt: "You are helpful.",
          messages: [
            { role: "user", content: "My balance?" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call_1", name: "get_balance", input: {} }],
            },
            {
              role: "tool",
              toolCallId: "call_1",
              name: "get_balance",
              content: '{"balance": 5000}',
            },
          ],
        },
        [
          {
            name: "get_balance",
            description: "Get balance",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      );

      // Verify the messages were correctly formatted for OpenAI
      const createCall = mockCreate.mock.calls[0][0];
      const messages = createCall.messages;

      // System + user + assistant with tool_calls + tool result
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe("system");
      expect(messages[1].role).toBe("user");
      expect(messages[2].role).toBe("assistant");
      expect(messages[2].tool_calls).toHaveLength(1);
      expect(messages[2].tool_calls[0].id).toBe("call_1");
      expect(messages[2].tool_calls[0].function.name).toBe("get_balance");
      expect(messages[3].role).toBe("tool");
      expect(messages[3].tool_call_id).toBe("call_1");
      expect(messages[3].content).toBe('{"balance": 5000}');
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
