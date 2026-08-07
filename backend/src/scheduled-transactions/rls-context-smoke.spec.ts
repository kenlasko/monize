import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { AccountsService } from "../accounts/accounts.service";
import { TransactionsService } from "../transactions/transactions.service";
import { InvestmentTransactionsService } from "../securities/investment-transactions.service";
import { ScheduledTransactionOverrideService } from "./scheduled-transaction-override.service";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the scheduled-transactions module's out-of-request entry point
 * (task R2).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the real
 * implementation runs (at the default RLS_MODE=off), so every DB access on the
 * auto-post cron path must find the ambient context seeded by the C2 wrappers
 * (withSystemContext for the cross-user fan-out, withUserContext for each
 * post) or withScopedDb throws its missing-context error. This is the CI stand-in
 * for the "dev smoke of the module's cron paths shows no context throws"
 * acceptance.
 */

describe("scheduled-transactions module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "7c2f4c1e-5b3a-4d21-9f08-2a6d4e7b1c93";
  const SCHEDULED_ID = "1b9e6f30-8c47-4a52-b0d3-6e5f2c8a4d17";

  const buildModule = async (
    scheduledRepo: Record<string, jest.Mock>,
    overridesRepo: Record<string, jest.Mock>,
  ) => {
    const { manager, dataSource } = createScopedDbMocks([
      [ScheduledTransaction, scheduledRepo],
      [ScheduledTransactionOverride, overridesRepo],
    ]);

    const transactionsService = {
      create: jest.fn().mockResolvedValue({ id: "tx-1" }),
      createTransfer: jest.fn(),
    };

    const exchangeRateService = {
      getLatestRate: jest.fn().mockResolvedValue(null),
      getRateForDate: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionsService,
        { provide: DataSource, useValue: dataSource },
        { provide: AccountsService, useValue: {} },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: InvestmentTransactionsService, useValue: {} },
        { provide: ScheduledTransactionOverrideService, useValue: {} },
        {
          provide: ScheduledTransactionLoanService,
          useValue: {
            findLoanAccountFromSplits: jest.fn().mockResolvedValue(null),
            recalculateLoanPaymentSplits: jest.fn(),
          },
        },
        { provide: ActionHistoryService, useValue: { record: jest.fn() } },
        { provide: ExchangeRateService, useValue: exchangeRateService },
      ],
    }).compile();

    return {
      service: module.get(ScheduledTransactionsService),
      manager,
      dataSource,
      transactionsService,
      exchangeRateService,
    };
  };

  const overrideQueryBuilder = () => ({
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    distinct: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  });

  it("processAutoPostTransactions runs fan-out and per-user posting under their contexts", async () => {
    const dueRow = {
      id: SCHEDULED_ID,
      userId: OWNER_ID,
      name: "Rent",
      accountId: "acc-1",
      amount: -1200,
      currencyCode: "USD",
      frequency: "MONTHLY",
      nextDueDate: "2020-01-15",
      isActive: true,
      autoPost: true,
      isSplit: false,
      isTransfer: false,
      isInvestment: false,
      occurrencesRemaining: null,
      endDate: null,
      splits: [],
      tagIds: null,
    };
    const scheduledRepo = {
      find: jest.fn().mockResolvedValue([dueRow]),
      findOne: jest.fn().mockResolvedValue(dueRow),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const overridesRepo = {
      createQueryBuilder: jest.fn().mockImplementation(overrideQueryBuilder),
    };

    const { service, manager, transactionsService } = await buildModule(
      scheduledRepo,
      overridesRepo,
    );
    // The timezone fan-out now runs through its own withScopedDb, and `post`
    // locks the schedule and claims the occurrence before creating any money
    // (audit P4-004) -- so the manager answers a locked read and a claim insert
    // as well as the fan-out.
    manager.findOne.mockResolvedValue(dueRow);
    manager.query.mockImplementation(async (sql: string) =>
      String(sql).includes("scheduled_transaction_postings")
        ? [[{ id: "posting-1" }], 1]
        : [{ user_id: OWNER_ID, timezone: "UTC" }],
    );
    manager.createQueryBuilder.mockImplementation(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    }));

    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    // The cron catches internally -- a missing ambient context would surface
    // as a logged "DB access outside request/user/system context" error.
    await service.processAutoPostTransactions();

    expect(errorSpy).not.toHaveBeenCalled();
    // The system-context fan-out read and the per-user post both reached the DB.
    expect(scheduledRepo.find).toHaveBeenCalled();
    expect(transactionsService.create).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ accountId: "acc-1" }),
    );
    // The post's bookkeeping write (advance nextDueDate) also ran in context.
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      SCHEDULED_ID,
      expect.objectContaining({ nextDueDate: expect.any(String) }),
    );
  });

  it("refreshForeignCurrencyEstimates sweeps under system context and writes under the owner's", async () => {
    const foreignRow = {
      id: SCHEDULED_ID,
      userId: OWNER_ID,
      name: "Netflix",
      amount: -54.61,
      currencyCode: "CAD",
      originalAmount: -40,
      originalCurrencyCode: "USD",
      exchangeRate: 1.365234,
      account: { fxFeePercent: null },
    };
    const scheduledRepo = {
      find: jest.fn().mockResolvedValue([foreignRow]),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const overridesRepo = {
      createQueryBuilder: jest.fn().mockImplementation(overrideQueryBuilder),
    };

    const { service, manager, exchangeRateService } = await buildModule(
      scheduledRepo,
      overridesRepo,
    );
    exchangeRateService.getLatestRate.mockResolvedValue(1.4);

    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.refreshForeignCurrencyEstimates();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(scheduledRepo.find).toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      SCHEDULED_ID,
      { amount: -56, exchangeRate: 1.4 },
    );
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { service } = await buildModule(
      { findOne: jest.fn() },
      {
        createQueryBuilder: jest.fn().mockImplementation(overrideQueryBuilder),
      },
    );

    // Called with no ambient scope at all (no interceptor, no wrapper): the
    // real withScopedDb must throw, proving the smoke above passes because of the
    // C1/C2 wrappers and not because the check is inert.
    await expect(service.findOne(OWNER_ID, SCHEDULED_ID)).rejects.toThrow(
      "DB access outside request/user/system context",
    );
  });
});
