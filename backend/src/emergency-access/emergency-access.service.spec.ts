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

    it("removeContact resolves when a row was deleted", async () => {
      contactsRepo.delete.mockResolvedValue({ affected: 1 });
      await expect(
        service.removeContact(userId, "00000000-0000-0000-0000-000000000000"),
      ).resolves.toBeUndefined();
    });

    it("updateContact updates fields and clears the in-flight magic link", async () => {
      const existing = {
        id: "c1",
        ownerUserId: userId,
        firstName: "Old",
        email: "old@example.com",
        claimTokenHash: "stale-hash",
        claimTokenExpiresAt: new Date(),
      };
      contactsRepo.findOne.mockResolvedValue(existing);
      contactsRepo.save.mockImplementation(async (row) => row);
      // The email changes, so the service runs the dup-check query.
      contactsRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      });

      const result = await service.updateContact(userId, "c1", {
        firstName: " New ",
        email: " new@example.com ",
      });

      expect(result.firstName).toBe("New");
      expect(result.email).toBe("new@example.com");
      expect(existing.claimTokenHash).toBeNull();
      expect(existing.claimTokenExpiresAt).toBeNull();
    });

    it("updateContact skips the dup-check when the email is unchanged", async () => {
      const existing = {
        id: "c1",
        ownerUserId: userId,
        firstName: "Old",
        email: "old@example.com",
        claimTokenHash: null,
        claimTokenExpiresAt: null,
      };
      contactsRepo.findOne.mockResolvedValue(existing);
      contactsRepo.save.mockImplementation(async (row) => row);

      await service.updateContact(userId, "c1", {
        firstName: "Renamed",
        email: "OLD@example.com",
      });

      expect(contactsRepo.createQueryBuilder).not.toHaveBeenCalled();
      expect(existing.firstName).toBe("Renamed");
    });

    it("updateContact rejects swapping to an email already used by another row", async () => {
      contactsRepo.findOne.mockResolvedValue({
        id: "c1",
        ownerUserId: userId,
        email: "old@example.com",
      });
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: "c2" }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.updateContact(userId, "c1", {
          firstName: "X",
          email: "Other@Example.com",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("decryptMessage edge cases", () => {
    it("returns null and warns when the encryption key is not configured", async () => {
      encryption.isConfigured.mockReturnValue(false);
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(hello)",
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.message).toBeNull();
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("returns null when decrypt throws", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw new Error("bad key");
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.message).toBeNull();
    });

    it("returns null when decrypt throws a non-Error value", async () => {
      encryption.decrypt.mockImplementation(() => {
        throw "raw-string-not-an-Error";
      });
      settingsRepo.findOne.mockResolvedValue({
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
      });
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.message).toBeNull();
    });
  });

  describe("getView lastActivityAt resolution", () => {
    it("returns the user's lastActivityAt when set", async () => {
      const t = new Date("2026-01-01T00:00:00Z");
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        lastActivityAt: t,
        lastLogin: null,
      });

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBe(t);
    });

    it("falls back to lastLogin when lastActivityAt is null", async () => {
      const t = new Date("2026-01-01T00:00:00Z");
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue({
        id: userId,
        lastActivityAt: null,
        lastLogin: t,
      });

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBe(t);
    });

    it("returns null when the user row itself is missing", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([]);
      usersRepo.findOne.mockResolvedValue(null);

      const view = await service.getView(userId);
      expect(view.lastActivityAt).toBeNull();
    });

    it("maps stored contact rows into the contact view shape", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      contactsRepo.find.mockResolvedValue([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const view = await service.getView(userId);
      expect(view.contacts).toEqual([
        {
          id: "c1",
          firstName: "Carol",
          email: "carol@example.com",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      ]);
    });
  });

  describe("upsertSettings: encryption configuration", () => {
    it("refuses to save a non-empty message when AI_ENCRYPTION_KEY is missing", async () => {
      encryption.isConfigured.mockReturnValue(false);
      await expect(
        service.upsertSettings(userId, {
          enabled: true,
          grantAfterDays: 14,
          reminderAfterDays: 7,
          message: "secret",
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("voids outstanding magic links and clears markers when owner disables", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });
      contactsRepo.find.mockResolvedValue([]);

      const builder = queryRunner.manager.createQueryBuilder();
      await service.upsertSettings(userId, {
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(builder.update).toHaveBeenCalledWith(EmergencyAccessContact);
      // The contact row's claimTokenUsedAt is set via a TypeORM function-valued
      // setter; invoking the closure should yield the SQL fragment we expect.
      const setArgs = builder.set.mock.calls[0][0];
      expect(typeof setArgs.claimTokenUsedAt).toBe("function");
      expect(setArgs.claimTokenUsedAt()).toBe("CURRENT_TIMESTAMP");
      expect(setArgs.claimVoidedReason).toBe("owner_revoked");
      expect(stored.grantedAt).toBeNull();
      expect(stored.lastReminderSentAt).toBeNull();
    });

    it("resets markers when the owner re-enables after a previous disable", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: false,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      queryRunner.manager.findOne.mockResolvedValue(stored);
      settingsRepo.findOne.mockResolvedValue(stored);
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });
      contactsRepo.find.mockResolvedValue([]);

      await service.upsertSettings(userId, {
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
      });

      expect(stored.grantedAt).toBeNull();
      expect(stored.lastReminderSentAt).toBeNull();
    });
  });

  describe("resetGrantedState", () => {
    it("throws when no settings row exists", async () => {
      settingsRepo.findOne.mockResolvedValue(null);
      await expect(service.resetGrantedState(userId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it("clears grant markers and voids outstanding tokens", async () => {
      const stored = {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        grantedAt: new Date(),
        lastReminderSentAt: new Date(),
      };
      // First findOne call: resetGrantedState's own lookup.
      // Second findOne call: getView at the end re-reads the row.
      settingsRepo.findOne
        .mockResolvedValueOnce(stored)
        .mockResolvedValueOnce({ ...stored, grantedAt: null });
      usersRepo.findOne.mockResolvedValue({ id: userId, lastActivityAt: null });

      const updateBuilder = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      };
      contactsRepo.createQueryBuilder.mockReturnValue(updateBuilder);

      const view = await service.resetGrantedState(userId);

      expect(stored.grantedAt).toBeNull();
      expect(stored.lastReminderSentAt).toBeNull();
      expect(settingsRepo.save).toHaveBeenCalledWith(stored);
      expect(updateBuilder.update).toHaveBeenCalledWith(EmergencyAccessContact);
      const setArgs = updateBuilder.set.mock.calls[0][0];
      expect(setArgs.claimTokenUsedAt()).toBe("CURRENT_TIMESTAMP");
      expect(setArgs.claimVoidedReason).toBe("owner_revoked");
      expect(view.grantedAt).toBeNull();
    });
  });
});
