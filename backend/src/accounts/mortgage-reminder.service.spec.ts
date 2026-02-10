import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { Account, AccountType } from "./entities/account.entity";

describe("MortgageReminderService", () => {
  let service: MortgageReminderService;
  let accountsRepository: Record<string, jest.Mock>;

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

  beforeEach(async () => {
    accountsRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MortgageReminderService,
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
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
    });

    it("processes upcoming renewals", async () => {
      accountsRepository.find.mockResolvedValue([mockMortgage]);

      await expect(service.checkMortgageRenewals()).resolves.not.toThrow();
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
