import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import {
  UnauthorizedException,
  BadRequestException,
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
import { encrypt } from "./crypto.util";

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
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    configService = module.get(ConfigService);
  });

  describe("register", () => {
    it("creates a new user and returns token pair", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      usersRepository.count.mockResolvedValue(1); // not first user
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "new-user",
      }));
      usersRepository.save.mockImplementation((user) => ({
        ...user,
        id: "new-user",
      }));

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
      usersRepository.count.mockResolvedValue(0); // first user
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "first-user",
      }));
      usersRepository.save.mockImplementation((user) => user);

      await service.register({
        email: "admin@example.com",
        password: "StrongPass123!",
      });

      const createdUser = usersRepository.save.mock.calls[0][0];
      expect(createdUser.role).toBe("admin");
    });

    it("throws for duplicate email", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      await expect(
        service.register({
          email: "test@example.com",
          password: "StrongPass123!",
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("login", () => {
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
    });

    it("throws for non-existent user", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.login({ email: "nobody@example.com", password: "pass" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws for wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.login({ email: "test@example.com", password: "WrongPass" }),
      ).rejects.toThrow(UnauthorizedException);
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
    });

    it("throws for wrong token type", async () => {
      (jwtService.verify as jest.Mock).mockReturnValue({
        sub: "user-1",
        type: "access",
      });

      await expect(service.verify2FA("token", "123456")).rejects.toThrow(
        "Invalid token type",
      );
    });
  });

  describe("sanitizeUser", () => {
    it("strips sensitive fields from user", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "user-1",
        passwordHash: "$2a$10$hash",
        resetToken: "reset",
        resetTokenExpiry: new Date(),
        twoFactorSecret: "secret",
      }));
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.register({
        email: "test@example.com",
        password: "StrongPass123!",
      });

      expect(result.user).not.toHaveProperty("passwordHash");
      expect(result.user).not.toHaveProperty("resetToken");
      expect(result.user).not.toHaveProperty("resetTokenExpiry");
      expect(result.user).not.toHaveProperty("twoFactorSecret");
      expect(result.user).toHaveProperty("hasPassword");
    });
  });

  describe("resetPassword", () => {
    it("throws for invalid token", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword("invalid-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws for expired token", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        resetTokenExpiry: new Date(Date.now() - 1000), // expired
      });

      await expect(
        service.resetPassword("expired-token", "NewPass123!"),
      ).rejects.toThrow(BadRequestException);
    });

    it("revokes all refresh tokens after password reset", async () => {
      const futureDate = new Date(Date.now() + 3600000);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        resetTokenExpiry: futureDate,
      });
      usersRepository.save.mockResolvedValue(mockUser);
      refreshTokensRepository.update.mockResolvedValue({ affected: 1 });

      await service.resetPassword("valid-token", "NewPass123!");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
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

  describe("generateToken", () => {
    it("returns a JWT string", () => {
      const token = service.generateToken(mockUser as any);
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: mockUser.id,
          email: mockUser.email,
          role: mockUser.role,
        }),
      );
      expect(token).toBe("mock-jwt-token");
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
      expect(savedUser.twoFactorSecret).toBeTruthy();
      expect(savedUser.twoFactorSecret).not.toBe("TESTSECRET"); // should be encrypted
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
  });

  // ---------------------------------------------------------------
  // confirmSetup2FA
  // ---------------------------------------------------------------

  describe("confirmSetup2FA", () => {
    const jwtSecret = "test-jwt-secret-minimum-32-chars-long";

    it("validates code and enables 2FA in preferences", async () => {
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
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
      const savedPrefs = preferencesRepository.save.mock.calls[0][0];
      expect(savedPrefs.twoFactorEnabled).toBe(true);
    });

    it("creates preferences if they do not exist yet", async () => {
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
      });
      (otplib.verifySync as jest.Mock).mockReturnValue({ valid: true });
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        twoFactorSecret: encryptedSecret,
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
        twoFactorSecret: null,
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
    });

    it("updates lastLogin on successful verification", async () => {
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);
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
    });
  });

  // ---------------------------------------------------------------
  // findOrCreateOidcUser
  // ---------------------------------------------------------------

  describe("findOrCreateOidcUser", () => {
    it("creates new user with verified email", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by subject
      usersRepository.count.mockResolvedValue(1); // not first user
      usersRepository.create.mockImplementation((data) => ({
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

      expect(result.email).toBe("oidc@example.com");
      expect(result.oidcSubject).toBe("oidc-sub-123");
      expect(result.authProvider).toBe("oidc");
      expect(result.firstName).toBe("OIDC");
      expect(result.lastName).toBe("User");
    });

    it("creates new user with unverified email (email stored but not linked)", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by subject or email
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
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
      expect(result.email).toBe("unverified@example.com");
      // Should NOT have looked up by email (only 1 findOne call for oidcSubject)
      expect(usersRepository.findOne).toHaveBeenCalledTimes(1);
    });

    it("links to existing user by verified email", async () => {
      const existingLocal = {
        ...mockUser,
        id: "existing-user",
        authProvider: "local",
        oidcSubject: null,
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

      expect(result.id).toBe("existing-user");
      expect(result.oidcSubject).toBe("oidc-sub-link");
      expect(result.authProvider).toBe("oidc");
    });

    it("does NOT link to existing user when email is unverified", async () => {
      usersRepository.findOne.mockResolvedValue(null); // no existing by oidcSubject
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
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

      expect(result.email).toBe("newemail@example.com");
      expect(result.firstName).toBe("New");
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

    it("handles duplicate email constraint error (code 23505) with verified email", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      const existingUser = {
        ...mockUser,
        id: "existing-dup",
        authProvider: "local",
        oidcSubject: null,
      };

      usersRepository.findOne
        .mockResolvedValueOnce(null) // no existing by oidcSubject
        .mockResolvedValueOnce(null) // no existing by email (race condition)
        .mockResolvedValueOnce(existingUser); // found after duplicate error
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "new-oidc",
      }));
      usersRepository.save
        .mockRejectedValueOnce(duplicateError) // first save fails
        .mockImplementation((u) => u); // subsequent saves succeed

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-dup",
        email: "test@example.com",
        email_verified: true,
      });

      expect(result.id).toBe("existing-dup");
      expect(result.oidcSubject).toBe("oidc-sub-dup");
    });

    it("re-throws duplicate email error when email is unverified", async () => {
      const duplicateError = new Error("duplicate key") as any;
      duplicateError.code = "23505";

      usersRepository.findOne.mockResolvedValue(null);
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "new-oidc",
      }));
      usersRepository.save.mockRejectedValue(duplicateError);

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
      usersRepository.count.mockResolvedValue(0); // first user
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "first-oidc",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-admin",
        email: "admin-oidc@example.com",
        email_verified: true,
      });

      expect(result.role).toBe("admin");
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
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "oidc-pref",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-pref",
        preferred_username: "johndoe",
        email_verified: false,
      });

      expect(result.firstName).toBe("johndoe");
    });

    it("uses full name split for firstName/lastName when specific claims absent", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "oidc-name",
      }));
      usersRepository.save.mockImplementation((u) => u);

      const result = await service.findOrCreateOidcUser({
        sub: "oidc-sub-name",
        name: "John Michael Doe",
        email_verified: false,
      });

      expect(result.firstName).toBe("John");
      expect(result.lastName).toBe("Michael Doe");
    });
  });

  // ---------------------------------------------------------------
  // validateOidcUser
  // ---------------------------------------------------------------

  describe("validateOidcUser", () => {
    it("delegates to findOrCreateOidcUser and sanitizes", async () => {
      usersRepository.findOne.mockResolvedValue(null);
      usersRepository.count.mockResolvedValue(1);
      usersRepository.create.mockImplementation((data) => ({
        ...data,
        id: "oidc-val",
        passwordHash: "$2a$10$hash",
        resetToken: "reset",
        resetTokenExpiry: new Date(),
        twoFactorSecret: "secret",
      }));
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
    it("deletes expired tokens", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 5 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt: expect.anything(),
        }),
      );
    });

    it("does not log when no tokens purged", async () => {
      refreshTokensRepository.delete.mockResolvedValue({ affected: 0 });

      await service.purgeExpiredRefreshTokens();

      expect(refreshTokensRepository.delete).toHaveBeenCalled();
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
      // Generate a known raw token and its hash
      const crypto = await import("crypto");
      const rawToken = "test-reset-token-hex-value";
      const hashedToken = crypto
        .createHash("sha256")
        .update(rawToken)
        .digest("hex");

      const futureDate = new Date(Date.now() + 3600000);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        resetToken: hashedToken,
        resetTokenExpiry: futureDate,
      });
      usersRepository.save.mockImplementation((u) => u);
      refreshTokensRepository.update.mockResolvedValue({ affected: 2 });

      await service.resetPassword(rawToken, "NewSecurePass123!");

      // Password should be hashed (not plaintext)
      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.passwordHash).toBeTruthy();
      expect(savedUser.passwordHash).not.toBe("NewSecurePass123!");
      const isPasswordValid = await bcrypt.compare(
        "NewSecurePass123!",
        savedUser.passwordHash,
      );
      expect(isPasswordValid).toBe(true);

      // Token fields should be cleared
      expect(savedUser.resetToken).toBeNull();
      expect(savedUser.resetTokenExpiry).toBeNull();

      // All refresh tokens should be revoked
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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);

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
    });

    it("falls back to 2FA when trusted device is invalid", async () => {
      const hashedPassword = await bcrypt.hash("ValidPass123!", 10);
      const jwtSecret = "test-jwt-secret-minimum-32-chars-long";
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);

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
      const encryptedSecret = encrypt("TESTSECRET", jwtSecret);

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
});
