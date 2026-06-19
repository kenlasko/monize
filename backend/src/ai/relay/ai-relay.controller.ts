import {
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Request,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { AiRelayService } from "./ai-relay.service";
import { RelayQueryDto } from "./dto/relay-query.dto";
import { RelayTunnelStatus } from "./ai-relay.types";
import { tr } from "../../i18n/translate";

/**
 * Browser side of the reverse MCP relay. The chat posts a prompt here; the
 * request is held open (SSE) until the user's MCP agent answers it through the
 * post_response tool, or it times out. Status is exposed for the tunnel
 * indicator. The agent side lives in the MCP relay tools.
 */
@ApiTags("AI")
@ApiBearerAuth()
@Controller("ai/relay")
@UseGuards(AuthGuard("jwt"))
export class AiRelayController {
  private readonly logger = new Logger(AiRelayController.name);

  constructor(private readonly relayService: AiRelayService) {}

  @Get("status")
  @ApiOperation({ summary: "Reverse MCP relay tunnel status" })
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  status(@Request() req: { user: { id: string } }): RelayTunnelStatus {
    return this.relayService.getStatus(req.user.id);
  }

  @Post("query/stream")
  @ApiOperation({
    summary: "Send a chat prompt to the user's MCP agent and stream the answer",
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async streamQuery(
    @Request() req: { user: { id: string } },
    @Body() dto: RelayQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const userId = req.user.id;
    const start = Date.now();

    const aborted = { value: false };
    res.on("close", () => {
      aborted.value = true;
    });

    // Keepalive: a parked agent may take minutes to answer; comment lines reset
    // proxy body timeouts without disturbing SSE consumers.
    const heartbeat = setInterval(() => {
      if (!aborted.value && !res.writableEnded) {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);

    const write = (event: Record<string, unknown>): void => {
      if (!aborted.value && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    try {
      const history = (dto.conversationHistory ?? []).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await this.relayService.enqueuePrompt(
        userId,
        dto.query,
        history,
        // Lets a write tool render its confirmation card in this browser stream
        // while the agent is still working on the prompt.
        write,
      );
      // Emit `content` (not `assistant_text`): the chat store treats
      // assistant_text as ephemeral "thinking" text and only `content` creates
      // the persisted assistant message, so the answer must arrive as content.
      write({ type: "content", text: response.text });
      write({ type: "done" });
    } catch (error) {
      const rawMessage =
        error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Relay stream failed user=${userId} after=${Date.now() - start}ms: ${rawMessage}`,
      );
      const message = tr(
        "errors.ai.relayTimeout",
        "Your assistant did not respond. Make sure your MCP agent is connected and listening.",
      );
      write({ type: "error", message });
    } finally {
      clearInterval(heartbeat);
      if (!aborted.value && !res.writableEnded) {
        res.end();
      }
    }
  }
}
