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
import {
  AiQueryService,
  DELEGATE_ALLOWED_AI_TOOLS,
  QueryRunOptions,
} from "./ai-query.service";
import { AiQueryDto } from "./dto/ai-query.dto";
import { tr } from "../../i18n/translate";
import { SSE_HEADERS, sseData } from "../../common/sse.util";
import {
  AllowDelegate,
  DelegateRequiresFullScope,
  DelegateRequiresSection,
} from "../../delegation/decorators/delegate-access.decorator";
import { AllowPat } from "../../auth/pat-access/pat-access.decorator";

@ApiTags("AI")
@AllowPat()
@Controller("ai")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
// The AI assistant is a read-only "ai" section for delegates: the query
// endpoints only read the owner's data (effective-user scoping) using the
// owner's configured provider. Reachable only with the "ai" grant.
@DelegateRequiresSection("ai")
// ...and only for a delegate who can read the whole ledger: the answer draws
// on every account and section and is not narrowed to the delegate's grants.
@DelegateRequiresFullScope()
export class AiQueryController {
  private readonly logger = new Logger(AiQueryController.name);

  constructor(private readonly queryService: AiQueryService) {}

  /** An acting delegate (`id` = owner, `realUserId` = delegate) may use only the allow-listed read tools. */
  private runOptions(user: {
    id: string;
    realUserId?: string;
  }): QueryRunOptions | undefined {
    return user.realUserId && user.realUserId !== user.id
      ? { allowTools: DELEGATE_ALLOWED_AI_TOOLS }
      : undefined;
  }

  @Post("query")
  @AllowDelegate()
  @ApiOperation({ summary: "Execute a natural language financial query" })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async query(
    @Request() req: { user: { id: string; realUserId?: string } },
    @Body() dto: AiQueryDto,
  ) {
    return this.queryService.executeQuery(
      req.user.id,
      dto.query,
      dto.conversationHistory,
      dto.attachments,
      this.runOptions(req.user),
    );
  }

  @Post("query/stream")
  @AllowDelegate()
  @ApiOperation({
    summary: "Execute a natural language financial query with SSE streaming",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async streamQuery(
    @Request() req: { user: { id: string; realUserId?: string } },
    @Body() dto: AiQueryDto,
    @Res() res: Response,
  ) {
    for (const [header, value] of Object.entries(SSE_HEADERS)) {
      res.setHeader(header, value);
    }
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
        dto.conversationHistory,
        dto.attachments,
        this.runOptions(req.user),
      )) {
        if (abortController.signal.aborted) break;
        if (event) {
          eventCount++;
          // Events carry user-controlled text (the prompt, tool output);
          // sseData escapes markup characters before they reach the socket.
          res.write(sseData(event));
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
        const message = tr(
          "errors.ai.queryStreamFailed",
          "An unexpected error occurred while processing your query.",
        );
        res.write(sseData({ type: "error", message }));
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
