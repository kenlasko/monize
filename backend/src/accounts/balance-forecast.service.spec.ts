import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { BalanceForecastService } from "./balance-forecast.service";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";

jest.mock("../common/date-utils", () => ({
  todayYMD: jest.fn(() => "2024-07-08"),
}));

describe("BalanceForecastService", () => {
  let service: BalanceForecastService;
  let accountsRepo: { findOne: jest.Mock };
  let scheduledRepo: { find: jest.Mock };
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    accountsRepo = { findOne: jest.fn() };
    scheduledRepo = { find: jest.fn() };
    dataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BalanceForecastService,
        { provide: getRepositoryToken(Account), useValue: accountsRepo },
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledRepo,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(BalanceForecastService);
  });

  it("projects the current balance forward using scheduled occurrences", async () => {
    accountsRepo.findOne.mockResolvedValue({
      id: "acc-1",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 1000,
    });
    // start-balance query, then future-actuals query.
    dataSource.query
      .mockResolvedValueOnce([{ balance: "1000" }])
      .mockResolvedValueOnce([]);
    scheduledRepo.find.mockResolvedValue([
      {
        accountId: "acc-1",
        transferAccountId: null,
        amount: -200,
        frequency: "MONTHLY",
        nextDueDate: "2024-07-20",
        endDate: null,
        occurrencesRemaining: null,
      },
    ]);

    const result = await service.getBalanceForecast("user-1", "acc-1", 60);

    expect(result.accountId).toBe("acc-1");
    expect(result.currencyCode).toBe("CAD");
    // Anchor at today, then -200 on Jul 20 (Aug 20 is past the 60-day horizon).
    expect(result.points[0]).toEqual({ date: "2024-07-08", balance: 1000 });
    expect(result.points).toContainEqual({ date: "2024-07-20", balance: 800 });
  });

  it("merges future-dated real transactions into the forecast", async () => {
    accountsRepo.findOne.mockResolvedValue({
      id: "acc-1",
      currencyCode: "CAD",
      openingBalance: 0,
      currentBalance: 500,
    });
    dataSource.query
      .mockResolvedValueOnce([{ balance: "500" }])
      .mockResolvedValueOnce([{ date: "2024-07-25", total: "300" }]);
    scheduledRepo.find.mockResolvedValue([]);

    const result = await service.getBalanceForecast("user-1", "acc-1", 60);

    expect(result.points).toContainEqual({ date: "2024-07-25", balance: 800 });
  });

  it("throws NotFound when the account is not owned", async () => {
    accountsRepo.findOne.mockResolvedValue(null);
    await expect(service.getBalanceForecast("user-1", "acc-1")).rejects.toThrow(
      NotFoundException,
    );
  });
});
