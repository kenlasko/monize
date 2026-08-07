import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { I18nService } from "nestjs-i18n";
import { DataSource } from "typeorm";
import { AccountsService } from "./accounts.service";
import { MortgageReminderService } from "./mortgage-reminder.service";
import { Account, AccountType } from "./entities/account.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { EmailService } from "../notifications/email.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { NetWorthService } from "../net-worth/net-worth.service";
import { PortfolioService } from "../securities/portfolio.service";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { ActionHistoryService } from "../action-history/action-history.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  createJobClaimMock,
  JobClaimMock,
  jobClaimProvider,
} from "../test-helpers/job-claim-testing";

/**
 * RLS smoke for the accounts module's out-of-request entry points (task R1).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the real
 * implementation runs (at the default RLS_MODE=off), so every DB access on the
 * cron paths must find the ambient context seeded by the C2 wrappers
 * (withSystemContext / withUserContext) or withScopedDb throws its
 * missing-context error. This is the CI stand-in for the "dev smoke of the
 * module's cron paths shows no context throws" acceptance.
 */

describe("accounts module RLS context smoke (real withScopedDb)", () => {
  /** Wins every claim, matching the pre-claim behaviour these specs describe. */
  const jobClaims: JobClaimMock = createJobClaimMock();
  const OWNER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";

  it("applyDueTransactionBalances runs its withScopedDb work under the system context", async () => {
    const accountsRepo = { find: jest.fn(), findOne: jest.fn() };
    const { manager, dataSource } = createScopedDbMocks([
      [Account, accountsRepo],
    ]);
    // The per-user body issues five queries in order: the timezone fan-out (its
    // own withScopedDb) finds one UTC user; then, inside the system-context
    // withScopedDb, the due-account scan, the FOR UPDATE lock
    // (lockAccountsForBalanceWrite -- it holds the rows before the ledger read,
    // audit P4-005), the balance recompute, and the bulk UPDATE. The lock query
    // sits between the scan and the recompute, so the mock chain has to account
    // for it or the recompute reads the wrong row.
    manager.query
      .mockResolvedValueOnce([{ user_id: OWNER_ID, timezone: "UTC" }])
      .mockResolvedValueOnce([{ account_id: "a1" }])
      .mockResolvedValueOnce([{ id: "a1" }])
      .mockResolvedValueOnce([{ account_id: "a1", balance: "150" }])
      .mockResolvedValueOnce(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: DataSource, useValue: dataSource },
        { provide: ActionHistoryService, useValue: { record: jest.fn() } },
        { provide: ScheduledTransactionsService, useValue: {} },
        { provide: NetWorthService, useValue: {} },
        { provide: PortfolioService, useValue: {} },
        { provide: LoanMortgageAccountService, useValue: {} },
      ],
    }).compile();
    const service = module.get(AccountsService);

    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    // The handler catches internally -- a missing ambient context would surface
    // as a logged "DB access outside request/user/system context" error.
    await service.applyDueTransactionBalances();

    expect(errorSpy).not.toHaveBeenCalled();
    // The bulk UPDATE inside withScopedDb actually ran.
    expect(
      manager.query.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("UPDATE accounts SET current_balance"),
      ),
    ).toBe(true);
    // And the accounts were locked before the balances were read.
    const lockIndex = manager.query.mock.calls.findIndex(
      (c) => typeof c[0] === "string" && c[0].includes("FOR UPDATE"),
    );
    const sumIndex = manager.query.mock.calls.findIndex(
      (c) =>
        typeof c[0] === "string" && c[0].includes("COALESCE(SUM(t.amount)"),
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(sumIndex);
  });

  it("checkMortgageRenewals runs fan-out and per-user reads under their contexts", async () => {
    const termEndDate = new Date();
    termEndDate.setDate(termEndDate.getDate() + 30);
    const accountsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: "mort-1",
          userId: OWNER_ID,
          name: "Home Mortgage",
          accountType: AccountType.MORTGAGE,
          isClosed: false,
          termEndDate,
        },
      ]),
    };
    const usersRepo = {
      findOne: jest.fn().mockResolvedValue({
        id: OWNER_ID,
        email: "owner@example.com",
        firstName: "Owner",
      }),
    };
    const preferencesRepo = {
      findOne: jest
        .fn()
        .mockResolvedValue({ notificationEmail: true, language: "en" }),
    };
    const { dataSource } = createScopedDbMocks([
      [Account, accountsRepo],
      [User, usersRepo],
      [UserPreference, preferencesRepo],
    ]);
    const sendMail = jest.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MortgageReminderService,
        jobClaimProvider(jobClaims),
        { provide: DataSource, useValue: dataSource },
        {
          provide: EmailService,
          useValue: {
            getStatus: jest.fn().mockReturnValue({ configured: true }),
            sendMail,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_k: string, fallback: string) => fallback),
          },
        },
        {
          provide: I18nService,
          useValue: {
            translate: (key: string, opts?: { defaultValue?: string }) =>
              opts?.defaultValue ?? key,
          },
        },
      ],
    }).compile();
    const service = module.get(MortgageReminderService);

    // Both the system-context fan-out and the per-user withUserContext reads
    // reach the DB through the real withScopedDb; a missing context would reject.
    await expect(service.checkMortgageRenewals()).resolves.toBeUndefined();

    expect(accountsRepo.find).toHaveBeenCalled();
    expect(preferencesRepo.findOne).toHaveBeenCalled();
    expect(usersRepo.findOne).toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { dataSource } = createScopedDbMocks([
      [Account, { findOne: jest.fn() }],
    ]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountsService,
        { provide: DataSource, useValue: dataSource },
        { provide: ActionHistoryService, useValue: { record: jest.fn() } },
        { provide: ScheduledTransactionsService, useValue: {} },
        { provide: NetWorthService, useValue: {} },
        { provide: PortfolioService, useValue: {} },
        { provide: LoanMortgageAccountService, useValue: {} },
      ],
    }).compile();
    const service = module.get(AccountsService);

    // Called with no ambient scope at all (no interceptor, no wrapper): the
    // real withScopedDb must throw, proving the smoke above passes because of the
    // C1/C2 wrappers and not because the check is inert.
    await expect(service.findOne(OWNER_ID, "acc-1")).rejects.toThrow(
      "DB access outside request/user/system context",
    );
  });
});
