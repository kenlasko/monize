import { Test, TestingModule } from "@nestjs/testing";
import { PatController } from "./pat.controller";
import { PatService } from "./pat.service";

describe("PatController", () => {
  let controller: PatController;
  let patService: Record<string, jest.Mock>;

  const mockReq = { user: { id: "user-1" } };

  const mockToken = {
    id: "token-1",
    name: "Test Token",
    tokenPrefix: "pat_abcd",
    scopes: "read",
    lastUsedAt: null,
    expiresAt: null,
    isRevoked: false,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    patService = {
      findAllByUser: jest.fn(),
      create: jest.fn(),
      revoke: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PatController],
      providers: [{ provide: PatService, useValue: patService }],
    }).compile();

    controller = module.get<PatController>(PatController);
  });

  describe("list", () => {
    it("should return user tokens", async () => {
      patService.findAllByUser.mockResolvedValue([mockToken]);

      const result = await controller.list(mockReq);

      expect(result).toEqual([mockToken]);
      expect(patService.findAllByUser).toHaveBeenCalledWith("user-1");
    });
  });

  describe("create", () => {
    it("should create and return token with raw value", async () => {
      const rawToken = "pat_abcdef1234567890";
      patService.create.mockResolvedValue({
        token: { ...mockToken, id: "token-2" },
        rawToken,
      });

      const result = await controller.create(mockReq, {
        name: "New Token",
        scopes: "read,write",
      });

      expect(result.token).toBe(rawToken);
      expect(result.name).toBe("Test Token");
      expect(result.id).toBe("token-2");
      expect(patService.create).toHaveBeenCalledWith("user-1", {
        name: "New Token",
        scopes: "read,write",
      });
    });
  });

  describe("revoke", () => {
    it("should revoke a token", async () => {
      patService.revoke.mockResolvedValue(undefined);

      const result = await controller.revoke(mockReq, "token-1");

      expect(result).toEqual({ message: "Token revoked" });
      expect(patService.revoke).toHaveBeenCalledWith("user-1", "token-1");
    });
  });
});
