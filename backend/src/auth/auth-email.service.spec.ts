import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { BadRequestException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthEmailService } from "./auth-email.service";
import { User } from "../users/entities/user.entity";
import { PasswordBreachService } from "./password-breach.service";
import { TokenService } from "./token.service";
import { hashToken } from "./crypto.util";

describe("AuthEmailService", () => {
  let service: AuthEmailService;
  let usersRepository: Record<string, jest.Mock>;
  let passwordBreachService: { isBreached: jest.Mock };
  let tokenService: { revokeAllUserRefreshTokens: jest.Mock };

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    resetToken: null,
    resetTokenExpiry: null,
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    passwordBreachService = {
      isBreached: jest.fn(),
    };

    tokenService = {
      revokeAllUserRefreshTokens: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthEmailService,
        {
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
        {
          provide: PasswordBreachService,
          useValue: passwordBreachService,
        },
        {
          provide: TokenService,
          useValue: tokenService,
        },
      ],
    }).compile();

    service = module.get<AuthEmailService>(AuthEmailService);
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe("generateResetToken", () => {
    it("should return user and token when user exists with password", async () => {
      const user = { ...mockUser };
      usersRepository.findOne.mockResolvedValue(user);
      usersRepository.save.mockResolvedValue(user);

      const result = await service.generateResetToken("test@example.com");

      expect(result).not.toBeNull();
      expect(result!.user).toBe(user);
      expect(result!.token).toBeDefined();
      expect(typeof result!.token).toBe("string");
      expect(result!.token).toHaveLength(64); // 32 bytes hex

      // Verify hashed token was saved (not the raw token)
      expect(usersRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          resetToken: hashToken(result!.token),
          resetTokenExpiry: expect.any(Date),
        }),
      );

      // Verify expiry is approximately 1 hour from now
      const savedUser = usersRepository.save.mock.calls[0][0];
      const expiryTime = savedUser.resetTokenExpiry.getTime();
      const oneHourFromNow = Date.now() + 60 * 60 * 1000;
      expect(Math.abs(expiryTime - oneHourFromNow)).toBeLessThan(5000);
    });

    it("should return null when user is not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.generateResetToken(
        "nonexistent@example.com",
      );

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("should return null when user has no passwordHash (OIDC-only)", async () => {
      const oidcUser = { ...mockUser, passwordHash: null };
      usersRepository.findOne.mockResolvedValue(oidcUser);

      const result = await service.generateResetToken("test@example.com");

      expect(result).toBeNull();
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("resetPassword", () => {
    let mockExecute: jest.Mock;
    let mockReturning: jest.Mock;
    let mockAndWhere: jest.Mock;
    let mockWhere: jest.Mock;
    let mockSet: jest.Mock;
    let mockUpdate: jest.Mock;

    beforeEach(() => {
      mockExecute = jest.fn();
      mockReturning = jest.fn().mockReturnValue({ execute: mockExecute });
      mockAndWhere = jest.fn().mockReturnValue({ returning: mockReturning });
      mockWhere = jest.fn().mockReturnValue({ andWhere: mockAndWhere });
      mockSet = jest.fn().mockReturnValue({ where: mockWhere });
      mockUpdate = jest.fn().mockReturnValue({ set: mockSet });

      usersRepository.createQueryBuilder.mockReturnValue({
        update: mockUpdate,
      });
    });

    it("should hash password, update user, and revoke refresh tokens on success", async () => {
      const userId = "user-1";
      mockExecute.mockResolvedValue({
        affected: 1,
        raw: [{ id: userId }],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);
      tokenService.revokeAllUserRefreshTokens.mockResolvedValue(undefined);

      await service.resetPassword("valid-token", "NewSecurePassword123!");

      // Verify breach check
      expect(passwordBreachService.isBreached).toHaveBeenCalledWith(
        "NewSecurePassword123!",
      );

      // Verify query builder chain
      expect(usersRepository.createQueryBuilder).toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(User);
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({
          passwordHash: expect.any(String),
          resetToken: null,
          resetTokenExpiry: null,
        }),
      );
      expect(mockWhere).toHaveBeenCalledWith("resetToken = :hashedToken", {
        hashedToken: hashToken("valid-token"),
      });
      expect(mockAndWhere).toHaveBeenCalledWith("resetTokenExpiry > :now", {
        now: expect.any(Date),
      });
      expect(mockReturning).toHaveBeenCalledWith("id");

      // Verify password was hashed with bcrypt
      const setArg = mockSet.mock.calls[0][0];
      const isValidHash = await bcrypt.compare(
        "NewSecurePassword123!",
        setArg.passwordHash,
      );
      expect(isValidHash).toBe(true);

      // Verify refresh tokens revoked
      expect(tokenService.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        userId,
      );
    });

    it("should throw BadRequestException when password is breached", async () => {
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.resetPassword("some-token", "breached-password"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.resetPassword("some-token", "breached-password"),
      ).rejects.toThrow("This password has been found in a data breach");

      // Should not attempt any DB update
      expect(usersRepository.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("should throw BadRequestException when token is invalid or expired", async () => {
      mockExecute.mockResolvedValue({
        affected: 0,
        raw: [],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await expect(
        service.resetPassword("invalid-token", "NewPassword123!"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.resetPassword("invalid-token", "NewPassword123!"),
      ).rejects.toThrow("Invalid or expired reset token");

      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });

    it("should not revoke refresh tokens when no userId in result.raw", async () => {
      mockExecute.mockResolvedValue({
        affected: 1,
        raw: [],
      });
      passwordBreachService.isBreached.mockResolvedValue(false);

      await service.resetPassword("valid-token", "NewPassword123!");

      expect(tokenService.revokeAllUserRefreshTokens).not.toHaveBeenCalled();
    });
  });

  describe("checkForgotPasswordEmailLimit", () => {
    it("should allow first request and set count to 1", () => {
      const result = service.checkForgotPasswordEmailLimit("test@example.com");

      expect(result).toBe(true);
    });

    it("should allow subsequent requests within the limit", () => {
      service.checkForgotPasswordEmailLimit("test@example.com");
      const result = service.checkForgotPasswordEmailLimit("test@example.com");

      expect(result).toBe(true);
    });

    it("should block at the limit (3rd request)", () => {
      service.checkForgotPasswordEmailLimit("test@example.com");
      service.checkForgotPasswordEmailLimit("test@example.com");
      service.checkForgotPasswordEmailLimit("test@example.com");

      const result = service.checkForgotPasswordEmailLimit("test@example.com");

      expect(result).toBe(false);
    });

    it("should normalize email case", () => {
      service.checkForgotPasswordEmailLimit("Test@Example.COM");
      service.checkForgotPasswordEmailLimit("test@example.com");
      service.checkForgotPasswordEmailLimit("TEST@EXAMPLE.COM");

      // All three count as the same email, so the 4th should be blocked
      const result = service.checkForgotPasswordEmailLimit("test@example.com");

      expect(result).toBe(false);
    });

    it("should reset and allow after window expires", () => {
      // First, exhaust the limit
      service.checkForgotPasswordEmailLimit("test@example.com");
      service.checkForgotPasswordEmailLimit("test@example.com");
      service.checkForgotPasswordEmailLimit("test@example.com");

      // Verify blocked
      expect(service.checkForgotPasswordEmailLimit("test@example.com")).toBe(
        false,
      );

      // Advance time past the 1-hour window
      const realDateNow = Date.now;
      const originalNow = Date.now();
      Date.now = jest.fn().mockReturnValue(
        originalNow + 60 * 60 * 1000 + 1, // 1 hour + 1ms
      );

      try {
        // Should reset and allow (covers lines 99-103)
        const result =
          service.checkForgotPasswordEmailLimit("test@example.com");

        expect(result).toBe(true);

        // Subsequent request should also be allowed (count reset to 1, now 2)
        const result2 =
          service.checkForgotPasswordEmailLimit("test@example.com");
        expect(result2).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should track different emails independently", () => {
      service.checkForgotPasswordEmailLimit("user1@example.com");
      service.checkForgotPasswordEmailLimit("user1@example.com");
      service.checkForgotPasswordEmailLimit("user1@example.com");

      // user1 is at limit
      expect(service.checkForgotPasswordEmailLimit("user1@example.com")).toBe(
        false,
      );

      // user2 should still be allowed
      expect(service.checkForgotPasswordEmailLimit("user2@example.com")).toBe(
        true,
      );
    });
  });

  describe("cleanup", () => {
    it("should remove expired entries when cleanup runs", () => {
      // Add entries
      service.checkForgotPasswordEmailLimit("expired@example.com");
      service.checkForgotPasswordEmailLimit("fresh@example.com");

      // Advance time so the first entry expires
      const realDateNow = Date.now;
      const originalNow = Date.now();
      Date.now = jest.fn().mockReturnValue(originalNow + 60 * 60 * 1000 + 1);

      try {
        // Add a fresh entry at the new time
        service.checkForgotPasswordEmailLimit("fresh@example.com");

        // Trigger cleanup via the internal method
        (service as any).cleanupExpiredAttempts();

        // expired@example.com should be cleaned up, fresh should remain
        // Verify by checking that expired@example.com starts fresh (allowed)
        // and reaches limit normally
        const result = service.checkForgotPasswordEmailLimit(
          "expired@example.com",
        );
        expect(result).toBe(true);
      } finally {
        Date.now = realDateNow;
      }
    });

    it("should clear interval on module destroy", () => {
      const clearIntervalSpy = jest.spyOn(global, "clearInterval");
      service.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });
  });
});
