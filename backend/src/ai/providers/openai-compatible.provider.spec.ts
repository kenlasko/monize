import type { AiMessage, AiToolStreamChunk } from "./ai-provider.interface";
import {
  OpenAiCompatibleProvider,
  flattenToolMessages,
  parseInlineToolCalls,
} from "./openai-compatible.provider";

const mockCreate = jest.fn();
const mockListModels = jest.fn().mockResolvedValue({ data: [] });

jest.mock("openai", () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockCreate } },
    models: { list: mockListModels },
  })),
}));

describe("parseInlineToolCalls", () => {
  it("returns null for plain text", () => {
    expect(parseInlineToolCalls("I don't know")).toBeNull();
    expect(parseInlineToolCalls("")).toBeNull();
  });

  it("parses the Llama-3.1 shape with `arguments`", () => {
    const text = JSON.stringify({
      name: "get_spending_by_category",
      arguments: { startDate: "2026-03-01", topN: "all" },
    });
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("get_spending_by_category");
    expect(result![0].input).toEqual({
      startDate: "2026-03-01",
      topN: "all",
    });
    expect(result![0].id).toMatch(/^call_inline_/);
  });

  it("parses the Cloudflare 70B shape with `type: function` and `parameters`", () => {
    const text = JSON.stringify({
      type: "function",
      name: "query_transactions",
      parameters: { startDate: "2026-03-01", direction: "expenses" },
    });
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("query_transactions");
    expect(result![0].input).toEqual({
      startDate: "2026-03-01",
      direction: "expenses",
    });
  });

  it("parses the OpenAI-ish nested `function` shape", () => {
    const text = JSON.stringify({
      type: "function",
      function: {
        name: "get_balance",
        arguments: JSON.stringify({ accountId: "abc" }),
      },
    });
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("get_balance");
    expect(result![0].input).toEqual({ accountId: "abc" });
  });

  it("strips <|python_tag|> prefix", () => {
    const text = `<|python_tag|>${JSON.stringify({
      name: "get_balance",
      arguments: { accountId: "abc" },
    })}`;
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("get_balance");
  });

  it("parses <function=name>{...}</function> wrapper", () => {
    const text = '<function=get_balance>{"accountId":"abc"}</function>';
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe("get_balance");
    expect(result![0].input).toEqual({ accountId: "abc" });
  });

  it("parses arrays of tool calls", () => {
    const text = JSON.stringify([
      { name: "a", arguments: { x: 1 } },
      { name: "b", arguments: { y: 2 } },
    ]);
    const result = parseInlineToolCalls(text);
    expect(result).toHaveLength(2);
    expect(result![0].name).toBe("a");
    expect(result![1].name).toBe("b");
  });

  it("returns null for JSON that is not a tool call", () => {
    expect(parseInlineToolCalls('{"answer":42}')).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseInlineToolCalls("{ this is not json")).toBeNull();
  });
});

describe("flattenToolMessages", () => {
  it("passes user messages through untouched", () => {
    const messages: AiMessage[] = [{ role: "user", content: "hi" }];
    expect(flattenToolMessages(messages)).toEqual(messages);
  });

  it("serializes assistant tool calls into plain content", () => {
    const messages: AiMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            name: "query_transactions",
            input: { startDate: "2026-03-01" },
          },
        ],
      },
    ];
    const out = flattenToolMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("assistant");
    // No toolCalls field on output -- Cloudflare rejects it.
    expect((out[0] as { toolCalls?: unknown }).toolCalls).toBeUndefined();
    if (out[0].role === "assistant") {
      const parsed = JSON.parse(out[0].content);
      expect(parsed.name).toBe("query_transactions");
      expect(parsed.parameters).toEqual({ startDate: "2026-03-01" });
    }
  });

  it("converts tool-result messages into user messages", () => {
    const messages: AiMessage[] = [
      {
        role: "tool",
        toolCallId: "call_1",
        name: "query_transactions",
        content: '{"total":42}',
      },
    ];
    const out = flattenToolMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    if (out[0].role === "user") {
      expect(out[0].content).toContain("Tool query_transactions result:");
      expect(out[0].content).toContain('{"total":42}');
    }
  });

  it("preserves assistant content alongside tool calls", () => {
    const messages: AiMessage[] = [
      {
        role: "assistant",
        content: "Let me check.",
        toolCalls: [{ id: "c1", name: "t", input: {} }],
      },
    ];
    const out = flattenToolMessages(messages);
    if (out[0].role === "assistant") {
      expect(out[0].content.startsWith("Let me check.")).toBe(true);
      expect(out[0].content).toContain('"name":"t"');
    }
  });
});

