import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { UsersService } from "./users.service";
import { User } from "./entities/user.entity";
import { UserPreference } from "./entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";

describe("UsersService", () => {
  let service: UsersService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;

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
    mustChangePassword: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPreferences = {
    userId: "user-1",
    defaultCurrency: "USD",
    dateFormat: "browser",
    numberFormat: "browser",
    theme: "system",
    timezone: "browser",
    notificationEmail: true,
    notificationBrowser: true,
    twoFactorEnabled: false,
    gettingStartedDismissed: false,
  };

  beforeEach(async () => {
    usersRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      remove: jest.fn(),
      count: jest.fn(),
    };

    preferencesRepository = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      delete: jest.fn(),
    };

    refreshTokensRepository = {
      update: jest.fn(),
    };

    patRepository = {
      update: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: usersRepository },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokensRepository,
        },
        {
          provide: getRepositoryToken(PersonalAccessToken),
          useValue: patRepository,
        },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe("findById", () => {
    it("returns user when found", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findById("user-1");

      expect(result).toEqual(mockUser);
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { id: "user-1" },
      });
    });

    it("returns null when not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.findById("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("findByEmail", () => {
    it("returns user when found", async () => {
      usersRepository.findOne.mockResolvedValue(mockUser);

      const result = await service.findByEmail("test@example.com");

      expect(result).toEqual(mockUser);
      expect(usersRepository.findOne).toHaveBeenCalledWith({
        where: { email: "test@example.com" },
      });
    });

    it("returns null when not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      const result = await service.findByEmail("nobody@example.com");

      expect(result).toBeNull();
    });
  });

  describe("findAll", () => {
    it("returns all users", async () => {
      usersRepository.find.mockResolvedValue([mockUser]);

      const result = await service.findAll();

      expect(result).toHaveLength(1);
      expect(usersRepository.find).toHaveBeenCalled();
    });
  });

  describe("updateProfile", () => {
    it("updates first and last name", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
        lastName: "Name",
      });

      expect(result.firstName).toBe("Updated");
      expect(result.lastName).toBe("Name");
    });

    it("updates email when not taken and password is correct", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne
        .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword }) // find user
        .mockResolvedValueOnce(null); // email not taken
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        email: "new@example.com",
        currentPassword: "CorrectPass123!",
      });

      expect(result.email).toBe("new@example.com");
    });

    it("throws BadRequestException when changing email without password", async () => {
      usersRepository.findOne.mockResolvedValueOnce({ ...mockUser });

      await expect(
        service.updateProfile("user-1", { email: "new@example.com" }),
      ).rejects.toThrow("Current password is required to change email address");
    });

    it("throws BadRequestException when changing email with wrong password", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne.mockResolvedValueOnce({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.updateProfile("user-1", {
          email: "new@example.com",
          currentPassword: "WrongPassword!",
        }),
      ).rejects.toThrow("Current password is incorrect");
    });

    it("throws ConflictException when email is already taken", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass123!", 10);
      usersRepository.findOne
        .mockResolvedValueOnce({ ...mockUser, passwordHash: hashedPassword }) // find user
        .mockResolvedValueOnce({ id: "other-user" }); // email taken

      await expect(
        service.updateProfile("user-1", {
          email: "taken@example.com",
          currentPassword: "CorrectPass123!",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("throws BadRequestException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateProfile("nonexistent", { firstName: "Test" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("strips sensitive fields from result", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
      });

      expect(result).not.toHaveProperty("passwordHash");
      expect(result).not.toHaveProperty("resetToken");
      expect(result).not.toHaveProperty("resetTokenExpiry");
      expect(result).not.toHaveProperty("twoFactorSecret");
      expect(result).toHaveProperty("hasPassword", true);
    });

    it("sets hasPassword to false when no password hash", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });
      usersRepository.save.mockImplementation((user) => user);

      const result = await service.updateProfile("user-1", {
        firstName: "Updated",
      });

      expect(result.hasPassword).toBe(false);
    });
  });

  describe("getPreferences", () => {
    it("returns existing preferences", async () => {
      preferencesRepository.findOne.mockResolvedValue(mockPreferences);

      const result = await service.getPreferences("user-1");

      expect(result).toEqual(mockPreferences);
    });

    it("creates default preferences when none exist", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      preferencesRepository.save.mockImplementation((data) => data);

      const result = await service.getPreferences("user-1");

      expect(preferencesRepository.save).toHaveBeenCalled();
      expect(result.userId).toBe("user-1");
      expect(result.defaultCurrency).toBe("USD");
      expect(result.dateFormat).toBe("browser");
      expect(result.theme).toBe("system");
    });
  });

  describe("updatePreferences", () => {
    it("updates only provided fields", async () => {
      preferencesRepository.findOne.mockResolvedValue({ ...mockPreferences });

      await service.updatePreferences("user-1", { theme: "dark" });

      const savedData = preferencesRepository.save.mock.calls[0][0];
      expect(savedData.theme).toBe("dark");
      expect(savedData.defaultCurrency).toBe("USD"); // unchanged
    });

    it("creates defaults first if preferences do not exist", async () => {
      preferencesRepository.findOne.mockResolvedValue(null);
      preferencesRepository.save.mockImplementation((data) => data);

      await service.updatePreferences("user-1", {
        defaultCurrency: "EUR",
      });

      // First save for creating defaults, second for updating
      expect(preferencesRepository.save).toHaveBeenCalled();
    });

    it("updates multiple fields at once", async () => {
      preferencesRepository.findOne.mockResolvedValue({ ...mockPreferences });

      await service.updatePreferences("user-1", {
        defaultCurrency: "CAD",
        theme: "dark",
        notificationEmail: false,
        gettingStartedDismissed: true,
      });

      const savedData = preferencesRepository.save.mock.calls[0][0];
      expect(savedData.defaultCurrency).toBe("CAD");
      expect(savedData.theme).toBe("dark");
      expect(savedData.notificationEmail).toBe(false);
      expect(savedData.gettingStartedDismissed).toBe(true);
    });
  });

  describe("changePassword", () => {
    it("changes password with valid current password", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(false);
      // Verify new password was hashed (not stored as plaintext)
      const isNewHash = await bcrypt.compare(
        "NewPass456!",
        savedUser.passwordHash,
      );
      expect(isNewHash).toBe(true);
    });

    it("revokes all refresh tokens after password change", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes all PATs on password change", async () => {
      const hashedPassword = await bcrypt.hash("OldPass123!", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await service.changePassword("user-1", {
        currentPassword: "OldPass123!",
        newPassword: "NewPass456!",
      });

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("throws when current password is incorrect", async () => {
      const hashedPassword = await bcrypt.hash("CorrectPass", 10);
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: hashedPassword,
      });

      await expect(
        service.changePassword("user-1", {
          currentPassword: "WrongPass",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow("Current password is incorrect");
    });

    it("throws when no password is set", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        passwordHash: null,
      });

      await expect(
        service.changePassword("user-1", {
          currentPassword: "anything",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow("No password set for this account");
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.changePassword("nonexistent", {
          currentPassword: "pass",
          newPassword: "NewPass456!",
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("deleteAccount", () => {
    it("deletes preferences, revokes tokens, then deletes user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await service.deleteAccount("user-1");

      expect(preferencesRepository.delete).toHaveBeenCalledWith({
        userId: "user-1",
      });
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("revokes all PATs before deletion", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockUser });

      await service.deleteAccount("user-1");

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-1", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("throws when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(service.deleteAccount("nonexistent")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("prevents the last admin from self-deleting", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(1);

      await expect(service.deleteAccount("user-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("allows admin self-deletion when other admins exist", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(2);

      await service.deleteAccount("user-1");

      expect(usersRepository.remove).toHaveBeenCalled();
    });
  });
});
