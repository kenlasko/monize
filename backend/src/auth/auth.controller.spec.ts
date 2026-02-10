import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { OidcService } from "./oidc/oidc.service";
import { EmailService } from "../notifications/email.service";

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
});
