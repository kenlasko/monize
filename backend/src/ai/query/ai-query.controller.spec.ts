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
        on: jest.fn(),
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
        on: jest.fn(),
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
      expect(errorEvent.message).toBe(
        "An unexpected error occurred while processing your query.",
      );
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
        on: jest.fn(),
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
      expect(errorEvent.message).toBe(
        "An unexpected error occurred while processing your query.",
      );
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
        on: jest.fn(),
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

    it("emits SSE comment heartbeats every 15s during quiet streams", async () => {
      // The Next.js dev proxy uses undici with a 5 min default bodyTimeout.
      // Heartbeats keep the upstream stream alive when the model is silent
      // for long stretches (e.g. CPU-only Ollama generating tokens).
      jest.useFakeTimers();
      try {
        // A stream that yields nothing for a while, then ends — gives the
        // heartbeat interval room to fire before the generator resolves.
        let resolveStream: () => void;
        const blocker = new Promise<void>((resolve) => {
          resolveStream = resolve;
        });
        mockQueryService.executeQueryStream.mockReturnValue(
          (async function* () {
            await blocker;
            if (false as boolean) yield { type: "noop" };
          })(),
        );

        const written: string[] = [];
        const mockRes = {
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
          write: jest.fn((data: string) => written.push(data)),
          end: jest.fn(),
          on: jest.fn(),
          writableEnded: false,
        };

        const streamPromise = controller.streamQuery(
          mockRequest,
          { query: "slow query" },
          mockRes as any,
        );

        // Advance through three heartbeat intervals (45 s)
        await jest.advanceTimersByTimeAsync(15_000);
        await jest.advanceTimersByTimeAsync(15_000);
        await jest.advanceTimersByTimeAsync(15_000);

        const heartbeatLines = written.filter((line) =>
          line.startsWith(": heartbeat"),
        );
        expect(heartbeatLines.length).toBeGreaterThanOrEqual(3);

        // Release the stream so the controller finishes
        resolveStream!();
        await streamPromise;
      } finally {
        jest.useRealTimers();
      }
    });

    it("clears the heartbeat interval after stream completes", async () => {
      jest.useFakeTimers();
      try {
        const events = [{ type: "content", text: "done" }];
        mockQueryService.executeQueryStream.mockReturnValue(
          (async function* () {
            for (const event of events) {
              yield event;
            }
          })(),
        );

        const written: string[] = [];
        const mockRes = {
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
          write: jest.fn((data: string) => written.push(data)),
          end: jest.fn(),
          on: jest.fn(),
          writableEnded: false,
        };

        await controller.streamQuery(
          mockRequest,
          { query: "fast" },
          mockRes as any,
        );

        // Advance well past the heartbeat interval; nothing new should be
        // written because the interval was cleared in the finally block.
        const writesBefore = written.length;
        await jest.advanceTimersByTimeAsync(60_000);
        expect(written.length).toBe(writesBefore);
      } finally {
        jest.useRealTimers();
      }
    });

    it("does not write a heartbeat after the response is ended", async () => {
      jest.useFakeTimers();
      try {
        let resolveStream: () => void;
        const blocker = new Promise<void>((resolve) => {
          resolveStream = resolve;
        });
        mockQueryService.executeQueryStream.mockReturnValue(
          (async function* () {
            await blocker;
            if (false as boolean) yield { type: "noop" };
          })(),
        );

        const written: string[] = [];
        const mockRes = {
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
          write: jest.fn((data: string) => written.push(data)),
          end: jest.fn(),
          on: jest.fn(),
          writableEnded: true, // simulate response already closed
        };

        const streamPromise = controller.streamQuery(
          mockRequest,
          { query: "slow" },
          mockRes as any,
        );

        await jest.advanceTimersByTimeAsync(30_000);
        // Heartbeat callback skips writing when writableEnded === true
        const heartbeatLines = written.filter((line) =>
          line.startsWith(": heartbeat"),
        );
        expect(heartbeatLines).toHaveLength(0);

        resolveStream!();
        await streamPromise;
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
