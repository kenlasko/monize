import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import * as cookieParser from "cookie-parser";
import { AuthController } from "@/auth/auth.controller";
import { AuthService } from "@/auth/auth.service";
import { OidcService } from "@/auth/oidc/oidc.service";
import { EmailService } from "@/notifications/email.service";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthGuard } from "@nestjs/passport";
import { CsrfGuard } from "@/common/guards/csrf.guard";

// -- Mock user data -----------------------------------------------------------

const mockUserId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
const mockUser = {
  id: mockUserId,
  email: "test@example.com",
  firstName: "Test",
  lastName: "User",
  authProvider: "local",
  isActive: true,
  role: "user",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

// -- Mocked service methods ---------------------------------------------------

const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  generateResetToken: jest.fn(),
  resetPassword: jest.fn(),
  verify2FA: jest.fn(),
  setup2FA: jest.fn(),
  confirmSetup2FA: jest.fn(),
  disable2FA: jest.fn(),
  getTrustedDevices: jest.fn(),
  findTrustedDeviceByToken: jest.fn(),
  revokeTrustedDevice: jest.fn(),
  revokeAllTrustedDevices: jest.fn(),
  refreshTokens: jest.fn(),
  revokeRefreshToken: jest.fn(),
  findOrCreateOidcUser: jest.fn(),
  generateTokenPair: jest.fn(),
  getUserById: jest.fn(),
};

const mockOidcService = {
  enabled: false,
  generateState: jest.fn(),
  generateNonce: jest.fn(),
  getAuthorizationUrl: jest.fn(),
  handleCallback: jest.fn(),
  getUserInfo: jest.fn(),
  initialize: jest.fn(),
  onModuleInit: jest.fn(),
};

const mockEmailService = {
  getStatus: jest.fn().mockReturnValue({ configured: false }),
  sendMail: jest.fn(),
  onModuleInit: jest.fn(),
};

const mockConfigService = {
  get: jest.fn((key: string, defaultValue?: any) => {
    const config: Record<string, string> = {
      LOCAL_AUTH_ENABLED: "true",
      REGISTRATION_ENABLED: "true",
      FORCE_2FA: "false",
      NODE_ENV: "test",
      PUBLIC_APP_URL: "http://localhost:3000",
      JWT_SECRET: "test-jwt-secret-that-is-at-least-32-chars-long",
    };
    return config[key] ?? defaultValue;
  }),
};

// -- Test suite ---------------------------------------------------------------

