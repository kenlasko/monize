import { Test, TestingModule } from "@nestjs/testing";
import { UnauthorizedException } from "@nestjs/common";
import { LocalStrategy } from "./local.strategy";
import { AuthService } from "../auth.service";

describe("LocalStrategy", () => {
  let strategy: LocalStrategy;
  let authService: Record<string, jest.Mock>;

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
      login: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LocalStrategy,
        { provide: AuthService, useValue: authService },
      ],
    }).compile();

    strategy = module.get<LocalStrategy>(LocalStrategy);
  });

  it("should be defined", () => {
    expect(strategy).toBeDefined();
  });

  describe("validate", () => {
    it("returns user when login succeeds", async () => {
      authService.login.mockResolvedValue({
        user: mockUser,
        accessToken: "token",
        refreshToken: "refresh",
      });

      const result = await strategy.validate("test@example.com", "password123");

      expect(authService.login).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
      expect(result).toEqual(mockUser);
    });

    it("throws UnauthorizedException when login requires 2FA", async () => {
      authService.login.mockResolvedValue({
        requires2FA: true,
        tempToken: "temp",
      });

      await expect(
        strategy.validate("test@example.com", "password123"),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        strategy.validate("test@example.com", "password123"),
      ).rejects.toThrow("2FA verification required");
    });

    it("throws when login throws UnauthorizedException", async () => {
      authService.login.mockRejectedValue(
        new UnauthorizedException("Invalid credentials"),
      );

      await expect(
        strategy.validate("test@example.com", "wrongpassword"),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
