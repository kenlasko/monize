import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import * as otplib from "otplib";
import * as QRCode from "qrcode";
import { AuthService } from "./auth.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { RefreshToken } from "./entities/refresh-token.entity";
import { encrypt, derivePurposeKey } from "./crypto.util";
import { PasswordBreachService } from "./password-breach.service";
import { EmailService } from "../notifications/email.service";

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

describe("AuthService", () => {
  let service: AuthService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let jwtService: Partial<JwtService>;
  let configService: { get: jest.Mock };
  let dataSource: Record<string, jest.Mock>;
  let passwordBreachService: { isBreached: jest.Mock };
  let emailService: { sendMail: jest.Mock };

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    lastLogin: null,
    oidcSubject: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    preferencesRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    trustedDevicesRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      delete: jest.fn(),
      remove: jest.fn(),
    };

    refreshTokensRepository = {
      create: jest.fn().mockImplementation((data) => data),
      save: jest.fn().mockImplementation((data) => ({ ...data, id: "rt-1" })),
      findOne: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    jwtService = {
      sign: jest.fn().mockReturnValue("mock-jwt-token"),
      verify: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn(),
      createQueryRunner: jest.fn(),
    };

    passwordBreachService = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    emailService = {
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        {
          provide: getRepositoryToken(TrustedDevice),
          useValue: trustedDevicesRepository,
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokensRepository,
        },
        { provide: JwtService, useValue: jwtService },
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((key: string, defaultValue?: string) => {
                if (key === "JWT_SECRET")
                  return "test-jwt-secret-minimum-32-chars-long";
                if (key === "FORCE_2FA") return defaultValue || "false";
                return defaultValue || undefined;
              }),
          },
        },
        { provide: DataSource, useValue: dataSource },
        { provide: PasswordBreachService, useValue: passwordBreachService },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    configService = module.get(ConfigService);

    // Spy on logger for security event logging tests (C2+C3)
    jest.spyOn((service as any).logger, "warn").mockImplementation();
    jest.spyOn((service as any).logger, "log").mockImplementation();
  });

  describe("register", () => {
    /**
     * Helper: set up dataSource.transaction mock for register()'s
     * SERIALIZABLE transaction pattern: dataSource.transaction("SERIALIZABLE", async (manager) => {...})
     */
    function setupRegisterTransactionMock(userCount: number) {
      const txManager = {
        count: jest.fn().mockResolvedValue(userCount),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "new-user",
        })),
        save: jest.fn().mockImplementation((user) => ({
          ...user,
          id: user.id || "new-user",
        })),
      };
      dataSource.transaction.mockImplementation(
        async (_isolation: string, cb: any) => cb(txManager),
      );
      return txManager;
    }

    it("creates a new user and returns token pair", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      setupRegisterTransactionMock(1); // not first user

      const result = await service.register({
        email: "new@example.com",
        password: "StrongPass123!",
        firstName: "New",
        lastName: "User",
      });

      expect(result.user).toBeDefined();
      expect(result.user.email).toBe("new@example.com");
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user).not.toHaveProperty("passwordHash");
    });

    it("makes first user an admin", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupRegisterTransactionMock(0); // first user

      await service.register({
        email: "admin@example.com",
        password: "StrongPass123!",
      });

      const createdUser = txManager.save.mock.calls[0][0];
      expect(createdUser.role).toBe("admin");
    });

    it("throws for duplicate email", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.register({
          email: "test@example.com",
          password: "StrongPass123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects breached password during registration", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.register({
          email: "new@example.com",
          password: "BreachedPass123!",
        }),
      ).rejects.toThrow("found in a data breach");
    });
  });

  describe("login", () => {
    function mockLoginQueryBuilder() {
      const builder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      usersRepository.createQueryBuilder.mockReturnValue(builder);
      return builder;
    }

    it("returns token pair for valid credentials", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const user = { ...mockUser, passwordHash: hashedPassword };
      usersRepository.findOne.mockResolvedValue(user);
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(user);

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login successful for user"),
      );
    });

    it("throws for non-existent user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: "nobody@example.com", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: no matching account"),
      );
    });

    it("throws for wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: invalid password"),
      );
    });

    it("throws for inactive user", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        isActive: false,
      });

      await expect(
        service.login({ email: "test@example.com", password: "ValidPass123!" }),
      ).rejects.toThrow("Account is deactivated");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Login failed: account deactivated"),
      );
    });

    it("returns 2FA required when enabled", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: "encrypted-secret",
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.requires2FA).toBe(true);
      expect(result.tempToken).toBeDefined();
      expect(result).not.toHaveProperty("accessToken");
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login requires 2FA"),
      );
    });

    it("rejects login when account is locked", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        lockedUntil: new Date(Date.now() + 60000),
      });

      await expect(
        service.login({ email: "test@example.com", password: "any" }),
      ).rejects.toThrow(ForbiddenException);
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("account locked"),
      );
    });

    it("allows login when lock has expired", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        lockedUntil: new Date(Date.now() - 1000),
        failedLoginAttempts: 5,
      });
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(mockUser);

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
    });

    it("increments failed attempts on wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      const builder = mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 2,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(builder.set).toHaveBeenCalledWith(
        expect.objectContaining({ failedLoginAttempts: 3 }),
      );
    });

    it("locks account at 5 failed attempts and sends email", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      const builder = mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(builder.set).toHaveBeenCalledWith(
        expect.objectContaining({
          failedLoginAttempts: 5,
          lockedUntil: expect.any(Date),
        }),
      );
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Account Temporarily Locked",
        expect.stringContaining("temporarily locked"),
      );
    });

    it("does not send lockout email for users without email", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        email: null,
        passwordHash: hashedPassword,
        failedLoginAttempts: 4,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("resets failed attempts on successful login", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const builder = mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 3,
      });
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.save.mockResolvedValue(mockUser);

      await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      expect(builder.set).toHaveBeenCalledWith({
        failedLoginAttempts: 0,
        lockedUntil: null,
      });
    });

    it("applies progressive lockout duration", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      const builder = mockLoginQueryBuilder();
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        failedLoginAttempts: 9, // Will become 10, 2nd lockout
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);

      const setArg = builder.set.mock.calls[0][0];
      // 2nd lockout: 30min * 2^1 = 60min
      const lockDuration = setArg.lockedUntil.getTime() - Date.now();
      expect(lockDuration).toBeGreaterThan(55 * 60 * 1000);
      expect(lockDuration).toBeLessThan(65 * 60 * 1000);
    });
  });

  describe("verify2FA", () => {
    it("throws for invalid temp token", async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error("invalid token");
      });

      await expect(service.verify2FA("bad-token", "123456")).rejects.toThrow(
        UnauthorizedException,
      );
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        "2FA verification failed: invalid or expired token",
      );
    });

    it("throws for wrong token type", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "access",
      });

      await expect(service.verify2FA("token", "123456")).rejects.toThrow(
        "Invalid token type",
      );
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid token type"),
      );
    });
  });

  describe("sanitizeUser", () => {
    it("strips sensitive fields from user", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "user-1",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
        })),
        save: jest.fn().mockImplementation((user) => user),
      };
      dataSource.transaction.mockImplementation(
        async (_isolation: string, cb: any) => cb(txManager),
      );

      const result = await service.register({
        email: "test@example.com",
        password: "StrongPass123!",
      });

      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.user).not.toHaveProperty("resetToken");
      expect(result.user).not.toHaveProperty("resetTokenExpiry");
      expect(result.user).not.toHaveProperty("twoFactorSecret");
      expect(result.user).not.toHaveProperty("failedLoginAttempts");
      expect(result.user).not.toHaveProperty("lockedUntil");
      expect(result.user).toHaveProperty("hasPassword");
    });
  });

  describe("resetPassword", () => {
    function mockQueryBuilder(executeResult: { affected: number; raw: any[] }) {
      const builder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(executeResult),
      };
      usersRepository.createQueryBuilder.mockReturnValue(builder);
      return builder;
    }

    it("throws for invalid token", async () => {
      mockQueryBuilder({ affected: 0, raw: [] });

      await expect(
        service.resetPassword("invalid-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws for expired token", async () => {
      mockQueryBuilder({ affected: 0, raw: [] });

      await expect(
        service.resetPassword("expired-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("revokes all refresh tokens after password reset", async () => {
      mockQueryBuilder({ affected: 1, raw: [{ id: mockUser.id }] });
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });

      await service.resetPassword("valid-token", "NewPass123!");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
    });

    it("rejects breached password during reset", async () => {
      passwordBreachService.isBreached.mockResolvedValue(true);

      await expect(
        service.resetPassword("valid-token", "BreachedPass123!"),
      ).rejects.toThrow("found in a data breach");
    });
  });

  describe("revokeRefreshToken", () => {
    it("does nothing for empty token", async () => {
      await service.revokeRefreshToken("");
      expect(refreshTokensRepository.findOne).not.toHaveBeenCalled();
    });

    it("revokes entire family when token found", async () => {
      refreshTokensRepository.findOne.mockResolvedValue({
        familyId: "family-1",
      });
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });

      await service.revokeRefreshToken("some-token");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { familyId: "family-1" },
        { isRevoked: true },
      );
    });
  });

  describe("revokeAllUserRefreshTokens", () => {
    it("revokes all non-revoked tokens for user", async () => {
      refreshTokensRepository.update.mockResolvedValue({ affected: 3 });

      await service.revokeAllUserRefreshTokens("user-1");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe("generateTokenPair", () => {
    it("returns access and refresh tokens", async () => {
      const result = await service.generateTokenPair(mockUser as any);

      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      expect(refreshTokensRepository.save).toHaveBeenCalled();
    });

    it("stores hashed refresh token in DB", async () => {
      await service.generateTokenPair(mockUser as any);

      const savedEntity = refreshTokensRepository.save.mock.calls[0][0];
      expect(savedEntity.tokenHash).toBeTruthy();
      expect(savedEntity.familyId).toBeTruthy();
      expect(savedEntity.isRevoked).toBe(false);
      expect(savedEntity.userId).toBe(mockUser.id);
    });
  });

  // ---------------------------------------------------------------
  // setup2FA
  // ---------------------------------------------------------------

  describe("setup2FA", () => {
    it("generates secret, QR code, and stores encrypted secret", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.setup2FA("user-1");

      expect(result.secret).toBe("TESTSECRET");
      expect(result.qrCodeDataUrl).toBe("data:image/png;base64,mockqrcode");
      expect(result.otpauthUrl).toContain("otpauth://");
      expect(otplib.generateSecret).toHaveBeenCalled();
      expect(otplib.generateURI).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: "TESTSECRET",
          issuer: "Monize",
          label: mockUser.email,
        }),
      );
      expect(QRCode.toDataURL).toHaveBeenCalled();

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.pendingTwoFactorSecret).toBeTruthy();
      expect(savedUser.pendingTwoFactorSecret).not.toBe("TESTSECRET"); // should be encrypted
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.setup2FA("nonexistent")).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.setup2FA("nonexistent")).rejects.toThrow(
        "User not found",
      );
    });

    it("throws BadRequestException for SSO users", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        authProvider: "oidc",
      });

      await expect(service.setup2FA("user-1")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.setup2FA("user-1")).rejects.toThrow(
        "Two-factor authentication is not available for SSO accounts",
      );
    });
  });

  // ---------------------------------------------------------------
  // confirmSetup2FA
  // ---------------------------------------------------------------

  describe("confirmSetup2FA", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("validates code and enables 2FA in preferences", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        twoFactorEnabled: false,
      });
      preferencesRepository.save.mockImplementation((p) => p);

      const result = await service.confirmSetup2FA("user-1", "123456");

      expect(result.message).toContain("enabled successfully");
      expect(otplib.verifySync).toHaveBeenCalledWith(
        expect.objectContaining({ token: "123456", secret: "TESTSECRET" }),
      );
      // H5: pending secret promoted to active, pending cleared
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBe(encryptedSecret);
      expect(savedUser.pendingTwoFactorSecret).toBeNull();
      const savedPrefs = preferencesRepository.save.mock.calls[0][0];
      expect(savedPrefs.twoFactorEnabled).toBe(true);
    });

    it("creates preferences if they do not exist yet", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue(null);
      preferencesRepository.create.mockImplementation((data) => ({
        ...data,
        twoFactorEnabled: false,
      }));
      preferencesRepository.save.mockImplementation((p) => p);

      await service.confirmSetup2FA("user-1", "123456");

      expect(preferencesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1" }),
      );
      const savedPrefs = preferencesRepository.save.mock.calls[0][0];
      expect(savedPrefs.twoFactorEnabled).toBe(true);
    });

    it("throws for invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.confirmSetup2FA("user-1", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("throws when 2FA setup not initiated (no user)", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        "2FA setup not initiated",
      );
    });

    it("throws when 2FA setup not initiated (no secret)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        pendingTwoFactorSecret: null,
      });

      await expect(service.confirmSetup2FA("user-1", "123456")).rejects.toThrow(
        "2FA setup not initiated",
      );
    });
  });

  // ---------------------------------------------------------------
  // disable2FA
  // ---------------------------------------------------------------

  describe("disable2FA", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("validates code, clears secret, disables preferences, revokes trusted devices", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        twoFactorEnabled: true,
      });
      preferencesRepository.save.mockImplementation((p) => p);
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 2 });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");

      // Secret should be cleared
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.twoFactorSecret).toBeNull();

      // Preferences should be disabled
      const savedPrefs = preferencesRepository.save.mock.calls[0][0];
      expect(savedPrefs.twoFactorEnabled).toBe(false);

      // Trusted devices should be revoked
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("throws ForbiddenException when FORCE_2FA is enabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          if (key === "JWT_SECRET")
            return "test-jwt-secret-minimum-32-chars-long";
          if (key === "FORCE_2FA") return "true";
          return defaultValue || undefined;
        },
      );

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "required by the administrator",
      );
    });

    it("throws for invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.disable2FA("user-1", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("throws when 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "2FA is not enabled",
      );
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.disable2FA("user-1", "123456")).rejects.toThrow(
        "2FA is not enabled",
      );
    });

    it("handles case where preferences do not exist", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue(null);
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.disable2FA("user-1", "123456");

      expect(result.message).toContain("disabled successfully");
      expect(preferencesRepository.save).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // verify2FA - success path
  // ---------------------------------------------------------------

  describe("verify2FA - success path", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("returns tokens on valid code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.verify2FA("valid-temp-token", "123456");

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      expect(result.trustedDeviceToken).toBeUndefined();
    });

    it("creates trusted device token when rememberDevice is true", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);
      trustedDevicesRepository.create.mockImplementation((data) => data);
      trustedDevicesRepository.save.mockResolvedValue({});

      const result = await service.verify2FA(
        "valid-temp-token",
        "123456",
        true,
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "192.168.1.1",
      );

      expect(result.trustedDeviceToken).toBeTruthy();
      expect(trustedDevicesRepository.save).toHaveBeenCalled();
    });

    it("throws for invalid code during verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.verify2FA("valid-temp-token", "000000"),
      ).rejects.toThrow("Invalid verification code");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid code"),
      );
    });

    it("throws for missing user or secret", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.verify2FA("valid-temp-token", "123456"),
      ).rejects.toThrow("Invalid verification state");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid state"),
      );
    });

    it("throws for user with no twoFactorSecret", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(
        service.verify2FA("valid-temp-token", "123456"),
      ).rejects.toThrow("Invalid verification state");
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification failed: invalid state"),
      );
    });

    it("updates lastLogin on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      usersRepository.save.mockImplementation((u) => u);

      await service.verify2FA("valid-temp-token", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.lastLogin).toBeInstanceOf(Date);
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("2FA verification successful"),
      );
    });
  });

  // ---------------------------------------------------------------
  // findOrCreateOidcUser
  // ---------------------------------------------------------------

  describe("findOrCreateOidcUser", () => {
    /**
     * Helper: set up dataSource.transaction mock for findOrCreateOidcUser's
     * SERIALIZABLE transaction: dataSource.transaction("SERIALIZABLE", async (manager) => {...})
     */
    function setupOidcTransactionMock(
      userCount: number,
      overrides: Record<string, jest.Mock> = {},
    ) {
      const txManager = {
        count: jest.fn().mockResolvedValue(userCount),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "oidc-new",
        })),
        save: jest.fn().mockImplementation((user) => user),
        findOne: jest.fn(),
        ...overrides,
      };
      dataSource.transaction.mockImplementation(
        async (_isolation: string, cb: any) => cb(txManager),
      );
      return txManager;
    }

    it("creates new user with verified email", async () => {
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null); // no existing by email
      const txManager = setupOidcTransactionMock(1); // not first user
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-user-1",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        email_verified: true,
        given_name: "OIDC",
        family_name: "User",
      });

      expect(result.user.email).toBe("oidc@example.com");
      expect(result.user.oidcSubject).toBe("oidc-sub-123");
      expect(result.user.authProvider).toBe("oidc");
      expect(result.user.firstName).toBe("OIDC");
      expect(result.user.lastName).toBe("User");
    });

    it("creates new user with unverified email (email stored but not linked)", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by subject
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-user-2",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-456",
        email: "unverified@example.com",
        email_verified: false,
      });

      // Unverified email should still be stored
      expect(result.user.email).toBe("unverified@example.com");
      // Should NOT have looked up by email (only 1 findOne call for oidcSubject)
      expect(usersRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("initiates pending link for local account with verified email (M6)", async () => {
      const existingLocal = {
        ...mockUser,
        id: "existing-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: "$2a$10$somehash",
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(existingLocal); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-link",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("existing-user");
      // M6: Should initiate pending link, NOT direct link
      expect(existingLocal.oidcLinkPending).toBe(true);
      expect(existingLocal.pendingOidcSubject).toBe("oidc-sub-link");
      // oidcSubject should NOT be directly set
      expect(existingLocal.oidcSubject).toBeNull();
    });

    it("directly links OIDC-only accounts without confirmation", async () => {
      const existingOidcOnly = {
        ...mockUser,
        id: "oidc-only-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: null, // No password = OIDC-only account
      };
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(existingOidcOnly); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-direct",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("oidc-only-user");
      expect(result.user.oidcSubject).toBe("oidc-sub-direct");
      expect(result.user.authProvider).toBe("oidc");
    });

    it("does NOT link to existing user when email is unverified", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by oidcSubject
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "new-oidc",
      }));
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-nolink",
        email: "test@example.com",
        email_verified: false,
      });

      // Only 1 findOne (for oidcSubject), not 2 (no email lookup)
      expect(usersRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("updates existing user info when changed", async () => {
      const existingOidcUser = {
        ...mockUser,
        id: "oidc-existing",
        oidcSubject: "oidc-sub-existing",
        authProvider: "oidc",
        firstName: "Old",
        lastName: "Name",
      };
      usersRepository.findOne.mockResolvedValue(existingOidcUser);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-existing",
        email: "newemail@example.com",
        email_verified: true,
        given_name: "New",
        family_name: "Name",
      });

      expect(result.user.email).toBe("newemail@example.com");
      expect(result.user.firstName).toBe("New");
    });

    it("does not update when info has not changed", async () => {
      const existingOidcUser = {
        ...mockUser,
        id: "oidc-existing",
        oidcSubject: "oidc-sub-same",
        authProvider: "oidc",
        firstName: "Test",
        lastName: "User",
        email: "test@example.com",
      };
      usersRepository.findOne.mockResolvedValue(existingOidcUser);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-same",
        email: "test@example.com",
        email_verified: true,
        given_name: "Test",
        family_name: "User",
      });

      // save called once for lastLogin update only (not for field updates)
      expect(usersRepository.save).toHaveBeenCalledTimes(1);
    });

    it("throws ForbiddenException when registration is disabled", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOrCreateOidcUser(
          { sub: "oidc-new", email: "new@example.com", email_verified: true },
          false, // registrationEnabled = false
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("handles duplicate email constraint error (code 23505) with passwordless account", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      const existingUser = {
        ...mockUser,
        id: "existing-dup",
        passwordHash: null,
        authProvider: "oidc",
        oidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null) // no existing by email (race condition)
        .mockResolvedValueOnce(existingUser); // found after duplicate error

      // C9: transaction throws duplicate error
      dataSource.transaction.mockRejectedValue(duplicateError);

      usersRepository.save.mockImplementation((u) => u); // subsequent saves succeed

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-dup",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.id).toBe("existing-dup");
      expect(result.user.oidcSubject).toBe("oidc-sub-dup");
    });

    it("initiates OIDC link confirmation in catch path for local account with password", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      const existingLocal = {
        ...mockUser,
        id: "existing-local-catch",
        passwordHash: "$2a$10$hashedpassword",
        authProvider: "local",
        oidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null) // no existing by email (race condition)
        .mockResolvedValueOnce(existingLocal); // found after duplicate error

      dataSource.transaction.mockRejectedValue(duplicateError);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-catch-link",
        email: "test@example.com",
        email_verified: true,
      });

      // Should return existing user without completing the link
      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("existing-local-catch");
      expect(result.user.oidcSubject).toBeNull(); // Link not completed
      expect((service as any).logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("OIDC link pending confirmation (catch path)"),
      );
    });

    it("re-throws duplicate email error when email is unverified", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      usersRepository.findOne.mockResolvedValue(null);

      // C9: transaction throws duplicate error
      dataSource.transaction.mockRejectedValue(duplicateError);

      await expect(
        service.findOrCreateOidcUser({
          sub: "oidc-sub-dup2",
          email: "test@example.com",
          email_verified: false,
        }),
      ).rejects.toThrow("duplicate key");
    });

    it("first OIDC user becomes admin", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(0); // first user
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "first-oidc",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-admin",
        email: "admin-oidc@example.com",
        email_verified: true,
      });

      expect(result.user.role).toBe("admin");
    });

    it("throws for missing subject identifier", async () => {
      await expect(
        service.findOrCreateOidcUser({
          email: "no-sub@example.com",
          email_verified: true,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("uses preferred_username as firstName fallback", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-pref",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-pref",
        preferred_username: "johndoe",
        email_verified: false,
      });

      expect(result.user.firstName).toBe("johndoe");
    });

    it("uses full name split for firstName/lastName when specific claims absent", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = setupOidcTransactionMock(1);
      txManager.create.mockImplementation((_entity, data) => ({
        ...data,
        id: "oidc-name",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-name",
        name: "John Michael Doe",
        email_verified: false,
      });

      expect(result.user.firstName).toBe("John");
      expect(result.user.lastName).toBe("Michael Doe");
    });

    it("clears 2FA config for SSO users who have it", async () => {
      const userWith2FA = {
        ...mockUser,
        id: "oidc-2fa",
        oidcSubject: "oidc-sub-2fa",
        authProvider: "oidc",
        twoFactorSecret: "encrypted-secret",
        pendingTwoFactorSecret: "pending-secret",
        backupCodes: '["code1","code2"]',
      };
      usersRepository.findOne.mockResolvedValue(userWith2FA);
      usersRepository.save.mockImplementation((u) => u);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "oidc-2fa",
        twoFactorEnabled: true,
      });
      preferencesRepository.save.mockImplementation((p) => p);
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 2 });

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-2fa",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.user.twoFactorSecret).toBeNull();
      expect(result.user.pendingTwoFactorSecret).toBeNull();
      expect(result.user.backupCodes).toBeNull();
      expect(preferencesRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorEnabled: false }),
      );
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "oidc-2fa",
      });
    });

    it("does not clear 2FA config when SSO user has no 2FA", async () => {
      const userWithout2FA = {
        ...mockUser,
        id: "oidc-no2fa",
        oidcSubject: "oidc-sub-no2fa",
        authProvider: "oidc",
        twoFactorSecret: null,
        pendingTwoFactorSecret: null,
        backupCodes: null,
      };
      usersRepository.findOne.mockResolvedValue(userWithout2FA);
      usersRepository.save.mockImplementation((u) => u);

      await service.findOrCreateOidcUser({
        sub: "oidc-sub-no2fa",
        email: "test@example.com",
        email_verified: true,
      });

      // preferencesRepository.findOne should NOT be called for 2FA cleanup
      // (only the lastLogin save should happen)
      expect(trustedDevicesRepository.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // validateOidcUser
  // ---------------------------------------------------------------

  describe("validateOidcUser", () => {
    it("delegates to findOrCreateOidcUser and sanitizes", async () => {
      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null); // no existing by email
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "oidc-val",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
        })),
        save: jest.fn().mockImplementation((user) => user),
        findOne: jest.fn(),
      };
      dataSource.transaction.mockImplementation(
        async (_isolation: string, cb: any) => cb(txManager),
      );
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.validateOidcUser({
        sub: "oidc-sub-validate",
        email: "val@example.com",
        email_verified: true,
      });

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).toHaveProperty("hasPassword");
    });
  });

  // ---------------------------------------------------------------
  // refreshTokens
  // ---------------------------------------------------------------

  describe("refreshTokens", () => {
    function setupTransactionMock(managerOverrides = {}) {
      const manager = {
        findOne: jest.fn(),
        save: jest.fn().mockImplementation((data) => data),
        update: jest.fn(),
        create: jest.fn().mockImplementation((_entity, data) => data),
        ...managerOverrides,
      };
      dataSource.transaction.mockImplementation(async (cb: any) => cb(manager));
      return manager;
    }

    it("rotates token successfully", async () => {
      const existingToken = {
        id: "rt-1",
        userId: "user-1",
        tokenHash: "old-hash",
        familyId: "family-1",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
        replacedByHash: null,
      };
      const manager = setupTransactionMock();
      manager.findOne
        .mockResolvedValueOnce(existingToken) // RefreshToken lookup
        .mockResolvedValueOnce({ ...mockUser }); // User lookup

      const result = await service.refreshTokens("raw-refresh-token");

      expect(result.accessToken).toBe("mock-jwt-token");
      expect(result.refreshToken).toBeTruthy();
      // Old token should be marked as revoked with replacedByHash
      expect(manager.save).toHaveBeenCalled();
      const savedOldToken = manager.save.mock.calls[0][0];
      expect(savedOldToken.isRevoked).toBe(true);
      expect(savedOldToken.replacedByHash).toBeTruthy();
    });

    it("detects replay and revokes entire family", async () => {
      const revokedToken = {
        id: "rt-revoked",
        userId: "user-1",
        tokenHash: "revoked-hash",
        familyId: "family-replay",
        isRevoked: true, // already revoked = replay
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      manager.findOne.mockResolvedValueOnce(revokedToken);

      await expect(
        service.refreshTokens("reused-refresh-token"),
      ).rejects.toThrow("Refresh token reuse detected");

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-replay" },
        { isRevoked: true },
      );
    });

    it("throws for expired refresh token", async () => {
      const expiredToken = {
        id: "rt-expired",
        userId: "user-1",
        tokenHash: "expired-hash",
        familyId: "family-expired",
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000), // expired
      };
      const manager = setupTransactionMock();
      manager.findOne.mockResolvedValueOnce(expiredToken);

      await expect(
        service.refreshTokens("expired-refresh-token"),
      ).rejects.toThrow("Refresh token expired");

      // Token should be revoked
      const savedToken = manager.save.mock.calls[0][0];
      expect(savedToken.isRevoked).toBe(true);
    });

    it("throws for inactive user and revokes family", async () => {
      const validToken = {
        id: "rt-valid",
        userId: "user-1",
        tokenHash: "valid-hash",
        familyId: "family-inactive",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      manager.findOne
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce({ ...mockUser, isActive: false });

      await expect(
        service.refreshTokens("valid-token-inactive-user"),
      ).rejects.toThrow("User not found or inactive");

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-inactive" },
        { isRevoked: true },
      );
    });

    it("throws for unknown refresh token", async () => {
      const manager = setupTransactionMock();
      manager.findOne.mockResolvedValueOnce(null);

      await expect(
        service.refreshTokens("unknown-refresh-token"),
      ).rejects.toThrow("Invalid refresh token");
    });

    it("throws when user not found and revokes family", async () => {
      const validToken = {
        id: "rt-valid",
        userId: "user-gone",
        tokenHash: "valid-hash",
        familyId: "family-gone",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
      };
      const manager = setupTransactionMock();
      manager.findOne
        .mockResolvedValueOnce(validToken)
        .mockResolvedValueOnce(null); // user not found

      await expect(service.refreshTokens("token-no-user")).rejects.toThrow(
        "User not found or inactive",
      );

      expect(manager.update).toHaveBeenCalledWith(
        RefreshToken,
        { familyId: "family-gone" },
        { isRevoked: true },
      );
    });

    it("new token uses same familyId for rotation tracking", async () => {
      const existingToken = {
        id: "rt-1",
        userId: "user-1",
        tokenHash: "old-hash",
        familyId: "family-track",
        isRevoked: false,
        expiresAt: new Date(Date.now() + 3600000),
        replacedByHash: null,
      };
      const manager = setupTransactionMock();
      manager.findOne
        .mockResolvedValueOnce(existingToken)
        .mockResolvedValueOnce({ ...mockUser });

      await service.refreshTokens("raw-token");

      const newTokenCreated = manager.create.mock.calls[0][1];
      expect(newTokenCreated.familyId).toBe("family-track");
      expect(newTokenCreated.isRevoked).toBe(false);
    });
  });

  // ---------------------------------------------------------------
  // purgeExpiredRefreshTokens
  // ---------------------------------------------------------------

  describe("purgeExpiredRefreshTokens", () => {
    it("deletes expired and revoked tokens", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: 5 })
        .mockResolvedValueOnce({ affected: 3 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expect.anything(),
        }),
      );
      expect(refreshTokensRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          isRevoked: true,
        }),
      );
    });

    it("does not log when no tokens purged", async () => {
      refreshTokensRepository.delete
        .mockResolvedValueOnce({ affected: 0 })
        .mockResolvedValueOnce({ affected: 0 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledTimes(2);
    });
  });

  // ---------------------------------------------------------------
  // generateResetToken
  // ---------------------------------------------------------------

  describe("generateResetToken", () => {
    it("generates token, stores hashed version, sets expiry", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: "$2a$10$hash",
      });
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.generateResetToken("test@example.com");

      expect(result).not.toBeNull();
      expect(result!.token).toBeTruthy();
      expect(result!.user.email).toBe("test@example.com");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.resetToken).toBeTruthy();
      // Token should be hashed (not the raw token)
      expect(savedUser.resetToken).not.toBe(result!.token);
      expect(savedUser.resetTokenExpiry).toBeInstanceOf(Date);
      expect(savedUser.resetTokenExpiry.getTime()).toBeGreaterThan(Date.now());
    });

    it("returns null for non-existent user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.generateResetToken("nobody@example.com");

      expect(result).toBeNull();
    });

    it("returns null for user without password (OIDC only)", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });

      const result = await service.generateResetToken("oidc@example.com");

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // resetPassword - success path
  // ---------------------------------------------------------------

  describe("resetPassword - success path", () => {
    it("updates password hash, clears token, revokes all refresh tokens", async () => {
      const rawToken = "test-reset-token-hex-value";

      const mockExecute = jest.fn().mockResolvedValue({
        affected: 1,
        raw: [{ id: mockUser.id }],
      });
      const builder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        returning: jest.fn().mockReturnThis(),
        execute: mockExecute,
      };
      usersRepository.createQueryBuilder.mockReturnValue(builder);
      refreshTokensRepository.update.mockResolvedValue({ affected: 2 });

      await service.resetPassword(rawToken, "NewSecurePass123!");

      // The query builder should have been used to update the user
      expect(usersRepository.createQueryBuilder).toHaveBeenCalled();
      expect(builder.update).toHaveBeenCalled();

      // Password hash should have been set (not plaintext)
      const setArg = builder.set.mock.calls[0][0];
      expect(setArg.passwordHash).toBeTruthy();
      expect(setArg.passwordHash).not.toBe("NewSecurePass123!");
      const isPasswordValid = await bcrypt.compare(
        "NewSecurePass123!",
        setArg.passwordHash,
      );
      expect(isPasswordValid).toBe(true);

      // Token fields should be cleared
      expect(setArg.resetToken).toBeNull();
      expect(setArg.resetTokenExpiry).toBeNull();

      // All refresh tokens should be revoked using the userId from the result
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  // ---------------------------------------------------------------
  // createTrustedDevice
  // ---------------------------------------------------------------

  describe("createTrustedDevice", () => {
    it("creates device with hashed token and parsed device name", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-1",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-1" });

      const token = await service.createTrustedDevice(
        "user-1",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "192.168.1.100",
      );

      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.userId).toBe("user-1");
      expect(createdDevice.tokenHash).toBeTruthy();
      expect(createdDevice.deviceName).toContain("Chrome");
      expect(createdDevice.ipAddress).toBe("192.168.1.100");
      expect(createdDevice.expiresAt).toBeInstanceOf(Date);
      expect(createdDevice.lastUsedAt).toBeInstanceOf(Date);
    });

    it("stores hashed token, not raw token", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-2",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-2" });

      const rawToken = await service.createTrustedDevice(
        "user-1",
        "Unknown Device",
      );

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      // The stored hash should not equal the raw token
      expect(createdDevice.tokenHash).not.toBe(rawToken);
      expect(createdDevice.tokenHash.length).toBe(64); // SHA-256 hex length
    });

    it("handles Unknown Device user agent", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-3",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-3" });

      await service.createTrustedDevice("user-1", "Unknown Device");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.deviceName).toBe("Unknown Device");
    });

    it("sets null for ipAddress when not provided", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => ({
        ...data,
        id: "device-4",
      }));
      trustedDevicesRepository.save.mockResolvedValue({ id: "device-4" });

      await service.createTrustedDevice("user-1", "SomeAgent");

      const createdDevice = trustedDevicesRepository.create.mock.calls[0][0];
      expect(createdDevice.ipAddress).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // validateTrustedDevice
  // ---------------------------------------------------------------

  describe("validateTrustedDevice", () => {
    it("returns true and updates lastUsedAt for valid device", async () => {
      const oldDate = new Date("2025-01-01T00:00:00Z");
      const device = {
        id: "device-1",
        userId: "user-1",
        tokenHash: "some-hash",
        expiresAt: new Date(Date.now() + 86400000), // future
        lastUsedAt: oldDate,
      };
      trustedDevicesRepository.findOne.mockResolvedValue(device);
      trustedDevicesRepository.save.mockImplementation((d) => d);

      const result = await service.validateTrustedDevice(
        "user-1",
        "device-token",
      );

      expect(result).toBe(true);
      const savedDevice = trustedDevicesRepository.save.mock.calls[0][0];
      expect(savedDevice.lastUsedAt).toBeInstanceOf(Date);
      expect(savedDevice.lastUsedAt.getTime()).toBeGreaterThan(
        oldDate.getTime(),
      );
    });

    it("removes expired device and returns false", async () => {
      const expiredDevice = {
        id: "device-expired",
        userId: "user-1",
        tokenHash: "expired-hash",
        expiresAt: new Date(Date.now() - 1000), // expired
        lastUsedAt: new Date(),
      };
      trustedDevicesRepository.findOne.mockResolvedValue(expiredDevice);
      trustedDevicesRepository.remove.mockResolvedValue(expiredDevice);

      const result = await service.validateTrustedDevice(
        "user-1",
        "expired-device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(
        expiredDevice,
      );
    });

    it("returns false for unknown device", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.validateTrustedDevice(
        "user-1",
        "unknown-device-token",
      );

      expect(result).toBe(false);
      expect(trustedDevicesRepository.remove).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // getTrustedDevices
  // ---------------------------------------------------------------

  describe("getTrustedDevices", () => {
    it("cleans expired devices and returns sorted by lastUsedAt", async () => {
      const devices = [
        { id: "d1", lastUsedAt: new Date("2026-01-02") },
        { id: "d2", lastUsedAt: new Date("2026-01-01") },
      ];
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 1 });
      trustedDevicesRepository.find.mockResolvedValue(devices);

      const result = await service.getTrustedDevices("user-1");

      // Should first delete expired devices
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          expiresAt: expect.anything(),
        }),
      );

      // Should return results sorted by lastUsedAt DESC
      expect(trustedDevicesRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: "user-1" },
          order: { lastUsedAt: "DESC" },
        }),
      );

      expect(result).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------
  // revokeTrustedDevice
  // ---------------------------------------------------------------

  describe("revokeTrustedDevice", () => {
    it("removes the device", async () => {
      const device = { id: "device-1", userId: "user-1" };
      trustedDevicesRepository.findOne.mockResolvedValue(device);
      trustedDevicesRepository.remove.mockResolvedValue(device);

      await service.revokeTrustedDevice("user-1", "device-1");

      expect(trustedDevicesRepository.findOne).toHaveBeenCalledWith({
        where: { id: "device-1", userId: "user-1" },
      });
      expect(trustedDevicesRepository.remove).toHaveBeenCalledWith(device);
    });

    it("throws NotFoundException when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.revokeTrustedDevice("user-1", "nonexistent"),
      ).rejects.toThrow("Device not found");
    });
  });

  // ---------------------------------------------------------------
  // revokeAllTrustedDevices
  // ---------------------------------------------------------------

  describe("revokeAllTrustedDevices", () => {
    it("returns affected count", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 3 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(3);
      expect(trustedDevicesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
    });

    it("returns 0 when no devices exist", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({ affected: 0 });

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });

    it("returns 0 when affected is undefined", async () => {
      trustedDevicesRepository.delete.mockResolvedValue({});

      const result = await service.revokeAllTrustedDevices("user-1");

      expect(result).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // findTrustedDeviceByToken
  // ---------------------------------------------------------------

  describe("findTrustedDeviceByToken", () => {
    it("returns device id when found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "device-found",
        userId: "user-1",
      });

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "device-token",
      );

      expect(result).toBe("device-found");
    });

    it("returns null when device not found", async () => {
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.findTrustedDeviceByToken(
        "user-1",
        "unknown-token",
      );

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // login with trusted device
  // ---------------------------------------------------------------

  describe("login with trusted device bypassing 2FA", () => {
    it("bypasses 2FA when trustedDeviceToken is valid", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const jwtSecret = "test-jwt-secret-minimum-32-chars-long";
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      // Mock validateTrustedDevice to return true
      trustedDevicesRepository.findOne.mockResolvedValue({
        id: "trusted-device-1",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 86400000),
        lastUsedAt: new Date(),
      });
      trustedDevicesRepository.save.mockImplementation((d) => d);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.login(
        { email: "test@example.com", password: "ValidPass123!" },
        "trusted-device-token",
      );

      // Should return full auth response, not 2FA required
      expect(result.requires2FA).toBeUndefined();
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      expect(result.user).toBeDefined();
      expect((service as any).logger.log).toHaveBeenCalledWith(
        expect.stringContaining("Login successful (trusted device)"),
      );
    });

    it("falls back to 2FA when trusted device is invalid", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const jwtSecret = "test-jwt-secret-minimum-32-chars-long";
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      // Mock validateTrustedDevice to return false (unknown device)
      trustedDevicesRepository.findOne.mockResolvedValue(null);

      const result = await service.login(
        { email: "test@example.com", password: "ValidPass123!" },
        "invalid-device-token",
      );

      // Should require 2FA
      expect(result.requires2FA).toBe(true);
      expect(result.tempToken).toBeDefined();
    });

    it("does not check trusted device when no token provided", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const jwtSecret = "test-jwt-secret-minimum-32-chars-long";
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
        twoFactorSecret: encryptedSecret,
      });
      preferencesRepository.findOne.mockResolvedValue({
        twoFactorEnabled: true,
      });

      const result = await service.login({
        email: "test@example.com",
        password: "ValidPass123!",
      });

      // Should require 2FA, no trusted device check
      expect(result.requires2FA).toBe(true);
      expect(trustedDevicesRepository.findOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------
  // M4: 2FA attempt tracking
  // ---------------------------------------------------------------

  describe("verify2FA - attempt tracking (M4)", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    beforeEach(() => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
    });

    it("blocks after 3 failed attempts on the same temp token", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await expect(
          service.verify2FA("same-temp-token", "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // 4th attempt should be blocked before even checking the code
      await expect(
        service.verify2FA("same-temp-token", "000000"),
      ).rejects.toThrow("Too many verification attempts");
    });

    it("allows attempts on different temp tokens independently", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      // 2 failures on token-A
      await expect(service.verify2FA("token-A", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
      await expect(service.verify2FA("token-A", "000000")).rejects.toThrow(
        "Invalid verification code",
      );

      // 1 failure on token-B
      await expect(service.verify2FA("token-B", "000000")).rejects.toThrow(
        "Invalid verification code",
      );

      // token-B should still have attempts remaining
      await expect(service.verify2FA("token-B", "000000")).rejects.toThrow(
        "Invalid verification code",
      );
    });

    it("clears attempt counter on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);

      // 2 failed attempts
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      await expect(
        service.verify2FA("clearable-token", "000000"),
      ).rejects.toThrow("Invalid verification code");
      await expect(
        service.verify2FA("clearable-token", "000000"),
      ).rejects.toThrow("Invalid verification code");

      // Successful attempt
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const result = await service.verify2FA("clearable-token", "123456");
      expect(result.user).toBeDefined();
    });
  });

  // ---------------------------------------------------------------
  // M5: Trusted device lifetime (14 days)
  // ---------------------------------------------------------------

  describe("createTrustedDevice - M5: 14-day expiry", () => {
    it("creates device with 14-day expiry", async () => {
      trustedDevicesRepository.create.mockImplementation((data) => data);
      trustedDevicesRepository.save.mockResolvedValue({});

      const beforeCreate = Date.now();
      await service.createTrustedDevice("user-1", "Mozilla/5.0", "1.2.3.4");

      const savedDevice = trustedDevicesRepository.create.mock.calls[0][0];
      const expiryMs = savedDevice.expiresAt.getTime() - beforeCreate;
      const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;

      // Expiry should be about 14 days (within 5 seconds tolerance)
      expect(expiryMs).toBeGreaterThan(fourteenDaysMs - 5000);
      expect(expiryMs).toBeLessThanOrEqual(fourteenDaysMs + 5000);
    });
  });

  // ---------------------------------------------------------------
  // M7: Per-email rate limiting for forgot-password
  // ---------------------------------------------------------------

  describe("checkForgotPasswordEmailLimit (M7)", () => {
    it("allows first 3 requests for an email", () => {
      expect(service.checkForgotPasswordEmailLimit("test@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("test@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("test@example.com")).toBe(
        true,
      );
    });

    it("blocks the 4th request for the same email within the window", () => {
      expect(service.checkForgotPasswordEmailLimit("block@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("block@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("block@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("block@example.com")).toBe(
        false,
      );
    });

    it("normalizes email case", () => {
      expect(service.checkForgotPasswordEmailLimit("UPPER@Example.COM")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("upper@example.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("Upper@EXAMPLE.com")).toBe(
        true,
      );
      expect(service.checkForgotPasswordEmailLimit("upper@example.com")).toBe(
        false,
      );
    });

    it("tracks different emails independently", () => {
      expect(service.checkForgotPasswordEmailLimit("a@test.com")).toBe(true);
      expect(service.checkForgotPasswordEmailLimit("a@test.com")).toBe(true);
      expect(service.checkForgotPasswordEmailLimit("a@test.com")).toBe(true);
      expect(service.checkForgotPasswordEmailLimit("b@test.com")).toBe(true); // different email
    });
  });

  // ---------------------------------------------------------------
  // M6: OIDC link confirmation
  // ---------------------------------------------------------------

  describe("OIDC link confirmation (M6)", () => {
    it("initiateOidcLink stores pending link data", async () => {
      const existingUser = {
        ...mockUser,
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };
      usersRepository.save.mockImplementation((u) => u);

      const token = await service.initiateOidcLink(
        existingUser as any,
        "oidc-sub-new",
      );

      expect(token).toBeTruthy();
      expect(existingUser.oidcLinkPending).toBe(true);
      expect(existingUser.pendingOidcSubject).toBe("oidc-sub-new");
      expect(existingUser.oidcLinkToken).toBeTruthy();
      expect(existingUser.oidcLinkExpiresAt).toBeInstanceOf(Date);
    });

    it("confirmOidcLink completes the link with valid token", async () => {
      const futureDate = new Date(Date.now() + 3600000);
      const pendingUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: futureDate,
        pendingOidcSubject: "oidc-sub-confirmed",
      };
      usersRepository.findOne.mockResolvedValue(pendingUser);
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.confirmOidcLink("some-token");

      expect(result.oidcSubject).toBe("oidc-sub-confirmed");
      expect(result.authProvider).toBe("oidc");
      expect(result.oidcLinkPending).toBe(false);
      expect(result.oidcLinkToken).toBeNull();
      expect(result.pendingOidcSubject).toBeNull();
    });

    it("confirmOidcLink throws for expired token", async () => {
      const pastDate = new Date(Date.now() - 3600000);
      const expiredUser = {
        ...mockUser,
        oidcLinkPending: true,
        oidcLinkExpiresAt: pastDate,
        pendingOidcSubject: "oidc-sub-expired",
      };
      usersRepository.findOne.mockResolvedValue(expiredUser);
      usersRepository.save.mockImplementation((u) => u);

      await expect(service.confirmOidcLink("expired-token")).rejects.toThrow(
        "Link token has expired",
      );
    });

    it("confirmOidcLink throws for invalid token", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.confirmOidcLink("invalid-token")).rejects.toThrow(
        "Invalid or expired link token",
      );
    });

    it("findOrCreateOidcUser initiates link instead of direct linking for local accounts", async () => {
      const existingLocal = {
        ...mockUser,
        id: "local-user",
        authProvider: "local",
        oidcSubject: null,
        passwordHash: "$2a$10$somehash",
        oidcLinkPending: false,
        oidcLinkToken: null,
        oidcLinkExpiresAt: null,
        pendingOidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no user by oidcSubject
        .mockResolvedValueOnce(existingLocal); // found by email
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-link",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.linkPending).toBe(true);
      expect(result.user.id).toBe("local-user");
      // Should have set oidcLinkPending to true
      expect(existingLocal.oidcLinkPending).toBe(true);
      expect(existingLocal.pendingOidcSubject).toBe("oidc-sub-link");
      // oidcSubject should NOT be directly set
      expect(existingLocal.oidcSubject).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // L5: Backup codes
  // ---------------------------------------------------------------

  describe("generateBackupCodes (L5)", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("generates 12 backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const codes = await service.generateBackupCodes("user-1", "123456");

      expect(codes).toHaveLength(12);
      codes.forEach((code) => {
        expect(code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      });
    });

    it("stores hashed codes in user entity", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.backupCodes).toBeTruthy();
      const hashedCodes = JSON.parse(savedUser.backupCodes);
      expect(hashedCodes).toHaveLength(12);
      // Hashed codes should be bcrypt hashes
      hashedCodes.forEach((hash: string) => {
        expect(hash).toMatch(/^\$2[ab]\$\d+\$/);
      });
    });

    it("throws if user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.generateBackupCodes("nonexistent", "123456"),
      ).rejects.toThrow("User not found");
    });

    it("throws if 2FA is not enabled", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: null,
      });

      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.generateBackupCodes("user-1", "123456"),
      ).rejects.toThrow("2FA is not enabled");
    });

    it("throws on invalid verification code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.generateBackupCodes("user-1", "000000"),
      ).rejects.toThrow("Invalid verification code");
    });
  });

  describe("verify2FA with backup code (L5)", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    function setupBackupCodeQueryRunner(backupCodes: string) {
      const mockSetFn = jest.fn().mockReturnThis();
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          backupCodes,
        }),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: mockSetFn,
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      };
      const mockQueryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: mockQRManager,
      };
      dataSource.createQueryRunner.mockReturnValue(mockQueryRunner);
      return { mockQueryRunner, mockQRManager, mockSetFn };
    }

    it("accepts a valid backup code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      // Generate real backup codes
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      // Now set up user with backup codes for verify2FA
      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verify2FA("backup-token", codes[0]);

      expect(result.user).toBeDefined();
      expect(result.accessToken).toBeDefined();
    });

    it("removes used backup code after verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      const { mockSetFn } = setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await service.verify2FA("backup-used-token", codes[0]);

      // After using the code, the atomic update should save 11 remaining codes
      const savedBackupCodes = mockSetFn.mock.calls[0][0].backupCodes;
      const updatedCodes = JSON.parse(savedBackupCodes);
      expect(updatedCodes).toHaveLength(11);
    });

    it("rejects invalid backup code", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const hashedCodes = [await bcrypt.hash("abcd-1234", 10)];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(hashedCodes),
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);

      await expect(
        service.verify2FA("bad-backup-token", "dead-beef"),
      ).rejects.toThrow("Invalid verification code");
    });

    it("does not call otplib.verifySync for backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");

      const savedUser = usersRepository.save.mock.calls[0][0];
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      };

      setupBackupCodeQueryRunner(savedUser.backupCodes);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockClear();

      await service.verify2FA("backup-routing-token", codes[0]);

      expect(otplib.verifySync).not.toHaveBeenCalled();
    });

    it("does not try backup codes for 6-digit TOTP codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const userWithCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(["some-hash"]),
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithCodes);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });

      const result = await service.verify2FA("totp-routing-token", "123456");

      expect(otplib.verifySync).toHaveBeenCalled();
      expect(result.user).toBeDefined();
    });

    it("rejects non-6-digit code when user has no backup codes", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const userWithNoCodes = {
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      };

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue(userWithNoCodes);

      await expect(
        service.verify2FA("no-backup-token", "abcd-ef12"),
      ).rejects.toThrow("Invalid verification code");
    });
  });

  // ---------------------------------------------------------------
  // M8: Legacy TOTP migration
  // ---------------------------------------------------------------

  describe("migrateLegacyTotpSecrets (M8)", () => {
    it("migrates legacy encrypted secrets to new format", async () => {
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      usersRepository.createQueryBuilder = jest.fn().mockReturnValue(mockQB);

      const count = await service.migrateLegacyTotpSecrets();
      expect(count).toBe(0);
      expect(usersRepository.createQueryBuilder).toHaveBeenCalledWith("user");
    });

    it("counts migrated users correctly", async () => {
      // Use a properly encrypted secret in new format (4-part, with derived key)
      const alreadyMigrated = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const mockQB = {
        where: jest.fn().mockReturnThis(),
        getMany: jest
          .fn()
          .mockResolvedValue([
            { ...mockUser, twoFactorSecret: alreadyMigrated },
          ]),
      };
      usersRepository.createQueryBuilder = jest.fn().mockReturnValue(mockQB);
      usersRepository.save.mockImplementation((u) => u);

      const count = await service.migrateLegacyTotpSecrets();
      // Already encrypted with the derived key, so no migration needed
      expect(count).toBe(0);
    });
  });

  // ---------------------------------------------------------------
  // sanitizeUser strips new fields
  // ---------------------------------------------------------------

  describe("sanitizeUser - new fields stripped", () => {
    it("strips backupCodes and OIDC link fields", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      const txManager = {
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation((_entity, data) => ({
          ...data,
          id: "user-1",
          passwordHash: "$2a$10$hash",
          resetToken: "reset",
          resetTokenExpiry: new Date(),
          twoFactorSecret: "secret",
          pendingTwoFactorSecret: "pending-secret",
          backupCodes: '["hash1","hash2"]',
          oidcLinkPending: true,
          oidcLinkToken: "token",
          oidcLinkExpiresAt: new Date(),
          pendingOidcSubject: "sub",
        })),
        save: jest.fn().mockImplementation((user) => user),
      };
      dataSource.transaction.mockImplementation(
        async (_isolation: string, cb: any) => cb(txManager),
      );

      const result = await service.register({
        email: "test@example.com",
        password: "StrongPass123!",
      });

      expect(result.user).not.toHaveProperty("pendingTwoFactorSecret");
      expect(result.user).not.toHaveProperty("backupCodes");
      expect(result.user).not.toHaveProperty("oidcLinkPending");
      expect(result.user).not.toHaveProperty("oidcLinkToken");
      expect(result.user).not.toHaveProperty("oidcLinkExpiresAt");
      expect(result.user).not.toHaveProperty("pendingOidcSubject");
    });
  });

  // ---------------------------------------------------------------
  // Per-user 2FA rate limiting and account lockout
  // ---------------------------------------------------------------

  describe("verify2FA - per-user attempt tracking", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    beforeEach(() => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
    });

    it("blocks after 10 failed attempts across different temp tokens", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const mockQB = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      usersRepository.createQueryBuilder.mockReturnValue(mockQB);

      // 10 failed attempts on unique temp tokens (3 per token, 4 tokens needed)
      for (let i = 0; i < 10; i++) {
        await expect(service.verify2FA(`token-${i}`, "000000")).rejects.toThrow(
          "Invalid verification code",
        );
      }

      // 11th attempt should be blocked by per-user limit
      await expect(service.verify2FA("token-new", "000000")).rejects.toThrow(
        "Too many verification attempts",
      );
    });

    it("locks user account after reaching per-user threshold", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const mockQB = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      };
      usersRepository.createQueryBuilder.mockReturnValue(mockQB);

      // Exhaust per-user limit
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`lockout-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // Verify that lockedUntil was set via QueryBuilder
      expect(mockQB.update).toHaveBeenCalled();
      expect(mockQB.set).toHaveBeenCalledWith(
        expect.objectContaining({
          lockedUntil: expect.any(Date),
        }),
      );
    });

    it("resets per-user counter on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);

      // Accumulate some failures
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      for (let i = 0; i < 5; i++) {
        await expect(
          service.verify2FA(`reset-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }

      // Succeed
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const result = await service.verify2FA("reset-token-final", "123456");
      expect(result.user).toBeDefined();

      // After success, per-user counter should be cleared; 10 more failures should be needed
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });
      usersRepository.createQueryBuilder.mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      });
      for (let i = 0; i < 10; i++) {
        await expect(
          service.verify2FA(`post-reset-token-${i}`, "000000"),
        ).rejects.toThrow("Invalid verification code");
      }
      // 11th should trigger per-user block
      await expect(
        service.verify2FA("post-reset-overflow", "000000"),
      ).rejects.toThrow("Too many verification attempts");
    });
  });

  // ---------------------------------------------------------------
  // Atomic backup code consumption
  // ---------------------------------------------------------------

  describe("verify2FA - atomic backup code consumption", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("uses QueryRunner transaction for backup code removal", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);

      // Generate backup codes
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: null,
      });
      usersRepository.save.mockImplementation((u) => u);
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
      const codes = await service.generateBackupCodes("user-1", "123456");
      const savedUser = usersRepository.save.mock.calls[0][0];

      // Set up QueryRunner mock
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          twoFactorSecret: encryptedSecret,
          backupCodes: savedUser.backupCodes,
        }),
        createQueryBuilder: jest.fn().mockReturnValue({
          update: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          execute: jest.fn().mockResolvedValue({ affected: 1 }),
        }),
      };
      const mockQueryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: mockQRManager,
      };
      dataSource.createQueryRunner.mockReturnValue(mockQueryRunner);

      // Set up verify2FA context
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: savedUser.backupCodes,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      const result = await service.verify2FA("atomic-backup-token", codes[0]);

      expect(result.user).toBeDefined();
      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled();
      expect(mockQRManager.findOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          lock: { mode: "pessimistic_write" },
        }),
      );
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });

    it("rolls back transaction if backup code was already consumed", async () => {
      const encryptedSecret = encrypt("TESTSECRET", TEST_TOTP_KEY);
      const hashedCodes = [await bcrypt.hash("abcd-1234", 10)];

      // QueryRunner returns user with no backup codes (already consumed)
      const mockQRManager = {
        findOne: jest.fn().mockResolvedValue({
          ...mockUser,
          backupCodes: null,
        }),
      };
      const mockQueryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockResolvedValue(undefined),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        rollbackTransaction: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: mockQRManager,
      };
      dataSource.createQueryRunner.mockReturnValue(mockQueryRunner);

      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "2fa_pending",
      });
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
        backupCodes: JSON.stringify(hashedCodes),
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: false });

      await expect(
        service.verify2FA("consumed-backup-token", "abcd-1234"),
      ).rejects.toThrow("Invalid verification code");

      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled();
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });
});
