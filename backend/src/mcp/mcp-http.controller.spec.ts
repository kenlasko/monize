import { Test, TestingModule } from "@nestjs/testing";
import { McpHttpController } from "./mcp-http.controller";
import { McpServerService } from "./mcp-server.service";
import { PatService } from "../auth/pat.service";

describe("McpHttpController", () => {
  let controller: McpHttpController;
  let patService: Record<string, jest.Mock>;
  let mcpServerService: Record<string, jest.Mock>;

  beforeEach(async () => {
    patService = {
      validateToken: jest.fn(),
    };

    mcpServerService = {
      createServer: jest.fn().mockReturnValue({
        connect: jest.fn(),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpHttpController],
      providers: [
        { provide: McpServerService, useValue: mcpServerService },
        { provide: PatService, useValue: patService },
      ],
    }).compile();

    controller = module.get<McpHttpController>(McpHttpController);
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
      } as any;

      await controller.handlePost(req, res);

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  describe("handleGet", () => {
    it("should reject requests without PAT", async () => {
      const req = { headers: {} } as any;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
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
      } as any;

      await controller.handleGet(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
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
      } as any;

      await controller.handleDelete(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
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
  });
});
