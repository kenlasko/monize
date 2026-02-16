import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OidcService } from "./oidc/oidc.service";
import { EmailService } from "../notifications/email.service";

jest.mock("openid-client", () => ({}));

describe("AuthController", () => {
  let controller: AuthController;
  let authService: Record<string, jest.Mock>;
  let oidcService: Record<string, jest.Mock | boolean>;
  let configService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;

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
      validateUser: jest.fn(),
      getUserById: jest.fn(),
      generateResetToken: jest.fn(),
      resetPassword: jest.fn(),
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
            NODE_ENV: "test",
            PUBLIC_APP_URL: "http://localhost:3000",
          };
          return config[key] ?? defaultValue;
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: OidcService, useValue: oidcService },
        { provide: ConfigService, useValue: configService },
        { provide: EmailService, useValue: emailService },
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
  });

  describe("login", () => {
    it("throws ForbiddenException if local auth is disabled", async () => {
      configService.get.mockImplementation(
        (key: string, defaultValue?: string) => {
          const config: Record<string, string> = {
            LOCAL_AUTH_ENABLED: "false",
            REGISTRATION_ENABLED: "true",
            FORCE_2FA: "false",
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
      const expressReq = { cookies: {} } as any;
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
        user: { id: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = { cookies: {} } as any;
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
      const reqWithUser = { user: { ...mockUser } };

      const result = await controller.getProfile(reqWithUser);

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result.hasPassword).toBe(true);
      expect(result.email).toBe("test@example.com");
      expect(result.id).toBe("user-1");
    });

    it("hasPassword is false when passwordHash is null", async () => {
      const reqWithUser = { user: { ...mockUser, passwordHash: null } };

      const result = await controller.getProfile(reqWithUser);

      expect(result.hasPassword).toBe(false);
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
      (oidcService as any).handleCallback = jest
        .fn()
        .mockResolvedValue({ access_token: "oidc-access-token", sub: "oidc-sub-123" });
      (oidcService as any).getUserInfo = jest.fn().mockResolvedValue({
        sub: "oidc-sub-123",
        email: "oidc@example.com",
        name: "OIDC User",
      });
      authService.findOrCreateOidcUser.mockResolvedValue({
        id: "user-oidc",
        email: "oidc@example.com",
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

      expect(res.clearCookie).toHaveBeenCalledWith("oidc_state");
      expect(res.clearCookie).toHaveBeenCalledWith("oidc_nonce");
      expect(oidcService.handleCallback).toHaveBeenCalledWith(
        query,
        "valid-state",
        "valid-nonce",
      );
      expect(oidcService.getUserInfo).toHaveBeenCalledWith("oidc-access-token", "oidc-sub-123");
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
        .mockRejectedValue(new Error("No access token received from OIDC provider"));

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

      await controller.csrfRefresh(res as any);

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
        user: { id: "user-1", email: "test@example.com" },
        trustedDeviceToken: null,
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
        user: { id: "user-1", email: "test@example.com" },
        trustedDeviceToken: "trusted-device-token-abc",
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
      expect(res.cookie).toHaveBeenCalledWith(
        "trusted_device",
        "trusted-device-token-abc",
        expect.objectContaining({
          httpOnly: true,
          sameSite: "lax",
          maxAge: 30 * 24 * 60 * 60 * 1000,
        }),
      );
    });

    it("does not set trusted_device cookie when trustedDeviceToken is null", async () => {
      const verifyResult = {
        accessToken: "2fa-access",
        refreshToken: "2fa-refresh",
        user: { id: "user-1", email: "test@example.com" },
        trustedDeviceToken: null,
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
        user: { id: "user-1" },
        trustedDeviceToken: null,
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
    it("delegates to authService.setup2FA with user id", async () => {
      const setupResult = {
        secret: "JBSWY3DPEHPK3PXP",
        qrCodeDataUrl: "data:image/png;base64,abc123",
      };
      authService.setup2FA.mockResolvedValue(setupResult);
      const reqWithUser = { user: { id: "user-1" } };

      const result = await controller.setup2FA(reqWithUser);

      expect(authService.setup2FA).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(setupResult);
    });
  });

  describe("confirmSetup2FA", () => {
    it("delegates to authService.confirmSetup2FA with user id and code", async () => {
      const confirmResult = { message: "2FA enabled successfully" };
      authService.confirmSetup2FA.mockResolvedValue(confirmResult);
      const reqWithUser = { user: { id: "user-1" } };
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
      const reqWithUser = { user: { id: "user-1" } };
      const dto = { code: "654321" };

      const result = await controller.disable2FA(reqWithUser, dto as any);

      expect(authService.disable2FA).toHaveBeenCalledWith("user-1", "654321");
      expect(result).toEqual(disableResult);
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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
        user: { id: "user-1" },
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

  describe("login with trustedDeviceToken", () => {
    it("passes trusted_device cookie to authService.login", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = {
        cookies: { trusted_device: "my-trusted-token" },
      } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(authService.login).toHaveBeenCalledWith(dto, "my-trusted-token");
    });

    it("passes undefined when no trusted_device cookie exists", async () => {
      const loginResult = {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        user: { id: "user-1", email: "test@example.com" },
      };
      authService.login.mockResolvedValue(loginResult);
      const res = mockRes();
      const expressReq = { cookies: {} } as any;
      const dto = { email: "test@example.com", password: "password" };

      await controller.login(dto as any, expressReq, res as any);

      expect(authService.login).toHaveBeenCalledWith(dto, undefined);
    });
  });
});
