import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import bcrypt from "bcryptjs";
import * as otplib from "otplib";
import { TwoFactorService } from "./two-factor.service";
import { TokenService } from "./token.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { encrypt, derivePurposeKey } from "./crypto.util";

const TEST_JWT_SECRET = "test-jwt-secret-minimum-32-chars-long";
const TEST_TOTP_KEY = derivePurposeKey(TEST_JWT_SECRET, "totp-encryption");

jest.mock("otplib", () => ({
  verifySync: jest.fn(),
  generateSecret: jest.fn().mockReturnValue("TESTSECRET"),
  generateURI: jest
    .fn()
    .mockReturnValue(
      "otpauth://totp/Monize:test@example.com?secret=TESTSECRET&issuer=Monize",
    ),
}));

jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,mockqrcode"),
}));

describe("TwoFactorService", () => {
  let service: TwoFactorService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let jwtService: Record<string, jest.Mock>;
  let configService: { get: jest.Mock };
  let dataSource: Record<string, jest.Mock>;
  let tokenService: Record<string, jest.Mock>;

  const mockUser: Partial<User> = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    pendingTwoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    lastLogin: null,
    oidcSubject: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    backupCodes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockQueryRunner = {
    connect: jest.fn(),
    startTransaction: jest.fn(),
    commitTransaction: jest.fn(),
    rollbackTransaction: jest.fn(),
    release: jest.fn(),
    manager: {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
      }),
    },
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
      create: jest.fn().mockImplementation((dto) => dto),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({}),
        getMany: jest.fn().mockResolvedValue([]),
      }),
    };

    preferencesRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((p) => Promise.resolve(p)),
      create: jest.fn().mockImplementation((dto) => dto),
    };

    trustedDevicesRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((d) => Promise.resolve(d)),
      create: jest.fn().mockImplementation((dto) => dto),
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    jwtService = {
      verify: jest.fn(),
      sign: jest.fn().mockReturnValue("mock-token"),
    };

    configService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET") return TEST_JWT_SECRET;
          if (key === "FORCE_2FA") return defaultValue ?? "false";
          return defaultValue ?? undefined;
        }),
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(mockQueryRunner),
    };

    tokenService = {
      generateTokenPair: jest.fn().mockResolvedValue({
        accessToken: "mock-access-token",
        refreshToken: "mock-refresh-token",
      }),
    };

    // Reset mockQueryRunner mocks
    mockQueryRunner.connect.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.startTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.commitTransaction.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.rollbackTransaction
      .mockReset()
      .mockResolvedValue(undefined);
    mockQueryRunner.release.mockReset().mockResolvedValue(undefined);
    mockQueryRunner.manager.findOne.mockReset();
    mockQueryRunner.manager.createQueryBuilder.mockReset().mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        {
          provide: getRepositoryToken(TrustedDevice),
          useValue: trustedDevicesRepository,
        },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: configService },
        { provide: DataSource, useValue: dataSource },
        { provide: TokenService, useValue: tokenService },
      ],
    }).compile();

    service = module.get<TwoFactorService>(TwoFactorService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("decryptTotpSecret", () => {
    it("should decrypt with purpose-derived key", () => {
      const plainSecret = "ABCDEF123456";
      const ciphertext = encrypt(plainSecret, TEST_TOTP_KEY);

      const result = service.decryptTotpSecret(ciphertext);

      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should fall back to legacy raw JWT secret and flag for re-encryption", () => {
      const plainSecret = "LEGACYSECRET";
      // Encrypt with the raw jwtSecret (legacy behavior)
      const ciphertext = encrypt(plainSecret, TEST_JWT_SECRET);

      const result = service.decryptTotpSecret(ciphertext);

      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(true);
    });
  });

  describe("reEncryptTotpSecret", () => {
    it("should encrypt with purpose-derived key", () => {
      const plainSecret = "MYSECRET";
      const ciphertext = service.reEncryptTotpSecret(plainSecret);

      // Should be decryptable with the purpose-derived key (no re-encrypt needed)
      const result = service.decryptTotpSecret(ciphertext);
      expect(result.secret).toBe(plainSecret);
      expect(result.needsReEncrypt).toBe(false);
    });
  });

  describe("verify2FA", () => {
    const tempToken = "temp-2fa-token";
    const code = "123456";

    let userWith2FA: Partial<User>;

    beforeEach(() => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      userWith2FA = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      };
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWith2FA });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
    });

    it("should verify a valid TOTP code and return tokens", async () => {
      const result = await service.verify2FA(tempToken, code);

      expect(result.accessToken).toBe("mock-access-token");
      expect(result.refreshToken).toBe("mock-refresh-token");
      expect(result.user).toBeDefined();
      expect(result.trustedDeviceRef).toBeUndefined();
    });

    it("should create a trusted device when rememberDevice is true", async () => {
      trustedDevicesRepository.save.mockResolvedValue({});
      trustedDevicesRepository.create.mockReturnValue({});

      const result = await service.verify2FA(
        tempToken,
        code,
        true,
        "Mozilla/5.0",
        "127.0.0.1",
      );

      expect(result.trustedDeviceRef).toBeDefined();
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should throw on invalid or expired token", async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error("expired");
      });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw on invalid token type", async () => {
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "access",
      });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw when user not found or no 2FA secret", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should throw on invalid TOTP code", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("should reject a replayed TOTP code", async () => {
      // First verification succeeds
      await service.verify2FA(tempToken, code);

      // Reset mocks for second call
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...userWith2FA,
        twoFactorSecret: encrypt("TOTP_SECRET", TEST_TOTP_KEY),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      // Second call with same code should fail (replay rejection)
      await expect(
        service.verify2FA("another-temp-token", code),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should re-encrypt secret when using legacy key", async () => {
      // Encrypt with raw JWT secret (legacy)
      const legacyCiphertext = encrypt("TOTP_SECRET", TEST_JWT_SECRET);
      const legacyUser = {
        ...userWith2FA,
        twoFactorSecret: legacyCiphertext,
      };
      usersRepository.findOne.mockResolvedValue({ ...legacyUser });

      await service.verify2FA(tempToken, code);

      // Should have saved the user with re-encrypted secret
      expect(usersRepository.save).toHaveBeenCalled();
      const savedUser = usersRepository.save.mock.calls[0][0];
      // The secret should now be decryptable with the purpose-derived key
      const result = service.decryptTotpSecret(savedUser.twoFactorSecret);
      expect(result.secret).toBe("TOTP_SECRET");
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should block after too many per-token attempts", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // Exhaust per-token attempts (MAX_2FA_ATTEMPTS = 3)
      for (let i = 0; i < 3; i++) {
        await expect(service.verify2FA(tempToken, "wrong1")).rejects.toThrow(
          UnauthorizedException,
        );
      }

      // Next attempt should be blocked even before verification
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      await expect(service.verify2FA(tempToken, code)).rejects.toThrow(
        "Too many verification attempts. Please log in again.",
      );
    });

    it("should block after too many per-user attempts", async () => {
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // Exhaust per-user attempts (MAX_USER_2FA_ATTEMPTS = 10)
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`temp-token-${i}`, "wrong1"),
        ).rejects.toThrow(UnauthorizedException);
      }

      // Next attempt with new token should still be blocked (per-user limit)
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      await expect(service.verify2FA("fresh-token", code)).rejects.toThrow(
        "Too many verification attempts. Your account has been temporarily locked.",
      );
    });

    it("should verify backup codes for non-6-digit format", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const userWithBackup = {
        ...userWith2FA,
        backupCodes: JSON.stringify([hashedCode]),
      };
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // Mock QueryRunner for backup code verification
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...userWithBackup,
        backupCodes: JSON.stringify([hashedCode]),
      });

      const result = await service.verify2FA(tempToken, "abcd-ef01");

      expect(result.accessToken).toBe("mock-access-token");
    });
  });

  describe("setup2FA", () => {
    it("should generate a secret and QR code for a local user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(true as never);

      const result = await service.setup2FA("user-1", "correct-password");

      expect(result.secret).toBe("TESTSECRET");
      expect(result.qrCodeDataUrl).toBe("data:image/png;base64,mockqrcode");
      expect(result.otpauthUrl).toContain("otpauth://totp/");
      expect(usersRepository.save).toHaveBeenCalled();
    });

    it("should throw NotFoundException for unknown user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.setup2FA("nonexistent", "pw")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("should reject SSO (OIDC) users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
      });

      await expect(service.setup2FA("user-1", "pw")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject incorrect current password", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      jest.spyOn(bcrypt, "compare").mockResolvedValueOnce(false as never);

      await expect(
        service.setup2FA("user-1", "wrong-password"),
      ).rejects.toThrow(UnauthorizedException);
      expect(usersRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("confirmSetup2FA", () => {
    it("should promote pending secret to active on valid code", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRepository.findOne.mockResolvedValue(null);

      const result = await service.confirmSetup2FA("user-1", "123456");

      expect(result.message).toContain("enabled successfully");
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBe(pendingSecret);
      expect(savedUser.pendingTwoFactorSecret).toBeNull();
      expect(preferencesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: true }),
      );
    });

    it("should update existing preferences", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        twoFactorEnabled: false,
      });

      await service.confirmSetup2FA("user-1", "123456");

      expect(preferencesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: true }),
      );
    });

    it("should throw when no pending secret", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw on invalid code", async () => {
      const pendingSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: pendingSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("disable2FA", () => {
    it("should disable 2FA and clear trusted devices", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        twoFactorEnabled: true,
      });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBeNull();
      expect(preferencesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: false }),
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("should throw ForbiddenException when FORCE_2FA is enabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET") return TEST_JWT_SECRET;
          if (key === "FORCE_2FA") return "true";
          return defaultValue ?? undefined;
        },
      );

      // Need to recreate the service so the configService mock takes effect in disable2FA
      // Since FORCE_2FA is checked at call time (not constructor), we just call it
      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("should throw when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should throw on invalid verification code", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should handle missing preferences gracefully", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      preferencesRepository.findOne.mockResolvedValue(null);

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      expect(preferencesRepository.save).not.toHaveBeenCalled();
    });
  });

  describe("generateBackupCodes", () => {
    it("should generate and store hashed backup codes", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const codes = await service.generateBackupCodes("user-1", "123456");

      expect(codes).toHaveLength(12);
      codes.forEach((code) => {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      });

      const savedUser = usersRepository.save.mock.calls[0][0];
      const storedHashes = JSON.parse(savedUser.backupCodes);
      expect(storedHashes).toHaveLength(12);
    });

    it("should throw when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.generateBackupCodes("nonexistent", "123456"),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw on invalid verification code", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("migrateLegacyTotpSecrets", () => {
    it("should migrate users with legacy-encrypted secrets", async () => {
      // Encrypt with raw JWT secret (legacy)
      const legacyCiphertext = encrypt("MY_TOTP_SECRET", TEST_JWT_SECRET);

      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: "user-1",
            twoFactorSecret: legacyCiphertext,
          },
          {
            id: "user-2",
            twoFactorSecret: encrypt("OTHER_SECRET", TEST_TOTP_KEY), // already migrated
          },
        ]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(1);
      // The user with legacy secret should have been saved
      expect(usersRepository.save).toHaveBeenCalledTimes(1);
      const savedUser = usersRepository.save.mock.calls[0][0];
      // Verify the re-encrypted secret can be decrypted with the purpose-derived key
      const result = service.decryptTotpSecret(savedUser.twoFactorSecret);
      expect(result.secret).toBe("MY_TOTP_SECRET");
      expect(result.needsReEncrypt).toBe(false);
    });

    it("should return 0 when no users need migration", async () => {
      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([
          {
            id: "user-1",
            twoFactorSecret: encrypt("SECRET", TEST_TOTP_KEY),
          },
        ]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(0);
      expect(usersRepository.save).not.toHaveBeenCalled();
    });

    it("should return 0 when no users have 2FA secrets", async () => {
      usersRepository.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      const count = await service.migrateLegacyTotpSecrets();

      expect(count).toBe(0);
    });
  });

  describe("validateTrustedDevice", () => {
    it("should return true for a valid, non-expired device with matching user-agent", async () => {
      const userAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: (service as any).hashUserAgent(userAgent),
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
        userAgent,
      );

      expect(result).toBe(true);
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should return false when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(false);
    });

    it("should remove expired device and return false", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        expiresAt: new Date(Date.now() - 1000), // expired
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).toHaveBeenCalled();
    });

    it("should reject when user-agent fingerprint does not match", async () => {
      const originalUA =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0";
      const differentUA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Firefox/121.0";
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: (service as any).hashUserAgent(originalUA),
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
        differentUA,
      );

      expect(result).toBe(false);
      // Should NOT save (rejected before updating lastUsedAt)
      expect(trustedDevicesRepository.save).not.toHaveBeenCalled();
    });

    it("should skip user-agent check when userAgent is not provided", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
        userId: "user-1",
        tokenHash: "somehash",
        userAgentHash: "some-hash",
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(true);
    });
  });

  describe("createTrustedDevice", () => {
    it("should create and save a trusted device, returning the token", async () => {
      const result = await service.createTrustedDevice(
        "user-1",
        "Mozilla/5.0 Chrome/120.0",
        "192.168.1.1",
      );

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(trustedDevicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          ipAddress: "192.168.1.1",
        }),
      );
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("should use null for ipAddress when not provided", async () => {
      await service.createTrustedDevice("user-1", "Mozilla/5.0");

      expect(trustedDevicesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ipAddress: null,
        }),
      );
    });
  });

  describe("getTrustedDevices", () => {
    it("should delete expired devices and return remaining", async () => {
      const devices = [
        { id: "d-1", deviceName: "Chrome on Linux", lastUsedAt: new Date() },
      ];
      trustedDevicesRepository.find.mockResolvedValue(devices);

      const result = await service.getTrustedDevices("user-1");

      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
        expiresAt: expect.anything(),
      });
      expect(result).toEqual(devices);
    });
  });

  describe("revokeTrustedDevice", () => {
    it("should remove the device", async () => {
      const device = { id: "device-1", userId: "user-1" };
      trustedDevicesRepository.findOne.mockResolvedValue(device);

      await service.revokeTrustedDevice("user-1", "device-1");

      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(device);
    });

    it("should throw NotFoundException when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("revokeAllTrustedDevices", () => {
    it("should delete all devices for the user and return count", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 3 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(3);
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("should return 0 when no devices exist", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });
  });

  describe("findTrustedDeviceByToken", () => {
    it("should return device id when found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-1",
      });

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "some-token",
      );

      expect(result).toBe("device-1");
    });

    it("should return null when not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "unknown-token",
      );

      expect(result).toBeNull();
    });
  });

  describe("sanitizeUser", () => {
    it("should strip sensitive fields and add hasPassword", () => {
      const user = {
        ...mockUser,
        id: "user-1",
        email: "test@example.com",
        passwordHash: "hashed",
        twoFactorSecret: "secret",
        pendingTwoFactorSecret: "pending",
        resetToken: "token",
        resetTokenExpiry: new Date(),
        failedLoginAttempts: 3,
        lockedUntil: new Date(),
        backupCodes: "codes",
        oidcLinkPending: true,
        oidcLinkToken: "link-token",
        oidcLinkExpiresAt: new Date(),
        pendingOidcSubject: "sub",
      } as unknown as User;

      const result = service.sanitizeUser(user);

      expect(result.hasPassword).toBe(true);
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).not.toHaveProperty("pendingTwoFactorSecret");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("failedLoginAttempts");
      expect(result).not.toHaveProperty("lockedUntil");
      expect(result).not.toHaveProperty("backupCodes");
      expect(result).not.toHaveProperty("oidcLinkPending");
      expect(result).not.toHaveProperty("oidcLinkToken");
      expect(result).not.toHaveProperty("oidcLinkExpiresAt");
      expect(result).not.toHaveProperty("pendingOidcSubject");
      expect(result).toHaveProperty("email", "test@example.com");
    });

    it("should set hasPassword to false when no password hash", () => {
      const user = {
        ...mockUser,
        passwordHash: null,
      } as unknown as User;

      const result = service.sanitizeUser(user);

      expect(result.hasPassword).toBe(false);
    });
  });

  describe("verifyBackupCode (via verify2FA)", () => {
    it("should handle concurrent backup code consumption rollback", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      const userWithBackup = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify([hashedCode]),
      };

      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // First pre-check finds the code, but the locked row has no codes
      // (concurrent consumption scenario)
      mockQueryRunner.manager.findOne.mockResolvedValue({
        ...userWithBackup,
        backupCodes: JSON.stringify(["different-hash-not-matching"]),
      });

      // The backup code won't match in the re-verify step, causing rollback
      await expect(
        service.verify2FA("temp-token", "abcd-ef01"),
      ).rejects.toThrow(UnauthorizedException);

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
    });

    it("should handle error during backup code verification", async () => {
      const hashedCode = await bcrypt.hash("abcd-ef01", 10);
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      const userWithBackup = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify([hashedCode]),
      };

      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({ ...userWithBackup });

      // Simulate a database error during QueryRunner operations
      mockQueryRunner.manager.findOne.mockRejectedValue(
        new Error("DB connection lost"),
      );

      await expect(
        service.verify2FA("temp-token", "abcd-ef01"),
      ).rejects.toThrow("DB connection lost");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  describe("cleanupExpired2FAAttempts", () => {
    it("should clean up expired entries from both maps", async () => {
      // Trigger some failed attempts to populate the maps
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.verify2FA("token-1", "wrong1")).rejects.toThrow(
        UnauthorizedException,
      );

      // Now manipulate time to make entries expired
      const twoFactorAttempts = (service as any).twoFactorAttempts;
      const user2FAAttempts = (service as any).user2FAAttempts;

      // Set expiry to the past
      for (const [key] of twoFactorAttempts.entries()) {
        twoFactorAttempts.set(key, { count: 1, expiresAt: Date.now() - 1000 });
      }
      for (const [key] of user2FAAttempts.entries()) {
        user2FAAttempts.set(key, { count: 1, expiresAt: Date.now() - 1000 });
      }

      // Next call should clean up expired entries
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });

      const result = await service.verify2FA("token-1", "123456");
      expect(result.accessToken).toBe("mock-access-token");
    });
  });

  describe("cleanupExpiredTotpCodes", () => {
    it("should clean up expired TOTP codes", async () => {
      const encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      // First call marks code as used
      await service.verify2FA("token-1", "123456");

      // Manually expire the code
      const usedCodes = (service as any).usedTotpCodes;
      for (const [key] of usedCodes.entries()) {
        usedCodes.set(key, Date.now() - 1000);
      }

      // Reset mocks for second call
      jwtService.verify.mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });

      // Same code should now be accepted since it was cleaned up
      const result = await service.verify2FA("token-2", "123456");
      expect(result.accessToken).toBe("mock-access-token");
    });
  });

  describe("verifyTotpForUser", () => {
    let encryptedSecret: string;

    beforeEach(() => {
      encryptedSecret = encrypt("TOTP_SECRET", TEST_TOTP_KEY);
    });

    it("returns false for non-6-digit codes", async () => {
      const result = await service.verifyTotpForUser("user-1", "abc");
      expect(result).toBe(false);
      expect(usersRepository.findOne).not.toHaveBeenCalled();
    });

    it("returns false when the user has no 2FA secret", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });
      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(false);
    });

    it("returns false when the user is missing", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(false);
    });

    it("returns true for a valid code", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const result = await service.verifyTotpForUser("user-1", "123456");
      expect(result).toBe(true);
    });

    it("returns false for an invalid code without stamping the replay map", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verifyTotpForUser("user-1", "999999");
      expect(result).toBe(false);
      expect((service as any).usedTotpCodes.has("user-1:999999")).toBe(false);
    });

    it("rejects a code that was already used in this window (replay)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const first = await service.verifyTotpForUser("user-1", "123456");
      expect(first).toBe(true);

      const replay = await service.verifyTotpForUser("user-1", "123456");
      expect(replay).toBe(false);
    });
  });
});