describe("AuthController (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: mockAuthService },
        { provide: OidcService, useValue: mockOidcService },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ConfigService, useValue: mockConfigService },
        Reflector,
      ],
    })
      // Disable ThrottlerGuard for tests
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      // Disable CsrfGuard for tests
      .overrideGuard(CsrfGuard)
      .useValue({ canActivate: () => true })
      // Override JWT AuthGuard -- return a mock authenticated user
      .overrideGuard(AuthGuard("jwt"))
      .useValue({
        canActivate: (context) => {
          const req = context.switchToHttp().getRequest();
          req.user = {
            ...mockUser,
            passwordHash: "hashed-password",
            resetToken: null,
            resetTokenExpiry: null,
            twoFactorSecret: null,
          };
          return true;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default mock behaviours
    mockEmailService.getStatus.mockReturnValue({ configured: false });
  });

  // ---------- POST /auth/register -------------------------------------------

  describe("POST /auth/register", () => {
    const validPayload = {
      email: "newuser@example.com",
      password: "SecurePass1!",
      firstName: "New",
      lastName: "User",
    };

    it("should register a new user and set auth cookies", async () => {
      const registerResult = {
        accessToken: "access-token-123",
        refreshToken: "refresh-token-123",
        user: { id: mockUserId, email: validPayload.email },
      };
      mockAuthService.register.mockResolvedValue(registerResult);

      const res = await request(app.getHttpServer())
        .post("/auth/register")
        .send(validPayload)
        .expect(201);

      expect(res.body).toEqual({ user: registerResult.user });
      expect(mockAuthService.register).toHaveBeenCalledWith(validPayload);

      // Verify cookies are set
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("auth_token=");
      expect(cookieStr).toContain("refresh_token=");
      expect(cookieStr).toContain("csrf_token=");
    });

    it("should reject invalid email format", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validPayload, email: "not-an-email" })
        .expect(400);
    });

    it("should reject weak password", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validPayload, password: "short" })
        .expect(400);
    });

    it("should reject extra unknown fields", async () => {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ ...validPayload, isAdmin: true })
        .expect(400);
    });
  });

  // ---------- POST /auth/login ----------------------------------------------

  describe("POST /auth/login", () => {
    const validLogin = {
      email: "test@example.com",
      password: "SecurePass1!",
    };

    it("should login successfully and set cookies", async () => {
      const loginResult = {
        accessToken: "access-token-456",
        refreshToken: "refresh-token-456",
        user: mockUser,
        requires2FA: false,
      };
      mockAuthService.login.mockResolvedValue(loginResult);

      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send(validLogin)
        .expect(201);

      // Dates are serialized as ISO strings in JSON responses
      expect(res.body.user.id).toBe(mockUser.id);
      expect(res.body.user.email).toBe(mockUser.email);
      expect(res.body.user.firstName).toBe(mockUser.firstName);
      expect(res.body.user.authProvider).toBe(mockUser.authProvider);
      expect(mockAuthService.login).toHaveBeenCalledWith(
        validLogin,
        undefined,
      );

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("auth_token=");
    });

    it("should return 2FA required response when user has 2FA enabled", async () => {
      const loginResult = {
        requires2FA: true,
        tempToken: "temp-2fa-token-789",
      };
      mockAuthService.login.mockResolvedValue(loginResult);

      const res = await request(app.getHttpServer())
        .post("/auth/login")
        .send(validLogin)
        .expect(201);

      expect(res.body).toEqual({
        requires2FA: true,
        tempToken: "temp-2fa-token-789",
      });

      // No auth cookies should be set for 2FA flow
      const cookies = res.headers["set-cookie"];
      const cookieStr = Array.isArray(cookies) ? cookies?.join("; ") : cookies;
      if (cookieStr) {
        expect(cookieStr).not.toContain("auth_token=");
      }
    });

    it("should reject missing email", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ password: "SecurePass1!" })
        .expect(400);
    });

    it("should reject missing password", async () => {
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email: "test@example.com" })
        .expect(400);
    });
  });

  // ---------- GET /auth/profile ---------------------------------------------

  describe("GET /auth/profile", () => {
    it("should return the authenticated user profile without sensitive fields", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/profile")
        .expect(200);

      // Should include hasPassword field
      expect(res.body).toHaveProperty("hasPassword");
      // Should NOT include sensitive fields
      expect(res.body).not.toHaveProperty("passwordHash");
      expect(res.body).not.toHaveProperty("resetToken");
      expect(res.body).not.toHaveProperty("resetTokenExpiry");
      expect(res.body).not.toHaveProperty("twoFactorSecret");
      // Should include identifying fields
      expect(res.body.email).toBe("test@example.com");
      expect(res.body.id).toBe(mockUserId);
    });
  });

  // ---------- GET /auth/methods ---------------------------------------------

  describe("GET /auth/methods", () => {
    it("should return auth configuration with local enabled and oidc disabled", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/methods")
        .expect(200);

      expect(res.body).toEqual({
        local: true,
        oidc: false,
        registration: true,
        smtp: false,
        force2fa: false,
      });
    });
  });

  // ---------- POST /auth/refresh --------------------------------------------

  describe("POST /auth/refresh", () => {
    it("should refresh tokens when a valid refresh_token cookie is present", async () => {
      const refreshResult = {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
      };
      mockAuthService.refreshTokens.mockResolvedValue(refreshResult);

      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("Cookie", ["refresh_token=valid-refresh-token"])
        .expect(201);

      expect(res.body).toEqual({ message: "Token refreshed" });
      expect(mockAuthService.refreshTokens).toHaveBeenCalledWith(
        "valid-refresh-token",
      );

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("auth_token=");
      expect(cookieStr).toContain("refresh_token=");
    });

    it("should return 401 when no refresh_token cookie is present", async () => {
      await request(app.getHttpServer()).post("/auth/refresh").expect(401);
    });

    it("should clear cookies when refresh fails", async () => {
      mockAuthService.refreshTokens.mockRejectedValue(
        new Error("Token revoked"),
      );

      const res = await request(app.getHttpServer())
        .post("/auth/refresh")
        .set("Cookie", ["refresh_token=revoked-token"])
        .expect(500);

      // Cookies should be cleared on failure
      const cookies = res.headers["set-cookie"];
      if (cookies) {
        const cookieStr = Array.isArray(cookies)
          ? cookies.join("; ")
          : cookies;
        // clearCookie sets the cookie with an expiry in the past
        expect(cookieStr).toContain("auth_token=");
      }
    });
  });

  // ---------- POST /auth/logout ---------------------------------------------

  describe("POST /auth/logout", () => {
    it("should revoke the refresh token and clear all auth cookies", async () => {
      mockAuthService.revokeRefreshToken.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Cookie", ["refresh_token=some-refresh-token"])
        .expect(201);

      expect(res.body).toEqual({ message: "Logged out successfully" });
      expect(mockAuthService.revokeRefreshToken).toHaveBeenCalledWith(
        "some-refresh-token",
      );

      // Auth cookies should be cleared
      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies;
      expect(cookieStr).toContain("auth_token=");
      expect(cookieStr).toContain("refresh_token=");
      expect(cookieStr).toContain("csrf_token=");
    });

    it("should succeed even without a refresh_token cookie", async () => {
      const res = await request(app.getHttpServer())
        .post("/auth/logout")
        .expect(201);

      expect(res.body).toEqual({ message: "Logged out successfully" });
      // Should not attempt to revoke if no cookie was provided
      expect(mockAuthService.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });

  // ---------- POST /auth/forgot-password ------------------------------------

  describe("POST /auth/forgot-password", () => {
    it("should always return success message regardless of whether account exists", async () => {
      // Account does NOT exist -- service returns null
      mockAuthService.generateResetToken.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: "nonexistent@example.com" })
        .expect(201);

      expect(res.body.message).toContain(
        "If an account exists with that email",
      );
    });

    it("should trigger email send when account exists and SMTP is configured", async () => {
      const resetResult = {
        token: "reset-token-xyz",
        user: { firstName: "Test", email: "test@example.com" },
      };
      mockAuthService.generateResetToken.mockResolvedValue(resetResult);
      mockEmailService.getStatus.mockReturnValue({ configured: true });
      mockEmailService.sendMail.mockResolvedValue(undefined);

      const res = await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: "test@example.com" })
        .expect(201);

      expect(res.body.message).toContain(
        "If an account exists with that email",
      );
      expect(mockEmailService.sendMail).toHaveBeenCalledWith(
        "test@example.com",
        "Monize Password Reset",
        expect.any(String),
      );
    });

    it("should reject invalid email format", async () => {
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: "not-an-email" })
        .expect(400);
    });
  });

  // ---------- GET /auth/oidc/status -----------------------------------------

  describe("GET /auth/oidc/status", () => {
    it("should return oidc disabled status", async () => {
      const res = await request(app.getHttpServer())
        .get("/auth/oidc/status")
        .expect(200);

      expect(res.body).toEqual({ enabled: false });
    });

    it("should return oidc enabled when oidcService.enabled is true", async () => {
      // Temporarily enable OIDC
      const originalEnabled = mockOidcService.enabled;
      Object.defineProperty(mockOidcService, "enabled", {
        get: () => true,
        configurable: true,
      });

      const res = await request(app.getHttpServer())
        .get("/auth/oidc/status")
        .expect(200);

      expect(res.body).toEqual({ enabled: true });

      // Restore
      Object.defineProperty(mockOidcService, "enabled", {
        value: originalEnabled,
        writable: true,
        configurable: true,
      });
    });
  });
});
