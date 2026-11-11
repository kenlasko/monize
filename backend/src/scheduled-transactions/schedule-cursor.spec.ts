import { EntityManager } from "typeorm";
import {
  PrunedScheduleOverride,
  advanceScheduleCursor,
  claimedSlotsFrom,
  rewindScheduleCursor,
} from "./schedule-cursor";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * The cursor advance `post()` runs after its claim, lifted so a settlement can
 * share it (`docs/specs/loan-installment-settlement.md` section 12.3). The
 * `post()` suite proves the posting still calls it; this one proves the block
 * itself, including the one thing `post()` never exercises: stepping past
 * several claimed slots at once.
 */
describe("advanceScheduleCursor", () => {
  let manager: Record<string, jest.Mock>;
  let deleteChain: Record<string, jest.Mock>;

  const schedule = (
    overrides: Partial<ScheduledTransaction> = {},
  ): Pick<
    ScheduledTransaction,
    "id" | "nextDueDate" | "frequency" | "occurrencesRemaining" | "endDate"
  > => ({
    id: "st-1",
    nextDueDate: "2025-02-15",
    frequency: "MONTHLY",
    occurrencesRemaining: null,
    endDate: null,
    ...overrides,
  });

  const m = () => manager as unknown as EntityManager;

  beforeEach(() => {
    manager = createScopedDbMocks().manager;
    deleteChain = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    manager.createQueryBuilder.mockReturnValue(deleteChain);
    manager.update.mockResolvedValue({ affected: 1 });
  });

  it("steps one slot for the one claimed occurrence, prunes overrides before it and stamps the posting", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule(),
      new Set(["2025-02-15"]),
    );

    expect(result).toEqual({
      nextDueDate: "2025-03-15",
      occurrencesRemaining: null,
      deactivated: false,
      slotsConsumed: 1,
    });
    expect(deleteChain.from).toHaveBeenCalledWith(ScheduledTransactionOverride);
    expect(deleteChain.where).toHaveBeenCalledWith(
      "scheduledTransactionId = :id",
      { id: "st-1" },
    );
    expect(deleteChain.andWhere).toHaveBeenCalledWith(
      "originalDate < :newNextDueDate",
      { newNextDueDate: "2025-03-15" },
    );
    expect(manager.update).toHaveBeenCalledWith(ScheduledTransaction, "st-1", {
      lastPostedDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      nextDueDate: "2025-03-15",
    });
    // An unbounded schedule has no count to decrement and nothing to deactivate.
    const written = manager.update.mock.calls[0][2];
    expect(written).not.toHaveProperty("occurrencesRemaining");
    expect(written).not.toHaveProperty("isActive");
  });

  it("leaves last_posted_date alone when asked not to stamp it (a skip posts nothing)", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule(),
      new Set(["2025-02-15"]),
      { stampLastPosted: false },
    );

    expect(result.nextDueDate).toBe("2025-03-15");
    expect(manager.update).toHaveBeenCalledWith(ScheduledTransaction, "st-1", {
      nextDueDate: "2025-03-15",
    });
    expect(manager.update.mock.calls[0][2]).not.toHaveProperty(
      "lastPostedDate",
    );
  });

  it("stamps last_posted_date when the option is explicitly true", async () => {
    await advanceScheduleCursor(m(), schedule(), new Set(["2025-02-15"]), {
      stampLastPosted: true,
    });

    expect(manager.update.mock.calls[0][2]).toHaveProperty("lastPostedDate");
  });

  it("returns to the start date's day after a short month (issue #1857)", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ nextDueDate: "2027-02-28", startDate: "2027-01-31" }),
      new Set(["2027-02-28"]),
    );
    expect(result.nextDueDate).toBe("2027-03-31");
  });

  it("keeps a day the user moved to, not the start date's (issue #1857)", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ nextDueDate: "2027-02-15", startDate: "2027-01-01" }),
      new Set(["2027-02-15"]),
    );
    expect(result.nextDueDate).toBe("2027-03-15");
  });

  it("keeps the previous day when the schedule carries no start date", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ nextDueDate: "2027-02-28" }),
      new Set(["2027-02-28"]),
    );
    expect(result.nextDueDate).toBe("2027-03-28");
  });

  it("steps past every consecutive claimed slot, consuming an occurrence for each", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ occurrencesRemaining: 5 }),
      new Set(["2025-02-15", "2025-03-15", "2025-04-15"]),
    );

    expect(result).toEqual({
      nextDueDate: "2025-05-15",
      occurrencesRemaining: 2,
      deactivated: false,
      slotsConsumed: 3,
    });
    expect(deleteChain.andWhere).toHaveBeenCalledWith(
      "originalDate < :newNextDueDate",
      { newNextDueDate: "2025-05-15" },
    );
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      "st-1",
      expect.objectContaining({
        nextDueDate: "2025-05-15",
        occurrencesRemaining: 2,
      }),
    );
  });

  it("stops at the first unclaimed slot: a claim after a gap leaves the earlier occurrence due", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule(),
      new Set(["2025-02-15", "2025-04-15"]),
    );
    expect(result.nextDueDate).toBe("2025-03-15");
    expect(result.slotsConsumed).toBe(1);
  });

  it("decrements the remaining count and deactivates at zero", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ occurrencesRemaining: 1 }),
      new Set(["2025-02-15"]),
    );
    expect(result).toEqual({
      nextDueDate: "2025-03-15",
      occurrencesRemaining: 0,
      deactivated: true,
      slotsConsumed: 1,
    });
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      "st-1",
      expect.objectContaining({ occurrencesRemaining: 0, isActive: false }),
    );
  });

  it("never drives the remaining count below zero when more slots were claimed than remained", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ occurrencesRemaining: 1 }),
      new Set(["2025-02-15", "2025-03-15"]),
    );
    expect(result.occurrencesRemaining).toBe(0);
    expect(result.deactivated).toBe(true);
  });

  it("leaves a count already at zero alone", async () => {
    await advanceScheduleCursor(
      m(),
      schedule({ occurrencesRemaining: 0 }),
      new Set(["2025-02-15"]),
    );
    const written = manager.update.mock.calls[0][2];
    expect(written).not.toHaveProperty("occurrencesRemaining");
    expect(written).not.toHaveProperty("isActive");
  });

  it("deactivates a schedule whose next slot falls past its end date", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ endDate: "2025-03-01" }),
      new Set(["2025-02-15"]),
    );
    expect(result.deactivated).toBe(true);
    expect(manager.update).toHaveBeenCalledWith(
      ScheduledTransaction,
      "st-1",
      expect.objectContaining({ nextDueDate: "2025-03-15", isActive: false }),
    );
  });

  it.each([["ONCE"], ["FORTNIGHTLY"]])(
    "refuses a cadence that does not advance (%s) instead of looping, and writes nothing",
    async (frequency) => {
      // `calculateNextDueDate` returns its input for ONCE and for a string the
      // column can hold but the type does not name; the claimed slot is always
      // in the set, so without the refusal the loop would never exit.
      await expect(
        advanceScheduleCursor(
          m(),
          schedule({
            frequency: frequency as ScheduledTransaction["frequency"],
          }),
          new Set(["2025-02-15"]),
        ),
      ).rejects.toThrow(/does not advance 2025-02-15/);
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    },
  );

  it("steps a CUSTOM schedule by its rule, past a claimed slot", async () => {
    // Monday/Wednesday/Friday, started Monday 2025-02-10: from Friday the
    // 14th, Monday the 17th is claimed, so the cursor lands on Wednesday.
    const result = await advanceScheduleCursor(
      m(),
      schedule({
        frequency: "CUSTOM",
        nextDueDate: "2025-02-14",
        startDate: "2025-02-10",
        customRecurrence: {
          unit: "WEEK",
          interval: 1,
          weekdays: [1, 3, 5],
          weekStartsOn: 1,
        },
      }),
      new Set(["2025-02-14", "2025-02-17"]),
    );
    expect(result.nextDueDate).toBe("2025-02-19");
    expect(result.slotsConsumed).toBe(2);
  });

  it("keeps a schedule active when the next slot is on or before its end date", async () => {
    const result = await advanceScheduleCursor(
      m(),
      schedule({ endDate: "2025-03-15" }),
      new Set(["2025-02-15"]),
    );
    expect(result.deactivated).toBe(false);
  });
});

