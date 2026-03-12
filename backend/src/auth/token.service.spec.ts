import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { TokenService } from "./token.service";
import { RefreshToken } from "./entities/refresh-token.entity";

jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return {
    ...actual,
    randomBytes: jest.fn().mockReturnValue({
      toString: () => "mock-random-token-hex",
    }),
    randomUUID: jest.fn().mockReturnValue("mock-family-uuid"),
  };
});

jest.mock("./crypto.util", () => ({
  hashToken: jest.fn().mockReturnValue("hashed-token"),
}));

describe("TokenService", () => {
  let service: TokenService;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    authProvider: "local",
    role: "user",
    isActive: true,
  };

  const mockRefreshToken = {
    id: "token-1",
    userId: "user-1",
    tokenHash: "hashed-token",
    familyId: "family-1",
    isRevoked: false,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    replacedByHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    refreshTokensRepository = {
      create: jest.fn().mockReturnValue(mockRefreshToken),
      save: jest.fn().mockResolvedValue(mockRefreshToken),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-access-token"),
    };

    dataSource = {
      transaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TokenService,
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokensRepository,
        },
        {
          provide: JwtService,
          useValue: jwtService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue("30") },
        },
      ],
    }).compile();

    service = module.get<TokenService>(TokenService);
  });

  describe("getRefreshExpiryMs", () => {
    it("should return 1-day expiry when rememberMe is false", () => {
      const result = service.getRefreshExpiryMs(false);

      expect(result).toBe(1 * 24 * 60 * 60 * 1000);
    });

    it("should return 1-day expiry when rememberMe is undefined", () => {
      const result = service.getRefreshExpiryMs();

      expect(result).toBe(1 * 24 * 60 * 60 * 1000);
    });

    it("should return configured REMEMBER_ME_DAYS expiry when rememberMe is true", () => {
      const result = service.getRefreshExpiryMs(true);

      // ConfigService returns "30", so 30 days
      expect(result).toBe(30 * 24 * 60 * 60 * 1000);
    });
  });

  describe("generateTokenPair", () => {
    it("should create an access token and refresh token", async () => {
      const result = await service.generateTokenPair(mockUser as any);

      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: "user-1",
          email: "test@example.com",
          authProvider: "local",
          role: "user",
        },
        { expiresIn: "15m" },
      );
      expect(refreshTokensRepository.create).toHaveBeenCalledWith({
        userId: "user-1",
        tokenHash: "hashed-token",
        familyId: "mock-family-uuid",
        isRevoked: false,
        expiresAt: expect.any(Date),
        replacedByHash: null,
      });
      expect(refreshTokensRepository.save).toHaveBeenCalledWith(
        mockRefreshToken,
      );
      expect(result).toEqual({
        accessToken: "mock-access-token",
        refreshToken: "mock-random-token-hex",
      });
    });

    it("should use shorter expiry without rememberMe", async () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      await service.generateTokenPair(mockUser as any);

      const createCall = refreshTokensRepository.create.mock.calls[0][0];
      const expectedExpiry = new Date(now + 1 * 24 * 60 * 60 * 1000);
      expect(createCall.expiresAt).toEqual(expectedExpiry);

      jest.restoreAllMocks();
    });

    it("should use longer expiry with rememberMe", async () => {
      const now = Date.now();
      jest.spyOn(Date, "now").mockReturnValue(now);

      await service.generateTokenPair(mockUser as any, true);

      const createCall = refreshTokensRepository.create.mock.calls[0][0];
      const expectedExpiry = new Date(now + 30 * 24 * 60 * 60 * 1000);
      expect(createCall.expiresAt).toEqual(expectedExpiry);

      jest.restoreAllMocks();
    });
  });

  describe("refreshTokens", () => {
    let mockManager: Record<string, jest.Mock>;

    beforeEach(() => {
      mockManager = {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        save: jest.fn().mockImplementation((entity) => Promise.resolve(entity)),
        create: jest.fn().mockImplementation((_Entity, data) => data),
      };

      dataSource.transaction.mockImplementation(async (callback) => {
        return callback(mockManager);
      });
    });

    it("should rotate token and return new token pair on success", async () => {
      const existingToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      };

      mockManager.findOne
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce(mockUser);

      const result = await service.refreshTokens("raw-refresh-token");

      expect(mockManager.findOne).toHaveBeenCalledWith(RefreshToken, {
        where: { tokenHash: "hashed-token" },
        lock: { mode: "pessimistic_write" },
      });

      expect(existingToken.isRevoked).toBe(true);
      expect(existingToken.replacedByHash).toBe("hashed-token");
      expect(mockManager.save).toHaveBeenCalledWith(existingToken);

      expect(mockManager.create).toHaveBeenCalledWith(RefreshToken, {
        userId: "user-1",
        tokenHash: "hashed-token",
        familyId: "family-1",
        isRevoked: false,
        expiresAt: expect.any(Date),
        replacedByHash: null,
      });

      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: "user-1",
          email: "test@example.com",
          authProvider: "local",
          role: "user",
        },
        { expiresIn: "15m" },
      );

      expect(result).toEqual({
        accessToken: "mock-access-token",
        refreshToken: "mock-random-token-hex",
        userId: "user-1",
      });
    });

    it("should throw UnauthorizedException when token is not found", async () => {
      mockManager.findOne.mockResolvedValueOnce(null);

      await expect(service.refreshTokens("unknown-token")).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(service.refreshTokens("unknown-token")).rejects.toThrow(
        "Invalid refresh token",
      );
    });

    it("should revoke entire family and throw when token is already revoked (replay detection)", async () => {
      const revokedToken = {
        ...mockRefreshToken,
        isRevoked: true,
        familyId: "family-1",
      };

      mockManager.findOne.mockResolvedValueOnce(revokedToken);

      await expect(service.refreshTokens("reused-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });

    it("should throw with correct message on replay detection", async () => {
      const revokedToken = {
        ...mockRefreshToken,
        isRevoked: true,
      };

      mockManager.findOne.mockResolvedValueOnce(revokedToken);

      await expect(service.refreshTokens("reused-token")).rejects.toThrow(
        "Refresh token reuse detected",
      );
    });

    it("should revoke token and throw when token is expired", async () => {
      const expiredToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000),
      };

      mockManager.findOne.mockResolvedValueOnce(expiredToken);

      await expect(service.refreshTokens("expired-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(expiredToken.isRevoked).toBe(true);
      expect(mockManager.save).toHaveBeenCalledWith(expiredToken);
    });

    it("should throw with correct message on expired token", async () => {
      const expiredToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000),
      };

      mockManager.findOne.mockResolvedValueOnce(expiredToken);

      await expect(service.refreshTokens("expired-token")).rejects.toThrow(
        "Refresh token expired",
      );
    });

    it("should revoke family and throw when user is not found", async () => {
      const validToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        familyId: "family-1",
      };

      mockManager.findOne
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(null);

      await expect(service.refreshTokens("valid-token")).rejects.toThrow(
        UnauthorizedException,
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });

    it("should revoke family and throw when user is inactive", async () => {
      const validToken = {
        ...mockRefreshToken,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        familyId: "family-1",
      };

      const inactiveUser = { ...mockUser, isActive: false };

      mockManager.findOne
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(inactiveUser);

      await expect(service.refreshTokens("valid-token")).rejects.toThrow(
        "User not found or inactive",
      );

      expect(mockManager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });
  });

  describe("revokeTokenFamily", () => {
    it("should update all tokens in family to revoked", async () => {
      await service.revokeTokenFamily("family-1");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });
  });

  describe("revokeRefreshToken", () => {
    it("should find token by hash and revoke its family", async () => {
      refreshTokensRepository.findOne.mockResolvedValueOnce({
        ...mockRefreshToken,
        familyId: "family-1",
      });

      await service.revokeRefreshToken("raw-token");

      expect(refreshTokensRepository.findOne).toHaveBeenCalledWith({
        where: { tokenHash: "hashed-token" },
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });

    it("should return early when given an empty string", async () => {
      await service.revokeRefreshToken("");

      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("should return early when given a falsy value", async () => {
      await service.revokeRefreshToken(undefined as any);

      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("should be a no-op when token is not found in DB", async () => {
      refreshTokensRepository.findOne.mockResolvedValueOnce(null);

      await service.revokeRefreshToken("unknown-token");

      expect(refreshTokensRepository.findOne).toHaveBeenCalled();
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });
  });

  describe("revokeAllUserRefreshTokens", () => {
    it("should batch revoke all non-revoked tokens for user", async () => {
      await service.revokeAllUserRefreshTokens("user-1");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe("purgeExpiredRefreshTokens", () => {
    it("should delete expired and revoked tokens", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: 3 })
        .mockResolvedValueOnce({ affected: 5 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledTimes(2);
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        expiresAt: expect.anything(),
      });
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith({
        isRevoked: true,
      });
    });

    it("should log when totalPurged > 0", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: 2 })
        .mockResolvedValueOnce({ affected: 3 });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).toHaveBeenCalledWith(
        "Purged 5 expired/revoked refresh tokens",
      );
    });

    it("should not log when totalPurged is 0", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 0 });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).not.toHaveBeenCalled();
    });

    it("should handle undefined affected counts", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: undefined })
        .mockResolvedValueOnce({ affected: undefined });

      const logSpy = jest.spyOn(service["logger"], "log");

      await service.purgeExpiredRefreshTokens();

      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
