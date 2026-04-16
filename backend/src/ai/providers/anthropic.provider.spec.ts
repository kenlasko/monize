import { AnthropicProvider } from "./anthropic.provider";
import type { AiToolStreamChunk } from "./ai-provider.interface";

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
const mockRetrieve = jest.fn();

jest.mock("@anthropic-ai/sdk", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
      stream: mockStream,
    },
    models: {
      list: mockList,
      retrieve: mockRetrieve,
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

  it("constructs the SDK client with the long-running fetch wrapper", () => {
    // Regression: the SDK uses Node fetch (undici) under the hood, which
    // defaults bodyTimeout to 5 minutes. The provider must inject the
    // long-running fetch wrapper so SDK calls inherit disabled timeouts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { longRunningFetch } = require("./long-running-fetch");
    expect(Anthropic).toHaveBeenCalledWith(
      expect.objectContaining({ fetch: longRunningFetch }),
    );
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
        stop_reason: "end_turn",
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
        { id: "tu_1", name: "categorize", input: { category: "food" } },
      ]);
      expect(result.usage.inputTokens).toBe(15);
      expect(result.usage.outputTokens).toBe(25);
      expect(result.provider).toBe("anthropic");
      expect(result.stopReason).toBe("end_turn");
    });

    it("maps stop_reason tool_use correctly", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "get_balance",
            input: {},
          },
        ],
        usage: { input_tokens: 10, output_tokens: 15 },
        model: "claude-sonnet-4-20250514",
        stop_reason: "tool_use",
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

      expect(result.stopReason).toBe("tool_use");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("tu_2");
    });

    it("handles multi-turn messages with tool results", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Based on the data, your balance is $5,000." },
        ],
        usage: { input_tokens: 50, output_tokens: 30 },
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
      });

      await provider.completeWithTools(
        {
          systemPrompt: "You are helpful.",
          messages: [
            { role: "user", content: "My balance?" },
            {
              role: "assistant",
              content: "Let me check.",
              toolCalls: [{ id: "tu_1", name: "get_balance", input: {} }],
            },
            {
              role: "tool",
              toolCallId: "tu_1",
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

      // Verify the messages were correctly formatted for Anthropic
      const createCall = mockCreate.mock.calls[0][0];
      const messages = createCall.messages;

      // user + assistant with tool_use block + user with tool_result block
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toEqual([
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tu_1", name: "get_balance", input: {} },
      ]);
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: '{"balance": 5000}',
        },
      ]);
    });
  });

  describe("streamWithTools()", () => {
    type AnthropicEvent = Record<string, unknown>;
    type FinalMessage = Record<string, unknown>;

    const buildStream = (
      events: AnthropicEvent[],
      finalMessage: FinalMessage,
    ) => {
      const stream = {
        [Symbol.asyncIterator]: () => {
          let idx = 0;
          return {
            next: () => {
              if (idx < events.length) {
                return Promise.resolve({ value: events[idx++], done: false });
              }
              return Promise.resolve({ value: undefined, done: true });
            },
          };
        },
        finalMessage: jest.fn().mockResolvedValue(finalMessage),
      };
      return stream;
    };

    const tools = [
      {
        name: "get_account_balances",
        description: "Get balances",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    it("yields text deltas as text chunks then a done chunk with end_turn", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Your " },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "balance is $5,000." },
            },
            { type: "content_block_stop", index: 0 },
            { type: "message_stop" },
          ],
          {
            content: [{ type: "text", text: "Your balance is $5,000." }],
            usage: { input_tokens: 30, output_tokens: 12 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "end_turn",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "Be brief.",
          messages: [{ role: "user", content: "balance?" }],
        },
        tools,
      )) {
        chunks.push(chunk);
      }

      expect(
        chunks
          .filter((c) => c.type === "text")
          .map((c) => (c.type === "text" ? c.text : "")),
      ).toEqual(["Your ", "balance is $5,000."]);
      const doneChunk = chunks[chunks.length - 1];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.content).toBe("Your balance is $5,000.");
        expect(doneChunk.toolCalls).toEqual([]);
        expect(doneChunk.stopReason).toBe("end_turn");
        expect(doneChunk.usage.inputTokens).toBe(30);
        expect(doneChunk.usage.outputTokens).toBe(12);
      }
    });

    it("emits accumulated tool calls from finalMessage with tool_use stop reason", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "Let me check." },
            },
            { type: "content_block_stop", index: 0 },
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "tu_1",
                name: "get_account_balances",
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"days":' },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: "30}" },
            },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" },
          ],
          {
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "tu_1",
                name: "get_account_balances",
                input: { days: 30 },
              },
            ],
            usage: { input_tokens: 25, output_tokens: 18 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "tool_use",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "balance?" }],
        },
        tools,
      )) {
        chunks.push(chunk);
      }

      const doneChunk = chunks[chunks.length - 1];
      expect(doneChunk.type).toBe("done");
      if (doneChunk.type === "done") {
        expect(doneChunk.stopReason).toBe("tool_use");
        expect(doneChunk.toolCalls).toEqual([
          { id: "tu_1", name: "get_account_balances", input: { days: 30 } },
        ]);
        expect(doneChunk.content).toBe("Let me check.");
      }
    });

    it("maps stop_reason max_tokens correctly", async () => {
      mockStream.mockReturnValueOnce(
        buildStream(
          [
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "truncated" },
            },
          ],
          {
            content: [{ type: "text", text: "truncated" }],
            usage: { input_tokens: 10, output_tokens: 4096 },
            model: "claude-sonnet-4-20250514",
            stop_reason: "max_tokens",
          },
        ),
      );

      const chunks: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        { systemPrompt: "test", messages: [{ role: "user", content: "hi" }] },
        tools,
      )) {
        chunks.push(chunk);
      }

      const doneChunk = chunks[chunks.length - 1];
      if (doneChunk.type === "done") {
        expect(doneChunk.stopReason).toBe("max_tokens");
      }
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

  describe("verifyModel()", () => {
    it("returns ok when models.retrieve succeeds", async () => {
      mockRetrieve.mockResolvedValueOnce({ id: "claude-sonnet-4-20250514" });
      const result = await provider.verifyModel();
      expect(result).toEqual({
        ok: true,
        model: "claude-sonnet-4-20250514",
      });
      expect(mockRetrieve).toHaveBeenCalledWith(
        "claude-sonnet-4-20250514",
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("reports a not-found reason when retrieve returns 404", async () => {
      const err = Object.assign(new Error("not found"), { status: 404 });
      mockRetrieve.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.model).toBe("claude-sonnet-4-20250514");
        expect(result.reason).toMatch(/not found/i);
      }
    });

    it("reports an auth-failure reason on 401", async () => {
      const err = Object.assign(new Error("Unauthorized"), { status: 401 });
      mockRetrieve.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/authentication/i);
      }
    });

    it("falls back to a generic reason for other errors", async () => {
      mockRetrieve.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("ECONNREFUSED");
      }
    });
  });
});