describe("rewindScheduleCursor", () => {
  let manager: Record<string, jest.Mock>;
  let updateChain: Record<string, jest.Mock>;
  let insertChain: Record<string, jest.Mock>;

  const change = (prunedOverrides: PrunedScheduleOverride[] = []) => ({
    before: {
      nextDueDate: "2025-02-15",
      occurrencesRemaining: 5,
      isActive: true,
      lastPostedDate: null,
    },
    after: {
      nextDueDate: "2025-04-15",
      occurrencesRemaining: 3,
      isActive: true,
      lastPostedDate: "2025-02-16",
    },
    prunedOverrides,
  });

  const pruned = (id: string): PrunedScheduleOverride => ({
    id,
    scheduledTransactionId: "st-1",
    originalDate: "2025-02-15",
    overrideDate: "2025-02-20",
    amount: -99,
    categoryId: null,
    description: null,
    isSplit: null,
    splits: null,
    investmentQuantity: null,
    investmentPrice: null,
    investmentTotalAmount: null,
  });

  beforeEach(() => {
    manager = createScopedDbMocks().manager;
    updateChain = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    insertChain = {
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orIgnore: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
    };
    manager.createQueryBuilder
      .mockReturnValueOnce(updateChain)
      .mockReturnValueOnce(insertChain);
  });

  it("puts the cursor columns back, only while next_due_date still stands where the advance left it, owner-scoped", async () => {
    const rewound = await rewindScheduleCursor(
      manager as unknown as EntityManager,
      "st-1",
      "user-1",
      change(),
    );

    expect(rewound).toBe(true);
    expect(updateChain.update).toHaveBeenCalledWith(ScheduledTransaction);
    expect(updateChain.set).toHaveBeenCalledWith({
      nextDueDate: "2025-02-15",
      occurrencesRemaining: 5,
      isActive: true,
      lastPostedDate: null,
    });
    expect(updateChain.where).toHaveBeenCalledWith("id = :id", { id: "st-1" });
    expect(updateChain.andWhere).toHaveBeenCalledWith("userId = :userId", {
      userId: "user-1",
    });
    expect(updateChain.andWhere).toHaveBeenCalledWith("nextDueDate = :after", {
      after: "2025-04-15",
    });
    // Nothing was pruned, so nothing is re-inserted.
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

  it("re-inserts the overrides the advance pruned, ON CONFLICT DO NOTHING, on the schedule it rewound", async () => {
    await rewindScheduleCursor(
      manager as unknown as EntityManager,
      "st-1",
      "user-1",
      change([pruned("ovr-1"), pruned("ovr-2")]),
    );

    expect(insertChain.into).toHaveBeenCalledWith(ScheduledTransactionOverride);
    expect(insertChain.values).toHaveBeenCalledWith([
      pruned("ovr-1"),
      pruned("ovr-2"),
    ]);
    expect(insertChain.orIgnore).toHaveBeenCalledTimes(1);
  });

  it("leaves a cursor the person has moved since as they set it, and re-inserts nothing", async () => {
    updateChain.execute.mockResolvedValue({ affected: 0 });

    const rewound = await rewindScheduleCursor(
      manager as unknown as EntityManager,
      "st-1",
      "user-1",
      change([pruned("ovr-1")]),
    );

    expect(rewound).toBe(false);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });
});

describe("claimedSlotsFrom", () => {
  it("returns the YYYY-MM-DD slot of every claim on or after the date, parameterized", async () => {
    const manager = createScopedDbMocks().manager;
    manager.query.mockResolvedValue([{ d: "2025-02-15" }, { d: "2025-04-15" }]);

    const slots = await claimedSlotsFrom(
      manager as unknown as EntityManager,
      "st-1",
      "2025-02-15",
    );

    expect(slots).toEqual(new Set(["2025-02-15", "2025-04-15"]));
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toContain("TO_CHAR(original_due_date, 'YYYY-MM-DD')");
    expect(sql).toContain("scheduled_transaction_id = $1");
    expect(sql).toContain("original_due_date >= $2");
    expect(params).toEqual(["st-1", "2025-02-15"]);
  });

  it("reads the driver's [rows, count] tuple as well as bare rows", async () => {
    const manager = createScopedDbMocks().manager;
    manager.query.mockResolvedValue([[{ d: "2025-03-15" }], 1]);

    const slots = await claimedSlotsFrom(
      manager as unknown as EntityManager,
      "st-1",
      "2025-03-15",
    );

    expect(slots).toEqual(new Set(["2025-03-15"]));
  });

  it("is an empty set when nothing is claimed", async () => {
    const manager = createScopedDbMocks().manager;
    manager.query.mockResolvedValue([]);

    expect(
      await claimedSlotsFrom(
        manager as unknown as EntityManager,
        "st-1",
        "2025-03-15",
      ),
    ).toEqual(new Set());
  });
});
