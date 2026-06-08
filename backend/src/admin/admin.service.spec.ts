import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { AdminService } from "./admin.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { OAuthProviderService } from "../oauth/oauth-provider.service";
import { UsersService } from "../users/users.service";
import { EmailService } from "../notifications/email.service";

describe("AdminService", () => {
  let service: AdminService;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let refreshTokensRepository: Record<string, jest.Mock>;
  let patRepository: Record<string, jest.Mock>;
  let oauthProviderService: Record<string, jest.Mock>;
  let usersService: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let transactionManager: Record<string, jest.Mock>;
  let dataSource: Record<string, jest.Mock>;

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
      createQueryBuilder: jest.fn(),
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

    oauthProviderService = {
      revokeAllForUser: jest.fn().mockResolvedValue(0),
    };

    usersService = {
      isActingDelegate: jest.fn().mockResolvedValue(false),
      purgeForDowngrade: jest.fn().mockResolvedValue(undefined),
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest.fn().mockReturnValue("http://localhost:3000"),
    };

    transactionManager = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((_entity, data) => ({ ...data })),
      save: jest.fn().mockImplementation((data) => ({
        id: data.id ?? "new-user-id",
        ...data,
      })),
    };

    dataSource = {
      transaction: jest.fn().mockImplementation((cb) => cb(transactionManager)),
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
        {
          provide: OAuthProviderService,
          useValue: oauthProviderService,
        },
        {
          provide: UsersService,
          useValue: usersService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
        {
          provide: ConfigService,
          useValue: configService,
        },
        {
          provide: EmailService,
          useValue: emailService,
        },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
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

    it("hides owner-managed delegate identities and orders by createdAt ASC", async () => {
      usersRepository.find.mockResolvedValue([]);

      await service.findAllUsers();

      expect(usersRepository.find).toHaveBeenCalledWith({
        where: { isDelegateOnly: false },
        order: { createdAt: "ASC" },
      });
    });
  });

  describe("createUser", () => {
    it("creates a new full account with an admin-set password", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({
        email: "New@Example.com",
        firstName: "New",
        password: "Sup3rStr0ng!Pass",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.email).toBe("new@example.com");
      expect(savedUser.isDelegateOnly).toBe(false);
      expect(savedUser.authProvider).toBe("local");
      expect(savedUser.role).toBe("user");
      expect(savedUser.mustChangePassword).toBe(false);
      expect(savedUser.passwordHash).not.toBe("Sup3rStr0ng!Pass");
      expect(result.invited).toBe(false);
      expect(result.upgraded).toBe(false);
      expect(result.temporaryPassword).toBeUndefined();
      expect(result).not.toHaveProperty("passwordHash");
    });

    it("honors the requested admin role", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      await service.createUser({
        email: "boss@example.com",
        password: "Sup3rStr0ng!Pass",
        role: "admin",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.role).toBe("admin");
    });

    it("generates a temporary password when neither password nor invite is given", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({ email: "temp@example.com" });

      expect(result.temporaryPassword).toBeDefined();
      expect(typeof result.temporaryPassword).toBe("string");
      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.mustChangePassword).toBe(true);
      expect(savedUser.passwordHash).not.toBe(result.temporaryPassword);
    });

    it("sends an invite email and sets a 24h reset token when sendInvite is true", async () => {
      transactionManager.findOne.mockResolvedValue(null);

      const result = await service.createUser({
        email: "invitee@example.com",
        firstName: "Invitee",
        sendInvite: true,
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.resetToken).toBeTruthy();
      expect(savedUser.resetTokenExpiry).toBeInstanceOf(Date);
      expect(savedUser.passwordHash).toBeUndefined();
      expect(result.invited).toBe(true);
      expect(result.temporaryPassword).toBeUndefined();
      expect(emailService.sendMail).toHaveBeenCalledWith(
        "invitee@example.com",
        "Your Monize account is ready",
        expect.stringContaining("reset-password?token="),
      );
    });

    it("rejects sendInvite when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });

      await expect(
        service.createUser({ email: "x@example.com", sendInvite: true }),
      ).rejects.toThrow(BadRequestException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it("rejects when both password and invite are supplied", async () => {
      await expect(
        service.createUser({
          email: "x@example.com",
          password: "Sup3rStr0ng!Pass",
          sendInvite: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("upgrades a pure delegate row into a full account, preserving the row id", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "delegate-1",
        email: "delegate@example.com",
        authProvider: "local",
        role: "user",
        isDelegateOnly: true,
        passwordHash: "$2a$10$existing",
      });

      const result = await service.createUser({
        email: "delegate@example.com",
        firstName: "Deleg",
        password: "Sup3rStr0ng!Pass",
      });

      const savedUser = transactionManager.save.mock.calls[0][0];
      expect(savedUser.id).toBe("delegate-1");
      expect(savedUser.isDelegateOnly).toBe(false);
      expect(savedUser.firstName).toBe("Deleg");
      expect(result.upgraded).toBe(true);
      // No new row created -- the existing delegate row is reused.
      expect(transactionManager.create).not.toHaveBeenCalled();
    });

    it("rejects creating a user whose email is already a full account", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "real-1",
        email: "real@example.com",
        authProvider: "local",
        role: "user",
        isDelegateOnly: false,
        passwordHash: "$2a$10$existing",
      });

      await expect(
        service.createUser({
          email: "real@example.com",
          password: "Sup3rStr0ng!Pass",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("never rotates credentials of an OIDC delegate-only row", async () => {
      transactionManager.findOne.mockResolvedValue({
        id: "oidc-1",
        email: "sso@example.com",
        authProvider: "oidc",
        role: "user",
        isDelegateOnly: true,
      });

      await expect(
        service.createUser({
          email: "sso@example.com",
          password: "Sup3rStr0ng!Pass",
        }),
      ).rejects.toThrow(ConflictException);
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

    it("revokes all OIDC artifacts when deactivating a user", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.updateUserStatus("admin-1", "user-2", false);

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("does not revoke OIDC artifacts when activating a user", async () => {
      usersRepository.findOne.mockResolvedValue({
        ...mockTargetUser,
        isActive: false,
      });

      await service.updateUserStatus("admin-1", "user-2", true);

      expect(oauthProviderService.revokeAllForUser).not.toHaveBeenCalled();
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

    it("revokes all OIDC artifacts on delete", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
    });

    it("revokes refresh tokens and PATs on delete", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.deleteUser("admin-1", "user-2");

      expect(refreshTokensRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
      expect(patRepository.update).toHaveBeenCalledWith(
        { userId: "user-2", isRevoked: false },
        { isRevoked: true },
      );
    });

    it("demotes a delegate to a pure delegate instead of deleting", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });
      usersService.isActingDelegate.mockResolvedValue(true);

      await service.deleteUser("admin-1", "user-2");

      expect(usersService.purgeForDowngrade).toHaveBeenCalledWith("user-2");
      expect(preferencesRepository.delete).not.toHaveBeenCalled();
      expect(usersRepository.remove).not.toHaveBeenCalled();
      // Sessions are still revoked so the demotion takes effect immediately.
      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
      );
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

    it("revokes all OIDC artifacts on password reset", async () => {
      usersRepository.findOne.mockResolvedValue({ ...mockTargetUser });

      await service.resetUserPassword("admin-1", "user-2");

      expect(oauthProviderService.revokeAllForUser).toHaveBeenCalledWith(
        "user-2",
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
