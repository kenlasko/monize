import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { BackupEncryptionService } from "./backup-encryption.service";
import { User } from "../users/entities/user.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { PasswordBreachService } from "../auth/password-breach.service";

jest.mock("bcryptjs");

describe("BackupEncryptionService", () => {
  let service: BackupEncryptionService;
  let usersRepo: Record<string, jest.Mock>;
  let aiEncryption: Record<string, jest.Mock>;
  let passwordBreach: Record<string, jest.Mock>;

  const userId = "user-1";

  function makeUser(overrides: Partial<User> = {}): User {
    return {
      id: userId,
      authProvider: "local",
      passwordHash: "bcrypt-hash",
      backupEncryptionEnabled: false,
      backupPasswordEnc: null,
      ...overrides,
    } as User;
  }

  beforeEach(async () => {
    usersRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation((u) => Promise.resolve(u)),
    };
    aiEncryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((s: string) => `enc:${s}`),
      decrypt: jest.fn((s: string) => s.replace(/^enc:/, "")),
    };
    passwordBreach = {
      isBreached: jest.fn().mockResolvedValue(false),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BackupEncryptionService,
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: AiEncryptionService, useValue: aiEncryption },
        { provide: PasswordBreachService, useValue: passwordBreach },
      ],
    }).compile();

    service = module.get(BackupEncryptionService);
  });

  describe("getStatus", () => {
    it("reports enabled flag and needsBackupPassword=false for local user", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );
      const status = await service.getStatus(userId);
      expect(status).toEqual({ enabled: true, needsBackupPassword: false });
    });

    it("reports needsBackupPassword=true for OIDC user without stored password", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      const status = await service.getStatus(userId);
      expect(status.needsBackupPassword).toBe(true);
    });

    it("throws when user not found", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await expect(service.getStatus(userId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("enableForLocalUser", () => {
    it("verifies password, stores encrypted copy, and turns on the flag", async () => {
      const user = makeUser();
      usersRepo.findOne.mockResolvedValue(user);
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);

      await service.enableForLocalUser(userId, "my-password");

      expect(aiEncryption.encrypt).toHaveBeenCalledWith("my-password");
      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:my-password",
        }),
      );
    });

    it("rejects an invalid password", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(service.enableForLocalUser(userId, "bad")).rejects.toThrow(
        UnauthorizedException,
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("refuses OIDC users", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      await expect(service.enableForLocalUser(userId, "any")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("refuses when AI_ENCRYPTION_KEY is missing", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      (bcrypt.compare as jest.Mock).mockResolvedValue(true);
      aiEncryption.isConfigured.mockReturnValue(false);
      await expect(service.enableForLocalUser(userId, "ok")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("setBackupPasswordForOidcUser", () => {
    it("requires minimum length", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      await expect(
        service.setBackupPasswordForOidcUser(userId, "short"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects breached passwords", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      passwordBreach.isBreached.mockResolvedValue(true);
      await expect(
        service.setBackupPasswordForOidcUser(userId, "a-long-enough-password"),
      ).rejects.toThrow(/data breach/i);
    });

    it("stores the encrypted password and enables encryption", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      await service.setBackupPasswordForOidcUser(userId, "long-good-password");
      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:long-good-password",
        }),
      );
    });

    it("refuses local users", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      await expect(
        service.setBackupPasswordForOidcUser(userId, "long-good-password"),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses when AI_ENCRYPTION_KEY is missing", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ authProvider: "oidc", passwordHash: null }),
      );
      aiEncryption.isConfigured.mockReturnValue(false);
      await expect(
        service.setBackupPasswordForOidcUser(userId, "long-good-password"),
      ).rejects.toThrow(/AI_ENCRYPTION_KEY/);
    });
  });

  describe("disable", () => {
    it("clears the flag and stored password", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:something",
        }),
      );
      await service.disable(userId);
      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          backupEncryptionEnabled: false,
          backupPasswordEnc: null,
        }),
      );
    });
  });

  describe("syncOnPasswordChange", () => {
    it("re-encrypts the stored password under the new value", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:old-password",
        }),
      );
      await service.syncOnPasswordChange(userId, "new-password");
      expect(aiEncryption.encrypt).toHaveBeenCalledWith("new-password");
      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ backupPasswordEnc: "enc:new-password" }),
      );
    });

    it("is a no-op when encryption is disabled", async () => {
      usersRepo.findOne.mockResolvedValue(makeUser());
      await service.syncOnPasswordChange(userId, "new");
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("is a no-op for OIDC users (they manage their backup password separately)", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({
          authProvider: "oidc",
          passwordHash: null,
          backupEncryptionEnabled: true,
          backupPasswordEnc: "enc:dedicated",
        }),
      );
      await service.syncOnPasswordChange(userId, "ignored");
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("is a no-op when AI_ENCRYPTION_KEY is missing", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );
      aiEncryption.isConfigured.mockReturnValue(false);
      await service.syncOnPasswordChange(userId, "new");
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("is a no-op when the user has disappeared", async () => {
      usersRepo.findOne.mockResolvedValue(null);
      await service.syncOnPasswordChange(userId, "new");
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it("does not throw if save fails -- password change must still succeed", async () => {
      usersRepo.findOne.mockResolvedValue(
        makeUser({ backupEncryptionEnabled: true }),
      );
      usersRepo.save.mockRejectedValue(new Error("db down"));
      await expect(
        service.syncOnPasswordChange(userId, "new"),
      ).resolves.not.toThrow();
    });
  });
});
