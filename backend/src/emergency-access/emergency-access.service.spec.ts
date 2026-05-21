import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { EmergencyAccessService } from "./emergency-access.service";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { EmailService } from "../notifications/email.service";
import { User } from "../users/entities/user.entity";

describe("EmergencyAccessService", () => {
  let service: EmergencyAccessService;
  let settingsRepo: Record<string, jest.Mock>;
  let contactsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: Record<string, jest.Mock>;
  };
  let dataSource: { createQueryRunner: jest.Mock };

  const userId = "11111111-1111-1111-1111-111111111111";

  beforeEach(async () => {
    settingsRepo = { findOne: jest.fn(), save: jest.fn() };
    contactsRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
      create: jest.fn((row) => row),
      createQueryBuilder: jest.fn(),
    };
    usersRepo = { findOne: jest.fn() };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      encrypt: jest.fn((s) => `enc(${s})`),
      decrypt: jest.fn((s) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
    };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
    };

    const updateBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: jest.fn(),
        create: jest.fn((_entity, row) => row),
        save: jest.fn((row) => row),
        createQueryBuilder: jest.fn(() => updateBuilder),
      },
    };
    dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmergencyAccessService,
        {
          provide: getRepositoryToken(EmergencyAccessSettings),
          useValue: settingsRepo,
        },
        {
          provide: getRepositoryToken(EmergencyAccessContact),
          useValue: contactsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        { provide: AiEncryptionService, useValue: encryption },
        { provide: EmailService, useValue: emailService },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(EmergencyAccessService);
  });

  describe("getView", () => {
    it("returns defaults and emailConfigured=true when no settings row exists", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);

      expect(view.emailConfigured).toBe(true);
      expect(view.enabled).toBe(false);
      expect(view.grantAfterDays).toBe(14);
      expect(view.reminderAfterDays).toBe(7);
      expect(view.message).toBeNull();
      expect(view.contacts).toEqual([]);
    });

    it("decrypts the stored ciphertext when present", async () => {
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(hello)",
        lastReminderSentAt: null,
        grantedAt: null,
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.message).toBe("hello");
      expect(encryption.decrypt).toHaveBeenCalledWith("enc(hello)");
    });

    it("returns emailConfigured=false when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.emailConfigured).toBe(false);
    });
  });

  describe("upsertSettings", () => {
    it("refuses to save when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("encrypts a non-empty message before storing", async () => {
      queryRunner.manager.findOne.mockResolvedValue(null);
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(hello)",
      });
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      await service.upsertSettings(userId, {
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        message: "hello",
      });

      expect(encryption.encrypt).toHaveBeenCalledWith("hello");
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
    });

    it("clears the ciphertext when message is empty", async () => {
      queryRunner.manager.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(stale)",
      });
      settingsRepo.findOne.mockResolvedValue(null);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      await service.upsertSettings(userId, {
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        message: "   ",
      });

      const saved = queryRunner.manager.save.mock.calls[0][0];
      expect(saved.messageCiphertext).toBeNull();
    });

    it("rolls back on error", async () => {
      queryRunner.manager.findOne.mockRejectedValueOnce(new Error("boom"));
      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
        }),
      ).rejects.toThrow("boom");
      expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    });
  });

  describe("contact CRUD", () => {
    it("addContact rejects duplicate email (case-insensitive)", async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "existing" }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.addContact(userId, {
          firstName: "Alice",
          email: "Alice@Example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("addContact saves a new row", async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);
      contactsRepo.save.mockImplementation((row) => ({
        id: "new",
        createdAt: new Date(),
        ...row,
      }));

      const created = await service.addContact(userId, {
        firstName: " Alice ",
        email: " alice@example.com ",
      });

      expect(created.firstName).toBe("Alice");
      expect(created.email).toBe("alice@example.com");
      expect(contactsRepo.save).toHaveBeenCalled();
    });

    it("updateContact throws NotFoundException when missing", async () => {
      contactsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.updateContact(userId, "00000000-0000-0000-0000-000000000000", {
          firstName: "X",
          email: "x@example.com",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("removeContact throws NotFoundException when nothing was deleted", async () => {
      contactsRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(
        service.removeContact(userId, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
