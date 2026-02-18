import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { AiQueryService, StreamEvent } from "./ai-query.service";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { FinancialContextBuilder } from "../context/financial-context.builder";
import { ToolExecutorService } from "./tool-executor.service";

describe("AiQueryService", () => {
  let service: AiQueryService;
  let mockAiService: Record<string, jest.Mock>;
  let mockUsageService: Record<string, jest.Mock>;
  let mockContextBuilder: Record<string, jest.Mock>;
  let mockToolExecutor: Record<string, jest.Mock>;
  let mockProvider: Record<string, jest.Mock | string | boolean>;

  const userId = "user-1";

  beforeEach(async () => {
    mockProvider = {
      name: "anthropic",
      supportsToolUse: true,
      completeWithTools: jest.fn().mockResolvedValue({
        content: "Here is your financial summary.",
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        stopReason: "end_turn",
      }),
    };

    mockAiService = {
      getToolUseProvider: jest.fn().mockResolvedValue(mockProvider),
    };

    mockUsageService = {
      logUsage: jest.fn().mockResolvedValue({ id: "log-1" }),
    };

    mockContextBuilder = {
      buildQueryContext: jest
        .fn()
        .mockResolvedValue("You are a financial assistant. TODAY: 2026-02-17"),
    };

    mockToolExecutor = {
      execute: jest.fn().mockResolvedValue({
        data: { totalExpenses: 3000, transactionCount: 45 },
        summary: "Found 45 transactions",
        sources: [
          {
            type: "transactions",
            description: "Transaction summary",
            dateRange: "2026-01-01 to 2026-01-31",
          },
        ],
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiQueryService,
        { provide: AiService, useValue: mockAiService },
        { provide: AiUsageService, useValue: mockUsageService },
        {
          provide: FinancialContextBuilder,
          useValue: mockContextBuilder,
        },
        { provide: ToolExecutorService, useValue: mockToolExecutor },
      ],
    }).compile();

    service = module.get<AiQueryService>(AiQueryService);
  });

  async function collectEvents(
    userId: string,
    query: string,
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of service.executeQueryStream(userId, query)) {
      events.push(event);
    }
    return events;
  }

  describe("executeQueryStream()", () => {
    it("yields thinking, content, and done events for simple queries", async () => {
      const events = await collectEvents(userId, "What's my balance?");

      expect(events[0]).toEqual({
        type: "thinking",
        message: "Analyzing your question...",
      });

      const contentEvent = events.find((e) => e.type === "content");
      expect(contentEvent).toBeDefined();
      expect(contentEvent!.text).toBe("Here is your financial summary.");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
      expect(doneEvent!.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        toolCalls: 0,
      });
    });

    it("builds financial context for the user", async () => {
      await collectEvents(userId, "How much did I spend?");

      expect(mockContextBuilder.buildQueryContext).toHaveBeenCalledWith(userId);
    });

    it("gets a tool-use provider", async () => {
      await collectEvents(userId, "How much did I spend?");

      expect(mockAiService.getToolUseProvider).toHaveBeenCalledWith(userId);
    });

    it("passes messages and system prompt to provider", async () => {
      await collectEvents(userId, "How much did I spend?");

      expect(mockProvider.completeWithTools).toHaveBeenCalledWith(
        {
          systemPrompt: "You are a financial assistant. TODAY: 2026-02-17",
          messages: [{ role: "user", content: "How much did I spend?" }],
          maxTokens: 4096,
          temperature: 0.1,
        },
        expect.any(Array), // FINANCIAL_TOOLS
      );
    });

    it("executes tool calls and feeds results back", async () => {
      // First call returns tool use
      (mockProvider.completeWithTools as jest.Mock)
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            {
              id: "tc-1",
              name: "query_transactions",
              input: { startDate: "2026-01-01", endDate: "2026-01-31" },
            },
          ],
          usage: { inputTokens: 80, outputTokens: 30 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "tool_use",
        })
        // Second call returns final answer
        .mockResolvedValueOnce({
          content: "You spent $3,000 in January.",
          toolCalls: [],
          usage: { inputTokens: 200, outputTokens: 40 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "end_turn",
        });

      const events = await collectEvents(
        userId,
        "How much did I spend in January?",
      );

      // Should have tool_start and tool_result events
      const toolStart = events.find((e) => e.type === "tool_start");
      expect(toolStart).toBeDefined();
      expect(toolStart!.name).toBe("query_transactions");

      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult).toBeDefined();
      expect(toolResult!.name).toBe("query_transactions");
      expect(toolResult!.summary).toBe("Found 45 transactions");

      // Should have content event with final answer
      const content = events.find((e) => e.type === "content");
      expect(content!.text).toBe("You spent $3,000 in January.");

      // Should have sources
      const sourcesEvent = events.find((e) => e.type === "sources");
      expect(sourcesEvent).toBeDefined();

      // Tool executor should have been called
      expect(mockToolExecutor.execute).toHaveBeenCalledWith(
        userId,
        "query_transactions",
        { startDate: "2026-01-01", endDate: "2026-01-31" },
      );
    });

    it("handles multiple tool calls in sequence", async () => {
      (mockProvider.completeWithTools as jest.Mock)
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            { id: "tc-1", name: "get_account_balances", input: {} },
          ],
          usage: { inputTokens: 80, outputTokens: 20 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            {
              id: "tc-2",
              name: "query_transactions",
              input: { startDate: "2026-01-01", endDate: "2026-01-31" },
            },
          ],
          usage: { inputTokens: 200, outputTokens: 30 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "Your net worth is $18,800 and you spent $3,000 this month.",
          toolCalls: [],
          usage: { inputTokens: 300, outputTokens: 50 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "end_turn",
        });

      const events = await collectEvents(
        userId,
        "What's my net worth and monthly spending?",
      );

      const toolStarts = events.filter((e) => e.type === "tool_start");
      expect(toolStarts).toHaveLength(2);

      const doneEvent = events.find((e) => e.type === "done");
      const usage = doneEvent!.usage as Record<string, number>;
      expect(usage.inputTokens).toBe(580); // 80 + 200 + 300
      expect(usage.outputTokens).toBe(100); // 20 + 30 + 50
      expect(usage.toolCalls).toBe(2);
    });

    it("stops after MAX_ITERATIONS (5)", async () => {
      // Always return tool_use to hit max iterations
      (mockProvider.completeWithTools as jest.Mock).mockResolvedValue({
        content: "",
        toolCalls: [
          { id: "tc-x", name: "query_transactions", input: { startDate: "2026-01-01", endDate: "2026-01-31" } },
        ],
        usage: { inputTokens: 50, outputTokens: 20 },
        model: "claude-sonnet-4-20250514",
        provider: "anthropic",
        stopReason: "tool_use",
      });

      const events = await collectEvents(userId, "Infinite loop query");

      // Should be called exactly 5 times
      expect(mockProvider.completeWithTools).toHaveBeenCalledTimes(5);

      // Should have a content event with the fallback message
      const contentEvent = events.find((e) => e.type === "content");
      expect(contentEvent!.text).toContain("maximum number of analysis steps");

      // Should still emit done
      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });

    it("yields error when context builder fails", async () => {
      mockContextBuilder.buildQueryContext.mockRejectedValueOnce(
        new Error("Database connection failed"),
      );

      const events = await collectEvents(userId, "Any query");

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toBe("Database connection failed");
    });

    it("yields error when no AI provider is available", async () => {
      mockAiService.getToolUseProvider.mockRejectedValueOnce(
        new BadRequestException("No AI provider with tool use support"),
      );

      const events = await collectEvents(userId, "Any query");

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toContain("No AI provider with tool use support");
    });

    it("yields error when AI provider throws during completion", async () => {
      (mockProvider.completeWithTools as jest.Mock).mockRejectedValueOnce(
        new Error("Rate limit exceeded"),
      );

      const events = await collectEvents(userId, "Any query");

      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toContain("The AI provider encountered an error processing your query.");
    });

    it("logs usage after successful completion", async () => {
      await collectEvents(userId, "What's my balance?");

      expect(mockUsageService.logUsage).toHaveBeenCalledWith({
        userId,
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        feature: "query",
        inputTokens: 100,
        outputTokens: 50,
        durationMs: expect.any(Number),
      });
    });

    it("handles usage logging failure gracefully", async () => {
      mockUsageService.logUsage.mockRejectedValueOnce(
        new Error("Usage log save failed"),
      );

      // Should not throw
      const events = await collectEvents(userId, "What's my balance?");

      const doneEvent = events.find((e) => e.type === "done");
      expect(doneEvent).toBeDefined();
    });

    it("does not yield sources when none collected", async () => {
      const events = await collectEvents(userId, "Simple question");

      const sourcesEvent = events.find((e) => e.type === "sources");
      expect(sourcesEvent).toBeUndefined();
    });

    it("appends tool result messages to conversation for multi-turn", async () => {
      (mockProvider.completeWithTools as jest.Mock)
        .mockResolvedValueOnce({
          content: "Looking up data...",
          toolCalls: [
            { id: "tc-1", name: "get_account_balances", input: {} },
          ],
          usage: { inputTokens: 80, outputTokens: 20 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "Your balance is $5,000.",
          toolCalls: [],
          usage: { inputTokens: 200, outputTokens: 30 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "end_turn",
        });

      await collectEvents(userId, "What's my balance?");

      // Second call should include the full conversation
      const secondCallArgs = (mockProvider.completeWithTools as jest.Mock).mock
        .calls[1][0];
      const messages = secondCallArgs.messages;

      // Should have: user message, assistant message with tool calls, tool result
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].toolCalls).toHaveLength(1);
      expect(messages[2].role).toBe("tool");
      expect(messages[2].toolCallId).toBe("tc-1");
      expect(messages[2].name).toBe("get_account_balances");
    });
  });

  describe("executeQuery()", () => {
    it("returns complete QueryResult", async () => {
      (mockProvider.completeWithTools as jest.Mock)
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [
            { id: "tc-1", name: "get_account_balances", input: {} },
          ],
          usage: { inputTokens: 80, outputTokens: 20 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "tool_use",
        })
        .mockResolvedValueOnce({
          content: "Your balance is $5,000.",
          toolCalls: [],
          usage: { inputTokens: 200, outputTokens: 30 },
          model: "claude-sonnet-4-20250514",
          provider: "anthropic",
          stopReason: "end_turn",
        });

      const result = await service.executeQuery(userId, "What's my balance?");

      expect(result.answer).toBe("Your balance is $5,000.");
      expect(result.toolsUsed).toHaveLength(1);
      expect(result.toolsUsed[0].name).toBe("get_account_balances");
      expect(result.sources).toHaveLength(1);
      expect(result.usage.inputTokens).toBe(280);
      expect(result.usage.outputTokens).toBe(50);
      expect(result.usage.toolCalls).toBe(1);
    });

    it("throws BadRequestException on error event", async () => {
      mockContextBuilder.buildQueryContext.mockRejectedValueOnce(
        new Error("DB error"),
      );

      await expect(
        service.executeQuery(userId, "Any query"),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
