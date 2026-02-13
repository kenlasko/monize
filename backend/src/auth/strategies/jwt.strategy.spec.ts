import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "./jwt.strategy";
import { AuthService } from "../auth.service";

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;
  let authService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  const mockUser = {
    id: "user-1",
    email: "test@example.com",
    firstName: "Test",
    lastName: "User",
    isActive: true,
    role: "user",
  };

  beforeEach(async () => {
    authService = {
      getUserById: jest.fn(),
    };

    configService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === "JWT_SECRET")
          return "test-secret-at-least-32-characters-long";
        return undefined;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: AuthService, useValue: authService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  it("should be defined", () => {
    expect(strategy).toBeDefined();
  });

  describe("constructor", () => {
    it("throws an error if JWT_SECRET is not configured", () => {
      const noSecretConfig = {
        get: jest.fn().mockReturnValue(undefined),
      };

      expect(() => {
        new JwtStrategy(noSecretConfig as any, authService as any);
      }).toThrow(
        "JWT_SECRET environment variable must be at least 32 characters",
      );
    });

    it("throws an error if JWT_SECRET is too short", () => {
      const shortSecretConfig = {
        get: jest.fn().mockReturnValue("short-secret"),
      };

      expect(() => {
        new JwtStrategy(shortSecretConfig as any, authService as any);
      }).toThrow(
        "JWT_SECRET environment variable must be at least 32 characters",
      );
    });
  });

  describe("validate", () => {
    it("rejects 2fa_pending tokens", async () => {
      const payload = { sub: "user-1", type: "2fa_pending" };

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(strategy.validate(payload)).rejects.toThrow(
        "2FA verification required",
      );
    });

    it("rejects inactive users", async () => {
      const payload = { sub: "user-1" };
      authService.getUserById.mockResolvedValue({
        ...mockUser,
        isActive: false,
      });

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(strategy.validate(payload)).rejects.toThrow(
        "User not found or inactive",
      );
    });

    it("rejects when user is not found", async () => {
      const payload = { sub: "nonexistent" };
      authService.getUserById.mockResolvedValue(null);

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns user for valid payload", async () => {
      const payload = { sub: "user-1" };
      authService.getUserById.mockResolvedValue(mockUser);

      const result = await strategy.validate(payload);

      expect(authService.getUserById).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(mockUser);
    });
  });
});
