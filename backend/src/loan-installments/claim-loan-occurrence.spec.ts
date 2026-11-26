import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "../scheduled-transactions/entities/scheduled-transaction-override.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  OCCURRENCE_ALREADY_POSTED_CODE,
  claimLoanOccurrence,
} from "./claim-loan-occurrence";
import { LoanSettlementPlan, pricingColumn } from "./loan-settlement.types";

/**
 * The claim a settlement writes (`docs/specs/loan-installment-settlement.md`
 * sections 12.1 and 12.3): the INSERT and its parameters, the backstop
 * conflict, and the cursor: advanced through `advanceScheduleCursor` only
 * when the slot is the locked row's `next_due_date`, past every consecutive
 * claimed slot, with the overrides it pruned recorded; a cadence that cannot
 * step deactivates instead. A mock proves the statements and their order;
 * the two-connection proof is the integration suite's.
 */
describe("claimLoanOccurrence", () => {
  const userId = "user-1";
  const scheduleId = "st-1";
  const transactionId = "tx-1";
  const ruleId = "rule-1";

  let manager: Record<string, jest.Mock>;
  let schedules: Record<string, jest.Mock>;
  let overrides: Record<string, jest.Mock>;
  let deleteChain: Record<string, jest.Mock>;

  const m = () => manager as unknown as EntityManager;

  const plan = (
    over: Partial<LoanSettlementPlan> = {},
  ): LoanSettlementPlan => ({
    loanAccountId: "acc-loan",
    scheduledTransactionId: scheduleId,
    dueDate: "2024-01-01",
    installmentNumber: 1,
    method: "LINEAR",
    prepaymentMode: "SHORTEN_TERM",
    currencyCode: "EUR",
    debtLedger: 300000,
    foldedPrincipal: 0,
    debtBefore: 300000,
    annualRate: 2,
    periodicRate: 0.0016666666666666668,
    priced: {
      principal: 833.3333,
      interest: 500,
      extra: 0,
      total: 1333.3333,
    },
    booked: { principal: 833.33, interest: 500, extra: 0, total: 1333.33 },
    paid: 1333.33,
    difference: 0,
    outcome: "exact",
    principal: 833.33,
    interest: 500,
    extraPrincipal: 0,
    toleranceApplied: 0,
    policy: { excess: "extra_principal", shortfall: "refuse" },
    advancesCursor: true,
    ...over,
  });

  const schedule = (
    over: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: scheduleId,
      userId,
      frequency: "MONTHLY",
      nextDueDate: "2024-01-01",
      occurrencesRemaining: 10,
      isActive: true,
      lastPostedDate: null,
      endDate: null,
      ...over,
    }) as unknown as ScheduledTransaction;

  const override = (
    id: string,
    originalDate: string,
  ): ScheduledTransactionOverride =>
    ({
      id,
      scheduledTransactionId: scheduleId,
      originalDate,
      overrideDate: originalDate,
      amount: -1300,
      categoryId: null,
      description: "moved",
      isSplit: null,
      splits: null,
      investmentQuantity: null,
      investmentPrice: null,
      investmentTotalAmount: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as ScheduledTransactionOverride;

  const claim = () =>
    claimLoanOccurrence(m(), userId, {
      plan: plan(),
      transactionId,
      ruleId,
      postedDate: "2024-01-03",
    });

  beforeEach(() => {
    schedules = { findOne: jest.fn() };
    overrides = { find: jest.fn().mockResolvedValue([]) };
    manager = createScopedDbMocks([
      [ScheduledTransaction, schedules],
      [ScheduledTransactionOverride, overrides],
    ]).manager;
    // The INSERT comes back as bare rows (the driver's shape for INSERT).
    manager.query.mockResolvedValue([{ id: "claim-1" }]);
    manager.update.mockResolvedValue({ affected: 1 });
    deleteChain = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    manager.createQueryBuilder.mockReturnValue(deleteChain);
  });

  it("inserts the claim with the slot, the row's date, the row, the rule and the pricing, ON CONFLICT DO NOTHING RETURNING id", async () => {
    schedules.findOne.mockResolvedValue(
      schedule({ nextDueDate: "2024-03-01" }),
    );

    const result = await claim();

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO scheduled_transaction_postings");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).toContain("RETURNING id");
    expect(sql).toMatch(/'rule'/);
    expect(params).toEqual([
      scheduleId,
      "2024-01-01",
      "2024-01-03",
      transactionId,
      ruleId,
      JSON.stringify(pricingColumn(plan())),
    ]);
    expect(JSON.parse(params[5])).toMatchObject({
      version: 1,
      dueDate: "2024-01-01",
      debtBefore: "300000.0000",
      lines: { principal: "833.33", interest: "500.00", extra: "0.00" },
    });
    expect(result).toEqual({
      claimId: "claim-1",
      scheduledTransactionId: scheduleId,
      dueDate: "2024-01-01",
      cursorAdvanced: false,
    });
  });

  it("throws the backstop conflict when the INSERT finds the slot taken, before reading the schedule", async () => {
    manager.query.mockResolvedValue([]);
    await expect(claim()).rejects.toMatchObject({
      constructor: ConflictException,
      response: expect.objectContaining({
        errorCode: OCCURRENCE_ALREADY_POSTED_CODE,
        scheduledTransactionId: scheduleId,
        dueDate: "2024-01-01",
      }),
    });
    expect(schedules.findOne).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it("reads the schedule row locked and owner-scoped, and leaves the cursor alone when the slot is not its next due date", async () => {
    // The plan said the slot was the cursor; the locked row is the authority.
    schedules.findOne.mockResolvedValue(
      schedule({ nextDueDate: "2024-02-01" }),
    );

    const result = await claim();

    expect(schedules.findOne).toHaveBeenCalledWith({
      where: { id: scheduleId, userId },
      lock: { mode: "pessimistic_write" },
    });
    expect(result.cursorAdvanced).toBe(false);
    expect(result).not.toHaveProperty("cursor");
    expect(manager.update).not.toHaveBeenCalled();
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it("advances the cursor past every consecutive claimed slot when the slot is the next due date, recording before and after", async () => {
    const locked = schedule();
    const advanced = schedule({
      nextDueDate: "2024-04-01",
      occurrencesRemaining: 7,
      lastPostedDate: "2026-10-08",
    });
    schedules.findOne
      .mockResolvedValueOnce(locked)
      .mockResolvedValueOnce(advanced);
    // The slot just claimed, and two later slots settled out of order before.
    manager.query
      .mockResolvedValueOnce([{ id: "claim-1" }])
      .mockResolvedValueOnce([
        { d: "2024-01-01" },
        { d: "2024-02-01" },
        { d: "2024-03-01" },
      ]);

    const result = await claim();

    // The claims on or after the cursor come from the shared `claimedSlotsFrom`.
    const [claimsSql, claimsParams] = manager.query.mock.calls[1];
    expect(claimsSql).toContain("FROM scheduled_transaction_postings");
    expect(claimsParams).toEqual([scheduleId, "2024-01-01"]);
    // advanceScheduleCursor stepped three slots: the claimed one and the two
    // already taken, so the bill never offers a claimed key.
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      scheduleId,
      expect.objectContaining({
        nextDueDate: "2024-04-01",
        occurrencesRemaining: 7,
      }),
    );
    expect(deleteChain.andWhere).toHaveBeenCalledWith(
      "originalDate < :newNextDueDate",
      { newNextDueDate: "2024-04-01" },
    );
    expect(result).toEqual({
      claimId: "claim-1",
      scheduledTransactionId: scheduleId,
      dueDate: "2024-01-01",
      cursorAdvanced: true,
      cursor: {
        before: {
          nextDueDate: "2024-01-01",
          occurrencesRemaining: 10,
          isActive: true,
          lastPostedDate: null,
        },
        after: {
          nextDueDate: "2024-04-01",
          occurrencesRemaining: 7,
          isActive: true,
          lastPostedDate: "2026-10-08",
        },
        prunedOverrides: [],
      },
    });
  });

  it("records the override rows the advance pruned, in the shape the rewind re-inserts", async () => {
    schedules.findOne
      .mockResolvedValueOnce(schedule())
      .mockResolvedValueOnce(schedule({ nextDueDate: "2024-02-01" }));
    manager.query
      .mockResolvedValueOnce([{ id: "claim-1" }])
      .mockResolvedValueOnce([{ d: "2024-01-01" }]);
    const kept = override("ovr-keep", "2024-03-01");
    overrides.find
      .mockResolvedValueOnce([override("ovr-gone", "2024-01-01"), kept])
      .mockResolvedValueOnce([kept]);

    const result = await claim();

    expect(result.cursor?.prunedOverrides).toEqual([
      {
        id: "ovr-gone",
        scheduledTransactionId: scheduleId,
        originalDate: "2024-01-01",
        overrideDate: "2024-01-01",
        amount: -1300,
        categoryId: null,
        description: "moved",
        isSplit: null,
        splits: null,
        investmentQuantity: null,
        investmentPrice: null,
        investmentTotalAmount: null,
        autoPost: null,
      },
    ]);
    // Read before the advance and again after it, on the schedule's overrides.
    expect(overrides.find).toHaveBeenCalledTimes(2);
    expect(overrides.find).toHaveBeenCalledWith({
      where: { scheduledTransactionId: scheduleId },
    });
  });

  it("deactivates a schedule whose cadence cannot step (ONCE) instead of advancing or deleting it", async () => {
    schedules.findOne
      .mockResolvedValueOnce(schedule({ frequency: "ONCE" }))
      .mockResolvedValueOnce(
        schedule({
          frequency: "ONCE",
          isActive: false,
          lastPostedDate: "2026-10-08",
        }),
      );

    const result = await claim();

    expect(manager.update).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      scheduleId,
      {
        isActive: false,
        lastPostedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    );
    // No step, so nothing to prune and no claims to read.
    expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledTimes(1);
    expect(manager.delete).not.toHaveBeenCalled();
    expect(result.cursorAdvanced).toBe(true);
    expect(result.cursor).toMatchObject({
      before: { nextDueDate: "2024-01-01", isActive: true },
      after: { nextDueDate: "2024-01-01", isActive: false },
      prunedOverrides: [],
    });
  });

  it("fails closed when the schedule row is gone between the plan and the claim", async () => {
    schedules.findOne.mockResolvedValue(null);
    await expect(claim()).rejects.toThrow(/vanished mid-write/);
    expect(manager.update).not.toHaveBeenCalled();
  });
});
