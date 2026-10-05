import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoanRateChangesService, toYmd } from "./loan-rate-changes.service";
import { LoanRateChange } from "./entities/loan-rate-change.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { recalculateMortgageAfterRateChange } from "../accounts/mortgage-amortization.util";
import { todayYMD } from "../common/date-utils";
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
  let scheduledTransactionsService: Record<string, jest.Mock>;
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
      mortgageType: "ANNUITY",
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

  beforeEach(() => {
    rateChangesRepository = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };

    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(makeAccount()),
    };

    scheduledTransactionsService = {
      findOne: jest.fn().mockResolvedValue({ id: "sched-1", splits: [] }),
      update: jest.fn().mockResolvedValue({ id: "sched-1" }),
    };

    ({ manager, dataSource } = createScopedDbMocks([
      [LoanRateChange, rateChangesRepository],
      [Account, accountsRepository],
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

    service = new LoanRateChangesService(
      dataSource as never,
      scheduledTransactionsService as never,
    );
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

    it("recalculates by the stored type", async () => {
      const account = makeAccount({ mortgageType: "CANADIAN_FIXED" });
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
      manager.find.mockResolvedValue([
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
      expect(manager.save).not.toHaveBeenCalledWith(account);
    });

    it("resyncs the scheduled payment splits at the new rate, keeping the amount", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      // Variable-rate mortgage: monthly compounding at the new rate
      const expectedInterest =
        Math.round(400000 * (4.9 / 100 / 12) * 10000) / 10000;
      expect(scheduledTransactionsService.update).toHaveBeenCalledWith(
        userId,
        "sched-1",
        expect.objectContaining({
          amount: -2500,
          splits: [
            expect.objectContaining({
              transferAccountId: accountId,
              amount: -(2500 - expectedInterest),
              memo: "Principal",
            }),
            expect.objectContaining({
              categoryId: "cat-interest",
              amount: -expectedInterest,
              memo: "Interest",
            }),
          ],
        }),
      );
    });

    it("preserves a separate extra-principal split on the scheduled payment", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);
      scheduledTransactionsService.findOne.mockResolvedValue({
        id: "sched-1",
        splits: [
          { transferAccountId: accountId, amount: -800, memo: "Principal" },
          { categoryId: "cat-interest", amount: -1700, memo: "Interest" },
          {
            transferAccountId: accountId,
            amount: -200,
            memo: "Extra Principal",
          },
        ],
      });

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      const updateArgs = scheduledTransactionsService.update.mock.calls[0][2];
      expect(updateArgs.amount).toBe(-2700);
      expect(updateArgs.splits).toHaveLength(3);
      expect(updateArgs.splits[2]).toMatchObject({
        transferAccountId: accountId,
        amount: -200,
        memo: "Extra Principal",
      });
    });

    it("leaves scalars and the scheduled payment untouched for future-dated changes", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      const future = "2099-01-01";
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: future, annualRate: 9.9 }),
      ]);

      await service.create(userId, accountId, {
        effectiveDate: future,
        annualRate: 9.9,
      });

      expect(account.interestRate).toBe(5.5);
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("persists rows on closed accounts without touching scalars or the schedule", async () => {
      const account = makeAccount({ isClosed: true });
      accountsRepository.findOne.mockResolvedValue(account);

      await service.create(userId, accountId, {
        effectiveDate: "2024-06-01",
        annualRate: 4.9,
      });

      expect(manager.save).toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
      expect(account.interestRate).toBe(5.5);
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("propagates a write failure out of the transaction without syncing", async () => {
      manager.save.mockRejectedValue(new Error("db down"));

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
        }),
      ).rejects.toThrow("db down");
      // Two scoped transactions: the account lookup, then the write block that
      // rolls back when the callback throws -- so the post-commit scheduled
      // sync never runs.
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("does not fail the request when the scheduled-payment sync fails", async () => {
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);
      scheduledTransactionsService.update.mockRejectedValue(
        new Error("sync failed"),
      );

      await expect(
        service.create(userId, accountId, {
          effectiveDate: "2024-06-01",
          annualRate: 4.9,
        }),
      ).resolves.toBeDefined();
    });

    it("defers the scheduled-payment sync and returns a preview instead of applying it", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);
      scheduledTransactionsService.findOne.mockResolvedValue({
        id: "sched-1",
        name: "Mortgage",
        currencyCode: "CAD",
        amount: -2500,
        splits: [
          { transferAccountId: accountId, amount: -800, memo: "Principal" },
          { categoryId: "cat-interest", amount: -1700, memo: "Interest" },
        ],
      });

      const result = await service.create(
        userId,
        accountId,
        { effectiveDate: "2024-06-01", annualRate: 4.9 },
        { deferScheduledSync: true },
      );

      // Nothing is applied to the schedule yet -- the user must confirm first
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();

      const expectedInterest =
        Math.round(400000 * (4.9 / 100 / 12) * 10000) / 10000;
      expect(result.scheduledPaymentPreview).toMatchObject({
        scheduledTransactionId: "sched-1",
        scheduledTransactionName: "Mortgage",
        currencyCode: "CAD",
        currentPaymentAmount: 2500,
        proposedPaymentAmount: 2500,
        currentPrincipal: 800,
        proposedPrincipal: 2500 - expectedInterest,
        currentInterest: 1700,
        proposedInterest: expectedInterest,
        extraPrincipal: 0,
      });
    });

    it("returns a null preview when deferring on an account with no linked schedule", async () => {
      const account = makeAccount({ scheduledTransactionId: null });
      accountsRepository.findOne.mockResolvedValue(account);
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);

      const result = await service.create(
        userId,
        accountId,
        { effectiveDate: "2024-06-01", annualRate: 4.9 },
        { deferScheduledSync: true },
      );

      expect(result.scheduledPaymentPreview).toBeNull();
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });
  });

  describe("applyScheduledPaymentSync", () => {
    it("resyncs the linked scheduled payment and returns the applied change", async () => {
      const account = makeAccount({ interestRate: 4.9 });
      accountsRepository.findOne.mockResolvedValue(account);
      scheduledTransactionsService.findOne.mockResolvedValue({
        id: "sched-1",
        name: "Mortgage",
        currencyCode: "CAD",
        amount: -2500,
        splits: [],
      });

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      const expectedInterest =
        Math.round(400000 * (4.9 / 100 / 12) * 10000) / 10000;
      expect(scheduledTransactionsService.update).toHaveBeenCalledWith(
        userId,
        "sched-1",
        expect.objectContaining({
          amount: -2500,
          splits: [
            expect.objectContaining({
              transferAccountId: accountId,
              amount: -(2500 - expectedInterest),
              memo: "Principal",
            }),
            expect.objectContaining({
              categoryId: "cat-interest",
              amount: -expectedInterest,
              memo: "Interest",
            }),
          ],
        }),
      );
      expect(result?.proposedInterest).toBe(expectedInterest);
    });

    it("splits from the ledger debt through the template's next due date", async () => {
      // The rewritten template's next posting is priced from the ledger
      // through its due date (`resolveInstallment`), so its split is too: a
      // payment already posted before that date is not still owed.
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ interestRate: 4.9 }),
      );
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);
      scheduledTransactionsService.findOne.mockResolvedValue({
        id: "sched-1",
        amount: -2500,
        nextDueDate: "2099-02-01",
        splits: [],
      });
      manager.query.mockResolvedValue([{ balance: "-390000" }]);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        accountId,
        userId,
        "2099-02-01",
      ]);
      expect(result?.proposedInterest).toBe(
        Math.round(390000 * (4.9 / 100 / 12) * 10000) / 10000,
      );
    });

    it("splits from the effective date when the template is due before it", async () => {
      accountsRepository.findOne.mockResolvedValue(makeAccount());
      manager.find.mockResolvedValue([
        makeRow({ effectiveDate: "2024-06-01", annualRate: 4.9 }),
      ]);
      scheduledTransactionsService.findOne.mockResolvedValue({
        id: "sched-1",
        amount: -2500,
        nextDueDate: "2024-05-01",
        splits: [],
      });

      await service.applyScheduledPaymentSync(userId, accountId);

      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        accountId,
        userId,
        "2024-06-01",
      ]);
    });

    it("applies nothing when the ledger cannot be read", async () => {
      accountsRepository.findOne.mockResolvedValue(makeAccount());
      manager.query.mockResolvedValue([]);

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toBeNull();
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("returns null and applies nothing when there is no linked schedule", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeAccount({ scheduledTransactionId: null }),
      );

      const result = await service.applyScheduledPaymentSync(userId, accountId);

      expect(result).toBeNull();
      expect(scheduledTransactionsService.update).not.toHaveBeenCalled();
    });

    it("rejects for an account the user does not own", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await expect(
        service.applyScheduledPaymentSync(userId, accountId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("update", () => {
    beforeEach(() => {
      rateChangesRepository.findOne.mockResolvedValue(makeRow());
    });

    it("merges provided fields without touching the account scalars", async () => {
      const account = makeAccount();
      accountsRepository.findOne.mockResolvedValue(account);
      manager.find.mockResolvedValue([
        makeRow({ annualRate: 5.1, effectiveDate: "2024-06-01" }),
      ]);

      const result = await service.update(userId, accountId, "rc-1", {
        annualRate: 5.1,
      });

      expect(result.annualRate).toBe(5.1);
      // Editing the timeline never rewrites the account's own rate.
      expect(account.interestRate).toBe(5.5);
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
      manager.find.mockResolvedValue([
        makeRow({
          source: "initial",
          effectiveDate: "2022-01-01",
          annualRate: 5.5,
          newPaymentAmount: 2500,
        }),
      ]);

      await service.remove(userId, accountId, "rc-1");

      expect(manager.remove).toHaveBeenCalledWith(row);
      // Account rate stays as the user set it; deletion never restores a row's value.
      expect(account.interestRate).toBe(4.9);
    });

    it("leaves scalars alone when no applicable rows remain", async () => {
      const account = makeAccount({ interestRate: 4.9 });
      accountsRepository.findOne.mockResolvedValue(account);
      rateChangesRepository.findOne.mockResolvedValue(makeRow());
      manager.find.mockResolvedValue([]);

      await service.remove(userId, accountId, "rc-1");

      expect(account.interestRate).toBe(4.9);
    });

    it("404s when the rate change does not exist", async () => {
      rateChangesRepository.findOne.mockResolvedValue(null);

      await expect(
        service.remove(userId, accountId, "missing"),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("resolveCurrentTimeline", () => {
    it("returns the latest applicable rate and latest non-null payment without mutating the account", async () => {
      const account = makeAccount();
      const today = todayYMD();
      manager.find.mockResolvedValue([
        makeRow({
          source: "initial",
          effectiveDate: "2022-01-01",
          annualRate: 5.5,
          newPaymentAmount: 2500,
        }),
        makeRow({
          id: "rc-2",
          effectiveDate: "2023-01-01",
          annualRate: 6.2,
          newPaymentAmount: 2650,
        }),
        makeRow({ id: "rc-3", effectiveDate: "2024-01-01", annualRate: 5.9 }),
        makeRow({ id: "rc-4", effectiveDate: "2099-01-01", annualRate: 4.0 }),
      ]);

      const resolved = await service.resolveCurrentTimeline(
        manager as any,
        account,
      );

      expect(today >= "2024-01-01").toBe(true);
      expect(resolved).toEqual({
        annualRate: 5.9,
        paymentAmount: 2650,
        effectiveDate: "2024-01-01",
      });
      // Read-only: the account's own scalars are never touched.
      expect(account.interestRate).toBe(5.5);
      expect(account.paymentAmount).toBe(2500);
      expect(manager.save).not.toHaveBeenCalledWith(account);
    });

    it("returns null for a closed account", async () => {
      const resolved = await service.resolveCurrentTimeline(
        manager as any,
        makeAccount({ isClosed: true }),
      );
      expect(resolved).toBeNull();
      expect(manager.find).not.toHaveBeenCalled();
    });
  });
});
