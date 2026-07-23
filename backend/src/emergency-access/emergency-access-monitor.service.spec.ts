import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { EmergencyAccessMonitorService } from "./emergency-access-monitor.service";
import { EmergencyAccessSettings } from "./entities/emergency-access-settings.entity";
import { EmergencyAccessContact } from "./entities/emergency-access-contact.entity";
import { AiEncryptionService } from "../ai/ai-encryption.service";
import { EmailService } from "../notifications/email.service";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { getRequestContext } from "../common/request-context";

describe("EmergencyAccessMonitorService", () => {
  let service: EmergencyAccessMonitorService;
  let settingsRepo: Record<string, jest.Mock>;
  let contactsRepo: Record<string, jest.Mock>;
  let usersRepo: Record<string, jest.Mock>;
  let prefsRepo: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let encryption: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  const userId = "11111111-1111-1111-1111-111111111111";

  function daysAgo(n: number): Date {
    return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  }

  beforeEach(async () => {
    settingsRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(),
    };
    contactsRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (row) => row),
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };
    usersRepo = { findOne: jest.fn() };
    prefsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };
    encryption = {
      isConfigured: jest.fn().mockReturnValue(true),
      decrypt: jest.fn((s) => s.replace(/^enc\(/, "").replace(/\)$/, "")),
    };
    configService = {
      get: jest.fn((key: string, fallback: string) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmergencyAccessMonitorService,
        {
          provide: getRepositoryToken(EmergencyAccessSettings),
          useValue: settingsRepo,
        },
        {
          provide: getRepositoryToken(EmergencyAccessContact),
          useValue: contactsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: prefsRepo,
        },
        { provide: EmailService, useValue: emailService },
        { provide: AiEncryptionService, useValue: encryption },
        { provide: ConfigService, useValue: configService },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
      ],
    }).compile();

    service = module.get(EmergencyAccessMonitorService);
  });

  it("returns immediately when SMTP is not configured", async () => {
    emailService.getStatus.mockReturnValue({ configured: false });
    await service.runDailyCheck();
    expect(settingsRepo.find).not.toHaveBeenCalled();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  // RLS (task C4): the cross-user sweep runs under a system context.
  it("runs the sweep under a system context", async () => {
    let ctx: ReturnType<typeof getRequestContext>;
    settingsRepo.find.mockImplementation(() => {
      ctx = getRequestContext();
      return Promise.resolve([]);
    });
    await service.runDailyCheck();
    expect(ctx).toEqual({ system: true });
  });

  it("sends a reminder when inactivity exceeds reminderAfterDays but not grantAfterDays", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "One",
      isActive: true,
      lastActivityAt: daysAgo(10),
    });
    contactsRepo.find.mockResolvedValue([
      { firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject] = emailService.sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("10");
    expect(settingsRepo.save).toHaveBeenCalled();
  });

  it("issues a grant token + email to every contact once grantAfterDays is reached", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: "enc(my last wishes)",
      lastReminderSentAt: null,
      grantedAt: null,
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      lastName: "One",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    const recipients = emailService.sendMail.mock.calls.map((c) => c[0]);
    expect(recipients).toEqual(["carol@example.com", "dave@example.com"]);
    expect(contactsRepo.save).toHaveBeenCalledTimes(2);
    expect(contactsRepo.save.mock.calls[0][0].claimTokenHash).toBeTruthy();
    expect(settings.grantedAt).toBeInstanceOf(Date);
  });

  it("does not re-issue grants once granted_at is set", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: daysAgo(0),
        grantedAt: daysAgo(1),
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("does not double-send the daily reminder", async () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: today,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(10),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("skips users without a last_activity_at or last_login timestamp", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: null,
      lastLogin: null,
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("falls back to last_login when last_activity_at is null", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: null,
      lastLogin: daysAgo(10),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("owner@example.com");
  });

  it("returns early when nobody has emergency access enabled", async () => {
    settingsRepo.find.mockResolvedValue([]);
    await service.runDailyCheck();
    expect(usersRepo.findOne).not.toHaveBeenCalled();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("logs and continues when one contact's grant email fails to send", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);
    emailService.sendMail
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce(undefined);

    await service.runDailyCheck();

    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
  });

  it("localizes the grant email to the contact's own account language when they are a Monize user", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockImplementation((opts) =>
      opts?.where?.email === "carol@example.com"
        ? Promise.resolve({ id: "contact-1", email: "carol@example.com" })
        : Promise.resolve({
            id: userId,
            email: "owner@example.com",
            firstName: "Owner",
            isActive: true,
            lastActivityAt: daysAgo(20),
          }),
    );
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);
    prefsRepo.findOne.mockResolvedValue({
      userId: "contact-1",
      language: "fr",
    });

    await service.runDailyCheck();

    expect(usersRepo.findOne).toHaveBeenCalledWith({
      where: { email: "carol@example.com" },
    });
    expect(prefsRepo.findOne).toHaveBeenCalledWith({
      where: { userId: "contact-1" },
    });
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("skips a user gracefully when their settings row is inactive (no email)", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: null,
      isActive: true,
      lastActivityAt: daysAgo(20),
    });

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("does nothing if the grant threshold is reached but the user has no contacts", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    expect(emailService.sendMail).not.toHaveBeenCalled();
    expect(settingsRepo.save).not.toHaveBeenCalled();
  });

  it("emits a grant email with no message body when decryption fails", async () => {
    encryption.decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    // The HTML body should not include the original ciphertext or any block
    // that requires a non-null message.
    const html = emailService.sendMail.mock.calls[0][2] as string;
    expect(html).not.toContain("enc(corrupt)");
    expect(html).not.toContain("border-left: 4px solid");
  });

  it("emits a grant email with no message body when the key is not configured", async () => {
    encryption.isConfigured.mockReturnValue(false);
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(unreadable)",
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it("uses singular phrasing in the reminder subject when daysSinceLogin === 1", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 1,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(1),
    });
    contactsRepo.find.mockResolvedValue([]);

    await service.runDailyCheck();
    const subject = emailService.sendMail.mock.calls[0][1] as string;
    expect(subject).toContain("1 day");
    expect(subject).not.toContain("1 days");
  });

  it("logs without crashing when the outer catch sees a non-Error throw", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockImplementation(() => {
      throw "string-not-an-Error";
    });

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).not.toHaveBeenCalled();
  });

  it("logs without crashing when a per-contact send throws a non-Error value", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);
    emailService.sendMail.mockRejectedValueOnce("smtp-string-error");

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("logs without crashing when decrypt throws a non-Error value", async () => {
    encryption.decrypt.mockImplementation(() => {
      throw "decrypt-string-error";
    });
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: userId,
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: "enc(corrupt)",
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
    ]);

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
  });

  it("does not crash when processOne itself throws and continues to the next user", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: "u1",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
      {
        ownerUserId: "u2",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({
        id: "u2",
        email: "two@example.com",
        isActive: true,
        lastActivityAt: daysAgo(10),
        lastLogin: null,
      });

    await expect(service.runDailyCheck()).resolves.toBeUndefined();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("two@example.com");
  });

  it("continues processing other users when one fails", async () => {
    settingsRepo.find.mockResolvedValue([
      {
        ownerUserId: "u1",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
      {
        ownerUserId: "u2",
        enabled: true,
        grantAfterDays: 14,
        reminderAfterDays: 7,
        messageCiphertext: null,
        lastReminderSentAt: null,
        grantedAt: null,
      },
    ]);
    usersRepo.findOne
      .mockResolvedValueOnce(null) // u1 missing -> skipped path
      .mockResolvedValueOnce({
        id: "u2",
        email: "two@example.com",
        isActive: true,
        lastActivityAt: daysAgo(10),
        lastLogin: null,
      });

    await service.runDailyCheck();
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    expect(emailService.sendMail.mock.calls[0][0]).toBe("two@example.com");
  });

  it("does not commit the grant when every contact email fails to send", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: null,
      grantedAt: null,
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      lastActivityAt: daysAgo(20),
    });
    contactsRepo.find.mockResolvedValue([
      { id: "c1", firstName: "Carol", email: "carol@example.com" },
      { id: "c2", firstName: "Dave", email: "dave@example.com" },
    ]);
    emailService.sendMail.mockRejectedValue(new Error("smtp down"));

    await service.runDailyCheck();

    // Both sends attempted, but grantedAt must stay null so the next daily
    // run retries instead of permanently disabling the safeguard.
    expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    expect(settings.grantedAt).toBeNull();
    expect(settingsRepo.save).not.toHaveBeenCalled();
  });

  it("voids outstanding links and notifies the owner when they return after a grant", async () => {
    const settings = {
      ownerUserId: userId,
      enabled: true,
      grantAfterDays: 14,
      reminderAfterDays: 7,
      messageCiphertext: null,
      lastReminderSentAt: daysAgo(8),
      grantedAt: daysAgo(3),
    };
    settingsRepo.find.mockResolvedValue([settings]);
    usersRepo.findOne.mockResolvedValue({
      id: userId,
      email: "owner@example.com",
      firstName: "Owner",
      isActive: true,
      // Active again: well under the 14-day grant threshold.
      lastActivityAt: daysAgo(1),
    });
    const execute = jest.fn().mockResolvedValue({ affected: 2 });
    contactsRepo.createQueryBuilder.mockReturnValue({
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute,
    });

    await service.runDailyCheck();

    // Outstanding links voided, grant state re-armed, owner emailed.
    expect(execute).toHaveBeenCalledTimes(1);
    expect(settings.grantedAt).toBeNull();
    expect(settings.lastReminderSentAt).toBeNull();
    expect(settingsRepo.save).toHaveBeenCalledWith(settings);
    expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    const [to, subject] = emailService.sendMail.mock.calls[0];
    expect(to).toBe("owner@example.com");
    expect(subject).toContain("while you were away");
  });
});