describe("OpenAiCompatibleProvider", () => {
  let provider: OpenAiCompatibleProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new OpenAiCompatibleProvider(
      "test-key",
      "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    );
  });

  it("has name openai-compatible", () => {
    expect(provider.name).toBe("openai-compatible");
    expect(provider.supportsStreaming).toBe(true);
    expect(provider.supportsToolUse).toBe(true);
  });

  describe("completeWithTools()", () => {
    it("converts inline JSON tool call text to structured tool calls", async () => {
      const inlineBlob = JSON.stringify({
        type: "function",
        name: "query_transactions",
        parameters: { startDate: "2026-03-01" },
      });
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: inlineBlob, tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        model: "llama",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [
          {
            name: "query_transactions",
            description: "",
            inputSchema: { type: "object" },
          },
        ],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("query_transactions");
      expect(result.toolCalls[0].input).toEqual({ startDate: "2026-03-01" });
      expect(result.content).toBe("");
      expect(result.stopReason).toBe("tool_use");
    });

    it("passes through plain text responses unchanged", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "Just a text answer.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
        model: "llama",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [],
      );

      expect(result.content).toBe("Just a text answer.");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.stopReason).toBe("end_turn");
    });

    it("flattens prior tool-call / tool-result messages before sending", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: { content: "done.", tool_calls: undefined },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "llama",
      });

      await provider.completeWithTools(
        {
          systemPrompt: "sys",
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "c1", name: "t", input: { a: 1 } }],
            },
            {
              role: "tool",
              toolCallId: "c1",
              name: "t",
              content: '{"ok":true}',
            },
          ],
        },
        [],
      );

      const payload = mockCreate.mock.calls[0][0];
      // No role="tool" messages, no tool_calls on assistant messages.
      for (const m of payload.messages) {
        expect(m.role).not.toBe("tool");
        if (m.role === "assistant") {
          expect(m.tool_calls).toBeUndefined();
        }
      }
      // Tool result became a user message.
      const userMessages = payload.messages.filter(
        (m: { role: string }) => m.role === "user",
      );
      expect(
        userMessages.some((m: { content: string }) =>
          m.content.includes("Tool t result:"),
        ),
      ).toBe(true);
    });

    it("does not clobber real structured tool calls", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_balance",
                    arguments: '{"accountId":"abc"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
        model: "llama",
      });

      const result = await provider.completeWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [],
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].id).toBe("call_1");
      expect(result.toolCalls[0].name).toBe("get_balance");
    });
  });

  describe("streamWithTools()", () => {
    const makeStream = (
      chunks: Array<{
        delta?: { content?: string; tool_calls?: unknown };
        finish_reason?: string | null;
        usage?: { prompt_tokens: number; completion_tokens: number };
        model?: string;
      }>,
    ) => ({
      [Symbol.asyncIterator]: () => {
        let idx = 0;
        return {
          next: () => {
            if (idx < chunks.length) {
              const c = chunks[idx++];
              return Promise.resolve({
                value: {
                  choices: [
                    { delta: c.delta ?? {}, finish_reason: c.finish_reason },
                  ],
                  usage: c.usage,
                  model: c.model,
                },
                done: false,
              });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    });

    it("buffers JSON-looking text and replaces it with tool calls on done", async () => {
      const inlineBlob = JSON.stringify({
        type: "function",
        name: "query_transactions",
        parameters: { startDate: "2026-03-01" },
      });
      mockCreate.mockResolvedValueOnce(
        makeStream([
          { delta: { content: inlineBlob.slice(0, 20) } },
          { delta: { content: inlineBlob.slice(20) } },
          {
            delta: {},
            finish_reason: "stop",
            usage: { prompt_tokens: 10, completion_tokens: 30 },
            model: "llama",
          },
        ]),
      );

      const yielded: AiToolStreamChunk[] = [];
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [],
      )) {
        yielded.push(chunk);
      }

      // Should NOT have surfaced any raw JSON text chunks
      expect(yielded.filter((c) => c.type === "text")).toHaveLength(0);
      const done = yielded.find((c) => c.type === "done");
      expect(done).toBeDefined();
      if (done && done.type === "done") {
        expect(done.toolCalls).toHaveLength(1);
        expect(done.toolCalls[0].name).toBe("query_transactions");
        expect(done.stopReason).toBe("tool_use");
        expect(done.content).toBe("");
      }
    });

    it("streams plain text normally", async () => {
      mockCreate.mockResolvedValueOnce(
        makeStream([
          { delta: { content: "Hello " } },
          { delta: { content: "world" } },
          {
            delta: {},
            finish_reason: "stop",
            usage: { prompt_tokens: 5, completion_tokens: 5 },
            model: "llama",
          },
        ]),
      );

      const texts: string[] = [];
      let done: AiToolStreamChunk | undefined;
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [],
      )) {
        if (chunk.type === "text") texts.push(chunk.text);
        else done = chunk;
      }

      expect(texts.join("")).toBe("Hello world");
      expect(done).toBeDefined();
      if (done && done.type === "done") {
        expect(done.toolCalls).toHaveLength(0);
      }
    });

    it("flushes buffered text when JSON-looking content does not parse as a tool call", async () => {
      // Content starts with `{` but is not a tool call -- e.g. the model is
      // narrating a code block. We should flush it rather than eating it.
      mockCreate.mockResolvedValueOnce(
        makeStream([
          { delta: { content: '{"answer":' } },
          { delta: { content: "42}" } },
          {
            delta: {},
            finish_reason: "stop",
            usage: { prompt_tokens: 5, completion_tokens: 5 },
            model: "llama",
          },
        ]),
      );

      const texts: string[] = [];
      let done: AiToolStreamChunk | undefined;
      for await (const chunk of provider.streamWithTools(
        {
          systemPrompt: "sys",
          messages: [{ role: "user", content: "hi" }],
        },
        [],
      )) {
        if (chunk.type === "text") texts.push(chunk.text);
        else done = chunk;
      }

      expect(texts.join("")).toBe('{"answer":42}');
      expect(done).toBeDefined();
      if (done && done.type === "done") {
        expect(done.toolCalls).toHaveLength(0);
      }
    });
  });

  describe("isAvailable()", () => {
    it("probes via chat.completions.create instead of models.list", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "pong" } }],
      });

      const result = await provider.isAvailable();

      expect(result).toBe(true);
      expect(mockListModels).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          max_tokens: 1,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns false when the probe fails", async () => {
      mockCreate.mockRejectedValueOnce(new Error("Unauthorized"));
      const result = await provider.isAvailable();
      expect(result).toBe(false);
    });
  });

  describe("verifyModel()", () => {
    it("returns ok when the probe completion succeeds", async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: "ok" } }],
      });
      const result = await provider.verifyModel();
      expect(result).toEqual({
        ok: true,
        model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      });
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          max_tokens: 1,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("reports a not-found reason when the probe returns 404", async () => {
      const err = Object.assign(new Error("model not found"), { status: 404 });
      mockCreate.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not found/i);
      }
    });

    it("reports a not-found reason when the error body mentions 'model does not exist'", async () => {
      // Some backends return 400 with a body like 'the model ... does not exist'.
      mockCreate.mockRejectedValueOnce(
        new Error("the model `foo` does not exist"),
      );
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/not found/i);
      }
    });

    it("reports an auth-failure reason on 401", async () => {
      const err = Object.assign(new Error("unauthorized"), { status: 401 });
      mockCreate.mockRejectedValueOnce(err);
      const result = await provider.verifyModel();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toMatch(/authentication/i);
      }
    });
  });
});
