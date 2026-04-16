import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { Account, AccountType } from "./entities/account.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";

describe("MortgageReminderService", () => {
  let service: MortgageReminderService;
  let accountsRepository: Record<string, jest.Mock>;
  let usersRepository: Record<string, jest.Mock>;
  let preferencesRepository: Record<string, jest.Mock>;
  let emailService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  function daysFromNow(days: number): Date {
    const date = new Date(today);
    date.setDate(date.getDate() + days);
    return date;
  }

  const mockMortgage = {
    id: "mort-1",
    userId: "user-1",
    name: "Home Mortgage",
    accountType: AccountType.MORTGAGE,
    isClosed: false,
    termEndDate: daysFromNow(30),
  };

  const mockUser: Partial<User> = {
    id: "user-1",
    email: "user1@example.com",
    firstName: "Alice",
  };

  const mockPrefsEmailEnabled: Partial<UserPreference> = {
    userId: "user-1",
    notificationEmail: true,
  };

  beforeEach(async () => {
    accountsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    usersRepository = {
      findOne: jest.fn(),
    };

    preferencesRepository = {
      findOne: jest.fn(),
    };

    emailService = {
      getStatus: jest.fn().mockReturnValue({ configured: true }),
      sendMail: jest.fn().mockResolvedValue(undefined),
    };

    configService = {
      get: jest
        .fn()
        .mockImplementation((_key: string, fallback: string) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MortgageReminderService,
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
        {
          provide: getRepositoryToken(User),
          useValue: usersRepository,
        },
        {
          provide: getRepositoryToken(UserPreference),
          useValue: preferencesRepository,
        },
        { provide: EmailService, useValue: emailService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<MortgageReminderService>(MortgageReminderService);
  });

  describe("findUpcomingRenewals", () => {
    it("returns mortgages with term ending within specified days", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);

      const result = await service.findUpcomingRenewals(60);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("mort-1");
    });

    it("filters out mortgages with term ending beyond the window", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockMortgage, termEndDate: daysFromNow(90) },
      ]);

      const result = await service.findUpcomingRenewals(60);

      expect(result).toHaveLength(0);
    });

    it("filters out mortgages with past term end dates", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockMortgage, termEndDate: daysFromNow(-10) },
      ]);

      const result = await service.findUpcomingRenewals(60);

      expect(result).toHaveLength(0);
    });

    it("includes mortgages expiring today", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockMortgage, termEndDate: new Date(today) },
      ]);

      const result = await service.findUpcomingRenewals(60);

      expect(result).toHaveLength(1);
    });

    it("handles null termEndDate in results", async () => {
      accountsRepository.find.mockResolvedValue([
        { ...mockMortgage, termEndDate: null },
      ]);

      const result = await service.findUpcomingRenewals(60);

      expect(result).toHaveLength(0);
    });
  });

  describe("checkMortgageRenewals", () => {
    it("runs without error when no renewals found", async () => {
      accountsRepository.find.mockResolvedValue([]);

      await expect(service.checkMortgageRenewals()).resolves.not.toThrow();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("processes upcoming renewals", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await expect(service.checkMortgageRenewals()).resolves.not.toThrow();
    });

    it("skips sending emails when SMTP is not configured", async () => {
      emailService.getStatus.mockReturnValue({ configured: false });
      accountsRepository.find.mockResolvedValue([mockMortgage]);

      await service.checkMortgageRenewals();

      expect(preferencesRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends an email when a user has a renewal and email notifications enabled", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      const [to, subject, html] = emailService.sendMail.mock.calls[0];
      expect(to).toBe("user1@example.com");
      expect(subject).toBe("Monize: 1 upcoming mortgage renewal");
      expect(html).toContain("Home Mortgage");
      expect(html).toContain("Hi Alice,");
    });

    it("uses plural subject for multiple mortgages", async () => {
      const secondMortgage = {
        ...mockMortgage,
        id: "mort-2",
        name: "Cottage Mortgage",
        termEndDate: daysFromNow(45),
      };
      accountsRepository.find.mockResolvedValue([mockMortgage, secondMortgage]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      const [, subject, html] = emailService.sendMail.mock.calls[0];
      expect(subject).toBe("Monize: 2 upcoming mortgage renewals");
      expect(html).toContain("Home Mortgage");
      expect(html).toContain("Cottage Mortgage");
    });

    it("groups mortgages by user into a single email", async () => {
      const mortgageUser1A = mockMortgage;
      const mortgageUser1B = {
        ...mockMortgage,
        id: "mort-1b",
        name: "Cottage Mortgage",
      };
      const mortgageUser2 = {
        ...mockMortgage,
        id: "mort-2",
        userId: "user-2",
        name: "Investment Mortgage",
      };
      accountsRepository.find.mockResolvedValue([
        mortgageUser1A,
        mortgageUser1B,
        mortgageUser2,
      ]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockImplementation((query) => {
        const id = query.where.id;
        if (id === "user-1") return Promise.resolve(mockUser);
        if (id === "user-2")
          return Promise.resolve({
            id: "user-2",
            email: "user2@example.com",
            firstName: "Bob",
          });
        return Promise.resolve(null);
      });

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
      const recipients = emailService.sendMail.mock.calls
        .map((c) => c[0])
        .sort();
      expect(recipients).toEqual(["user1@example.com", "user2@example.com"]);
    });

    it("skips user when notificationEmail preference is disabled", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue({
        userId: "user-1",
        notificationEmail: false,
      });

      await service.checkMortgageRenewals();

      expect(usersRepository.findOne).not.toHaveBeenCalled();
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("sends when preferences row is missing (default on)", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue(null);
      usersRepository.findOne.mockResolvedValue(mockUser);

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
    });

    it("skips user when no user record is found", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockResolvedValue(null);

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("skips user when user has no email address", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockResolvedValue({
        id: "user-1",
        email: null,
        firstName: "Alice",
      });

      await service.checkMortgageRenewals();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it("continues processing remaining users when one send fails", async () => {
      const mortgageUser2 = {
        ...mockMortgage,
        id: "mort-2",
        userId: "user-2",
        name: "Investment Mortgage",
      };
      accountsRepository.find.mockResolvedValue([mockMortgage, mortgageUser2]);
      preferencesRepository.findOne.mockResolvedValue(mockPrefsEmailEnabled);
      usersRepository.findOne.mockImplementation((query) => {
        const id = query.where.id;
        if (id === "user-1") return Promise.resolve(mockUser);
        if (id === "user-2")
          return Promise.resolve({
            id: "user-2",
            email: "user2@example.com",
            firstName: "Bob",
          });
        return Promise.resolve(null);
      });
      emailService.sendMail
        .mockRejectedValueOnce(new Error("SMTP send failed"))
        .mockResolvedValueOnce(undefined);

      await expect(service.checkMortgageRenewals()).resolves.not.toThrow();
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
    });
  });

  describe("triggerRenewalCheck", () => {
    it("returns count and mortgage details", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);

      const result = await service.triggerRenewalCheck();

      expect(result.count).toBe(1);
      expect(result.mortgages).toHaveLength(1);
      expect(result.mortgages[0]).toEqual(
        expect.objectContaining({
          id: "mort-1",
          name: "Home Mortgage",
        }),
      );
      expect(result.mortgages[0].daysUntilRenewal).toBeGreaterThan(0);
    });

    it("returns empty result when no upcoming renewals", async () => {
      accountsRepository.find.mockResolvedValue([]);

      const result = await service.triggerRenewalCheck();

      expect(result.count).toBe(0);
      expect(result.mortgages).toHaveLength(0);
    });
  });
});
