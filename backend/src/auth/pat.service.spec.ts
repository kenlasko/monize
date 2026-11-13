import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as crypto from "crypto";
import { DEFAULT_PAT_LIFETIME_DAYS, PatService } from "./pat.service";
import { PersonalAccessToken } from "./entities/personal-access-token.entity";
import { User } from "../users/entities/user.entity";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("PatService", () => {
  let service: PatService;
  let repository: Record<string, jest.Mock>;
  let userRepository: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;

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

    userRepository = {
      findOne: jest.fn(),
    };

    const scoped = createScopedDbMocks([
      [PersonalAccessToken, repository as never],
      [User, userRepository as never],
    ]);
    manager = scoped.manager as unknown as Record<string, jest.Mock>;
    manager.query.mockResolvedValue([{ id: "user-1" }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: DataSource,
          useValue: scoped.dataSource,
        },
        PatService,
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
        scopes: "read,write",
      });

      expect(result.token.scopes).toBe("read,write");
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

    describe("expiry", () => {
      const DAY_MS = 24 * 60 * 60 * 1000;

      beforeEach(() => {
        repository.count.mockResolvedValue(0);
        repository.create.mockImplementation((data) => ({
          ...data,
          id: "token-1",
        }));
        repository.save.mockImplementation((token) =>
          Promise.resolve({ ...token }),
        );
      });

      it("defaults an omitted expiresAt to the default lifetime", async () => {
        const before = Date.now();
        await service.create("user-1", { name: "Default" });
        const after = Date.now();

        const stored = repository.create.mock.calls[0][0].expiresAt as Date;
        expect(stored).toBeInstanceOf(Date);
        expect(stored.getTime()).toBeGreaterThanOrEqual(
          before + DEFAULT_PAT_LIFETIME_DAYS * DAY_MS,
        );
        expect(stored.getTime()).toBeLessThanOrEqual(
          after + DEFAULT_PAT_LIFETIME_DAYS * DAY_MS,
        );
      });

      it("stores null for an explicit null (no expiry)", async () => {
        await service.create("user-1", { name: "Forever", expiresAt: null });

        expect(repository.create).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAt: null }),
        );
      });

      it("keeps an explicit date", async () => {
        const expiresAt = "2027-06-01T00:00:00.000Z";
        await service.create("user-1", { name: "Dated", expiresAt });

        expect(repository.create).toHaveBeenCalledWith(
          expect.objectContaining({ expiresAt: new Date(expiresAt) }),
        );
      });
    });

    it("should reject when max tokens reached", async () => {
      repository.count.mockResolvedValue(10);

      await expect(
        service.create("user-1", { name: "Too Many" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("serializes on the owner's row before counting against the cap", async () => {
      // The cap is a read-modify-write with no unique constraint behind it, so
      // nothing catches a breach after the fact. Counting on one connection and
      // inserting on another let two concurrent creates both pass; so would
      // counting and inserting in one transaction, since neither sees the
      // other's uncommitted row. The lock is the whole guard.
      repository.count.mockResolvedValue(0);
      repository.create.mockImplementation((data) => ({ ...data }));
      repository.save.mockImplementation((token) =>
        Promise.resolve({ ...token }),
      );

      await service.create("user-1", { name: "My Token" });

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringMatching(/FROM users WHERE id = \$1 FOR UPDATE/),
        ["user-1"],
      );
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        repository.count.mock.invocationCallOrder[0],
      );
      expect(repository.count.mock.invocationCallOrder[0]).toBeLessThan(
        repository.save.mock.invocationCallOrder[0],
      );
    });

    it("does not insert the token when the cap refuses it", async () => {
      repository.count.mockResolvedValue(10);

      await expect(
        service.create("user-1", { name: "Too Many" }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
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
    beforeEach(() => {
      userRepository.findOne.mockResolvedValue({
        id: "user-1",
        isActive: true,
        mustChangePassword: false,
      });
    });

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
        // The credential fingerprint the MCP transport binds a session to.
        tokenId: "token-1",
      });
      expect(repository.update).toHaveBeenCalledWith(
        "token-1",
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
    });

    describe("lastUsedAt write throttle", () => {
      const rawToken = "pat_" + crypto.randomBytes(32).toString("hex");

      it.each([
        ["10 seconds old", 10 * 1000, false],
        ["2 minutes old", 2 * 60 * 1000, true],
        ["never used", null, true],
      ])("lastUsedAt %s: writes=%s", async (_label, ageMs, writes: boolean) => {
        repository.findOne.mockResolvedValue({
          ...mockToken,
          isRevoked: false,
          expiresAt: null,
          lastUsedAt: ageMs === null ? null : new Date(Date.now() - ageMs),
        });
        repository.update.mockResolvedValue(undefined);

        await expect(service.validateToken(rawToken)).resolves.toEqual({
          userId: "user-1",
          scopes: "read",
          tokenId: "token-1",
        });

        if (writes) {
          expect(repository.update).toHaveBeenCalledWith(
            "token-1",
            expect.objectContaining({ lastUsedAt: expect.any(Date) }),
          );
        } else {
          expect(repository.update).not.toHaveBeenCalled();
        }
      });
    });

    // RLS (task C1): PAT validation is pre-identity (the token-hash lookup
    // scans across users, before any req.user exists). Assert the lookup runs
    // under a system context.
    it("runs the token lookup under a system context", async () => {
      const rawToken = "pat_" + crypto.randomBytes(32).toString("hex");
      let ctx: ReturnType<typeof getRequestContext>;
      repository.findOne.mockImplementation(() => {
        ctx = getRequestContext();
        return Promise.resolve({
          ...mockToken,
          isRevoked: false,
          expiresAt: null,
        });
      });
      repository.update.mockResolvedValue(undefined);

      await service.validateToken(rawToken);

      expect(ctx).toEqual({ system: true });
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

    it("should reject token when user is inactive", async () => {
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
      userRepository.findOne.mockResolvedValue({
        id: "user-1",
        isActive: false,
        mustChangePassword: false,
      });

      await expect(service.validateToken(rawToken)).rejects.toThrow(
        "User account is inactive",
      );
    });

    it("should reject token when user must change password", async () => {
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
      userRepository.findOne.mockResolvedValue({
        id: "user-1",
        isActive: true,
        mustChangePassword: true,
      });

      await expect(service.validateToken(rawToken)).rejects.toThrow(
        "Password change required",
      );
    });

    it("should reject token when user not found", async () => {
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
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.validateToken(rawToken)).rejects.toThrow(
        UnauthorizedException,
      );
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
