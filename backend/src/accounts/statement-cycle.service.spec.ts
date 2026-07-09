import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { StatementCycleService } from "./statement-cycle.service";
import { Account, AccountType } from "./entities/account.entity";

// Fix "today" so cycle boundaries are deterministic.
jest.mock("../common/date-utils", () => ({
  todayYMD: jest.fn(() => "2024-07-08"),
}));

function makeCard(overrides: Partial<Account> = {}): Account {
  return {
    id: "cc-1",
    userId: "user-1",
    accountType: AccountType.CREDIT_CARD,
    currencyCode: "CAD",
    openingBalance: 0,
    currentBalance: -1500,
    statementSettlementDay: 10,
    statementDueDay: 15,
    ...overrides,
  } as Account;
}

describe("StatementCycleService", () => {
  let service: StatementCycleService;
  let repo: { findOne: jest.Mock };
  let dataSource: { query: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
    dataSource = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatementCycleService,
        { provide: getRepositoryToken(Account), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(StatementCycleService);
  });

  describe("getStatementCycle", () => {
    it("returns the cycle window and statement figures", async () => {
      repo.findOne.mockResolvedValue(makeCard());
      dataSource.query.mockResolvedValue([
        { statement_balance: "-1200", amount_paid: "300" },
      ]);

      const result = await service.getStatementCycle("user-1", "cc-1");

      expect(result).toEqual({
        accountId: "cc-1",
        currencyCode: "CAD",
        cycleStart: "2024-06-10",
        cycleEnd: "2024-07-09",
        lastSettlementDate: "2024-06-10",
        nextSettlementDate: "2024-07-10",
        daysUntilSettlement: 2,
        paymentDueDate: "2024-07-15",
        daysUntilPaymentDue: 7,
        statementBalance: -1200,
        amountPaidSinceStatement: 300,
        currentBalance: -1500,
      });
      // The balance query is parameterised on the last settlement date.
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        "cc-1",
        "user-1",
        "2024-06-10",
      ]);
    });

    it("scopes the account lookup to the owner", async () => {
      repo.findOne.mockResolvedValue(makeCard());
      dataSource.query.mockResolvedValue([
        { statement_balance: "0", amount_paid: "0" },
      ]);

      await service.getStatementCycle("user-1", "cc-1");

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: "cc-1", userId: "user-1" },
      });
    });

    it("falls back to the opening balance when there are no transactions", async () => {
      repo.findOne.mockResolvedValue(
        makeCard({ openingBalance: -50, currentBalance: -50 }),
      );
      dataSource.query.mockResolvedValue([]);

      const result = await service.getStatementCycle("user-1", "cc-1");

      expect(result.statementBalance).toBe(-50);
      expect(result.amountPaidSinceStatement).toBe(0);
    });

    it("throws NotFound when the account is not owned", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getStatementCycle("user-1", "cc-1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws BadRequest for a non-credit-card account", async () => {
      repo.findOne.mockResolvedValue(
        makeCard({ accountType: AccountType.CHEQUING }),
      );
      await expect(service.getStatementCycle("user-1", "cc-1")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws BadRequest when no settlement day is configured", async () => {
      repo.findOne.mockResolvedValue(
        makeCard({ statementSettlementDay: null }),
      );
      await expect(service.getStatementCycle("user-1", "cc-1")).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("getInterestPaid", () => {
    it("returns the summed interest charges and count", async () => {
      repo.findOne.mockResolvedValue(makeCard());
      dataSource.query.mockResolvedValue([{ amount: "45.5", count: "3" }]);

      const result = await service.getInterestPaid(
        "user-1",
        "cc-1",
        "2024-01-01",
        "2024-12-31",
      );

      expect(result).toEqual({ amount: 45.5, count: 3 });
      expect(dataSource.query).toHaveBeenCalledWith(expect.any(String), [
        "cc-1",
        "user-1",
        "2024-01-01",
        "2024-12-31",
      ]);
    });

    it("returns zeros when there are no interest charges", async () => {
      repo.findOne.mockResolvedValue(makeCard());
      dataSource.query.mockResolvedValue([]);

      const result = await service.getInterestPaid(
        "user-1",
        "cc-1",
        "2024-01-01",
        "2024-12-31",
      );

      expect(result).toEqual({ amount: 0, count: 0 });
    });

    it("throws NotFound when the account is not owned", async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.getInterestPaid("user-1", "cc-1", "2024-01-01", "2024-12-31"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
