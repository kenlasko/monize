import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException, BadRequestException } from "@nestjs/common";
import { DataSource } from "typeorm";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { RefreshToken } from "./entities/refresh-token.entity";

describe("AuthService", () => {
  let service: AuthService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let trustedDevicesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let jwtService: Partial<JwtService>;
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
            get: jest.fn().mockImplementation((key: string) => {
              if (key === "JWT_SECRET")
                return "test-jwt-secret-minimum-32-chars-long";
              return undefined;
            }),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
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
});
