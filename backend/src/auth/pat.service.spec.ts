import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import * as crypto from "crypto";
import { PatService } from "./pat.service";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";

describe("PatService", () => {
  let service: PatService;
  let repository: Record<string, jest.Mock>;

  const mockToken = {
    id: "token-1",
    userId: "user-1",
    name: "Test Token",
    tokenPrefix: "pat_abcd",
    tokenHash: "hashed",
    scopes: "read",
    lastUsedAt: null,
    expiresAt: null,
    isRevoked: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    repository = {
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PatService,
        {
          provide: getRepositoryToken(PersonalAccessToken),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<PatService>(PatService);
  });

  describe("create", () => {
    it("should create a token with correct format", async () => {
      repository.count.mockResolvedValue(0);
      repository.create.mockImplementation((data) => ({
        ...data,
        id: "token-1",
        createdAt: new Date(),
      }));
      repository.save.mockImplementation((token) =>
        Promise.resolve({ ...token }),
      );

      const result = await service.create("user-1", {
        name: "My Token",
      });

      expect(result.rawToken).toMatch(/^pat_[a-f0-9]{64}$/);
      expect(result.token.tokenPrefix).toBe(result.rawToken.substring(0, 8));
      expect(result.token.name).toBe("My Token");
      expect(result.token.scopes).toBe("read");
    });

    it("should hash the token with SHA-256", async () => {
      repository.count.mockResolvedValue(0);
      repository.create.mockImplementation((data) => ({
        ...data,
        id: "token-1",
      }));
      repository.save.mockImplementation((token) =>
        Promise.resolve({ ...token }),
      );

      const result = await service.create("user-1", {
        name: "My Token",
      });

      const expectedHash = crypto
        .createHash("sha256")
        .update(result.rawToken)
        .digest("hex");
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: expectedHash }),
      );
    });

    it("should use provided scopes", async () => {
      repository.count.mockResolvedValue(0);
      repository.create.mockImplementation((data) => ({
        ...data,
        id: "token-1",
      }));
      repository.save.mockImplementation((token) =>
        Promise.resolve({ ...token }),
      );

      const result = await service.create("user-1", {
        name: "Full Access",
        scopes: "read,write,reports",
      });

      expect(result.token.scopes).toBe("read,write,reports");
    });

    it("should set expiration date when provided", async () => {
      repository.count.mockResolvedValue(0);
      repository.create.mockImplementation((data) => ({
        ...data,
        id: "token-1",
      }));
      repository.save.mockImplementation((token) =>
        Promise.resolve({ ...token }),
      );

      const expiresAt = "2027-01-01T00:00:00.000Z";
      await service.create("user-1", {
        name: "Expiring Token",
        expiresAt,
      });

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: new Date(expiresAt),
        }),
      );
    });

    it("should reject when max tokens reached", async () => {
      repository.count.mockResolvedValue(10);

      await expect(
        service.create("user-1", { name: "Too Many" }),
      ).rejects.toThrow("Maximum of 10 active tokens per user");
    });
  });

  describe("findAllByUser", () => {
    it("should return tokens without hash", async () => {
      repository.find.mockResolvedValue([mockToken]);

      const result = await service.findAllByUser("user-1");

      expect(result).toEqual([mockToken]);
      expect(repository.find).toHaveBeenCalledWith({
        where: { userId: "user-1" },
        order: { createdAt: "DESC" },
        select: [
          "id",
          "name",
          "tokenPrefix",
          "scopes",
          "lastUsedAt",
          "expiresAt",
          "isRevoked",
          "createdAt",
        ],
      });
    });
  });

  describe("validateToken", () => {
    it("should validate a correct token", async () => {
      const rawToken = "pat_" + crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      repository.findOne.mockResolvedValue({
        ...mockToken,
        tokenHash,
        isRevoked: false,
        expiresAt: null,
      });
      repository.update.mockResolvedValue(undefined);

      const result = await service.validateToken(rawToken);

      expect(result).toEqual({
        userId: "user-1",
        scopes: "read",
      });
      expect(repository.update).toHaveBeenCalledWith(
        "token-1",
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });

    it("should reject invalid format", async () => {
      await expect(service.validateToken("not_a_pat_token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject empty token", async () => {
      await expect(service.validateToken("")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject unknown token", async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.validateToken("pat_" + "a".repeat(64)),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should reject revoked token", async () => {
      repository.findOne.mockResolvedValue({
        ...mockToken,
        isRevoked: true,
      });

      await expect(
        service.validateToken("pat_" + "a".repeat(64)),
      ).rejects.toThrow("Token has been revoked");
    });

    it("should reject expired token", async () => {
      repository.findOne.mockResolvedValue({
        ...mockToken,
        isRevoked: false,
        expiresAt: new Date("2020-01-01"),
      });

      await expect(
        service.validateToken("pat_" + "a".repeat(64)),
      ).rejects.toThrow("Token has expired");
    });
  });

  describe("revoke", () => {
    it("should revoke an existing token", async () => {
      repository.findOne.mockResolvedValue(mockToken);
      repository.update.mockResolvedValue(undefined);

      await service.revoke("user-1", "token-1");

      expect(repository.update).toHaveBeenCalledWith("token-1", {
        isRevoked: true,
      });
    });

    it("should throw when token not found", async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.revoke("user-1", "nonexistent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should not allow revoking another users token", async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.revoke("user-2", "token-1")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
