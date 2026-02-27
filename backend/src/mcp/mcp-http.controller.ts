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
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
@SkipPasswordCheck()
@Controller("mcp")
export class McpHttpController implements OnModuleDestroy {
  private static readonly SESSION_TTL_MS = 3_600_000; // 1 hour
  private static readonly MAX_SESSIONS_PER_USER = 10;
  private static readonly CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

  private transports = new Map<string, StreamableHTTPServerTransport>();
  private servers = new Map<string, McpServer>();
  private sessionUsers = new Map<string, McpUserContext>();
  private sessionCreatedAt = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly mcpServerService: McpServerService,
    private readonly patService: PatService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredSessions(),
      McpHttpController.CLEANUP_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    for (const transport of this.transports.values()) {
      transport.close().catch(() => {});
    }
    this.transports.clear();
    this.servers.clear();
    this.sessionUsers.clear();
    this.sessionCreatedAt.clear();
  }

  private cleanupExpiredSessions() {
    const now = Date.now();
    for (const [sid, createdAt] of this.sessionCreatedAt.entries()) {
      if (now - createdAt > McpHttpController.SESSION_TTL_MS) {
        const transport = this.transports.get(sid);
        if (transport) transport.close().catch(() => {});
        this.transports.delete(sid);
        this.servers.delete(sid);
        this.sessionUsers.delete(sid);
        this.sessionCreatedAt.delete(sid);
      }
    }
  }

  private getUserSessionCount(userId: string): number {
    let count = 0;
    for (const ctx of this.sessionUsers.values()) {
      if (ctx.userId === userId) count++;
    }
    return count;
  }

  private isSessionExpired(sessionId: string): boolean {
    const createdAt = this.sessionCreatedAt.get(sessionId);
    if (!createdAt) return true;
    return Date.now() - createdAt > McpHttpController.SESSION_TTL_MS;
  }

  @Post()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
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
      if (this.isSessionExpired(sessionId)) {
        this.destroySession(sessionId);
        res.status(404).json({
          jsonrpc: "2.0",
          error: { code: -32004, message: "Session expired" },
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

    // Enforce per-user session limit
    if (
      this.getUserSessionCount(authResult.userId) >=
      McpHttpController.MAX_SESSIONS_PER_USER
    ) {
      res.status(429).json({
        jsonrpc: "2.0",
        error: {
          code: -32005,
          message: "Too many active sessions. Close existing sessions first.",
        },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.destroySession(sid);
      }
    };

    const resolve = (sessionId?: string) => {
      if (!sessionId) return undefined;
      return this.sessionUsers.get(sessionId);
    };
    const server = this.mcpServerService.createServer(resolve);
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    if (transport.sessionId) {
      this.transports.set(transport.sessionId, transport);
      this.servers.set(transport.sessionId, server);
      this.sessionUsers.set(transport.sessionId, {
        userId: authResult.userId,
        scopes: authResult.scopes,
      });
      this.sessionCreatedAt.set(transport.sessionId, Date.now());
    }
  }

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handleGet(@Req() req: Request, @Res() res: Response) {
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

    if (this.isSessionExpired(sessionId)) {
      this.destroySession(sessionId);
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Session expired" },
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

    await transport.handleRequest(req, res);
  }

  @Delete()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handleDelete(@Req() req: Request, @Res() res: Response) {
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

    if (this.isSessionExpired(sessionId)) {
      this.destroySession(sessionId);
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32004, message: "Session expired" },
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

    await transport.handleRequest(req, res);
    this.destroySession(sessionId);
  }

  private destroySession(sessionId: string) {
    const transport = this.transports.get(sessionId);
    if (transport) transport.close().catch(() => {});
    this.transports.delete(sessionId);
    this.servers.delete(sessionId);
    this.sessionUsers.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
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
