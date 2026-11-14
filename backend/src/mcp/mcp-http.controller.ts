import {
  Controller,
  Post,
  Get,
  Delete,
  Logger,
  Req,
  Res,
  OnModuleDestroy,
} from "@nestjs/common";
import { ApiTags, ApiExcludeController } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request, Response } from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import {
  NodeStreamableHTTPServerTransport,
  toNodeHandler,
  toWebRequest,
} from "@modelcontextprotocol/node";
import { SkipCsrf } from "../common/decorators/skip-csrf.decorator";
import { PatSelfAuthenticated } from "../auth/pat-access/pat-access.decorator";
import { SetMetadata } from "@nestjs/common";
import { SKIP_PASSWORD_CHECK_KEY } from "../auth/guards/must-change-password.guard";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";
import { McpUserContext, toAuthInfo } from "./mcp-context";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { ConfigService } from "@nestjs/config";
import { withUserContext } from "../common/db/with-context";

const SkipPasswordCheck = () => SetMetadata(SKIP_PASSWORD_CHECK_KEY, true);

/**
 * RLS: this transport is bearer-authenticated with no JWT guard, so `req.user`
 * is never set and `RequestContextInterceptor` enters its ALS scope with an
 * **undefined** userId. Every tool handler therefore reaches the domain services
 * with no ambient identity, and `withScopedDb` refuses to run without one. Each
 * `transport.handleRequest` is wrapped in `withUserContext(authResult.userId)`
 * so the request's authenticated user is the ambient identity for the whole
 * JSON-RPC exchange, including the tool handlers it dispatches.
 *
 * This is the MCP counterpart of what the interceptor does for cookie/JWT
 * routes; the id comes from `validatePat` (PAT or OAuth access token), never
 * from tool arguments. The same validated credential is attached to the
 * request as the SDK's `AuthInfo`, which is how a tool handler learns who is
 * calling (`resolveUserContext`) -- identity is a property of the request, not
 * of a session. Individual tools may still re-seed the same id locally
 * (see `transactions.tool.ts`) -- a nested seed of the same user is a no-op.
 */
@ApiExcludeController()
@ApiTags("MCP")
@SkipCsrf()
@SkipPasswordCheck()
@PatSelfAuthenticated()
@Controller("mcp")
export class McpHttpController implements OnModuleDestroy {
  private static readonly SESSION_TTL_MS = 3_600_000; // 1 hour
  private static readonly MAX_SESSIONS_PER_USER = 10;
  private static readonly CLEANUP_INTERVAL_MS = 300_000; // 5 minutes

  private readonly logger = new Logger(McpHttpController.name);

  /**
   * The 2026-07-28 leg. `legacy: "reject"` makes it modern-only: 2025-era
   * traffic is routed to the sessionful path below instead of to the SDK's
   * stateless fallback, which would answer an elicitation-shaped confirmation
   * from an instance that holds nothing between rounds.
   */
  private readonly modern = createMcpHandler(
    () => this.mcpServerService.createServer(),
    {
      legacy: "reject",
      onerror: (error) =>
        this.logger.warn(`MCP request failed: ${error.message}`),
    },
  );
  private modernNode = toNodeHandler(this.modern, {
    onerror: (error) =>
      this.logger.warn(`MCP request could not be served: ${error.message}`),
  });

