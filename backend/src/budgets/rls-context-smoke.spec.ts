import { BudgetAlertService } from "./budget-alert.service";
import { BudgetPeriodCronService } from "./budget-period-cron.service";
import { Budget } from "./entities/budget.entity";
import { Notification } from "../notification-center/entities/notification.entity";
import { BudgetPeriod } from "./entities/budget-period.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { createJobClaimMock } from "../test-helpers/job-claim-testing";

/**
 * RLS smoke for the budgets module's cron entry points (task R4).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs (at the default RLS_MODE=off), so every DB access on
 * the cron paths must find the ambient context seeded by the C2 wrappers
 * (withSystemContext / withUserContext) or withScopedDb throws its
 * missing-context error. This is the CI stand-in for the "dev smoke of the
 * module's cron paths shows no context throws" acceptance.
 */
describe("budgets module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";

  const emailService = {
    getStatus: jest.fn().mockReturnValue({ configured: false }),
    sendMail: jest.fn(),
  };
  const configService = {
    get: jest.fn((_k: string, fallback: string) => fallback),
  };
  const i18n = {
    translate: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
  };

  it("checkBudgetAlerts runs its fan-out and per-user work under their contexts", async () => {
    const budgetsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: "budget-1",
          userId: OWNER_ID,
          isActive: true,
          budgetType: "MONTHLY",
          periodStart: "2026-01-01",
          periodEnd: null,
          categories: [],
        },
      ]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    const { manager, dataSource } = createScopedDbMocks([
      [Budget, budgetsRepo],
      [Notification, { find: jest.fn().mockResolvedValue([]) }],
      [Transaction, { createQueryBuilder: jest.fn() }],
      [TransactionSplit, { createQueryBuilder: jest.fn() }],
      [ScheduledTransaction, { createQueryBuilder: jest.fn() }],
      [User, { findOne: jest.fn() }],
      [UserPreference, { findOne: jest.fn() }],
    ]);
    // `buildTimezoneLookup`'s raw `getUsersByEffectiveTimezone` query, routed
    // through the real `withScopedDb` this suite exercises; no rows is a user
    // table this smoke test never populated.
    manager.query.mockResolvedValue([]);

    const service = new BudgetAlertService(
      dataSource as never,
      emailService as never,
      configService as never,
      i18n as never,
      { create: jest.fn(), markEmailSent: jest.fn() } as never,
      { resolveEmail: jest.fn().mockResolvedValue(true) } as never,
      { notify: jest.fn().mockResolvedValue(null) } as never,
      createJobClaimMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    // The handler catches internally -- a missing ambient context would surface
    // as a logged "DB access outside request/user/system context" error.
    await service.checkBudgetAlerts();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(budgetsRepo.find).toHaveBeenCalled();
  });

  it("closeExpiredPeriods runs its fan-out under the system context", async () => {
    const budgetsRepo = { find: jest.fn().mockResolvedValue([]) };
    const { dataSource } = createScopedDbMocks([
      [Budget, budgetsRepo],
      [BudgetPeriod, { findOne: jest.fn() }],
      [User, { findOne: jest.fn() }],
      [UserPreference, { findOne: jest.fn() }],
    ]);

    const service = new BudgetPeriodCronService(
      dataSource as never,
      {} as never,
      {} as never,
      emailService as never,
      configService as never,
      i18n as never,
      { resolveEmail: jest.fn().mockResolvedValue(true) } as never,
      createJobClaimMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.closeExpiredPeriods();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(budgetsRepo.find).toHaveBeenCalled();
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { dataSource } = createScopedDbMocks([
      [Transaction, { createQueryBuilder: jest.fn() }],
      [TransactionSplit, { createQueryBuilder: jest.fn() }],
    ]);
    const service = new BudgetAlertService(
      dataSource as never,
      emailService as never,
      configService as never,
      i18n as never,
      { create: jest.fn(), markEmailSent: jest.fn() } as never,
      { resolveEmail: jest.fn().mockResolvedValue(true) } as never,
      { notify: jest.fn().mockResolvedValue(null) } as never,
      createJobClaimMock() as never,
    );

    // Called with no ambient scope at all (no interceptor, no wrapper): the
    // real withScopedDb must throw, proving the smokes above pass because of
    // the C2 wrappers and not because the check is inert.
    await expect(
      service.checkSeasonalSpikes(OWNER_ID, {
        categories: [
          {
            id: "bc-1",
            categoryId: "cat-1",
            isIncome: false,
            isTransfer: false,
          },
        ],
      } as never),
    ).rejects.toThrow("DB access outside request/user/system context");
  });
});
