import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { McpHttpController } from "./mcp-http.controller";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { withScopedDb } from "../common/db/scoped-db";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the MCP transport (task R6).
 *
 * The MCP endpoint is bearer-authenticated with no JWT guard, so `req.user` is
 * never set and `RequestContextInterceptor` enters its scope with an undefined
 * userId. Once R1-R5 moved the domain services onto `withScopedDb`, every MCP
 * tool handler reaching those services had no ambient identity to spend, and
 * `withScopedDb` refuses to run without one -- so each `handleRequest` is now
 * wrapped in `withUserContext(session user)`.
 *
 * This suite runs the REAL `withScopedDb` (at the default RLS_MODE=off) from
 * inside a fake transport's `handleRequest`, which is exactly where a tool
 * handler's data access happens. It fails on the original mistake: drop the
 * wrapper and the first assertion throws the missing-context error.
 */
describe("MCP transport RLS context smoke (real withScopedDb)", () => {
  const USER_ID = "7d2b6c11-3f8a-4c5e-9b0d-6a1e2f3c4d5b";
  const TOKEN_ID = "0c5f1a2b-4d6e-4a8b-9c0d-1e2f3a4b5c6d";

  let controller: McpHttpController;
  let patService: Record<string, jest.Mock>;

  beforeEach(async () => {
    patService = {
      validateToken: jest.fn().mockResolvedValue({
        userId: USER_ID,
        scopes: "read,write",
        tokenId: TOKEN_ID,
      }),
    };

    const timezoneDb = createScopedDbMocks([]);
    timezoneDb.manager.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpHttpController],
      providers: [
        {
          provide: McpServerService,
          useValue: { createServer: jest.fn(() => ({ connect: jest.fn() })) },
        },
        { provide: PatService, useValue: patService },
        {
          provide: OAuthProviderService,
          useValue: { validateAccessToken: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("https://monize.test") },
        },
        { provide: DataSource, useValue: timezoneDb.dataSource },
      ],
    }).compile();

    controller = module.get<McpHttpController>(McpHttpController);
  });

  afterEach(() => {
    controller.onModuleDestroy();
  });

  /**
   * Install a transport whose handleRequest performs the data access a tool
   * handler would, through the real withScopedDb, and report what happened.
   */
  function installTransport(sessionId: string): {
    outcome: { error?: string; ran: boolean };
    dataSource: DataSource;
  } {
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockResolvedValue([]);
    const outcome: { error?: string; ran: boolean } = { ran: false };

    const transport = {
      sessionId,
      handleRequest: jest.fn(async () => {
        try {
          await withScopedDb(dataSource as unknown as DataSource, (m) =>
            m.query("SELECT 1"),
          );
          outcome.ran = true;
        } catch (err) {
          outcome.error = err instanceof Error ? err.message : String(err);
        }
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (controller as any).transports.set(sessionId, transport);
    (controller as any).servers.set(sessionId, { close: jest.fn() });
    (controller as any).sessionUsers.set(sessionId, {
      userId: USER_ID,
      scopes: "read,write",
      credentialId: `pat:${TOKEN_ID}`,
    });
    (controller as any).sessionCreatedAt.set(sessionId, Date.now());

    return { outcome, dataSource: dataSource as unknown as DataSource };
  }

  it("POST on an existing session gives tool handlers the session user's context", async () => {
    const { outcome } = installTransport("session-post");

    const req = {
      headers: {
        authorization: "Bearer pat_abc",
        "mcp-session-id": "session-post",
      },
      body: { jsonrpc: "2.0", method: "tools/call", id: 1 },
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;

    await controller.handlePost(req, res);

    expect(outcome.error).toBeUndefined();
    expect(outcome.ran).toBe(true);
  });

  it("GET (the notification stream) is scoped the same way", async () => {
    const { outcome } = installTransport("session-get");

    const req = {
      headers: {
        authorization: "Bearer pat_abc",
        "mcp-session-id": "session-get",
      },
    } as any;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;

    await controller.handleGet(req, res);

    expect(outcome.error).toBeUndefined();
    expect(outcome.ran).toBe(true);
  });

  it("the same data access outside the transport wrapper still throws", async () => {
    const { manager, dataSource } = createScopedDbMocks([]);
    manager.query.mockResolvedValue([]);

    // Negative control: proves the assertions above pass because of the
    // withUserContext wrapper and not because the context check is inert here.
    await expect(
      withScopedDb(dataSource as unknown as DataSource, (m) =>
        m.query("SELECT 1"),
      ),
    ).rejects.toThrow("DB access outside request/user/system context");
  });
});
