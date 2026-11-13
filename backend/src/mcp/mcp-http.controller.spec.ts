import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { McpHttpController } from "./mcp-http.controller";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";
import { PAT_SELF_AUTHENTICATED_KEY } from "../auth/pat-access/pat-access.decorator";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";

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
  });

  afterEach(() => {
    controller.onModuleDestroy();
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  // A security scan reported the server answering 200 to an invalid token. The
  // cause was the frontend proxy, which did not recognise a bearer-only request
  // to the bare origin as MCP traffic and let the app shell answer it
  // (frontend/src/proxy.ts). This endpoint has always refused these, on every
  // verb -- so that claim is checked here rather than left as a comment.
  it("is marked @PatSelfAuthenticated() so PatAccessGuard stands aside", () => {
    expect(
      Reflect.getMetadata(PAT_SELF_AUTHENTICATED_KEY, McpHttpController),
    ).toBe(true);
  });

  describe("malformed and unknown Authorization headers", () => {
    const cases: Array<[string, Record<string, string>]> = [
      ["no Authorization header", {}],
      ["a bare scheme", { authorization: "Bearer" }],
      ["an empty token", { authorization: "Bearer " }],
      ["a whitespace token", { authorization: "Bearer    " }],
      ["the wrong scheme", { authorization: "Basic dXNlcjpwYXNz" }],
      ["a lowercase scheme", { authorization: "bearer pat_whatever" }],
      ["an unknown PAT", { authorization: "Bearer pat_does_not_exist" }],
      ["an unknown OAuth token", { authorization: "Bearer eyJhbGciOiJIUzI1" }],
      ["a token that is only punctuation", { authorization: "Bearer ...." }],
    ];

    const verbs: Array<["handlePost" | "handleGet" | "handleDelete", string]> =
      [
        ["handlePost", "POST"],
        ["handleGet", "GET"],
        ["handleDelete", "DELETE"],
      ];

    describe.each(verbs)("%s", (method, verb) => {
      it.each(cases)(`refuses ${verb} with %s`, async (_label, headers) => {
        patService.validateToken.mockRejectedValue(new Error("Invalid"));
        oauthProviderService.validateAccessToken.mockResolvedValue(null);

        const req = { headers, body: {} } as any;
        const res = {
          status: jest.fn().mockReturnThis(),
          json: jest.fn(),
          setHeader: jest.fn(),
        } as any;

        await controller[method](req, res);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: expect.objectContaining({ message: "Unauthorized" }),
          }),
        );
        // RFC 9728: the refusal names where to get a token, so a client can
        // start the OAuth flow rather than guessing.
        expect(res.setHeader).toHaveBeenCalledWith(
          "WWW-Authenticate",
          expect.stringContaining("resource_metadata="),
        );
      });
    });
  });

  // One endpoint serves both revisions. The routing decision is the SDK's own
  // predicate, and everything it does not classify as legacy must reach the
  // modern handler -- that path owns the modern error answers, so a request
  // sent to the sessionful transport instead would be refused in the wrong
  // shape and never reach a tool.
  describe("protocol era routing", () => {
    const PAT = {
      userId: "11111111-1111-4111-8111-111111111111",
      scopes: "read",
      tokenId: "tok-a",
    };

    function mockRes() {
      return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      } as any;
    }

    // The sessionful path hands the request to the real SDK transport, which
    // writes to the Node response rather than through Express's helpers.
    function mockNodeRes() {
      return {
        ...mockRes(),
        writeHead: jest.fn().mockReturnThis(),
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        on: jest.fn(),
        once: jest.fn(),
        removeListener: jest.fn(),
        destroyed: false,
        headersSent: false,
      } as any;
    }

    let modernNode: jest.Mock;

    beforeEach(() => {
      patService.validateToken.mockResolvedValue(PAT);
      modernNode = jest.fn().mockResolvedValue(undefined);
      (controller as any).modernNode = modernNode;
    });

    it("serves a 2026-07-28 request from the modern handler, with its authInfo", async () => {
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
        },
      };
      const req = {
        method: "POST",
        url: "/api/v1/mcp",
        headers: {
          authorization: "Bearer pat_test",
          "content-type": "application/json",
          "mcp-method": "tools/list",
        },
        body,
      } as any;
      const res = mockRes();

      await controller.handlePost(req, res);

      expect(modernNode).toHaveBeenCalledWith(req, res, body);
      // The identity a handler reads is the credential on THIS request.
      expect(req.auth).toMatchObject({
        clientId: "pat:tok-a",
        extra: expect.objectContaining({ userId: PAT.userId }),
      });
      // No session is created, looked up, or bound.
      expect((controller as any).transports.size).toBe(0);
      expect((controller as any).sessionUsers.size).toBe(0);
    });

    it("keeps a 2025-era initialize on the sessionful path", async () => {
      const req = {
        method: "POST",
        url: "/api/v1/mcp",
        headers: {
          authorization: "Bearer pat_test",
          "content-type": "application/json",
        },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {} },
        },
      } as any;

      await controller.handlePost(req, mockNodeRes());

      expect(modernNode).not.toHaveBeenCalled();
      // The factory takes no era -- the sessionful leg is identified by the
      // fact that it built a server of its own rather than by an argument.
      expect(mcpServerService.createServer).toHaveBeenCalledWith();
    });

    it("routes a 2025-era request carrying a session id to that session", async () => {
      const sessionId = "live-session";
      const handleRequest = jest.fn();
      (controller as any).transports.set(sessionId, {
        sessionId,
        handleRequest,
        close: jest.fn().mockResolvedValue(undefined),
      });
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, {
        userId: PAT.userId,
        scopes: "read",
        credentialId: "pat:tok-a",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      const req = {
        method: "POST",
        url: "/api/v1/mcp",
        headers: {
          authorization: "Bearer pat_test",
          "content-type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: { jsonrpc: "2.0", id: 2, method: "tools/list" },
      } as any;

      await controller.handlePost(req, mockRes());

      expect(modernNode).not.toHaveBeenCalled();
      expect(handleRequest).toHaveBeenCalled();
    });

    // An unbindable credential cannot be tied to a session or to a
    // confirmation, so it is refused before either era serves it.
    it("refuses an OAuth grant with no id", async () => {
      patService.validateToken.mockRejectedValue(new Error("not a PAT"));
      oauthProviderService.validateAccessToken.mockResolvedValue({
        userId: PAT.userId,
        scopes: "read",
        grantId: undefined,
      });

      const req = {
        method: "POST",
        url: "/api/v1/mcp",
        headers: { authorization: "Bearer oauth_token" },
        body: {},
      } as any;
      const res = mockRes();

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(modernNode).not.toHaveBeenCalled();
      expect(req.auth).toBeUndefined();
    });
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
        userId: "33333333-3333-4333-8333-333333333333",
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

    it("should return 404 for an expired session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "44444444-4444-4444-8444-444444444444",
        scopes: "read",
        tokenId: "tok-a",
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
          userId: "44444444-4444-4444-8444-444444444444",
          scopes: "read",
          credentialId: "pat:tok-a",
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

    it("answers 405 when no session id is present", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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

      // GET and DELETE are 2025-era session operations. Without a session id
      // there is nothing to answer on either era: the 2026-07-28 revision has
      // no standalone stream and no session to end.
      expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
      expect(res.status).toHaveBeenCalledWith(405);
    });

    it("should reject requests with unknown session ID", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      // Now try GET with a different user
      patService.validateToken.mockResolvedValue({
        userId: "22222222-2222-4222-8222-222222222222",
        scopes: "read",
        tokenId: "tok-a",
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
          error: expect.objectContaining({
            message: "Session credential mismatch",
          }),
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

    it("answers 405 when no session id is present", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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

      // GET and DELETE are 2025-era session operations. Without a session id
      // there is nothing to answer on either era: the 2026-07-28 revision has
      // no standalone stream and no session to end.
      expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
      expect(res.status).toHaveBeenCalledWith(405);
    });

    it("should return 404 for an expired session", async () => {
      patService.validateToken.mockResolvedValue({
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
      });
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());

      // Now try DELETE with a different user
      patService.validateToken.mockResolvedValue({
        userId: "22222222-2222-4222-8222-222222222222",
        scopes: "read",
        tokenId: "tok-a",
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
          error: expect.objectContaining({
            message: "Session credential mismatch",
          }),
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
      (controller as any).sessionUsers.set("a", {
        userId: "66666666-6666-4666-8666-666666666666",
        scopes: "",
      });
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "55555555-5555-4555-8555-555555555555",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        tokenId: "tok-a",
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
        userId: "11111111-1111-4111-8111-111111111111",
        scopes: "read",
        credentialId: "pat:tok-a",
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

  /**
   * P2-004. A session used to be accepted whenever the presented token's user
   * matched the cached one, while tools kept reading the scopes captured at
   * session creation. One user holds many tokens, so "same user" is not "same
   * authorization".
   */
  describe("session credential binding", () => {
    const USER = "11111111-1111-4111-8111-111111111111";
    const OTHER_USER = "22222222-2222-4222-8222-222222222222";

    const seedSession = (
      sessionId: string,
      ctx: { userId: string; scopes: string; credentialId?: string },
    ) => {
      const handleRequest = jest.fn().mockResolvedValue(undefined);
      (controller as any).transports.set(sessionId, {
        sessionId,
        handleRequest,
        close: jest.fn().mockResolvedValue(undefined),
      });
      (controller as any).servers.set(sessionId, {});
      (controller as any).sessionUsers.set(sessionId, ctx);
      (controller as any).sessionCreatedAt.set(sessionId, Date.now());
      return handleRequest;
    };

    const makeRes = () =>
      ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      }) as any;

    const post = (sessionId: string) =>
      ({
        headers: {
          authorization: "Bearer pat_test",
          "mcp-session-id": sessionId,
        },
        body: {},
      }) as any;

    it("refuses a read-only token reusing a session opened with a write token", async () => {
      const sessionId = "write-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "pat:write-token",
      });
      // Same user, different (read-only) PAT.
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read",
        tokenId: "read-token",
      });
      const res = makeRes();

      await controller.handlePost(post(sessionId), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            message: "Session credential mismatch",
          }),
        }),
      );
      expect(handleRequest).not.toHaveBeenCalled();
      // The cached write scope must not survive the rejected attempt either.
      expect((controller as any).sessionUsers.get(sessionId).scopes).toBe(
        "read,write",
      );
    });

    it("refuses a replacement token after the creating token is revoked", async () => {
      const sessionId = "revoked-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "pat:revoked-token",
      });
      // The original token is gone; the user minted a new one with the same scopes.
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read,write",
        tokenId: "fresh-token",
      });
      const res = makeRes();

      await controller.handlePost(post(sessionId), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(handleRequest).not.toHaveBeenCalled();
    });

    it("adopts the presented token's current scopes on every request", async () => {
      const sessionId = "narrowing-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "pat:tok-a",
      });
      // Same credential, scopes since narrowed on the token row itself.
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read",
        tokenId: "tok-a",
      });

      await controller.handlePost(post(sessionId), makeRes());

      expect(handleRequest).toHaveBeenCalled();
      expect((controller as any).sessionUsers.get(sessionId)).toEqual({
        userId: USER,
        scopes: "read",
        credentialId: "pat:tok-a",
      });
    });

    it("serves an existing session's tools the scopes of the token presented now", async () => {
      // INV-MCP-001 / MON-M04 (A26-S17-05): the session was opened with a
      // write-scoped token; the same credential now carries read only. What the
      // tools see is the `authInfo` the transport forwards from `req.auth`, so
      // that is what must carry the narrowed scope when the request reaches the
      // session -- not the scopes stored when the session was created.
      const sessionId = "narrowed-tool-session";
      let authAtDispatch: AuthInfo | undefined;
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "pat:tok-n",
      });
      handleRequest.mockImplementation(async (req: { auth?: AuthInfo }) => {
        authAtDispatch = req.auth;
      });
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read",
        tokenId: "tok-n",
      });

      await controller.handlePost(post(sessionId), makeRes());

      expect(handleRequest).toHaveBeenCalledTimes(1);
      expect(authAtDispatch?.scopes).toEqual(["read"]);
      expect(authAtDispatch?.extra).toEqual(
        expect.objectContaining({ userId: USER, credentialId: "pat:tok-n" }),
      );
    });

    it("accepts the same credential and still rejects another user's", async () => {
      const sessionId = "same-credential-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read",
        credentialId: "pat:tok-a",
      });
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read",
        tokenId: "tok-a",
      });
      await controller.handlePost(post(sessionId), makeRes());
      expect(handleRequest).toHaveBeenCalledTimes(1);

      patService.validateToken.mockResolvedValue({
        userId: OTHER_USER,
        scopes: "read",
        tokenId: "tok-a",
      });
      const res = makeRes();
      await controller.handlePost(post(sessionId), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(handleRequest).toHaveBeenCalledTimes(1);
    });

    it("refuses a session whose stored context predates credential binding", async () => {
      // A session created by the previous build carries no credentialId. It
      // cannot be matched, so it must not be usable -- an unbindable session is
      // exactly the hole this closes.
      const sessionId = "legacy-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
      });
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read,write",
        tokenId: "tok-a",
      });
      const res = makeRes();

      await controller.handlePost(post(sessionId), res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(handleRequest).not.toHaveBeenCalled();
    });

    it("refuses an OAuth token whose grant cannot be identified", async () => {
      const sessionId = "oauth-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "oauth:grant-1",
      });
      oauthProviderService.validateAccessToken.mockResolvedValue({
        userId: USER,
        scopes: "read,write",
        grantId: undefined,
      });
      const res = makeRes();

      await controller.handlePost(
        {
          headers: {
            authorization: "Bearer oauth-opaque",
            "mcp-session-id": sessionId,
          },
          body: {},
        } as any,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(handleRequest).not.toHaveBeenCalled();
    });

    it("keeps an OAuth session alive across an access-token refresh in the same grant", async () => {
      const sessionId = "oauth-refresh-session";
      const handleRequest = seedSession(sessionId, {
        userId: USER,
        scopes: "read,write",
        credentialId: "oauth:grant-1",
      });
      oauthProviderService.validateAccessToken.mockResolvedValue({
        userId: USER,
        scopes: "read,write",
        grantId: "grant-1",
      });

      await controller.handlePost(
        {
          headers: {
            authorization: "Bearer oauth-refreshed",
            "mcp-session-id": sessionId,
          },
          body: {},
        } as any,
        makeRes(),
      );

      expect(handleRequest).toHaveBeenCalled();
    });

    it("fingerprints a PAT by its row id and an OAuth token by its grant", async () => {
      // The value a new session stores, and the value every later request is
      // compared against, both come from here.
      patService.validateToken.mockResolvedValue({
        userId: USER,
        scopes: "read,write",
        tokenId: "tok-new",
      });
      await expect(
        (controller as any).validatePat({
          headers: { authorization: "Bearer pat_test" },
        }),
      ).resolves.toEqual({
        userId: USER,
        scopes: "read,write",
        credentialId: "pat:tok-new",
      });

      oauthProviderService.validateAccessToken.mockResolvedValue({
        userId: USER,
        scopes: "read",
        grantId: "grant-9",
      });
      await expect(
        (controller as any).validatePat({
          headers: { authorization: "Bearer opaque" },
        }),
      ).resolves.toEqual({
        userId: USER,
        scopes: "read",
        credentialId: "oauth:grant-9",
      });
    });
  });

  /**
   * M1 (`docs/specs/horizontal-scaling.md`, WP6) asked whether a 2025-era
   * session can be re-created on another replica from a persisted
   * `session_id -> user_id` row. It cannot, and these two SDK facts are why.
   * They are pinned here rather than written down only in prose: an SDK upgrade
   * that adds a session-restore seam should turn this red and send the reader
   * back to M1's persisted variant, instead of leaving the sticky-routing
   * requirement in `helm/README.md` standing on a limitation that has lapsed.
   */
  describe("a 2025-era session cannot be rehydrated on another replica", () => {
    it("exposes sessionId as a getter, so a persisted id cannot be assigned", () => {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => "generated-session-id",
      });
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(transport),
        "sessionId",
      );

      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
      expect(() => {
        (transport as unknown as { sessionId: string }).sessionId =
          "rehydrated-from-a-row";
      }).toThrow(TypeError);
    });

    // The Node transport wraps this one, and answers the same way; the web
    // standard transport is driven here because it returns the `Response`
    // itself, so the refusal can be read rather than inferred from a status.
    it("refuses a known session id on a transport that has not seen initialize", async () => {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => "generated-session-id",
      });
      const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
      const response = await transport.handleRequest(
        new Request("https://app.monize.test/api/v1/mcp", {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            // The id a second replica would have read out of an `mcp_sessions` row.
            "mcp-session-id": "generated-session-id",
          },
          body: JSON.stringify(body),
        }),
        { parsedBody: body },
      );

      // `_initialized` is private and only an `initialize` request sets it, so
      // the replica holding the row still answers as an uninitialized server.
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Server not initialized");
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
        userId: "66666666-6666-4666-8666-666666666666",
        scopes: "",
      });
      (controller as any).sessionUsers.set(stale, {
        userId: "66666666-6666-4666-8666-666666666666",
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
