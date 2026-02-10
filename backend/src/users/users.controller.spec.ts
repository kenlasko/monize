import { Test, TestingModule } from "@nestjs/testing";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

describe("UsersController", () => {
  let controller: UsersController;
  let mockUsersService: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockUsersService = {
      findById: jest.fn(),
      updateProfile: jest.fn(),
      getPreferences: jest.fn(),
      updatePreferences: jest.fn(),
      changePassword: jest.fn(),
      deleteAccount: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
  });

  describe("getProfile()", () => {
    it("returns sanitized user profile with hasPassword field", async () => {
      mockUsersService.findById.mockResolvedValue({
        id: "user-1",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        passwordHash: "$2b$10$hashedsecret",
        resetToken: "some-token",
        resetTokenExpiry: new Date(),
        twoFactorSecret: "secret123",
      });

      const result = await controller.getProfile(mockReq);

      expect(result).toEqual({
        id: "user-1",
        email: "test@example.com",
        firstName: "John",
        lastName: "Doe",
        hasPassword: true,
      });
      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(mockUsersService.findById).toHaveBeenCalledWith("user-1");
    });

    it("sets hasPassword to false when passwordHash is null", async () => {
      mockUsersService.findById.mockResolvedValue({
        id: "user-1",
        email: "test@example.com",
        passwordHash: null,
        resetToken: null,
        resetTokenExpiry: null,
        twoFactorSecret: null,
      });

      const result = await controller.getProfile(mockReq);

      expect(result.hasPassword).toBe(false);
    });

    it("returns null when user is not found", async () => {
      mockUsersService.findById.mockResolvedValue(null);

      const result = await controller.getProfile(mockReq);

      expect(result).toBeNull();
    });
  });

  describe("updateProfile()", () => {
    it("delegates to usersService.updateProfile with userId and dto", async () => {
      const dto = { firstName: "Jane", lastName: "Smith" };
      const expected = {
        id: "user-1",
        firstName: "Jane",
        lastName: "Smith",
      };
      mockUsersService.updateProfile.mockResolvedValue(expected);

      const result = await controller.updateProfile(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockUsersService.updateProfile).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("getPreferences()", () => {
    it("delegates to usersService.getPreferences with userId", async () => {
      const expected = { currency: "USD", dateFormat: "MM/DD/YYYY" };
      mockUsersService.getPreferences.mockResolvedValue(expected);

      const result = await controller.getPreferences(mockReq);

      expect(result).toEqual(expected);
      expect(mockUsersService.getPreferences).toHaveBeenCalledWith("user-1");
    });
  });

  describe("updatePreferences()", () => {
    it("delegates to usersService.updatePreferences with userId and dto", async () => {
      const dto = { currency: "EUR" };
      const expected = { currency: "EUR", dateFormat: "MM/DD/YYYY" };
      mockUsersService.updatePreferences.mockResolvedValue(expected);

      const result = await controller.updatePreferences(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockUsersService.updatePreferences).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("changePassword()", () => {
    it("delegates to usersService.changePassword and returns success message", async () => {
      const dto = { currentPassword: "old123", newPassword: "new456" };
      mockUsersService.changePassword.mockResolvedValue(undefined);

      const result = await controller.changePassword(mockReq, dto as any);

      expect(result).toEqual({ message: "Password changed successfully" });
      expect(mockUsersService.changePassword).toHaveBeenCalledWith(
        "user-1",
        dto,
      );
    });
  });

  describe("deleteAccount()", () => {
    it("delegates to usersService.deleteAccount and returns success message", async () => {
      mockUsersService.deleteAccount.mockResolvedValue(undefined);

      const result = await controller.deleteAccount(mockReq);

      expect(result).toEqual({ message: "Account deleted successfully" });
      expect(mockUsersService.deleteAccount).toHaveBeenCalledWith("user-1");
    });
  });
});
