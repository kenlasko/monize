import { Test, TestingModule } from "@nestjs/testing";
import { AiQueryController } from "./ai-query.controller";
import { AiQueryService, QueryResult } from "./ai-query.service";

describe("AiQueryController", () => {
  let controller: AiQueryController;
  let mockQueryService: Record<string, jest.Mock>;

  const mockRequest = { user: { id: "user-1" } };

  const mockQueryResult: QueryResult = {
    answer: "You spent $3,000 in January.",
    toolsUsed: [
      { name: "query_transactions", summary: "Found 45 transactions" },
    ],
    sources: [
      {
        type: "transactions",
        description: "Transaction summary",
        dateRange: "2026-01-01 to 2026-01-31",
      },
    ],
    usage: { inputTokens: 300, outputTokens: 80, toolCalls: 1 },
  };

  beforeEach(async () => {
    mockQueryService = {
      executeQuery: jest.fn().mockResolvedValue(mockQueryResult),
      executeQueryStream: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AiQueryController],
      providers: [{ provide: AiQueryService, useValue: mockQueryService }],
    }).compile();

    controller = module.get<AiQueryController>(AiQueryController);
  });

  describe("query()", () => {
    it("executes query and returns result", async () => {
      const result = await controller.query(mockRequest, {
        query: "How much did I spend in January?",
      });

      expect(result).toEqual(mockQueryResult);
      expect(mockQueryService.executeQuery).toHaveBeenCalledWith(
        "user-1",
        "How much did I spend in January?",
      );
    });

    it("passes the authenticated user ID", async () => {
      const otherRequest = { user: { id: "user-2" } };

      await controller.query(otherRequest, { query: "My balance?" });

      expect(mockQueryService.executeQuery).toHaveBeenCalledWith(
        "user-2",
        "My balance?",
      );
    });
  });

  describe("streamQuery()", () => {
    it("sets SSE headers and streams events", async () => {
      const events = [
        { type: "thinking", message: "Analyzing..." },
        { type: "content", text: "Your balance is $5,000." },
        {
          type: "done",
          usage: { inputTokens: 100, outputTokens: 50, toolCalls: 0 },
        },
      ];

      mockQueryService.executeQueryStream.mockReturnValue(
        (async function* () {
          for (const event of events) {
            yield event;
          }
        })(),
      );

      const written: string[] = [];
      const headers: Record<string, string> = {};
      const mockRes = {
        setHeader: jest.fn((key: string, value: string) => {
          headers[key] = value;
        }),
        flushHeaders: jest.fn(),
        write: jest.fn((data: string) => written.push(data)),
        end: jest.fn(),
      };

      await controller.streamQuery(
        mockRequest,
        { query: "What's my balance?" },
        mockRes as any,
      );

      // Verify SSE headers
      expect(headers["Content-Type"]).toBe("text/event-stream");
      expect(headers["Cache-Control"]).toBe("no-cache");
      expect(headers["Connection"]).toBe("keep-alive");
      expect(headers["X-Accel-Buffering"]).toBe("no");
      expect(mockRes.flushHeaders).toHaveBeenCalled();

      // Verify events were written as SSE
      expect(written).toHaveLength(3);
      expect(written[0]).toBe(`data: ${JSON.stringify(events[0])}\n\n`);
      expect(written[1]).toBe(`data: ${JSON.stringify(events[1])}\n\n`);
      expect(written[2]).toBe(`data: ${JSON.stringify(events[2])}\n\n`);

      // Verify stream ended
      expect(mockRes.end).toHaveBeenCalled();
    });

    it("writes error event when stream throws", async () => {
      mockQueryService.executeQueryStream.mockReturnValue(
        (async function* () {
          yield; // satisfy require-yield
          throw new Error("Provider crashed");
        })(),
      );

      const written: string[] = [];
      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn((data: string) => written.push(data)),
        end: jest.fn(),
      };

      await controller.streamQuery(
        mockRequest,
        { query: "Any query" },
        mockRes as any,
      );

      expect(written).toHaveLength(1);
      const errorEvent = JSON.parse(
        written[0].replace("data: ", "").replace("\n\n", ""),
      );
      expect(errorEvent.type).toBe("error");
      expect(errorEvent.message).toBe("An unexpected error occurred while processing your query.");
      expect(mockRes.end).toHaveBeenCalled();
    });

    it("handles non-Error throws in stream", async () => {
      mockQueryService.executeQueryStream.mockReturnValue(
        (async function* () {
          yield; // satisfy require-yield
          throw "String error";
        })(),
      );

      const written: string[] = [];
      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn((data: string) => written.push(data)),
        end: jest.fn(),
      };

      await controller.streamQuery(
        mockRequest,
        { query: "Any query" },
        mockRes as any,
      );

      const errorEvent = JSON.parse(
        written[0].replace("data: ", "").replace("\n\n", ""),
      );
      expect(errorEvent.type).toBe("error");
      expect(errorEvent.message).toBe("An unexpected error occurred while processing your query.");
    });

    it("passes query service the correct user ID", async () => {
      mockQueryService.executeQueryStream.mockReturnValue(
        (async function* () {})(),
      );

      const mockRes = {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
      };

      await controller.streamQuery(
        mockRequest,
        { query: "My spending?" },
        mockRes as any,
      );

      expect(mockQueryService.executeQueryStream).toHaveBeenCalledWith(
        "user-1",
        "My spending?",
      );
    });
  });
});
