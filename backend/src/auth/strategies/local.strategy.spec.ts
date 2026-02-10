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
      validateUser: jest.fn(),
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
    it("returns user when authService.validateUser returns a user", async () => {
      authService.validateUser.mockResolvedValue(mockUser);

      const result = await strategy.validate("test@example.com", "password123");

      expect(authService.validateUser).toHaveBeenCalledWith("test@example.com", "password123");
      expect(result).toEqual(mockUser);
    });

    it("throws UnauthorizedException when validateUser returns null", async () => {
      authService.validateUser.mockResolvedValue(null);

      await expect(
        strategy.validate("test@example.com", "wrongpassword"),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        strategy.validate("test@example.com", "wrongpassword"),
      ).rejects.toThrow("Invalid credentials");
    });
  });
});