  /**
   * A 2025-era session lives in THIS process and cannot be moved to another.
   *
   * These four maps are process-local on purpose, not for want of a table. The
   * SDK (`@modelcontextprotocol/{server,node}` 2.0.0) gives a session id no way
   * back in: `NodeStreamableHTTPServerTransport.sessionId` is a getter with no
   * setter, `_initialized` is private and set only by handling an `initialize`
   * request, and `validateSession` answers `400 Bad Request: Server not
   * initialized` to every non-initialize request that reaches a transport which
   * has not seen one. So a replica cannot rebuild a transport from a persisted
   * `session_id -> user_id` row, and persisting one would buy nothing anyway:
   * the live state of a 2025-era exchange is the open SSE stream bound to this
   * pod's socket (`_streamMapping`), the `Protocol._responseHandlers` entry
   * holding the promise a `confirmWrite` elicitation is waiting on, and the
   * per-`McpServer` behaviour record in `mcp-elicitation-support.ts`. None of
   * those is addressable by a session id.
   *
   * Under `CLUSTER_MODE=multi` that makes sticky routing on the MCP path a
   * deployment requirement for 2025-era clients, not an optimization
   * (`helm/README.md`, `docs/backend/mcp.md`). Without it a session id lands on
   * the wrong replica and is answered `404 Session not found`, which the spec
   * requires a client to recover from by re-initializing -- reads recover, but
   * an in-flight confirmation does not: its answer never reaches the pod that
   * asked, that pod's wait expires, and `clientAnsweredForItself` reads the
   * timeout as `"unsupported"` and lets the write proceed under the client's own
   * approval prompt.
   *
   * The 2026-07-28 leg has none of this: no session, no server-side wait, and a
   * fresh server per request, so it is replica-agnostic as it stands.
   */
  private transports = new Map<string, NodeStreamableHTTPServerTransport>();
  private servers = new Map<string, McpServer>();
  private sessionUsers = new Map<string, McpUserContext>();
  private sessionCreatedAt = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly mcpServerService: McpServerService,
    private readonly patService: PatService,
    private readonly oauthProviderService: OAuthProviderService,
    private readonly configService: ConfigService,
  ) {
    this.cleanupTimer = setInterval(
      () => this.cleanupExpiredSessions(),
      McpHttpController.CLEANUP_INTERVAL_MS,
    );
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    void this.modern.close();
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
    for (const bound of this.sessionUsers.values()) {
      if (bound.userId === userId) count++;
    }
    return count;
  }

  private isSessionExpired(sessionId: string): boolean {
    const createdAt = this.sessionCreatedAt.get(sessionId);
    if (!createdAt) return true;
    return Date.now() - createdAt > McpHttpController.SESSION_TTL_MS;
  }

  /**
   * Authorize an existing session against the credential presented on THIS
   * request, and re-bind the session's authorization to it.
   *
   * The session used to be accepted whenever the current token's `userId`
   * matched the cached one, while tools kept reading the scopes captured when
   * the session was created. Two consequences, both live (P2-004): a read-only
   * PAT that presented the session id of a session opened with a write PAT was
   * authorized for every mutating tool, and revoking the creating token left the
   * session usable until its TTL expired as long as the user still held any
   * valid token.
   *
   * So: the credential must be the same one (matching users is not enough --
   * one user holds many tokens with different scopes), and the scopes the tools
   * see are replaced by the ones the presented token carries right now. A
   * narrowed token narrows the session immediately; it never widens it back,
   * because a session may only ever be used by the credential that created it.
   *
   * Returns false when the request has been answered and must not proceed.
   */
  private authorizeExistingSession(
    sessionId: string,
    authResult: McpUserContext,
    res: Response,
  ): boolean {
    const sessionUser = this.sessionUsers.get(sessionId);
    if (
      sessionUser?.userId !== authResult.userId ||
      !sessionUser.credentialId ||
      !authResult.credentialId ||
      sessionUser.credentialId !== authResult.credentialId
    ) {
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Session credential mismatch" },
        id: null,
      });
      return false;
    }

    // Adopt the presented token's current authorization state. Immutable
    // replacement rather than a mutation of the object the tools hold.
    this.sessionUsers.set(sessionId, {
      userId: authResult.userId,
      scopes: authResult.scopes,
      credentialId: authResult.credentialId,
    });
    return true;
  }

  /**
   * Validate the request's bearer token and attach the identity the SDK gives
   * every handler as `ctx.http.authInfo`.
   *
   * This is where INV-MCP-001 becomes a property of the REQUEST: the credential
   * presented on this request decides the user and the scopes, on both protocol
   * eras, and no tool reads identity from a session. A session (2025-era only)
   * is additionally bound to the credential that opened it, below.
   *
   * Returns null when the request has been answered and must not proceed.
   */
  private async authorize(
    req: Request,
    res: Response,
  ): Promise<McpUserContext | null> {
    const authResult = await this.validatePat(req);
    if (!authResult) {
      this.sendUnauthorized(res);
      return null;
    }
    const authInfo = toAuthInfo(authResult, this.bearerToken(req));
    if (!authInfo) {
      // An OAuth grant with no id cannot be bound to a session or to a
      // confirmation, and an unbindable credential must not be served.
      res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Credential cannot be identified" },
        id: null,
      });
      return null;
    }
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    return authResult;
  }

  /**
   * Which protocol era this request belongs to.
   *
   * The SDK's own predicate rather than a header check, because its ladder has
   * rungs a header check cannot reproduce: a malformed envelope behind a
   * present claim, a `MCP-Protocol-Version` header naming a modern revision
   * with no envelope, and header/body mismatches are all answered BY THE MODERN
   * PATH, with modern error codes. Anything it classifies as not-legacy that
   * reached the sessionful transport instead would be answered in the wrong
   * shape.
   *
   * `req.body` is the JSON Express already parsed, so the conversion reads
   * nothing from the stream and the sessionful transport still gets its body.
   */
  private async isLegacy(req: Request): Promise<boolean> {
    return isLegacyRequest(await toWebRequest(req, req.body), req.body);
  }

  private bearerToken(req: Request): string {
    const auth = req.headers.authorization ?? "";
    return auth.startsWith("Bearer ") ? auth.substring(7) : "";
  }

  // A 2026-07-28 client spends more requests for the same work than a 2025-era
  // one: `server/discover` on connect, and a confirmed write is two `tools/call`
  // POSTs rather than one call plus a server-initiated dialog.
  @Post()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async handlePost(@Req() req: Request, @Res() res: Response) {
    const authResult = await this.authorize(req, res);
    if (!authResult) return;

    if (!(await this.isLegacy(req))) {
      await withUserContext(authResult.userId, () =>
        this.modernNode(req, res, req.body),
      );
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
      if (!this.authorizeExistingSession(sessionId, authResult, res)) {
        return;
      }
      await withUserContext(authResult.userId, () =>
        transport.handleRequest(req, res, req.body),
      );
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

    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.destroySession(sid);
      }
    };

    const server = this.mcpServerService.createServer();
    await server.connect(transport);
    await withUserContext(authResult.userId, () =>
      transport.handleRequest(req, res, req.body),
    );

    if (transport.sessionId) {
      this.transports.set(transport.sessionId, transport);
      this.servers.set(transport.sessionId, server);
      this.sessionUsers.set(transport.sessionId, {
        userId: authResult.userId,
        scopes: authResult.scopes,
        credentialId: authResult.credentialId,
      });
      this.sessionCreatedAt.set(transport.sessionId, Date.now());
    }
  }

  @Get()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handleGet(@Req() req: Request, @Res() res: Response) {
    const authResult = await this.authorize(req, res);
    if (!authResult) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      this.sendNoSessionStream(res);
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

    if (!this.authorizeExistingSession(sessionId, authResult, res)) {
      return;
    }

    await withUserContext(authResult.userId, () =>
      transport.handleRequest(req, res),
    );
  }

  @Delete()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async handleDelete(@Req() req: Request, @Res() res: Response) {
    const authResult = await this.authorize(req, res);
    if (!authResult) return;

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId) {
      this.sendNoSessionStream(res);
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

    if (!this.authorizeExistingSession(sessionId, authResult, res)) {
      return;
    }

    await withUserContext(authResult.userId, () =>
      transport.handleRequest(req, res),
    );
    this.destroySession(sessionId);
  }

  /**
   * GET and DELETE are 2025-era session operations: the standalone stream and
   * the session's own end. The 2026-07-28 revision has neither -- there is no
   * session to address and no standalone stream to open -- so without a session
   * id there is nothing here to answer, on either era.
   */
  private sendNoSessionStream(res: Response): void {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32600,
        message:
          "Method not allowed: this endpoint answers POST. The 2026-07-28 revision has no session stream.",
      },
      id: null,
    });
  }

  private destroySession(sessionId: string) {
    const transport = this.transports.get(sessionId);
    // Delete from maps BEFORE calling close() to prevent re-entrant loop:
    // close() fires transport.onclose → destroySession() → close() → stack overflow
    this.transports.delete(sessionId);
    this.servers.delete(sessionId);
    this.sessionUsers.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
    if (transport) transport.close().catch(() => {});
  }

  private async validatePat(req: Request): Promise<McpUserContext | null> {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return null;
    }
    const token = auth.substring(7);

    // PAT bearer tokens (legacy / advanced users)
    if (token.startsWith("pat_")) {
      try {
        const result = await this.patService.validateToken(token);
        return {
          userId: result.userId,
          scopes: result.scopes,
          credentialId: `pat:${result.tokenId}`,
        };
      } catch {
        return null;
      }
    }

    // OAuth 2.1 access tokens (issued via /oauth for MCP clients like
    // Claude Desktop's "Add Connector" flow). Audience-bound to the MCP
    // resource URL by the provider's resourceIndicators config.
    const oauthResult =
      await this.oauthProviderService.validateAccessToken(token);
    if (oauthResult) {
      return {
        userId: oauthResult.userId,
        scopes: oauthResult.scopes,
        // A grant with no id cannot be bound, and an unbindable credential must
        // not be able to open a session that a later request could match by
        // user alone -- refuse it here rather than mint one.
        credentialId: oauthResult.grantId
          ? `oauth:${oauthResult.grantId}`
          : undefined,
      };
    }

    return null;
  }

  private sendUnauthorized(res: Response): void {
    const publicUrl =
      this.configService.get<string>("PUBLIC_APP_URL")?.replace(/\/$/, "") ??
      "";
    const resourceMetadata = `${publicUrl}/.well-known/oauth-protected-resource`;
    res.setHeader(
      "WWW-Authenticate",
      `Bearer realm="monize", resource_metadata="${resourceMetadata}"`,
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }
}
