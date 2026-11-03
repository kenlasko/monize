import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { LoanFeeDto } from "./dto/loan-fee.dto";
import { LoanFee } from "./entities/loan-fee.entity";
import { LoanFeesService } from "./loan-fees.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * `LoanFeesService.replace` (docs/specs/mortgage-fees.md section 7): the fee
 * set and the template lines change together, the parent moves by exactly
 * the change in fee lines, and every refusal runs before the first write.
 * The mortgage owes 100,000 through its next due date.
 */
describe("LoanFeesService", () => {
  const userId = "user-1";
  const accountId = "acc-mortgage";
  const scheduleId = "st-mortgage";

  let accounts: Record<string, jest.Mock>;
  let categories: Record<string, jest.Mock>;
  let fees: Record<string, jest.Mock>;
  let schedules: Record<string, jest.Mock>;
  let splits: Record<string, jest.Mock>;
  let scoped: ReturnType<typeof createScopedDbMocks>;
  let service: LoanFeesService;
  let stored: LoanFee[];
  let lines: ScheduledTransactionSplit[];

  const mortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: accountId,
      userId,
      accountType: "MORTGAGE",
      interestCategoryId: "cat-interest",
      scheduledTransactionId: scheduleId,
      paymentFrequency: "MONTHLY",
      currencyCode: "CAD",
      originalPrincipal: 100000,
      openingBalance: -100000,
      ...overrides,
    }) as unknown as Account;

  const line = (
    id: string,
    amount: number,
    rest: Partial<ScheduledTransactionSplit>,
  ): ScheduledTransactionSplit =>
    ({
      id,
      scheduledTransactionId: scheduleId,
      transferAccountId: null,
      categoryId: null,
      memo: null,
      amount: -amount,
      ...rest,
    }) as unknown as ScheduledTransactionSplit;

  const baseLines = () => [
    line("split-principal", 167.92, {
      transferAccountId: accountId,
      memo: "Principal",
    }),
    line("split-interest", 416.67, {
      categoryId: "cat-interest",
      memo: "Interest",
    }),
  ];

  const tax: LoanFeeDto = {
    categoryId: "cat-tax",
    name: "Property tax",
    calculation: "FIXED",
    basis: "ANNUAL",
    amount: 3600,
  };
  const insurance: LoanFeeDto = {
    categoryId: "cat-insurance",
    name: "Default insurance",
    calculation: "PERCENT_CURRENT_BALANCE",
    basis: "ANNUAL",
    rate: 0.5,
  };

  beforeEach(() => {
    stored = [];
    lines = baseLines();
    accounts = { findOne: jest.fn().mockResolvedValue(mortgage()) };
    categories = {
      find: jest.fn(async ({ where }) =>
        (where.id._value as string[]).map((id) => ({ id, userId })),
      ),
    };
    // A small in-memory table: rows by id, ordered as the service reads.
    let nextId = 0;
    fees = {
      find: jest.fn(async () =>
        [...stored].sort((a, b) => a.sortOrder - b.sortOrder),
      ),
      delete: jest.fn(async ({ id }: { id: string }) => {
        stored = stored.filter((row) => row.id !== id);
      }),
      update: jest.fn(
        async ({ id }: { id: string }, values: Partial<LoanFee>) => {
          stored = stored.map((row) =>
            row.id === id ? ({ ...row, ...values } as LoanFee) : row,
          );
        },
      ),
      create: jest.fn((row) => row),
      save: jest.fn(async (row: LoanFee) => {
        const saved = { ...row, id: `fee-${++nextId}` } as LoanFee;
        stored = [...stored, saved];
        return saved;
      }),
    };
    schedules = {
      findOne: jest.fn().mockResolvedValue({
        id: scheduleId,
        userId,
        amount: -584.59,
        frequency: "MONTHLY",
        nextDueDate: "2026-12-01",
      }),
      update: jest.fn(),
    };
    splits = {
      find: jest.fn(async () => lines),
      delete: jest.fn(),
      update: jest.fn(),
      create: jest.fn((row) => row),
      save: jest.fn(async (row) => row),
    };
    scoped = createScopedDbMocks([
      [Account, accounts],
      [Category, categories],
      [LoanFee, fees],
      [ScheduledTransaction, schedules],
      [ScheduledTransactionSplit, splits],
    ]);
    scoped.manager.query.mockResolvedValue([{ balance: "-100000" }]);
    service = new LoanFeesService(scoped.dataSource as unknown as DataSource);
  });

  const writes = () =>
    fees.delete.mock.calls.length +
    fees.update.mock.calls.length +
    fees.save.mock.calls.length +
    splits.delete.mock.calls.length +
    splits.update.mock.calls.length +
    splits.save.mock.calls.length +
    schedules.update.mock.calls.length;

  it("adds a line per new fee, priced at the next due date, and moves the parent by their sum", async () => {
    const result = await service.replace(userId, accountId, [tax, insurance]);

    expect(accounts.findOne).toHaveBeenCalledWith({
      where: { id: accountId, userId },
      lock: { mode: "pessimistic_write" },
    });
    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: scheduleId, userId },
      lock: { mode: "pessimistic_write" },
    });
    // 3,600 / 12 = 300.00; 100,000 x 0.5 % / 12 = 41.67.
    expect(splits.save.mock.calls.map(([row]) => row)).toEqual([
      expect.objectContaining({
        categoryId: "cat-tax",
        amount: -300,
        memo: "Property tax",
        kind: "category",
      }),
      expect.objectContaining({
        categoryId: "cat-insurance",
        amount: -41.67,
        memo: "Default insurance",
      }),
    ]);
    expect(schedules.update).toHaveBeenCalledWith(
      { id: scheduleId },
      { amount: -926.26 },
    );
    expect(result.map((f) => [f.categoryId, f.sortOrder])).toEqual([
      ["cat-tax", 0],
      ["cat-insurance", 1],
    ]);
  });

  it("removes a dropped fee's line and lowers the parent by exactly that line", async () => {
    stored = [
      { ...tax, id: "fee-tax", rate: null, sortOrder: 0 } as unknown as LoanFee,
    ];
    lines = [
      ...baseLines(),
      line("split-tax", 300, { categoryId: "cat-tax", memo: "Property tax" }),
    ];
    schedules.findOne.mockResolvedValue({
      id: scheduleId,
      userId,
      amount: -884.59,
      frequency: "MONTHLY",
      nextDueDate: "2026-12-01",
    });

    await service.replace(userId, accountId, []);

    expect(splits.delete).toHaveBeenCalledWith({ id: "split-tax" });
    expect(fees.delete).toHaveBeenCalledWith({ id: "fee-tax" });
    expect(schedules.update).toHaveBeenCalledWith(
      { id: scheduleId },
      { amount: -584.59 },
    );
    expect(stored).toEqual([]);
  });

  it("adopts the template's one existing line on the fee's category and reprices it", async () => {
    lines = [
      ...baseLines(),
      line("split-escrow", 250, { categoryId: "cat-tax", memo: "Escrow" }),
    ];
    schedules.findOne.mockResolvedValue({
      id: scheduleId,
      userId,
      amount: -834.59,
      frequency: "MONTHLY",
      nextDueDate: "2026-12-01",
    });

    await service.replace(userId, accountId, [tax]);

    expect(splits.save).not.toHaveBeenCalled();
    expect(splits.update).toHaveBeenCalledWith(
      { id: "split-escrow" },
      { amount: -300, memo: "Property tax" },
    );
    expect(schedules.update).toHaveBeenCalledWith(
      { id: scheduleId },
      { amount: -884.59 },
    );
  });

  it("writes the fee rows without touching a template when the mortgage has none", async () => {
    accounts.findOne.mockResolvedValue(
      mortgage({ scheduledTransactionId: null }),
    );

    await service.replace(userId, accountId, [tax]);

    expect(schedules.findOne).not.toHaveBeenCalled();
    expect(stored).toHaveLength(1);
  });

  it("keeps a fee's row, and its id, when its category stays in the set", async () => {
    stored = [
      {
        ...tax,
        id: "fee-tax",
        rate: null,
        sortOrder: 0,
      } as unknown as LoanFee,
    ];
    lines = [
      ...baseLines(),
      line("split-tax", 300, { categoryId: "cat-tax", memo: "Property tax" }),
    ];

    const result = await service.replace(userId, accountId, [
      { ...tax, name: "School tax", amount: 2400 },
      insurance,
    ]);

    expect(fees.delete).not.toHaveBeenCalled();
    expect(fees.update).toHaveBeenCalledWith(
      { id: "fee-tax" },
      expect.objectContaining({
        name: "School tax",
        amount: 2400,
        sortOrder: 0,
      }),
    );
    expect(result.map((f) => [f.id, f.categoryId, f.sortOrder])).toEqual([
      ["fee-tax", "cat-tax", 0],
      [expect.stringMatching(/^fee-/), "cat-insurance", 1],
    ]);
  });

  describe("refuses before any write", () => {
    it("a fee on a mortgage whose bank debits a payment matching rule settles", async () => {
      accounts.findOne.mockResolvedValue(
        mortgage({ paymentMatchingRuleId: "rule-1" } as Partial<Account>),
      );
      await expect(service.replace(userId, accountId, [tax])).rejects.toThrow(
        BadRequestException,
      );
      expect(writes()).toBe(0);
    });

    it("but removes the fees of such a mortgage", async () => {
      accounts.findOne.mockResolvedValue(
        mortgage({ paymentMatchingRuleId: "rule-1" } as Partial<Account>),
      );
      await expect(service.replace(userId, accountId, [])).resolves.toEqual([]);
    });

    it("an account that is not the caller's", async () => {
      accounts.findOne.mockResolvedValue(null);
      await expect(service.replace(userId, accountId, [tax])).rejects.toThrow(
        NotFoundException,
      );
      expect(writes()).toBe(0);
    });

    it("an account that is not a mortgage", async () => {
      accounts.findOne.mockResolvedValue(
        mortgage({ accountType: "LOAN" } as Partial<Account>),
      );
      await expect(service.replace(userId, accountId, [tax])).rejects.toThrow(
        BadRequestException,
      );
      expect(writes()).toBe(0);
    });

    it.each([
      ["a category twice", [tax, { ...insurance, categoryId: "cat-tax" }]],
      ["the interest category", [{ ...tax, categoryId: "cat-interest" }]],
      ["a fixed fee with a rate", [{ ...tax, rate: 1 }]],
      ["a percentage fee without a rate", [{ ...insurance, rate: null }]],
    ])("%s", async (_label, dtos) => {
      await expect(
        service.replace(userId, accountId, dtos as LoanFeeDto[]),
      ).rejects.toThrow(BadRequestException);
      expect(writes()).toBe(0);
    });

    it("a category the caller does not own", async () => {
      categories.find.mockResolvedValue([]);
      await expect(service.replace(userId, accountId, [tax])).rejects.toThrow(
        BadRequestException,
      );
      expect(writes()).toBe(0);
    });

    it("a fee whose category already has several template lines", async () => {
      lines = [
        ...baseLines(),
        line("split-a", 100, { categoryId: "cat-tax" }),
        line("split-b", 100, { categoryId: "cat-tax" }),
      ];
      await expect(service.replace(userId, accountId, [tax])).rejects.toThrow(
        BadRequestException,
      );
      expect(writes()).toBe(0);
    });
  });

  it("lists a mortgage's fees, and 404s another user's", async () => {
    stored = [
      {
        id: "fee-1",
        categoryId: "cat-tax",
        name: "Property tax",
        calculation: "FIXED",
        basis: "ANNUAL",
        amount: 3600,
        rate: null,
        sortOrder: 0,
      } as LoanFee,
    ];
    await expect(service.list(userId, accountId)).resolves.toEqual([
      {
        id: "fee-1",
        categoryId: "cat-tax",
        name: "Property tax",
        calculation: "FIXED",
        basis: "ANNUAL",
        amount: 3600,
        rate: null,
        sortOrder: 0,
      },
    ]);
    accounts.findOne.mockResolvedValue(null);
    await expect(service.list(userId, accountId)).rejects.toThrow(
      NotFoundException,
    );
  });
});
