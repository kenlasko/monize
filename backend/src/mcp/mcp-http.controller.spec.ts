import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { McpHttpController } from "./mcp-http.controller";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";
import { OAuthProviderService } from "../oauth/oauth-provider.service";

// Capture the options passed to each StreamableHTTPServerTransport so we can
// assert the transport is constructed in JSON-response mode (required for
// buffering ingresses like Cloudflare).
const mockTransportOptions: any[] = [];
jest.mock(
  "@modelcontextprotocol/sdk/server/streamableHttp.js",
  () => ({
    StreamableHTTPServerTransport: jest
      .fn()
      .mockImplementation((opts: any) => {
        mockTransportOptions.push(opts);
        return {
          sessionId: undefined,
          onclose: null,
          handleRequest: jest.fn().mockResolvedValue(undefined),
          close: jest.fn().mockResolvedValue(undefined),
        };
      }),
  }),
  { virtual: false },
);

describe("McpHttpController", () => {
  let controller: McpHttpController;
  let patService: Record<string, jest.Mock>;
  let mcpServerService: Record<string, jest.Mock>;
  let oauthProviderService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  beforeEach(async () => {
    patService = {
      validateToken: jest.fn(),
    };

    mcpServerService = {
      createServer: jest.fn().mockReturnValue({
        connect: jest.fn(),
      }),
    };

    oauthProviderService = {
      validateAccessToken: jest.fn().mockResolvedValue(null),
    };

    configService = {
      get: jest.fn().mockReturnValue("https://app.monize.test"),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpHttpController],
      providers: [
        { provide: McpServerService, useValue: mcpServerService },
        { provide: PatService, useValue: patService },
        { provide: OAuthProviderService, useValue: oauthProviderService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    controller = module.get<McpHttpController>(McpHttpController);
    mockTransportOptions.length = 0;
  });

  afterEach(() => {
    controller.onModuleDestroy();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("handlePost", () => {
    it("should reject requests without PAT", async () => {
      const req = {
        headers: {},
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Unauthorized" }),
        }),
      );
    });

    it("should reject requests with invalid PAT", async () => {
      patService.validateToken.mockRejectedValue(new Error("Invalid"));

      const req = {
        headers: { authorization: "Bearer pat_invalid" },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("should reject non-PAT bearer tokens", async () => {
      const req = {
        headers: { authorization: "Bearer jwt_token_here" },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it("emits WWW-Authenticate header with resource_metadata on 401", async () => {
      const req = { headers: {}, body: {} } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.setHeader).toHaveBeenCalledWith(
        "WWW-Authenticate",
        expect.stringContaining("/.well-known/oauth-protected-resource"),
      );
    });

    it("accepts OAuth bearer tokens validated by the provider", async () => {
      oauthProviderService.validateAccessToken.mockResolvedValue({
        userId: "oauth-user-1",
        scopes: "monize:read",
      });

      const req = {
        headers: {
          authorization: "Bearer abc123opaque",
          accept: "application/json, text/event-stream",
        },
        body: { jsonrpc: "2.0", method: "initialize", id: 1 },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
        on: jest.fn(),
      } as any;

      // The transport requires a real handleRequest; just confirm we got past
      // auth (i.e. no 401 + setHeader call for WWW-Authenticate).
      try {
        await controller.handlePost(req, res);
      } catch {
        // Transport may throw because we're not providing a full mock; auth
        // path is what we're testing here.
      }

      expect(oauthProviderService.validateAccessToken).toHaveBeenCalledWith(
        "abc123opaque",
      );
      expect(res.setHeader).not.toHaveBeenCalledWith(
        "WWW-Authenticate",
        expect.anything(),
      );
    });

    it("constructs the transport in JSON-response mode for buffering proxies", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          accept: "application/json, text/event-stream",
        },
        body: { jsonrpc: "2.0", method: "initialize", id: 1 },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
        on: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(mockTransportOptions).toHaveLength(1);
      expect(mockTransportOptions[0].enableJsonResponse).toBe(true);
      expect(typeof mockTransportOptions[0].sessionIdGenerator).toBe(
        "function",
      );
    });

    it("should return 404 for an expired session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "expired-post-session";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(
        sessionId,
        Date.now() - 3_600_001,
      );

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session expired" }),
        }),
      );
    });

    it("should return 429 when per-user session limit is reached", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-flood",
        scopes: "read",
      });

      // Populate 10 active sessions for the same user
      for (let i = 0; i < 10; i++) {
        const sid = `flood-session-${i}`;
        const mockTransport = {
          sessionId: sid,
          onclose: null as any,
          handleRequest: jest.fn(),
          close: jest.fn().mockResolvedValue(undefined),
        };
        (controller as any).transports.set(sid, mockTransport);
        (controller as any).servers.set(sid, {});
        (controller as any).sessionUsers.set(sid, {
          userId: "user-flood",
          scopes: "read",
        });
        (controller as any).sessionCreatedAt.set(sid, Date.now());
      }

      // Attempt to create an 11th session (POST without mcp-session-id)
      const req = {
        headers: { authorization: "Bearer pat_test" },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: "Too many active sessions. Close existing sessions first.",
          }),
        }),
      );
    });
  });

  describe("handleGet", () => {
    it("should reject requests without PAT", async () => {
      const req = { headers: {} } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Unauthorized" }),
        }),
      );
    });

    it("should reject requests without session ID", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: { authorization: "Bearer pat_test" },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should reject requests with unknown session ID", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": "unknown-session",
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it("should return 404 for an expired session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "expired-get-session";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(
        sessionId,
        Date.now() - 3_600_001,
      );

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session expired" }),
        }),
      );
    });

    it("should reject when session user does not match authenticated user", async () => {
      // First, set up a session by calling handlePost with user-1
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "test-session-id";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      // Directly populate the private maps via any-cast
      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      // Now try GET with a different user
      patService.validateToken.mockResolvedValue({
        userId: "user-2",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session user mismatch" }),
        }),
      );
    });
  });

  describe("handleDelete", () => {
    it("should reject requests without PAT", async () => {
      const req = { headers: {} } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Unauthorized" }),
        }),
      );
    });

    it("should reject requests without session ID", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: { authorization: "Bearer pat_test" },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it("should return 404 for an expired session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "expired-delete-session";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(
        sessionId,
        Date.now() - 3_600_001,
      );

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session expired" }),
        }),
      );
    });

    it("should reject when session user does not match authenticated user", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "delete-session-id";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };

      // Directly populate the private maps via any-cast
      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      // Now try DELETE with a different user
      patService.validateToken.mockResolvedValue({
        userId: "user-2",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session user mismatch" }),
        }),
      );
    });
  });

  describe("onModuleDestroy", () => {
    it("should clean up transports", () => {
      controller.onModuleDestroy();
      // Should not throw
    });

    it("closes all open transports on destroy", () => {
      const close1 = jest.fn().mockResolvedValue(undefined);
      const close2 = jest.fn().mockResolvedValue(undefined);
      (controller as any).transports.set("a", { close: close1 });
      (controller as any).transports.set("b", { close: close2 });
      (controller as any).servers.set("a", {});
      (controller as any).sessionUsers.set("a", { userId: "u", scopes: "" });
      (controller as any).sessionCreatedAt.set("a", Date.now());

      controller.onModuleDestroy();

      expect(close1).toHaveBeenCalled();
      expect(close2).toHaveBeenCalled();
      expect((controller as any).transports.size).toBe(0);
      expect((controller as any).servers.size).toBe(0);
      expect((controller as any).sessionUsers.size).toBe(0);
      expect((controller as any).sessionCreatedAt.size).toBe(0);
    });
  });

  describe("handlePost session lookup branches", () => {
    it("returns 404 when supplied mcp-session-id has no transport", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": "no-such-session",
        },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session not found" }),
        }),
      );
    });

    it("returns 403 when authenticated user does not own the session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-other",
        scopes: "read",
      });

      const sessionId = "post-mismatch";
      const mockTransport = {
        sessionId,
        onclose: null as any,
        handleRequest: jest.fn(),
        close: jest.fn().mockResolvedValue(undefined),
      };
      (controller as any).transports.set(sessionId, mockTransport);
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
        body: {},
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockTransport.handleRequest).not.toHaveBeenCalled();
    });

    it("delegates to transport.handleRequest for an existing valid session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "post-valid";
      const handleRequest = jest.fn().mockResolvedValue(undefined);
      (controller as any).transports.set(sessionId, {
        sessionId,
        handleRequest,
        close: jest.fn().mockResolvedValue(undefined),
      });
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
        body: { hello: "rpc" },
      } as any;
      const res = {} as any;

      await controller.handlePost(req, res);

      expect(handleRequest).toHaveBeenCalledWith(req, res, req.body);
    });
  });

  describe("handleGet success branch", () => {
    it("delegates to transport.handleRequest when session is valid", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "get-valid";
      const handleRequest = jest.fn().mockResolvedValue(undefined);
      (controller as any).transports.set(sessionId, {
        sessionId,
        handleRequest,
        close: jest.fn().mockResolvedValue(undefined),
      });
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {} as any;

      await controller.handleGet(req, res);

      expect(handleRequest).toHaveBeenCalledWith(req, res);
    });
  });

  describe("handleDelete additional branches", () => {
    it("returns 404 when delete targets an unknown session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": "missing",
        },
      } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: "Session not found" }),
        }),
      );
    });

    it("calls transport.handleRequest then destroys the session on success", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "user-1",
        scopes: "read",
      });

      const sessionId = "delete-valid";
      const handleRequest = jest.fn().mockResolvedValue(undefined);
      const close = jest.fn().mockResolvedValue(undefined);
      (controller as any).transports.set(sessionId, {
        sessionId,
        handleRequest,
        close,
      });
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: "user-1",
        scopes: "read",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      const req = {
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
      } as any;
      const res = {} as any;

      await controller.handleDelete(req, res);

      expect(handleRequest).toHaveBeenCalledWith(req, res);
      expect((controller as any).transports.has(sessionId)).toBe(false);
      expect((controller as any).sessionUsers.has(sessionId)).toBe(false);
    });
  });

  describe("cleanupExpiredSessions()", () => {
    it("removes sessions older than the TTL and keeps fresh ones", () => {
      const fresh = "fresh-session";
      const stale = "stale-session";
      const freshClose = jest.fn().mockResolvedValue(undefined);
      const staleClose = jest.fn().mockResolvedValue(undefined);

      (controller as any).transports.set(fresh, { close: freshClose });
      (controller as any).transports.set(stale, { close: staleClose });
      (controller as any).servers.set(fresh, {});
      (controller as any).servers.set(stale, {});
      (controller as any).sessionUsers.set(fresh, {
        userId: "u",
        scopes: "",
      });
      (controller as any).sessionUsers.set(stale, {
        userId: "u",
        scopes: "",
      });
      (controller as any).sessionCreatedAt.set(fresh, Date.now());
      (controller as any).sessionCreatedAt.set(stale, Date.now() - 3_700_000);

      (controller as any).cleanupExpiredSessions();

      expect(staleClose).toHaveBeenCalled();
      expect((controller as any).transports.has(stale)).toBe(false);
      expect((controller as any).transports.has(fresh)).toBe(true);
      expect(freshClose).not.toHaveBeenCalled();
    });
  });
});
