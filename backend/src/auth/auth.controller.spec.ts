import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { UserPreference } from "../users/entities/user-preference.entity";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OidcService } from "./oidc/oidc.service";
import { EmailService } from "../notifications/email.service";
import { DemoModeService } from "../common/demo-mode.service";
import { TokenService } from "./token.service";
import { DelegationService } from "../delegation/delegation.service";
import { encrypt, derivePurposeKey } from "./crypto.util";
import { I18nService } from "nestjs-i18n";

// Matches the JWT_SECRET used in the configService mock below; kept in one
// place so encrypt/decrypt in tests can round-trip against the controller's
// derived trusted-device-cookie key.
const TEST_JWT_SECRET = "test-jwt-secret-for-spec-32-characters-min";
const TRUSTED_DEVICE_COOKIE_KEY = derivePurposeKey(
  TEST_JWT_SECRET,
  "trusted-device-cookie",
);
function encryptTrustedDeviceCookieForTest(plaintext: string): string {
  return encrypt(plaintext, TRUSTED_DEVICE_COOKIE_KEY);
}

jest.mock("openid-client", () => ({}));

describe("AuthController", () => {
  let controller: AuthController;
  let authService: Record<string, jest.Mock>;
  let oidcService: Record<string, jest.Mock | boolean>;
  let configService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let demoModeService: { isDemo: boolean };

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    isActive: true,
    role: "user",
    passwordHash: "hashed",
    resetToken: null,
    resetTokenExpiry: null,
    twoFactorSecret: null,
    pendingTwoFactorSecret: null,
    failedLoginAttempts: 0,
    lockedUntil: null,
    backupCodes: null,
    oidcLinkPending: false,
    oidcLinkToken: null,
    oidcLinkExpiresAt: null,
    pendingOidcSubject: null,
  };

  const mockRes = () => ({
    json: jest.fn(),
    cookie: jest.fn(),
    clearCookie: jest.fn(),
    redirect: jest.fn(),
  });

  beforeEach(async () => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      getUserById: jest.fn(),
      generateResetToken: jest.fn(),
      resetPassword: jest.fn(),
      verifyEmail: jest.fn(),
      generateVerificationToken: jest.fn(),
      checkVerificationEmailLimit: jest.fn().mockReturnValue(true),
      revokeRefreshToken: jest.fn(),
      refreshTokens: jest.fn(),
      setup2FA: jest.fn(),
      confirmSetup2FA: jest.fn(),
      disable2FA: jest.fn(),
      verify2FA: jest.fn(),
      generateTokenPair: jest.fn(),
      findOrCreateOidcUser: jest.fn(),
      getTrustedDevices: jest.fn(),
      findTrustedDeviceByToken: jest.fn(),
      revokeTrustedDevice: jest.fn(),
      revokeAllTrustedDevices: jest.fn(),
      checkForgotPasswordEmailLimit: jest.fn().mockReturnValue(true),
      generateBackupCodes: jest.fn(),
      confirmOidcLink: jest.fn(),
      getCsrfKey: jest.fn().mockReturnValue("test-csrf-key"),
      sanitizeUser: jest.fn().mockImplementation((user) => {
        const {
          passwordHash,
          resetToken,
          resetTokenExpiry,
          twoFactorSecret,
          pendingTwoFactorSecret,
          failedLoginAttempts,
          lockedUntil,
          backupCodes,
          oidcLinkPending,
          oidcLinkToken,
          oidcLinkExpiresAt,
          pendingOidcSubject,
          ...sanitized
        } = user;
        return { ...sanitized, hasPassword: !!passwordHash };
      }),
    };

    oidcService = {
      enabled: false,
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest
        .fn()
        .mockImplementation((key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
            PUBLIC_APP_URL: "http://localhost:3000",
          };
          return config[key] ?? defaultValue;
        }),
    };

    demoModeService = { isDemo: false };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: OidcService, useValue: oidcService },
        { provide: ConfigService, useValue: configService },
        { provide: EmailService, useValue: emailService },
        { provide: DemoModeService, useValue: demoModeService },
        {
          provide: TokenService,
          useValue: {
            getRefreshExpiryMs: jest
              .fn()
              .mockReturnValue(7 * 24 * 60 * 60 * 1000),
          },
        },
        {
          provide: DelegationService,
          useValue: {
            getAvailableContexts: jest.fn().mockResolvedValue([]),
            resolveSwitchTarget: jest.fn(),
            validateActingContext: jest.fn(),
          },
        },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("register", () => {
    it("throws ForbiddenException if local auth is disabled", async () => {
      // Recreate with local auth disabled
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "false",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const disabledController = module.get<AuthController>(AuthController);
      const res = mockRes();
      const dto = {
        email: "new@example.com",
        password: "Password1!",
        firstName: "New",
      };

      await expect(
        disabledController.register(dto as any, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws ForbiddenException if registration is disabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "false",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const disabledController = module.get<AuthController>(AuthController);
      const res = mockRes();
      const dto = {
        email: "new@example.com",
        password: "Password1!",
        firstName: "New",
      };

      await expect(
        disabledController.register(dto as any, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("calls authService.register and sets cookies on success", async () => {
      const registerResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-2", email: "new@example.com" },
      };
      authService.register.mockResolvedValue(registerResult);
      const res = mockRes();
      const dto = {
        email: "new@example.com",
        password: "Password1!",
        firstName: "New",
      };

      await controller.register(dto as any, res as any);

      expect(authService.register).toHaveBeenCalledWith(dto);
      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "access-token",
        expect.any(Object),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "refresh-token",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({ user: registerResult.user });
    });

    it("sends a verification email and sets no cookies when verification is required", async () => {
      authService.register.mockResolvedValue({
        verificationRequired: true,
        user: { id: "user-3", email: "verify@example.com", firstName: "Vee" },
        verificationToken: "raw-verify-token",
      });
      const res = mockRes();
      const dto = {
        email: "verify@example.com",
        password: "Password1!",
        firstName: "Vee",
      };

      await controller.register(dto as any, res as any);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        "verify@example.com",
        "Verify your Monize email",
        expect.stringContaining("/verify-email?token=raw-verify-token"),
      );
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith({ verificationRequired: true });
    });
  });

  describe("login", () => {
    it("throws ForbiddenException if local auth is disabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "false",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const disabledController = module.get<AuthController>(AuthController);
      const res = mockRes();
      const expressReq = { cookies: {} } as any;
      const dto = { email: "test@example.com", password: "password" };

      await expect(
        disabledController.login(dto as any, expressReq, res as any),
      ).rejects.toThrow(ForbiddenException);
    });

    it("returns 2FA response when requires2FA is true", async () => {
      authService.login.mockResolvedValue({
        requires2FA: true,
        tempToken: "temp-2fa-token",
      });
      const res = mockRes();
      const expressReq = {
        cookies: {},
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(res.json).toHaveBeenCalledWith({
        requires2FA: true,
        tempToken: "temp-2fa-token",
      });
      expect(res.cookie).not.toHaveBeenCalledWith(
        "auth_token",
        expect.anything(),
        expect.anything(),
      );
    });

    it("sets cookies and returns user on successful login without 2FA", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = {
        cookies: {},
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "access-token",
        expect.any(Object),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "refresh-token",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({ user: loginResult.user });
    });

    it("passes rememberMe from login result to refresh cookie options", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
        rememberMe: true,
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = {
        cookies: {},
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = {
        email: "test@example.com",
        password: "password",
        rememberMe: true,
      };

      await controller.login(dto as any, expressReq, res as any);

      // refresh_token cookie should have maxAge set
      const refreshCookieCall = res.cookie.mock.calls.find(
        (call: any[]) => call[0] === "refresh_token",
      );
      expect(refreshCookieCall[2]).toHaveProperty("maxAge");
    });

    it("returns emailNotVerified and sets no cookies when the email is unverified", async () => {
      authService.login.mockResolvedValue({ emailNotVerified: true });
      const res = mockRes();
      const expressReq = {
        cookies: {},
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(res.json).toHaveBeenCalledWith({ emailNotVerified: true });
      expect(res.cookie).not.toHaveBeenCalled();
    });
  });

  describe("getAuthMethods", () => {
    it("returns correct methods object", async () => {
      const result = await controller.getAuthMethods();

      expect(result).toEqual({
        local: true,
        oidc: false,
        registration: true,
        smtp: true,
        force2fa: false,
        demo: false,
      });
    });

    it("reflects oidc enabled status", async () => {
      oidcService.enabled = true;

      const result = await controller.getAuthMethods();

      expect(result.oidc).toBe(true);
    });

    it("reflects smtp not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });

      const result = await controller.getAuthMethods();

      expect(result.smtp).toBe(false);
    });
  });

  describe("getProfile", () => {
    it("strips sensitive fields and adds hasPassword", async () => {
      // req.user only carries lightweight JWT auth state; getProfile loads the
      // full user by id so profile fields (email/firstName) are present.
      authService.getUserById.mockResolvedValue({ ...mockUser });
      const reqWithUser = { user: { id: mockUser.id } };

      const result = await controller.getProfile(reqWithUser);

      expect(authService.getUserById).toHaveBeenCalledWith(mockUser.id);
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).not.toHaveProperty("pendingTwoFactorSecret");
      expect(result).not.toHaveProperty("failedLoginAttempts");
      expect(result).not.toHaveProperty("lockedUntil");
      expect(result).not.toHaveProperty("backupCodes");
      expect(result).not.toHaveProperty("oidcLinkPending");
      expect(result).not.toHaveProperty("oidcLinkToken");
      expect(result).not.toHaveProperty("oidcLinkExpiresAt");
      expect(result).not.toHaveProperty("pendingOidcSubject");
      expect(result!.hasPassword).toBe(true);
      expect(result!.email).toBe("test@example.com");
      expect(result!.id).toBe("user-1");
    });

    it("hasPassword is false when passwordHash is null", async () => {
      authService.getUserById.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });
      const reqWithUser = { user: { id: mockUser.id } };

      const result = await controller.getProfile(reqWithUser);

      expect(result!.hasPassword).toBe(false);
    });

    it("returns null when the user no longer exists", async () => {
      authService.getUserById.mockResolvedValue(null);
      const reqWithUser = { user: { id: mockUser.id } };

      const result = await controller.getProfile(reqWithUser);

      expect(result).toBeNull();
    });
  });

  describe("forgotPassword", () => {
    it("always returns success message to prevent enumeration", async () => {
      authService.generateResetToken.mockResolvedValue(null);

      const result = await controller.forgotPassword({
        email: "nonexistent@example.com",
      } as any);

      expect(result.message).toContain("If an account exists");
    });

    it("sends email when user exists and smtp is configured", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "reset-token-123",
        user: { email: "test@example.com", firstName: "Test" },
      });

      const result = await controller.forgotPassword({
        email: "test@example.com",
      } as any);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Monize Password Reset",
        expect.any(String),
      );
      expect(result.message).toContain("If an account exists");
    });

    it("returns success even if email sending fails", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "reset-token-123",
        user: { email: "test@example.com", firstName: "Test" },
      });
      emailService.sendMail.mockRejectedValue(new Error("SMTP error"));

      const result = await controller.forgotPassword({
        email: "test@example.com",
      } as any);

      expect(result.message).toContain("If an account exists");
    });

    it("throws ForbiddenException if local auth is disabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "false",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const disabledController = module.get<AuthController>(AuthController);

      await expect(
        disabledController.forgotPassword({ email: "test@example.com" } as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("resetPassword", () => {
    it("delegates to authService.resetPassword and returns success", async () => {
      authService.resetPassword.mockResolvedValue(undefined);

      const result = await controller.resetPassword({
        token: "reset-token",
        newPassword: "NewPassword1!",
      } as any);

      expect(authService.resetPassword).toHaveBeenCalledWith(
        "reset-token",
        "NewPassword1!",
      );
      expect(result.message).toContain("Password reset successfully");
    });
  });

  describe("verifyEmail", () => {
    it("delegates to authService.verifyEmail and returns a success message", async () => {
      authService.verifyEmail.mockResolvedValue(undefined);

      const result = await controller.verifyEmail({
        token: "verify-token",
      } as any);

      expect(authService.verifyEmail).toHaveBeenCalledWith("verify-token");
      expect(result.message).toContain("Email verified successfully");
    });

    it("propagates errors from an invalid token", async () => {
      authService.verifyEmail.mockRejectedValue(
        new BadRequestException("Invalid or expired verification link"),
      );

      await expect(
        controller.verifyEmail({ token: "bad" } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("resendVerification", () => {
    it("always returns a generic message to prevent enumeration", async () => {
      authService.generateVerificationToken.mockResolvedValue(null);

      const result = await controller.resendVerification({
        email: "nobody@example.com",
      } as any);

      expect(result.message).toContain("If an account exists");
    });

    it("sends a verification email when an unverified account exists and SMTP is configured", async () => {
      authService.generateVerificationToken.mockResolvedValue({
        token: "raw-verify-token",
        user: { email: "verify@example.com", firstName: "Vee" },
      });

      const result = await controller.resendVerification({
        email: "verify@example.com",
      } as any);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        "verify@example.com",
        "Verify your Monize email",
        expect.stringContaining("/verify-email?token=raw-verify-token"),
      );
      expect(result.message).toContain("If an account exists");
    });

    it("stays generic even when sending the verification email fails", async () => {
      authService.generateVerificationToken.mockResolvedValue({
        token: "raw-verify-token",
        user: { email: "verify@example.com", firstName: "Vee" },
      });
      emailService.sendMail.mockRejectedValue(new Error("SMTP error"));

      const result = await controller.resendVerification({
        email: "verify@example.com",
      } as any);

      expect(result.message).toContain("If an account exists");
    });

    it("skips sending and stays generic when the per-email limit is exceeded", async () => {
      authService.checkVerificationEmailLimit.mockReturnValue(false);

      const result = await controller.resendVerification({
        email: "verify@example.com",
      } as any);

      expect(authService.generateVerificationToken).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(result.message).toContain("If an account exists");
    });

    it("does not send when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });

      const result = await controller.resendVerification({
        email: "verify@example.com",
      } as any);

      expect(authService.generateVerificationToken).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(result.message).toContain("If an account exists");
    });

    it("throws ForbiddenException when local auth is disabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "false",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const disabledController = module.get<AuthController>(AuthController);

      await expect(
        disabledController.resendVerification({
          email: "verify@example.com",
        } as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("logout", () => {
    it("revokes refresh token and clears cookies", async () => {
      authService.revokeRefreshToken.mockResolvedValue(undefined);
      const res = mockRes();
      const expressReq = { cookies: { refresh_token: "rt-123" } } as any;

      await controller.logout(expressReq, res as any);

      expect(authService.revokeRefreshToken).toHaveBeenCalledWith("rt-123");
      expect(res.clearCookie).toHaveBeenCalledWith(
        "auth_token",
        expect.any(Object),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        "refresh_token",
        expect.any(Object),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        "csrf_token",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({
        message: "Logged out successfully",
      });
    });

    it("clears cookies even when no refresh token exists", async () => {
      const res = mockRes();
      const expressReq = { cookies: {} } as any;

      await controller.logout(expressReq, res as any);

      expect(authService.revokeRefreshToken).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith(
        "auth_token",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({
        message: "Logged out successfully",
      });
    });
  });

  describe("oidcStatus", () => {
    it("returns enabled false when oidc is not configured", async () => {
      oidcService.enabled = false;

      const result = await controller.oidcStatus();

      expect(result).toEqual({ enabled: false });
    });

    it("returns enabled true when oidc is configured", async () => {
      oidcService.enabled = true;

      const result = await controller.oidcStatus();

      expect(result).toEqual({ enabled: true });
    });
  });

  describe("oidcLogin", () => {
    it("throws BadRequestException when OIDC is not configured", async () => {
      oidcService.enabled = false;
      const res = mockRes();

      await expect(controller.oidcLogin(res as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("sets state/nonce cookies and redirects to auth URL", async () => {
      oidcService.enabled = true;
      (oidcService as any).generateState = jest
        .fn()
        .mockReturnValue("mock-state");
      (oidcService as any).generateNonce = jest
        .fn()
        .mockReturnValue("mock-nonce");
      (oidcService as any).getAuthorizationUrl = jest
        .fn()
        .mockReturnValue("https://provider.example.com/auth?state=mock-state");
      const res = mockRes();

      await controller.oidcLogin(res as any);

      expect(oidcService.generateState).toHaveBeenCalled();
      expect(oidcService.generateNonce).toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalledWith(
        "oidc_state",
        "mock-state",
        expect.objectContaining({
          httpOnly: true,
          maxAge: 600000,
        }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "oidc_nonce",
        "mock-nonce",
        expect.objectContaining({
          httpOnly: true,
          maxAge: 600000,
        }),
      );
      expect(oidcService.getAuthorizationUrl).toHaveBeenCalledWith(
        "mock-state",
        "mock-nonce",
      );
      expect(res.redirect).toHaveBeenCalledWith(
        "https://provider.example.com/auth?state=mock-state",
      );
    });
  });

  describe("oidcCallback", () => {
    it("redirects with success on valid callback", async () => {
      (oidcService as any).handleCallback = jest.fn().mockResolvedValue({
        access_token: "oidc-access-token",
        sub: "oidc-sub-123",
      });
      (oidcService as any).getUserInfo = jest.fn().mockResolvedValue({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        name: "OIDC User",
      });
      authService.findOrCreateOidcUser.mockResolvedValue({
        user: {
          id: "user-oidc",
          email: "oidc@example.com",
        },
      });
      authService.generateTokenPair.mockResolvedValue({
        accessToken: "oidc-jwt",
        refreshToken: "oidc-refresh",
      });

      const res = mockRes();
      const expressReq = {
        cookies: { oidc_state: "valid-state", oidc_nonce: "valid-nonce" },
      } as any;
      const query = { code: "auth-code" };

      await controller.oidcCallback(query, expressReq, res as any);

      expect(res.clearCookie).toHaveBeenCalledWith("oidc_state", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
      });
      expect(res.clearCookie).toHaveBeenCalledWith("oidc_nonce", {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
      });
      expect(oidcService.handleCallback).toHaveBeenCalledWith(
        query,
        "valid-state",
        "valid-nonce",
      );
      expect(oidcService.getUserInfo).toHaveBeenCalledWith(
        "oidc-access-token",
        "oidc-sub-123",
      );
      expect(authService.findOrCreateOidcUser).toHaveBeenCalledWith(
        { sub: "oidc-sub-123", email: "oidc@example.com", name: "OIDC User" },
        true,
      );
      expect(authService.generateTokenPair).toHaveBeenCalledWith({
        id: "user-oidc",
        email: "oidc@example.com",
      });
      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "oidc-jwt",
        expect.any(Object),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "oidc-refresh",
        expect.any(Object),
      );
      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining("/auth/callback?success=true"),
      );
    });

    it("redirects with error when state or nonce is missing", async () => {
      const res = mockRes();
      const expressReq = { cookies: {} } as any;
      const query = { code: "auth-code" };

      await controller.oidcCallback(query, expressReq, res as any);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining("error=authentication_failed"),
      );
    });

    it("redirects with error when handleCallback throws", async () => {
      (oidcService as any).handleCallback = jest
        .fn()
        .mockRejectedValue(new Error("Invalid callback"));

      const res = mockRes();
      const expressReq = {
        cookies: { oidc_state: "state", oidc_nonce: "nonce" },
      } as any;
      const query = { code: "bad-code" };

      await controller.oidcCallback(query, expressReq, res as any);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining("error=authentication_failed"),
      );
    });

    it("redirects with error when handleCallback returns no token", async () => {
      (oidcService as any).handleCallback = jest
        .fn()
        .mockRejectedValue(
          new Error("No access token received from OIDC provider"),
        );

      const res = mockRes();
      const expressReq = {
        cookies: { oidc_state: "state", oidc_nonce: "nonce" },
      } as any;
      const query = { code: "auth-code" };

      await controller.oidcCallback(query, expressReq, res as any);

      expect(res.redirect).toHaveBeenCalledWith(
        expect.stringContaining("error=authentication_failed"),
      );
    });
  });

  describe("csrfRefresh", () => {
    it("sets csrf_token cookie and returns success message", async () => {
      const res = mockRes();
      const req = { user: { id: "user-1", realUserId: "user-1" } };

      await controller.csrfRefresh(req as any, res as any);

      expect(res.cookie).toHaveBeenCalledWith(
        "csrf_token",
        expect.any(String),
        expect.objectContaining({
          httpOnly: false,
          sameSite: "lax",
          path: "/",
        }),
      );
      expect(res.json).toHaveBeenCalledWith({
        message: "CSRF token refreshed",
      });
    });
  });

  describe("verify2FA", () => {
    it("sets auth cookies and returns user on successful verification", async () => {
      const verifyResult = {
        accessToken: "2fa-access",
        refreshToken: "2fa-refresh",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
        trustedDeviceRef: null,
      };
      authService.verify2FA.mockResolvedValue(verifyResult);
      const res = mockRes();
      const expressReq = {
        headers: { "user-agent": "Test Browser" },
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.1" },
      } as any;
      const dto = {
        tempToken: "temp-token",
        code: "123456",
        rememberDevice: false,
      };

      await controller.verify2FA(dto as any, expressReq, res as any);

      expect(authService.verify2FA).toHaveBeenCalledWith(
        "temp-token",
        "123456",
        false,
        "Test Browser",
        "127.0.0.1",
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "2fa-access",
        expect.any(Object),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "2fa-refresh",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({ user: verifyResult.user });
    });

    it("sets trusted_device cookie when rememberDevice is true", async () => {
      const verifyResult = {
        accessToken: "2fa-access",
        refreshToken: "2fa-refresh",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
        trustedDeviceRef: "trusted-device-token-abc",
      };
      authService.verify2FA.mockResolvedValue(verifyResult);
      const res = mockRes();
      const expressReq = {
        headers: { "user-agent": "Test Browser" },
        ip: "192.168.1.100",
        socket: { remoteAddress: "192.168.1.100" },
      } as any;
      const dto = {
        tempToken: "temp-token",
        code: "654321",
        rememberDevice: true,
      };

      await controller.verify2FA(dto as any, expressReq, res as any);

      expect(authService.verify2FA).toHaveBeenCalledWith(
        "temp-token",
        "654321",
        true,
        "Test Browser",
        "192.168.1.100",
      );
      // The cookie value is an AES-256-GCM ciphertext of the trusted-device
      // ref; we can't predict the bytes (random salt/iv) but we can assert
      // the format (salt:iv:authTag:ciphertext, 4 hex segments) and that
      // the plaintext is not leaked.
      expect(res.cookie).toHaveBeenCalledWith(
        "trusted_device",
        expect.stringMatching(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i),
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          maxAge: 14 * 24 * 60 * 60 * 1000,
        }),
      );
      const cookieCall = (res.cookie as jest.Mock).mock.calls.find(
        (c) => c[0] === "trusted_device",
      );
      expect(cookieCall?.[1]).not.toBe("trusted-device-token-abc");
    });

    it("does not set trusted_device cookie when trustedDeviceRef is null", async () => {
      const verifyResult = {
        accessToken: "2fa-access",
        refreshToken: "2fa-refresh",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
        trustedDeviceRef: null,
      };
      authService.verify2FA.mockResolvedValue(verifyResult);
      const res = mockRes();
      const expressReq = {
        headers: { "user-agent": "Test Browser" },
        ip: "127.0.0.1",
        socket: { remoteAddress: "127.0.0.1" },
      } as any;
      const dto = {
        tempToken: "temp-token",
        code: "123456",
        rememberDevice: false,
      };

      await controller.verify2FA(dto as any, expressReq, res as any);

      expect(res.cookie).not.toHaveBeenCalledWith(
        "trusted_device",
        expect.anything(),
        expect.anything(),
      );
    });

    it("strips ::ffff: prefix from IPv4-mapped IPv6 addresses", async () => {
      const verifyResult = {
        accessToken: "2fa-access",
        refreshToken: "2fa-refresh",
        user: { id: "user-1", realUserId: "user-1" },
        trustedDeviceRef: null,
      };
      authService.verify2FA.mockResolvedValue(verifyResult);
      const res = mockRes();
      const expressReq = {
        headers: { "user-agent": "Test Browser" },
        ip: "::ffff:10.0.0.1",
        socket: { remoteAddress: "::ffff:10.0.0.1" },
      } as any;
      const dto = {
        tempToken: "temp-token",
        code: "111111",
      };

      await controller.verify2FA(dto as any, expressReq, res as any);

      expect(authService.verify2FA).toHaveBeenCalledWith(
        "temp-token",
        "111111",
        false,
        "Test Browser",
        "10.0.0.1",
      );
    });
  });

  describe("setup2FA", () => {
    it("delegates to authService.setup2FA with user id and password", async () => {
      const setupResult = {
        secret: "JBSWY3DPEHPK3PXP",
        qrCodeDataUrl: "data:image/png;base64,abc123",
      };
      authService.setup2FA.mockResolvedValue(setupResult);
      const reqWithUser = { user: { id: "user-1", realUserId: "user-1" } };

      const result = await controller.setup2FA(reqWithUser, {
        currentPassword: "correct-password",
      });

      expect(authService.setup2FA).toHaveBeenCalledWith(
        "user-1",
        "correct-password",
      );
      expect(result).toEqual(setupResult);
    });
  });

  describe("confirmSetup2FA", () => {
    it("delegates to authService.confirmSetup2FA with user id and code", async () => {
      const confirmResult = { message: "2FA enabled successfully" };
      authService.confirmSetup2FA.mockResolvedValue(confirmResult);
      const reqWithUser = { user: { id: "user-1", realUserId: "user-1" } };
      const dto = { code: "123456" };

      const result = await controller.confirmSetup2FA(reqWithUser, dto as any);

      expect(authService.confirmSetup2FA).toHaveBeenCalledWith(
        "user-1",
        "123456",
      );
      expect(result).toEqual(confirmResult);
    });
  });

  describe("disable2FA", () => {
    it("delegates to authService.disable2FA with user id and code", async () => {
      const disableResult = { message: "2FA disabled successfully" };
      authService.disable2FA.mockResolvedValue(disableResult);
      const reqWithUser = { user: { id: "user-1", realUserId: "user-1" } };
      const dto = { code: "654321" };

      const result = await controller.disable2FA(reqWithUser, dto as any);

      expect(authService.disable2FA).toHaveBeenCalledWith("user-1", "654321");
      expect(result).toEqual(disableResult);
    });

    it("targets the real (delegate) user id, never the owner, when acting", async () => {
      authService.disable2FA.mockResolvedValue({ message: "ok" });
      const actingReq = {
        user: { id: "owner-1", realUserId: "delegate-1", isActing: true },
      };

      await controller.disable2FA(actingReq as any, { code: "123456" } as any);

      expect(authService.disable2FA).toHaveBeenCalledWith(
        "delegate-1",
        "123456",
      );
    });
  });

  describe("get2FAStatus", () => {
    it("returns the 2FA-enabled flag for the real (delegate) user id", async () => {
      (authService as any).is2FAEnabled = jest.fn().mockResolvedValue(true);
      const actingReq = {
        user: { id: "owner-1", realUserId: "delegate-1", isActing: true },
      };

      const result = await controller.get2FAStatus(actingReq as any);

      expect((authService as any).is2FAEnabled).toHaveBeenCalledWith(
        "delegate-1",
      );
      expect(result).toEqual({ enabled: true });
    });
  });

  describe("getSelfProfile", () => {
    it("loads and sanitizes the real (delegate) user, never the owner", async () => {
      const delegateUser = { id: "delegate-1", email: "d@x.com" } as any;
      (authService as any).getUserById = jest
        .fn()
        .mockResolvedValue(delegateUser);
      (authService as any).sanitizeUser = jest
        .fn()
        .mockReturnValue({ id: "delegate-1", email: "d@x.com" });
      const actingReq = {
        user: { id: "owner-1", realUserId: "delegate-1", isActing: true },
      };

      const result = await controller.getSelfProfile(actingReq as any);

      expect((authService as any).getUserById).toHaveBeenCalledWith(
        "delegate-1",
      );
      expect(result).toEqual({ id: "delegate-1", email: "d@x.com" });
    });
  });

  describe("getTrustedDevices", () => {
    const mockDevices = [
      {
        id: "device-1",
        deviceName: "Chrome on Linux",
        ipAddress: "192.168.1.1",
        lastUsedAt: new Date("2026-02-01"),
        expiresAt: new Date("2026-03-01"),
        createdAt: new Date("2026-01-01"),
      },
      {
        id: "device-2",
        deviceName: "Firefox on Windows",
        ipAddress: "10.0.0.1",
        lastUsedAt: new Date("2026-02-10"),
        expiresAt: new Date("2026-03-10"),
        createdAt: new Date("2026-01-10"),
      },
    ];

    it("returns devices with isCurrent flag for the matching device", async () => {
      authService.getTrustedDevices.mockResolvedValue(mockDevices);
      authService.findTrustedDeviceByToken.mockResolvedValue("device-1");
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: { trusted_device: "current-device-token" },
      } as any;

      await controller.getTrustedDevices(expressReq, res as any);

      expect(authService.getTrustedDevices).toHaveBeenCalledWith("user-1");
      expect(authService.findTrustedDeviceByToken).toHaveBeenCalledWith(
        "user-1",
        "current-device-token",
      );
      expect(res.json).toHaveBeenCalledWith([
        expect.objectContaining({ id: "device-1", isCurrent: true }),
        expect.objectContaining({ id: "device-2", isCurrent: false }),
      ]);
    });

    it("returns all devices with isCurrent false when no trusted_device cookie", async () => {
      authService.getTrustedDevices.mockResolvedValue(mockDevices);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: {},
      } as any;

      await controller.getTrustedDevices(expressReq, res as any);

      expect(authService.findTrustedDeviceByToken).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith([
        expect.objectContaining({ id: "device-1", isCurrent: false }),
        expect.objectContaining({ id: "device-2", isCurrent: false }),
      ]);
    });

    it("returns empty array when no devices exist", async () => {
      authService.getTrustedDevices.mockResolvedValue([]);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: {},
      } as any;

      await controller.getTrustedDevices(expressReq, res as any);

      expect(res.json).toHaveBeenCalledWith([]);
    });
  });

  describe("revokeTrustedDevice", () => {
    it("revokes device and clears cookie if revoking current device", async () => {
      authService.revokeTrustedDevice.mockResolvedValue(undefined);
      authService.findTrustedDeviceByToken.mockResolvedValue("device-1");
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: { trusted_device: "current-device-token" },
      } as any;

      await controller.revokeTrustedDevice(expressReq, "device-1", res as any);

      expect(authService.revokeTrustedDevice).toHaveBeenCalledWith(
        "user-1",
        "device-1",
      );
      expect(authService.findTrustedDeviceByToken).toHaveBeenCalledWith(
        "user-1",
        "current-device-token",
      );
      expect(res.clearCookie).toHaveBeenCalledWith("trusted_device");
      expect(res.json).toHaveBeenCalledWith({
        message: "Device revoked successfully",
      });
    });

    it("revokes device without clearing cookie if revoking a different device", async () => {
      authService.revokeTrustedDevice.mockResolvedValue(undefined);
      authService.findTrustedDeviceByToken.mockResolvedValue("device-2");
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: { trusted_device: "current-device-token" },
      } as any;

      await controller.revokeTrustedDevice(expressReq, "device-1", res as any);

      expect(authService.revokeTrustedDevice).toHaveBeenCalledWith(
        "user-1",
        "device-1",
      );
      expect(res.clearCookie).not.toHaveBeenCalledWith("trusted_device");
      expect(res.json).toHaveBeenCalledWith({
        message: "Device revoked successfully",
      });
    });

    it("does not look up current device when no trusted_device cookie", async () => {
      authService.revokeTrustedDevice.mockResolvedValue(undefined);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: {},
      } as any;

      await controller.revokeTrustedDevice(expressReq, "device-1", res as any);

      expect(authService.findTrustedDeviceByToken).not.toHaveBeenCalled();
      expect(res.clearCookie).not.toHaveBeenCalledWith("trusted_device");
      expect(res.json).toHaveBeenCalledWith({
        message: "Device revoked successfully",
      });
    });

    it("clears cookie when findTrustedDeviceByToken returns null (token already invalid)", async () => {
      authService.revokeTrustedDevice.mockResolvedValue(undefined);
      authService.findTrustedDeviceByToken.mockResolvedValue(null);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
        cookies: { trusted_device: "stale-token" },
      } as any;

      await controller.revokeTrustedDevice(expressReq, "device-1", res as any);

      expect(res.clearCookie).toHaveBeenCalledWith("trusted_device");
    });
  });

  describe("revokeAllTrustedDevices", () => {
    it("revokes all devices, clears cookie, and returns count", async () => {
      authService.revokeAllTrustedDevices.mockResolvedValue(3);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
      } as any;

      await controller.revokeAllTrustedDevices(expressReq, res as any);

      expect(authService.revokeAllTrustedDevices).toHaveBeenCalledWith(
        "user-1",
      );
      expect(res.clearCookie).toHaveBeenCalledWith("trusted_device");
      expect(res.json).toHaveBeenCalledWith({
        message: "3 device(s) revoked",
        count: 3,
      });
    });

    it("returns zero count when no devices existed", async () => {
      authService.revokeAllTrustedDevices.mockResolvedValue(0);
      const res = mockRes();
      const expressReq = {
        user: { id: "user-1", realUserId: "user-1" },
      } as any;

      await controller.revokeAllTrustedDevices(expressReq, res as any);

      expect(res.clearCookie).toHaveBeenCalledWith("trusted_device");
      expect(res.json).toHaveBeenCalledWith({
        message: "0 device(s) revoked",
        count: 0,
      });
    });
  });

  describe("refresh", () => {
    it("throws UnauthorizedException when no refresh token cookie exists", async () => {
      const res = mockRes();
      const expressReq = { cookies: {} } as any;

      await expect(controller.refresh(expressReq, res as any)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("sets new auth cookies on successful refresh", async () => {
      authService.refreshTokens.mockResolvedValue({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        userId: "user-1",
      });
      const res = mockRes();
      const expressReq = { cookies: { refresh_token: "old-refresh" } } as any;

      await controller.refresh(expressReq, res as any);

      expect(authService.refreshTokens).toHaveBeenCalledWith("old-refresh");
      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "new-access",
        expect.any(Object),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "new-refresh",
        expect.any(Object),
      );
      expect(res.json).toHaveBeenCalledWith({ message: "Token refreshed" });
    });

    it("clears all auth cookies and re-throws when refreshTokens fails", async () => {
      const error = new UnauthorizedException("Token revoked");
      authService.refreshTokens.mockRejectedValue(error);
      const res = mockRes();
      const expressReq = { cookies: { refresh_token: "bad-refresh" } } as any;

      await expect(controller.refresh(expressReq, res as any)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(res.clearCookie).toHaveBeenCalledWith(
        "auth_token",
        expect.any(Object),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        "refresh_token",
        expect.any(Object),
      );
      expect(res.clearCookie).toHaveBeenCalledWith(
        "csrf_token",
        expect.any(Object),
      );
    });
  });

  describe("login with trustedDeviceRef", () => {
    it("passes trusted_device cookie to authService.login", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      // Cookie carries the AES-256-GCM ciphertext of the trusted-device ref
      // (CWE-312); the controller decrypts before forwarding to the service.
      const encryptedCookie =
        encryptTrustedDeviceCookieForTest("my-trusted-token");
      const expressReq = {
        cookies: { trusted_device: encryptedCookie },
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(authService.login).toHaveBeenCalledWith(
        dto,
        "my-trusted-token",
        "TestBrowser/1.0",
      );
    });

    it("passes undefined when trusted_device cookie has invalid ciphertext", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = {
        cookies: { trusted_device: "not-a-valid-ciphertext" },
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(authService.login).toHaveBeenCalledWith(
        dto,
        undefined,
        "TestBrowser/1.0",
      );
    });

    it("passes undefined when no trusted_device cookie exists", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", realUserId: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = {
        cookies: {},
        headers: { "user-agent": "TestBrowser/1.0" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(authService.login).toHaveBeenCalledWith(
        dto,
        undefined,
        "TestBrowser/1.0",
      );
    });
  });

  describe("cookie secure flag with DISABLE_HTTPS_HEADERS", () => {
    it("sets secure cookies in production when DISABLE_HTTPS_HEADERS is not set", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "production",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const prodController = module.get<AuthController>(AuthController);
      authService.login.mockResolvedValue({
        accessToken: "at",
        refreshToken: "rt",
        user: mockUser,
      });
      const res = mockRes();
      const expressReq = { cookies: {}, headers: {} } as any;

      await prodController.login(
        { email: "test@example.com", password: "Password1!" } as any,
        expressReq,
        res as any,
      );

      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "at",
        expect.objectContaining({ secure: true }),
      );
    });

    it("disables secure cookies in production when DISABLE_HTTPS_HEADERS=true", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "production",
            DISABLE_HTTPS_HEADERS: "true",
          };
          return config[key] ?? defaultValue;
        },
      );

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();

      const httpController = module.get<AuthController>(AuthController);
      authService.login.mockResolvedValue({
        accessToken: "at",
        refreshToken: "rt",
        user: mockUser,
      });
      const res = mockRes();
      const expressReq = { cookies: {}, headers: {} } as any;

      await httpController.login(
        { email: "test@example.com", password: "Password1!" } as any,
        expressReq,
        res as any,
      );

      expect(res.cookie).toHaveBeenCalledWith(
        "auth_token",
        "at",
        expect.objectContaining({ secure: false }),
      );
      expect(res.cookie).toHaveBeenCalledWith(
        "refresh_token",
        "rt",
        expect.objectContaining({ secure: false }),
      );
    });
  });

  // ─── Branch coverage extras ─────────────────────────────────────────

  describe("oidcProvedMfa via callback", () => {
    it("rejects when FORCE_2FA but IdP did not assert MFA (no amr/acr)", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "true",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
            PUBLIC_APP_URL: "http://localhost:3000",
          };
          return config[key] ?? defaultValue;
        },
      );
      const force2faModule: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn().mockResolvedValue({
                amr: undefined,
                acr: undefined,
                access_token: "tok",
                sub: "sub-1",
              }),
              getUserInfo: jest.fn(),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = force2faModule.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback({}, req as never, res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?error=mfa_required",
      );
    });

    it("accepts when FORCE_2FA and amr includes MFA value (otp)", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "true",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
            PUBLIC_APP_URL: "http://localhost:3000",
          };
          return config[key] ?? defaultValue;
        },
      );
      authService.findOrCreateOidcUser.mockResolvedValue({
        user: { id: "user-2", email: "x@y.z" },
        linkPending: false,
      });
      authService.generateTokenPair.mockResolvedValue({
        accessToken: "a",
        refreshToken: "r",
      });
      const force2faModule: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn().mockResolvedValue({
                amr: ["pwd", "OTP"],
                acr: undefined,
                access_token: "tok",
                sub: "sub-1",
              }),
              getUserInfo: jest.fn().mockResolvedValue({
                email: "x@y.z",
                sub: "sub-1",
              }),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = force2faModule.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback({}, req as never, res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?success=true",
      );
    });

    it("accepts when FORCE_2FA and acr indicates MFA", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "true",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "true",
            JWT_SECRET: "test-jwt-secret-for-spec-32-characters-min",
            NODE_ENV: "test",
            PUBLIC_APP_URL: "http://localhost:3000",
          };
          return config[key] ?? defaultValue;
        },
      );
      authService.findOrCreateOidcUser.mockResolvedValue({
        user: { id: "user-2", email: "x@y.z" },
        linkPending: false,
      });
      authService.generateTokenPair.mockResolvedValue({
        accessToken: "a",
        refreshToken: "r",
      });
      const acrCases = ["mfa", "level:2", "loa-3", "/2", "2"];
      for (const acrVal of acrCases) {
        const m: TestingModule = await Test.createTestingModule({
          controllers: [AuthController],
          providers: [
            { provide: AuthService, useValue: authService },
            {
              provide: OidcService,
              useValue: {
                enabled: true,
                handleCallback: jest.fn().mockResolvedValue({
                  amr: undefined,
                  acr: acrVal,
                  access_token: "tok",
                  sub: "sub-1",
                }),
                getUserInfo: jest.fn().mockResolvedValue({
                  email: "x@y.z",
                  sub: "sub-1",
                }),
                generateState: jest.fn(),
                generateNonce: jest.fn(),
                getAuthorizationUrl: jest.fn(),
              },
            },
            { provide: ConfigService, useValue: configService },
            { provide: EmailService, useValue: emailService },
            { provide: DemoModeService, useValue: demoModeService },
            {
              provide: TokenService,
              useValue: {
                getRefreshExpiryMs: jest
                  .fn()
                  .mockReturnValue(7 * 24 * 60 * 60 * 1000),
              },
            },
            {
              provide: DelegationService,
              useValue: {
                getAvailableContexts: jest.fn().mockResolvedValue([]),
                resolveSwitchTarget: jest.fn(),
                validateActingContext: jest.fn(),
              },
            },
            {
              provide: I18nService,
              useValue: {
                translate: (key: string, opts?: { defaultValue?: string }) =>
                  opts?.defaultValue ?? key,
              },
            },
            {
              provide: getRepositoryToken(UserPreference),
              useValue: { findOne: jest.fn().mockResolvedValue(null) },
            },
          ],
        }).compile();
        const c = m.get<AuthController>(AuthController);
        const res = mockRes();
        const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
        await c.oidcCallback({}, req as never, res as never);
        expect(res.redirect).toHaveBeenCalledWith(
          "http://localhost:3000/auth/callback?success=true",
        );
      }
    });
  });

  describe("oidcCallback edge cases", () => {
    it("redirects with error when query.error is present", async () => {
      const m: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn(),
              getUserInfo: jest.fn(),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = m.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback(
        { error: "access_denied" },
        req as never,
        res as never,
      );
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?error=authentication_failed",
      );
    });

    it("redirects with error_description fallback when no description provided", async () => {
      const m: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn(),
              getUserInfo: jest.fn(),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = m.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback(
        { error: "x", error_description: "details" },
        req as never,
        res as never,
      );
      expect(res.redirect).toHaveBeenCalled();
    });

    it("redirects when linkPending is true", async () => {
      authService.findOrCreateOidcUser.mockResolvedValue({
        user: { id: "user-2" },
        linkPending: true,
      });
      const m: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn().mockResolvedValue({
                amr: undefined,
                acr: undefined,
                access_token: "tok",
                sub: "sub-1",
              }),
              getUserInfo: jest.fn().mockResolvedValue({
                email: "x@y.z",
                sub: "sub-1",
              }),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = m.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback({}, req as never, res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?link=pending",
      );
    });

    it("logs error when error is non-Error", async () => {
      const m: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          {
            provide: OidcService,
            useValue: {
              enabled: true,
              handleCallback: jest.fn().mockRejectedValue("string-error"),
              getUserInfo: jest.fn(),
              generateState: jest.fn(),
              generateNonce: jest.fn(),
              getAuthorizationUrl: jest.fn(),
            },
          },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: {
              getRefreshExpiryMs: jest
                .fn()
                .mockReturnValue(7 * 24 * 60 * 60 * 1000),
            },
          },
          {
            provide: DelegationService,
            useValue: {
              getAvailableContexts: jest.fn().mockResolvedValue([]),
              resolveSwitchTarget: jest.fn(),
              validateActingContext: jest.fn(),
            },
          },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      const c = m.get<AuthController>(AuthController);
      const res = mockRes();
      const req = { cookies: { oidc_state: "s", oidc_nonce: "n" } };
      await c.oidcCallback({}, req as never, res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?error=authentication_failed",
      );
    });
  });

  describe("getAuthMethods extras", () => {
    it("hides force2fa and registration when in demo mode", async () => {
      demoModeService.isDemo = true;
      const r = await controller.getAuthMethods();
      expect(r.demo).toBe(true);
      expect(r.force2fa).toBe(false);
      expect(r.registration).toBe(false);
    });
  });

  describe("forgotPassword extras", () => {
    it("returns success when checkForgotPasswordEmailLimit returns false", async () => {
      authService.checkForgotPasswordEmailLimit.mockReturnValue(false);
      const r = await controller.forgotPassword({
        email: "x@y.z",
      } as never);
      expect(r.message).toContain("If an account exists");
      expect(authService.generateResetToken).not.toHaveBeenCalled();
    });

    it("does not send email when SMTP not configured", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "t",
        user: { email: "x@y.z", firstName: "X" },
      });
      emailService.getStatus.mockReturnValue({ configured: false });
      await controller.forgotPassword({ email: "x@y.z" } as never);
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("logs error when sendMail fails (Error instance)", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "t",
        user: { email: "x@y.z", firstName: "X" },
      });
      emailService.sendMail.mockRejectedValue(new Error("smtp fail"));
      const r = await controller.forgotPassword({
        email: "x@y.z",
      } as never);
      expect(r.message).toContain("If an account exists");
    });

    it("logs error when sendMail fails (non-Error)", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "t",
        user: { email: "x@y.z", firstName: "X" },
      });
      emailService.sendMail.mockRejectedValue("not-an-error");
      const r = await controller.forgotPassword({
        email: "x@y.z",
      } as never);
      expect(r.message).toContain("If an account exists");
    });

    it("uses empty string when firstName missing", async () => {
      authService.generateResetToken.mockResolvedValue({
        token: "t",
        user: { email: "x@y.z" },
      });
      await controller.forgotPassword({ email: "x@y.z" } as never);
      expect(emailService.sendMail).toHaveBeenCalled();
    });

    it("returns success when generateResetToken returns null", async () => {
      authService.generateResetToken.mockResolvedValue(null);
      const r = await controller.forgotPassword({
        email: "x@y.z",
      } as never);
      expect(r.message).toContain("If an account exists");
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe("verify2FA edge cases", () => {
    it("uses fallback userAgent when none in headers", async () => {
      authService.verify2FA.mockResolvedValue({
        accessToken: "a",
        refreshToken: "r",
        user: mockUser,
        rememberMe: false,
      });
      const res = mockRes();
      const req = { headers: {}, ip: "127.0.0.1" };
      await controller.verify2FA(
        {
          tempToken: "t",
          code: "123456",
          rememberDevice: false,
        } as never,
        req as never,
        res as never,
      );
      expect(authService.verify2FA).toHaveBeenCalledWith(
        "t",
        "123456",
        false,
        "Unknown Device",
        "127.0.0.1",
      );
    });

    it("strips ::ffff: prefix from IPv4-mapped IP", async () => {
      authService.verify2FA.mockResolvedValue({
        accessToken: "a",
        refreshToken: "r",
        user: mockUser,
        rememberMe: false,
      });
      const res = mockRes();
      const req = {
        headers: { "user-agent": "ua" },
        ip: undefined,
        socket: { remoteAddress: "::ffff:192.168.1.1" },
      };
      await controller.verify2FA(
        { tempToken: "t", code: "123456" } as never,
        req as never,
        res as never,
      );
      expect(authService.verify2FA).toHaveBeenCalledWith(
        "t",
        "123456",
        false,
        "ua",
        "192.168.1.1",
      );
    });
  });

  describe("confirmOidcLink", () => {
    it("redirects with success when token valid", async () => {
      authService.confirmOidcLink.mockResolvedValue(undefined);
      const res = mockRes();
      await controller.confirmOidcLink("valid-token", res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?link=success",
      );
    });

    it("redirects with failed when token missing", async () => {
      const res = mockRes();
      await controller.confirmOidcLink("", res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?link=failed",
      );
    });

    it("redirects with failed when service throws (non-Error)", async () => {
      authService.confirmOidcLink.mockRejectedValue("boom");
      const res = mockRes();
      await controller.confirmOidcLink("tok", res as never);
      expect(res.redirect).toHaveBeenCalledWith(
        "http://localhost:3000/auth/callback?link=failed",
      );
    });
  });

  describe("getContexts", () => {
    async function buildController(delegation: Record<string, jest.Mock>) {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AuthService, useValue: authService },
          { provide: OidcService, useValue: oidcService },
          { provide: ConfigService, useValue: configService },
          { provide: EmailService, useValue: emailService },
          { provide: DemoModeService, useValue: demoModeService },
          {
            provide: TokenService,
            useValue: { getRefreshExpiryMs: jest.fn() },
          },
          { provide: DelegationService, useValue: delegation },
          {
            provide: I18nService,
            useValue: {
              translate: (key: string, opts?: { defaultValue?: string }) =>
                opts?.defaultValue ?? key,
            },
          },
          {
            provide: getRepositoryToken(UserPreference),
            useValue: { findOne: jest.fn().mockResolvedValue(null) },
          },
        ],
      }).compile();
      return module.get<AuthController>(AuthController);
    }

    it("returns capabilities and sections when acting", async () => {
      const delegation = {
        getAvailableContexts: jest.fn().mockResolvedValue([{ userId: "o1" }]),
        getCapabilities: jest.fn().mockResolvedValue({ payees: {} }),
        getSections: jest.fn().mockResolvedValue({ bills: true }),
        hasTransactionalAccess: jest.fn().mockResolvedValue(true),
        hasAnyAccountAccess: jest.fn().mockResolvedValue(true),
      };
      const c = await buildController(delegation);
      const res = await c.getContexts({
        user: {
          id: "o1",
          realUserId: "d1",
          isActing: true,
          delegationId: "g1",
        },
      } as never);
      expect(res).toEqual({
        actingAsUserId: "o1",
        contexts: [{ userId: "o1" }],
        capabilities: { payees: {} },
        sections: { bills: true, transactions: true, accounts: true },
      });
      expect(delegation.getSections).toHaveBeenCalledWith("g1");
      expect(delegation.hasTransactionalAccess).toHaveBeenCalledWith("g1");
      expect(delegation.hasAnyAccountAccess).toHaveBeenCalledWith("g1");
    });

    it("returns null capabilities and sections when not acting", async () => {
      const delegation = {
        getAvailableContexts: jest.fn().mockResolvedValue([]),
        getCapabilities: jest.fn(),
        getSections: jest.fn(),
      };
      const c = await buildController(delegation);
      const res = await c.getContexts({
        user: { id: "d1", realUserId: "d1", isActing: false },
      } as never);
      expect(res).toEqual({
        actingAsUserId: null,
        contexts: [],
        capabilities: null,
        sections: null,
      });
      expect(delegation.getSections).not.toHaveBeenCalled();
    });
  });

  // Use the previously-imported helpers without regenerating the controller
  // — these branches don't depend on alternate config.
  void encryptTrustedDeviceCookieForTest;
});
