import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoanRateChangesService, toYmd } from "./loan-rate-changes.service";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { recalculateMortgageAfterRateChange } from "../accounts/mortgage-amortization.util";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("LoanRateChangesService", () => {
  let service: LoanRateChangesService;
  let rateChangesRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let manager: ManagerMock;
  let dataSource: DataSourceMock;

  const userId = "user-1";
  const accountId = "account-1";

  const makeAccount = (overrides: Partial<Account> = {}): Account =>
    ({
      id: accountId,
      userId,
      accountType: AccountType.MORTGAGE,
      currentBalance: -400000,
      interestRate: 5.5,
      paymentAmount: 2500,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2022-01-01",
      amortizationMonths: 300,
      isCanadianMortgage: true,
      isVariableRate: true,
      isClosed: false,
      scheduledTransactionId: "sched-1",
      interestCategoryId: "cat-interest",
      ...overrides,
    }) as unknown as Account;

  const makeRow = (overrides: Partial<LoanRateChange> = {}): LoanRateChange =>
    ({
      id: "rc-1",
      userId,
      accountId,
      effectiveDate: "2024-06-01",
      annualRate: 4.9,
      newPaymentAmount: null,
      source: "manual",
      note: null,
      createdAt: new Date("2024-06-01"),
      updatedAt: new Date("2024-06-01"),
      ...overrides,
    }) as LoanRateChange;

  /** The account row is never written by any rate-change path (spec 7.5, decision 5). */
  const expectAccountUntouched = () => {
    expect(accountsRepository.save).not.toHaveBeenCalled();
    expect(accountsRepository.update).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    for (const [saved] of manager.save.mock.calls) {
      expect(saved).not.toHaveProperty("paymentAmount");
    }
  };

  /** Nothing was written to the schedule or its lines. */
  const expectTemplateUntouched = () => {
    expect(splitsRepository.save).not.toHaveBeenCalled();
    expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    rateChangesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(makeAccount()),
      save: jest.fn(),
      update: jest.fn(),
    };

    scheduledTransactionsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    splitsRepository = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((split) => Promise.resolve(split)),
    };

    ({ manager, dataSource } = createScopedDbMocks([
      [LoanRateChange, rateChangesRepository],
      [Account, accountsRepository],
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, splitsRepository],
    ]));
    manager.count.mockResolvedValue(1);
    manager.find.mockResolvedValue([]);
    manager.findOne.mockResolvedValue(null);
    manager.create.mockImplementation((_entity, data) => ({ ...data }));
    manager.save.mockImplementation((data) =>
      Promise.resolve(data.id ? data : { ...data, id: "rc-new" }),
    );
    manager.remove.mockResolvedValue(undefined);
    manager.merge.mockImplementation((_entity, target, patch) => ({
      ...target,
      ...patch,
    }));
    manager.delete.mockResolvedValue({ affected: 0 });
    // The ledger debt as of any date (`datedLoanDebt`), equal by default to
    // the fixture's current balance.
    manager.query.mockResolvedValue([{ balance: "-400000" }]);

    service = new LoanRateChangesService(dataSource as never);
  });

  describe("toYmd", () => {
    it("normalizes strings and Dates to YYYY-MM-DD", () => {
      expect(toYmd("2024-06-01")).toBe("2024-06-01");
      expect(toYmd("2024-06-01T00:00:00.000Z")).toBe("2024-06-01");
      expect(toYmd(new Date(2024, 5, 1))).toBe("2024-06-01");
      expect(toYmd(null)).toBeNull();
    });
  });

  describe("findAll", () => {
    it("returns the timeline ordered by effective date", async () => {
      const rows = [makeRow()];
      rateChangesRepository.find.mockResolvedValue(rows);

      const result = await service.findAll(userId, accountId);

      expect(rateChangesRepository.find).toHaveBeenCalledWith({
        where: { userId, accountId },
        order: { effectiveDate: "ASC" },
      });
      expect(result).toEqual(rows);
    });

    it("404s for an account the user does not own", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(service.findAll(userId, accountId)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("rejects line-of-credit and other non-amortizing account types", async () => {
      for (const accountType of [
        AccountType.LINE_OF_CREDIT,
        AccountType.CHEQUING,
      ]) {
        accountsRepository.findOne.mockResolvedValue(
          makeAccount({ accountType }),
        );
        await expect(service.findAll(userId, accountId)).rejects.toThrow(
          BadRequestException,
        );
      }
    });

    it("accepts LOAN accounts", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ accountType: AccountType.LOAN }),
      );
      await expect(service.findAll(userId, accountId)).resolves.toEqual([]);
    });
  });

  describe("create", () => {
    it("snapshots an initial row before the first change", async () => {
      manager.count.mockResolvedValue(0);

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      const savedRows = manager.save.mock.calls.map((call) => call[0]);
      const initial = savedRows.find((row) => row.source === "initial");
      expect(initial).toMatchObject({
        accountId,
        effectiveDate: "2022-01-01",
        annualRate: 5.5,
        newPaymentAmount: 2500,
      });
      const created = savedRows.find((row) => row.source === "manual");
      expect(created).toMatchObject({
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
        newPaymentAmount: null,
      });
    });

    it("dates the initial row just before the change when it precedes the start date", async () => {
      manager.count.mockResolvedValue(0);
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ paymentStartDate: "2025-01-01" as any }),
      );

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      const initial = manager.save.mock.calls
        .map((call) => call[0])
        .find((row) => row.source === "initial");
      expect(initial.effectiveDate).toBe("2024-05-31");
    });

    it("does not snapshot an initial row when history already exists", async () => {
      manager.count.mockResolvedValue(2);

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      const initialRows = manager.save.mock.calls
        .map((call) => call[0])
        .filter((row) => row.source === "initial");
      expect(initialRows).toHaveLength(0);
    });

    it("409s on a duplicate effective date", async () => {
      manager.findOne.mockResolvedValue(makeRow());

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
        }),
      ).rejects.toThrow(ConflictException);
      // The duplicate check runs inside the write transaction, so nothing is
      // saved when it rejects.
      expect(dataSource.transaction).toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("rejects supplying both a payment and recalculatePayment", async () => {
      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
          newPaymentAmount: 2600,
          recalculatePayment: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects recalculatePayment for plain loans", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ accountType: AccountType.LOAN }),
      );

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
          recalculatePayment: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects recalculatePayment on a closed account", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ isClosed: true }),
      );

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
          recalculatePayment: true,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it("recalculates the payment to hold remaining amortization", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);

      const result = await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
        recalculatePayment: true,
      });

      // 29 calendar months elapsed of 300; Canadian variable-rate is ANNUITY
      const expected = recalculateMortgageAfterRateChange(
        400000,
        4.9,
        300 - 29,
        "MONTHLY",
        "ANNUITY",
      );
      expect(result.newPaymentAmount).toBe(expected.paymentAmount);
    });

    it("prices a future-dated recalculation from the debt after a payment posted before it", async () => {
      // Issue #1505 acceptance, spec decision 5: a change effective next month
      // on a loan with a principal payment already posted for next week is
      // priced from the debt after that payment. `current_balance` (400,000)
      // stops at today; the ledger through the effective date owes 395,000.
      const account = makeAccount({ paymentStartDate: "2026-01-01" } as never);
      accountsRepository.findOne.mockResolvedValue(account);
      manager.query.mockImplementation(async (sql: string, params: string[]) =>
        sql === ACCOUNT_BALANCE_AS_OF_SQL && params[2] >= "2026-10-09"
          ? [{ balance: "-395000" }]
          : [{ balance: "-400000" }],
      );

      const result = await service.create(userId, accountId, {
        effectiveDate: "2026-11-01",
        annualRate: 4.9,
        recalculatePayment: true,
      });

      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        accountId,
        userId,
        "2026-11-01",
      ]);
      // 10 calendar months elapsed of 300.
      const expected = recalculateMortgageAfterRateChange(
        395000,
        4.9,
        300 - 10,
        "MONTHLY",
        "ANNUITY",
      );
      expect(result.newPaymentAmount).toBe(expected.paymentAmount);
      expect(result.newPaymentAmount).not.toBe(
        recalculateMortgageAfterRateChange(
          400000,
          4.9,
          300 - 10,
          "MONTHLY",
          "ANNUITY",
        ).paymentAmount,
      );
    });

    it("recalculates by the stored type over the flags", async () => {
      const account = makeAccount({
        mortgageType: "CANADIAN_FIXED",
        isCanadianMortgage: false,
        isVariableRate: false,
      });
      accountsRepository.findOne.mockResolvedValue(account);

      const result = await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
        recalculatePayment: true,
      });

      expect(result.newPaymentAmount).toBe(
        recalculateMortgageAfterRateChange(
          400000,
          4.9,
          300 - 29,
          "MONTHLY",
          "CANADIAN_FIXED",
        ).paymentAmount,
      );
    });

    it("refuses a recalculation whose ledger cannot be read, writing nothing", async () => {
      accountsRepository.findOne.mockResolvedValue(makeAccount());
      manager.query.mockResolvedValue([]);

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
          recalculatePayment: true,
        }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it("records a past-dated change without touching the account scalars", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      manager.save.mockImplementation((data) => Promise.resolve(data));
      rateChangesRepository.find.mockResolvedValue([
        makeRow({
          source: "initial",
          effectiveDate: "2022-01-01",
          annualRate: 5.5,
          newPaymentAmount: 2500,
        }),
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      // The timeline is user-owned; the account's manual rate/payment stay put.
      expect(account.interestRate).toBe(5.5);
      expect(account.paymentAmount).toBe(2500);
      expectAccountUntouched();
    });

    it("persists rows on closed accounts without reading or touching the schedule", async () => {
      const account = makeAccount({ isClosed: true });
      accountsRepository.findOne.mockResolvedValue(account);

      const result = await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      expect(manager.save).toHaveBeenCalled();
      expect(account.interestRate).toBe(5.5);
      expect(result.scheduledPaymentPreview).toBeNull();
      expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
      expectTemplateUntouched();
    });

    it("propagates a write failure out of the transaction without reading the schedule", async () => {
      manager.save.mockRejectedValue(new Error("db down"));

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
        }),
      ).rejects.toThrow("db down");
      // Two scoped transactions: the account lookup, then the write block that
      // rolls back when the callback throws -- so the preview never runs.
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
    });

    it("does not fail the request when the preview cannot be read: the row is committed", async () => {
      scheduledTransactionsRepository.findOne.mockRejectedValue(
        new Error("connection reset"),
      );

      const result = await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      expect(result.id).toBe("rc-new");
      expect(result.scheduledPaymentPreview).toBeNull();
    });

    it("returns a null preview for an account with no linked schedule", async () => {
      const account = makeAccount({ scheduledTransactionId: null });
      accountsRepository.findOne.mockResolvedValue(account);

      const result = await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      expect(result.scheduledPaymentPreview).toBeNull();
      expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
    });
  });

  /**
   * The sync prices the template at its own `next_due_date` through the
   * loan core, asks before writing, and never writes the account
   * (`docs/specs/scheduled-loan-installment-pricing.md` section 7.5, every row
   * of its table; issue #1637 Scenario 2). Fixture 5.1: ANNUITY, 100,000.00
   * over 300 monthly payments from 2023-02-03, 584.59 at 5.0 %; Timeline A is
   * the `initial` row plus 4.5 % / 560.00 stated from 2023-04-15. Figures are
   * the spec's, in cents.
   */
  describe("the scheduled-payment sync (spec 7.5)", () => {
    const loan = (overrides: Partial<Account> = {}): Account =>
      makeAccount({
        mortgageType: "ANNUITY",
        isCanadianMortgage: false,
        isVariableRate: false,
        interestRate: 5,
        paymentAmount: 584.59,
        extraPaymentAmount: null,
        paymentStartDate: "2023-02-03",
        amortizationMonths: 300,
        originalPrincipal: 100000,
        openingBalance: -100000,
        currentBalance: -100000,
        currencyCode: "USD",
        ...overrides,
      } as unknown as Partial<Account>);

    const rateRow = (
      id: string,
      effectiveDate: string,
      annualRate: number,
      newPaymentAmount: number | null,
      source: "initial" | "manual" | "inferred" = "manual",
    ) =>
      makeRow({
        id,
        effectiveDate,
        annualRate: annualRate.toFixed(4) as unknown as number,
        newPaymentAmount:
          newPaymentAmount === null
            ? null
            : (newPaymentAmount.toFixed(4) as unknown as number),
        source,
      });
    const initial = rateRow("rc-initial", "2023-02-03", 5, 584.59, "initial");
    const change = rateRow("rc-change", "2023-04-15", 4.5, 560);
    const timelineA = [initial, change];

    /** The linked bill: its parent and lines as the schedule holds them, due at `nextDueDate`. */
    const template = (
      principal: number,
      interest: number,
      nextDueDate: string,
      extra?: number,
    ) => {
      scheduledTransactionsRepository.findOne.mockResolvedValue({
        id: "sched-1",
        userId,
        accountId: "acc-chequing",
        name: "Mortgage Payment",
        currencyCode: "USD",
        amount: -(principal + interest + (extra ?? 0)),
        frequency: "MONTHLY",
        startDate: "2023-02-03",
        nextDueDate,
        endDate: null,
        occurrencesRemaining: null,
        isActive: true,
      });
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-principal",
          scheduledTransactionId: "sched-1",
          transferAccountId: accountId,
          categoryId: null,
          amount: -principal,
          memo: "Principal",
        },
        {
          id: "split-interest",
          scheduledTransactionId: "sched-1",
          transferAccountId: null,
          categoryId: "cat-interest",
          amount: -interest,
          memo: "Interest",
        },
        ...(extra
          ? [
              {
                id: "split-extra",
                scheduledTransactionId: "sched-1",
                transferAccountId: accountId,
                categoryId: null,
                amount: -extra,
                memo: "Extra Principal",
              },
            ]
          : []),
      ]);
    };

    /** The ledger debt `datedLoanDebt` reads through any date. */
    const debt = (amount: number) =>
      manager.query.mockResolvedValue([{ balance: String(-amount) }]);

    const cents = (value: number) => Math.round(value * 100) / 100;

    /** The preview's figures in cents, as the spec states them. */
    const inCents = (preview: {
      currentPaymentAmount: number | null;
      proposedPaymentAmount: number;
      proposedPrincipal: number;
      proposedInterest: number;
      extraPrincipal: number;
    }) => ({
      current: preview.currentPaymentAmount,
      payment: cents(preview.proposedPaymentAmount),
      interest: cents(preview.proposedInterest),
      principal: cents(preview.proposedPrincipal),
      extra: cents(preview.extraPrincipal),
    });

    /** The lines and parent the apply wrote, in cents. */
    const written = () => {
      const byId = new Map<string, number>(
        splitsRepository.save.mock.calls.map(([split]) => [
          split.id,
          cents(Number(split.amount)),
        ]),
      );
      const parent = scheduledTransactionsRepository.update.mock.calls[0];
      return {
        principal: byId.get("split-principal"),
        interest: byId.get("split-interest"),
        extra: byId.get("split-extra"),
        parent: parent ? Number(parent[1].amount) : undefined,
      };
    };

    beforeEach(() => {
      accountsRepository.findOne.mockResolvedValue(loan());
      rateChangesRepository.find.mockResolvedValue(timelineA);
      manager.count.mockResolvedValue(2);
    });

    it("create: Timeline A added, nothing posted, D = 2023-02-03: offers 584.59 = 416.67 + 167.92, the bill becomes 560.00 from 2023-05-03, and writes nothing", async () => {
      template(167.92, 416.67, "2023-02-03");
      debt(100000);

      const result = await service.create(userId, accountId, {
        effectiveDate: "2023-04-15",
        annualRate: 4.5,
        newPaymentAmount: 560,
      });

      const preview = result.scheduledPaymentPreview!;
      expect(preview).toMatchObject({
        scheduledTransactionId: "sched-1",
        scheduledTransactionName: "Mortgage Payment",
        currencyCode: "USD",
        dueDate: "2023-02-03",
        nextPaymentChange: { dueDate: "2023-05-03", paymentAmount: 560 },
      });
      expect(inCents(preview)).toEqual({
        current: 584.59,
        payment: 584.59,
        interest: 416.67,
        principal: 167.92,
        extra: 0,
      });
      // Priced on the ledger through the template's own due date, not the
      // effective date of the change.
      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        accountId,
        userId,
        "2023-02-03",
      ]);
      expectTemplateUntouched();
      expectAccountUntouched();
    });

    it("update: Scenario 2 (the template holds 560.00) returns the 584.59 preview and does not touch the template until confirmed", async () => {
      rateChangesRepository.findOne.mockResolvedValue(change);
      template(185, 375, "2023-02-03");
      debt(100000);

      const result = await service.update(userId, accountId, "rc-change", {
        newPaymentAmount: 560,
      });

      expect(result.newPaymentAmount).toBe(560);
      const preview = result.scheduledPaymentPreview!;
      expect(inCents(preview)).toEqual({
        current: 560,
        payment: 584.59,
        interest: 416.67,
        principal: 167.92,
        extra: 0,
      });
      expect(preview.currentPrincipal).toBe(185);
      expect(preview.currentInterest).toBe(375);
      expect(preview.nextPaymentChange).toEqual({
        dueDate: "2023-05-03",
        paymentAmount: 560,
      });
      expectTemplateUntouched();
      expectAccountUntouched();
    });

    it("apply: rewrites the Scenario 2 template to 584.59 = 416.67 + 167.92 through the loan core, in one transaction, and writes nothing on the account", async () => {
      template(185, 375, "2023-02-03");
      debt(100000);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(written()).toEqual({
        principal: -167.92,
        interest: -416.67,
        extra: undefined,
        parent: -584.59,
      });
      expect(inCents(result!)).toMatchObject({
        payment: 584.59,
        interest: 416.67,
        principal: 167.92,
      });
      // The schedule row is locked before it is read, and the plan and the
      // write share the transaction: the account lookup, then one for both.
      expect(scheduledTransactionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: "sched-1" },
        lock: { mode: "pessimistic_write" },
      });
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expectAccountUntouched();
    });

    it("the raised template (A7): D = 2023-04-03, 600.00 held, is replaced by the timeline's 584.59 = 415.20 + 169.39, with the raise shown as current", async () => {
      template(184.03, 415.97, "2023-04-03");
      debt(99648.05);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toMatchObject({
        dueDate: "2023-04-03",
        currentPaymentAmount: 600,
        nextPaymentChange: { dueDate: "2023-05-03", paymentAmount: 560 },
      });
      expect(inCents(result!)).toMatchObject({
        payment: 584.59,
        interest: 415.2,
        principal: 169.39,
      });
      expect(written().parent).toBe(-584.59);
    });

    it("D = 2023-06-03 (table 5.2 posted through 2023-05-03): the stated 560.00 = 372.40 + 187.60, and no later change", async () => {
      template(186.9, 373.1, "2023-06-03");
      debt(99307.23);

      const preview = await service.previewScheduledPayment(loan());

      expect(preview).toMatchObject({
        dueDate: "2023-06-03",
        nextPaymentChange: null,
      });
      expect(inCents(preview!)).toEqual({
        current: 560,
        payment: 560,
        interest: 372.4,
        principal: 187.6,
        extra: 0,
      });
    });

    it("remove: deleting the only change offers the initial row's 584.59 at D = 2023-02-03 with no later change, and writes nothing", async () => {
      rateChangesRepository.findOne.mockResolvedValue(change);
      // The timeline after the delete.
      rateChangesRepository.find.mockResolvedValue([initial]);
      template(185, 375, "2023-02-03");
      debt(100000);

      const result = await service.remove(userId, accountId, "rc-change");

      expect(manager.remove).toHaveBeenCalledWith(change);
      expect(result.scheduledPaymentPreview).toMatchObject({
        dueDate: "2023-02-03",
        nextPaymentChange: null,
      });
      expect(inCents(result.scheduledPaymentPreview!)).toEqual({
        current: 560,
        payment: 584.59,
        interest: 416.67,
        principal: 167.92,
        extra: 0,
      });
      expectTemplateUntouched();
      expectAccountUntouched();
    });

    it("a standing extra rides on top of a stated base, in the preview and in the later change (A14 loan)", async () => {
      accountsRepository.findOne.mockResolvedValue(
        loan({ paymentAmount: 634.59, extraPaymentAmount: 50 }),
      );
      rateChangesRepository.find.mockResolvedValue([
        rateRow("rc-initial", "2023-02-03", 5, 634.59, "initial"),
        change,
      ]);
      template(167.92, 416.67, "2023-02-03", 50);
      debt(100000);

      const preview = await service.previewScheduledPayment(
        loan({ paymentAmount: 634.59, extraPaymentAmount: 50 }),
      );

      expect(inCents(preview!)).toEqual({
        current: 634.59,
        payment: 634.59,
        interest: 416.67,
        principal: 167.92,
        extra: 50,
      });
      expect(preview!.nextPaymentChange).toEqual({
        dueDate: "2023-05-03",
        paymentAmount: 610,
      });
    });

    it("applies nothing and offers nothing when the ledger cannot be read", async () => {
      template(185, 375, "2023-02-03");
      manager.query.mockResolvedValue([]);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toBeNull();
      expectTemplateUntouched();
    });

    it("offers nothing for a retired debt, and does not deactivate the schedule", async () => {
      template(185, 375, "2023-02-03");
      debt(0);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toBeNull();
      expectTemplateUntouched();
    });

    it("offers nothing for a template with a line the core cannot account for", async () => {
      template(185, 375, "2023-02-03");
      debt(100000);
      splitsRepository.find.mockResolvedValue([
        {
          id: "split-principal",
          transferAccountId: accountId,
          categoryId: null,
          amount: -185,
          memo: "Principal",
        },
        {
          id: "split-interest",
          transferAccountId: null,
          categoryId: "cat-interest",
          amount: -375,
          memo: "Interest",
        },
        {
          id: "split-escrow",
          transferAccountId: null,
          categoryId: "cat-escrow",
          amount: -100,
          memo: "Escrow",
        },
      ]);

      const preview = await service.previewScheduledPayment(loan());

      expect(preview).toBeNull();
    });

    it("offers nothing for a bill that pays another loan", async () => {
      template(185, 375, "2023-02-03");
      debt(100000);
      accountsRepository.findOne.mockImplementation(
        async ({ where }: { where: { id: string; userId?: string } }) =>
          where.userId ? loan() : loan({ id: "another-loan" }),
      );

      const preview = await service.previewScheduledPayment(loan());

      expect(preview).toBeNull();
    });

    it("declines rather than pricing 0 % when no rate is recorded anywhere", async () => {
      accountsRepository.findOne.mockResolvedValue(
        loan({ interestRate: null }),
      );
      rateChangesRepository.find.mockResolvedValue([]);
      template(185, 375, "2023-02-03");
      debt(100000);

      const preview = await service.previewScheduledPayment(
        loan({ interestRate: null }),
      );

      expect(preview).toBeNull();
      expectTemplateUntouched();
    });

    it("returns null and applies nothing when there is no linked schedule", async () => {
      accountsRepository.findOne.mockResolvedValue(
        loan({ scheduledTransactionId: null }),
      );

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toBeNull();
      expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
    });

    it("rejects an apply for an account the user does not own", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.applyScheduledPaymentSync(userId, accountId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * The sync writes the template through the loan core's `rewriteLoanTemplate`
   * and never through `ScheduledTransactionsService.update`, whose
   * template-amount edit writes `accounts.payment_amount` (spec 7.5; issue
   * #1637's side effect). A scan, because the ban is on a collaborator the
   * type system would happily inject again.
   */
  describe("the rate-change module does not reach the scheduled-transactions service", () => {
    const files = readdirSync(__dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"),
    );
    /** Comments are blanked: this module's own prose names the banned service. */
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    it.each(files)("%s", (file) => {
      const source = stripComments(readFileSync(join(__dirname, file), "utf8"));
      expect(source).not.toMatch(
        /ScheduledTransactionsService|scheduled-transactions\.service|scheduled-transactions\.module/,
      );
    });

    it("scans the service itself", () => {
      expect(files).toContain("loan-rate-changes.service.ts");
      expect(files).toContain("loan-rate-changes.module.ts");
    });
  });

  describe("update", () => {
    beforeEach(() => {
      rateChangesRepository.findOne.mockResolvedValue(makeRow());
    });

    it("merges provided fields without touching the account scalars", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);

      const result = await service.update(userId, accountId, "rc-1", {
        annualRate: 5.1,
      });

      expect(result.annualRate).toBe(5.1);
      // Editing the timeline never rewrites the account's own rate.
      expect(account.interestRate).toBe(5.5);
      expectAccountUntouched();
    });

    it("flips an inferred row to manual when edited", async () => {
      rateChangesRepository.findOne.mockResolvedValue(
        makeRow({ source: "inferred" }),
      );

      const result = await service.update(userId, accountId, "rc-1", {
        annualRate: 5.05,
      });

      expect(result.source).toBe("manual");
    });

    it("keeps the source when a manual row is edited", async () => {
      const result = await service.update(userId, accountId, "rc-1", {
        annualRate: 5.05,
      });

      expect(result.source).toBe("manual");
    });

    it("409s when moving onto another row's effective date", async () => {
      manager.findOne.mockResolvedValue(makeRow({ id: "rc-other" }));

      await expect(
        service.update(userId, accountId, "rc-1", {
          effectiveDate: "2024-07-01",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("skips the duplicate check when the date is unchanged", async () => {
      await service.update(userId, accountId, "rc-1", {
        effectiveDate: "2024-06-01",
      });

      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it("404s for a rate change on another account or user", async () => {
      rateChangesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.update(userId, accountId, "rc-1", { annualRate: 5 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("remove", () => {
    it("removes the row without rewriting the account scalars", async () => {
      const account = makeAccount({ interestRate: 4.9 });
      accountsRepository.findOne.mockResolvedValue(account);
      const row = makeRow();
      rateChangesRepository.findOne.mockResolvedValue(row);

      const result = await service.remove(userId, accountId, "rc-1");

      expect(manager.remove).toHaveBeenCalledWith(row);
      // Account rate stays as the user set it; deletion never restores a row's value.
      expect(account.interestRate).toBe(4.9);
      expect(result.scheduledPaymentPreview).toBeNull();
      expectAccountUntouched();
    });

    it("404s when the rate change does not exist", async () => {
      rateChangesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.remove(userId, accountId, "missing"),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
