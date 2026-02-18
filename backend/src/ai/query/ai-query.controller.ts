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

    try {
      for await (const event of this.queryService.executeQueryStream(
        req.user.id,
        dto.query,
      )) {
        if (event) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      }
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.error(`SSE query stream error: ${rawMessage}`);
      res.write(
        `data: ${JSON.stringify({ type: "error", message: "An unexpected error occurred while processing your query." })}\n\n`,
      );
    }

    res.end();
  }
}
