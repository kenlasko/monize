import {
  Controller,
  Logger,
  Post,
  Body,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiTags, ApiBearerAuth, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";
import { AiQueryService } from "./ai-query.service";
import { AiQueryDto } from "./dto/ai-query.dto";

@ApiTags("AI")
@Controller("ai")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AiQueryController {
  private readonly logger = new Logger(AiQueryController.name);

  constructor(private readonly queryService: AiQueryService) {}

  @Post("query")
  @ApiOperation({ summary: "Execute a natural language financial query" })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async query(
    @Request() req: { user: { id: string } },
    @Body() dto: AiQueryDto,
  ) {
    return this.queryService.executeQuery(req.user.id, dto.query);
  }

  @Post("query/stream")
  @ApiOperation({
    summary: "Execute a natural language financial query with SSE streaming",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async streamQuery(
    @Request() req: { user: { id: string } },
    @Body() dto: AiQueryDto,
    @Res() res: Response,
  ) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const streamStart = Date.now();
    const userId = req.user.id;
    this.logger.log(
      `SSE stream open user=${userId} queryLen=${dto.query.length}`,
    );

    const abortController = new AbortController();
    res.on("close", () => {
      if (!abortController.signal.aborted) {
        this.logger.warn(
          `SSE client disconnected user=${userId} after=${Date.now() - streamStart}ms`,
        );
      }
      abortController.abort();
    });

    // Send a periodic SSE comment as a keepalive. The Next.js dev proxy uses
    // undici, whose `bodyTimeout` defaults to 5 minutes — without this, an
    // idle interval (e.g. while a slow CPU model is generating tokens) will
    // terminate the upstream stream and surface as "Error in input stream"
    // in the browser. Comment lines (`: ...`) are silently ignored by SSE
    // consumers but reset the body timeout.
    const heartbeat = setInterval(() => {
      if (!abortController.signal.aborted && !res.writableEnded) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);

    let eventCount = 0;
    try {
      for await (const event of this.queryService.executeQueryStream(
        userId,
        dto.query,
      )) {
        if (abortController.signal.aborted) break;
        if (event) {
          eventCount++;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const rawMessage =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.error(
          `SSE query stream error user=${userId} after=${Date.now() - streamStart}ms events=${eventCount}: ${rawMessage}`,
          error instanceof Error ? error.stack : undefined,
        );
        res.write(
          `data: ${JSON.stringify({ type: "error", message: "An unexpected error occurred while processing your query." })}\n\n`,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }

    this.logger.log(
      `SSE stream close user=${userId} totalMs=${Date.now() - streamStart} events=${eventCount} aborted=${abortController.signal.aborted}`,
    );

    if (!abortController.signal.aborted) {
      res.end();
    }
  }
}
