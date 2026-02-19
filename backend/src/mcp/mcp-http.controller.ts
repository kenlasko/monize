import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  OnModuleDestroy,
} from "@nestjs/common";
import { ApiTags, ApiExcludeController } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { SetMetadata } from "@nestjs/common";
import { SKIP_PASSWORD_CHECK_KEY } from "../auth/guards/must-change-password.guard";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";
import { McpUserContext } from "./mcp-context";

const SkipPasswordCheck = () => SetMetadata(SKIP_PASSWORD_CHECK_KEY, true);

@ApiExcludeController()
@ApiTags("MCP")
@SkipCsrf()
@SkipThrottle()
@SkipPasswordCheck()
@Controller("mcp")
export class McpHttpController implements OnModuleDestroy {
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private sessionUsers = new Map<string, McpUserContext>();

  constructor(
    private readonly mcpServerService: McpServerService,
    private readonly patService: PatService,
  ) {
    this.mcpServerService.setUserContextResolver((sessionId?: string) => {
      if (!sessionId) return undefined;
      return this.sessionUsers.get(sessionId);
    });
  }

  onModuleDestroy() {
    for (const transport of this.transports.values()) {
      transport.close().catch(() => {});
    }
    this.transports.clear();
    this.sessionUsers.clear();
  }

  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const authResult = await this.validatePat(req);
    if (!authResult) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized" },
        id: null,
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId) {
      const transport = this.transports.get(sessionId);
      if (!transport) {
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32004, message: "Session not found" },
          id: null,
        });
        return;
      }
      const sessionUser = this.sessionUsers.get(sessionId);
      if (sessionUser?.userId !== authResult.userId) {
        res.status(403).json({
          jsonrpc: "2.0",
          error: { code: -32003, message: "Session user mismatch" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.transports.delete(sid);
        this.sessionUsers.delete(sid);
      }
    };

    await this.mcpServerService.getServer().connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      this.transports.set(transport.sessionId, transport);
      this.sessionUsers.set(transport.sessionId, {
        userId: authResult.userId,
        scopes: authResult.scopes,
      });
    }
  }

  @Get()
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session ID required" },
        id: null,
      });
      return;
    }

    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Session not found" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res);
  }

  @Delete()
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session ID required" },
        id: null,
      });
      return;
    }

    const transport = this.transports.get(sessionId);
    if (!transport) {
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Session not found" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res);
    this.transports.delete(sessionId);
    this.sessionUsers.delete(sessionId);
  }

  private async validatePat(req: Request): Promise<McpUserContext | null> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer pat_")) {
      return null;
    }

    try {
      const token = auth.substring(7);
      const result = await this.patService.validateToken(token);
      return { userId: result.userId, scopes: result.scopes };
    } catch {
      return null;
    }
  }
}
