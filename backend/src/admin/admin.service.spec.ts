import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";

describe("AdminService", () => {
  let service: AdminService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;

  const mockAdmin = {
    id: "admin-1",
    email: "admin@example.com",
    firstName: "Admin",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "admin",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockTargetUser = {
    id: "user-2",
    email: "user@example.com",
    firstName: "Regular",
    lastName: "User",
    passwordHash: "$2a$10$hashedpassword",
    authProvider: "local",
    role: "user",
    isActive: true,
    twoFactorSecret: null,
    resetToken: null,
    resetTokenExpiry: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    usersRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((data) => data),
      remove: jest.fn(),
      count: jest.fn(),
    };

    preferencesRepository = {
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
        AdminService,
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

    service = module.get<AdminService>(AdminService);
  });

  describe("findAllUsers", () => {
    it("returns users with sensitive fields stripped", async () => {
      usersRepository.find.mockResolvedValue([mockAdmin, mockTargetUser]);

      const result = await service.findAllUsers();

      expect(result).toHaveLength(2);
      result.forEach((user) => {
        expect(user).not.toHaveProperty("passwordHash");
        expect(user).not.toHaveProperty("resetToken");
        expect(user).not.toHaveProperty("resetTokenExpiry");
        expect(user).not.toHaveProperty("twoFactorSecret");
        expect(user).toHaveProperty("hasPassword", true);
      });
    });

    it("sets hasPassword false for OIDC users without password", async () => {
      usersRepository.find.mockResolvedValue([
        { ...mockTargetUser, passwordHash: null, authProvider: "oidc" },
      ]);

      const result = await service.findAllUsers();

      expect(result[0].hasPassword).toBe(false);
    });

    it("orders users by createdAt ASC", async () => {
      usersRepository.find.mockResolvedValue([]);

      await service.findAllUsers();

      expect(usersRepository.find).toHaveBeenCalledWith({
        order: { createdAt: "ASC" },
      });
    });
  });

  describe("updateUserRole", () => {
    it("updates role successfully", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.updateUserRole("admin-1", "user-2", "admin");

      expect(result.role).toBe("admin");
      expect(result).not.toHaveProperty("passwordHash");
    });

    it("throws ForbiddenException when changing own role", async () => {
      await expect(
        service.updateUserRole("admin-1", "admin-1", "user"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when target user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateUserRole("admin-1", "nonexistent", "admin"),
      ).rejects.toThrow(NotFoundException);
    });

    it("prevents removing the last admin", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(1);

      await expect(
        service.updateUserRole("admin-1", "user-2", "user"),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows demoting admin when other admins exist", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(3);

      const result = await service.updateUserRole("admin-1", "user-2", "user");

      expect(result.role).toBe("user");
    });
  });

  describe("updateUserStatus", () => {
    it("deactivates a user and revokes refresh tokens", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.updateUserStatus("admin-1", "user-2", false);

      expect(result.isActive).toBe(false);
      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("activates a user without revoking tokens", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        isActive: false,
      });

      const result = await service.updateUserStatus("admin-1", "user-2", true);

      expect(result.isActive).toBe(true);
      expect(refreshTokensRepository.update).not.toHaveBeenCalled();
    });

    it("revokes all PATs when deactivating a user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.updateUserStatus("admin-1", "user-2", false);

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("throws ForbiddenException when disabling own account", async () => {
      await expect(
        service.updateUserStatus("admin-1", "admin-1", false),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when target not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.updateUserStatus("admin-1", "nonexistent", false),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("deleteUser", () => {
    it("deletes preferences then user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(preferencesRepository.delete).toHaveBeenCalledWith({
        userId: "user-2",
      });
      expect(usersRepository.remove).toHaveBeenCalled();
    });

    it("throws ForbiddenException when deleting own account", async () => {
      await expect(service.deleteUser("admin-1", "admin-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws NotFoundException when target not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.deleteUser("admin-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("prevents deleting the last admin", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(1);

      await expect(service.deleteUser("admin-1", "user-2")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("allows deleting admin when other admins exist", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        role: "admin",
      });
      usersRepository.count.mockResolvedValue(2);

      await service.deleteUser("admin-1", "user-2");

      expect(usersRepository.remove).toHaveBeenCalled();
    });
  });

  describe("resetUserPassword", () => {
    it("generates a temporary password and sets mustChangePassword", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      const result = await service.resetUserPassword("admin-1", "user-2");

      expect(result.temporaryPassword).toBeDefined();
      expect(typeof result.temporaryPassword).toBe("string");
      expect(result.temporaryPassword.length).toBeGreaterThan(8);

      const savedUser = usersRepository.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(true);
      expect(savedUser.resetToken).toBeNull();
      expect(savedUser.resetTokenExpiry).toBeNull();
      // Password should be hashed, not plaintext
      expect(savedUser.passwordHash).not.toBe(result.temporaryPassword);
    });

    it("revokes all refresh tokens after password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("revokes all PATs on password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("throws ForbiddenException when resetting own password", async () => {
      await expect(
        service.resetUserPassword("admin-1", "admin-1"),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when user not found", async () => {
      usersRepository.findOne.mockResolvedValue(null);

      await expect(
        service.resetUserPassword("admin-1", "nonexistent"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException for accounts without local password", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        passwordHash: null,
        authProvider: "oidc",
      });

      await expect(
        service.resetUserPassword("admin-1", "user-2"),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
