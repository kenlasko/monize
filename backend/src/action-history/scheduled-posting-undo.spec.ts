import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { ActionHistory } from "./entities/action-history.entity";
import {
  assertScheduledPostingRedoable,
  undoScheduledPosting,
} from "./scheduled-posting-undo";
import { ScheduledPostingSnapshot } from "../scheduled-transactions/scheduled-posting-history";
import * as cursor from "../scheduled-transactions/schedule-cursor";
import * as postingHistory from "../scheduled-transactions/scheduled-posting-history";

const USER = "user-1";
const SCHEDULE = "sched-1";

const cursorChange: cursor.ScheduleCursorChange = {
  before: {
    nextDueDate: "2025-01-15",
    occurrencesRemaining: null,
    isActive: true,
    lastPostedDate: null,
  },
  after: {
    nextDueDate: "2025-02-15",
    occurrencesRemaining: null,
    isActive: true,
    lastPostedDate: "2025-01-15",
  },
  prunedOverrides: [],
};

function actionOf(snapshot: Partial<ScheduledPostingSnapshot> | null) {
  return {
    id: "history-1",
    userId: USER,
    entityType: "scheduled_posting",
    action: "post",
    afterData: snapshot,
  } as unknown as ActionHistory;
}

/**
 * A manager whose raw queries answer the schedule lock and the later-claim
 * read from the given rows, and record every statement in order.
 */
function managerWith({
  scheduleExists = true,
  laterClaims = [] as { d: string }[],
  // Where the posting left the cursor, unless a test moves it.
  nextDueDate = "2025-02-15",
  autoPost = false,
} = {}) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    statements.push(sql);
    if (
      sql.includes("FROM scheduled_transactions") &&
      sql.includes("FOR UPDATE")
    ) {
      return scheduleExists
        ? [
            {
              id: SCHEDULE,
              next_due_date: nextDueDate,
              auto_post: autoPost,
              amount_is_estimated: false,
            },
          ]
        : [];
    }
    if (sql.includes("stp.original_due_date > $2")) return laterClaims;
    return [[], 0];
  });
  return { manager: { query } as unknown as EntityManager, query, statements };
}

describe("undoScheduledPosting (issue #2165)", () => {
  let rewind: jest.SpyInstance;
  let restore: jest.SpyInstance;

  beforeEach(() => {
    rewind = jest.spyOn(cursor, "rewindScheduleCursor").mockResolvedValue(true);
    restore = jest
      .spyOn(postingHistory, "restoreRemovedSchedule")
      .mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  const recurring: ScheduledPostingSnapshot = {
    scheduledTransactionId: SCHEDULE,
    claimId: "claim-1",
    dueDate: "2025-01-15",
    money: { kind: "transaction", transactionId: "tx-1" },
    cursor: cursorChange,
  };

  it("removes the money, releases the claim and rewinds the cursor, in that order", async () => {
    const { manager, query, statements } = managerWith();
    const removeMoney = jest.fn(async () => {
      statements.push("removeMoney");
    });

    const result = await undoScheduledPosting(
      actionOf(recurring),
      manager,
      removeMoney,
    );

    expect(removeMoney).toHaveBeenCalledWith(recurring.money);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM scheduled_transaction_postings"),
      ["claim-1", USER],
    );
    expect(rewind).toHaveBeenCalledWith(manager, SCHEDULE, USER, cursorChange);
    expect(restore).not.toHaveBeenCalled();
    const lockAt = statements.findIndex((s) => s.includes("FOR UPDATE"));
    const moneyAt = statements.indexOf("removeMoney");
    const releaseAt = statements.findIndex((s) =>
      s.includes("DELETE FROM scheduled_transaction_postings"),
    );
    expect(lockAt).toBeLessThan(moneyAt);
    expect(moneyAt).toBeLessThan(releaseAt);
    expect(result).toEqual({ scheduleIds: [SCHEDULE], securityIds: [] });
  });

  it("puts an estimated schedule's amount back to its estimate before the posting", async () => {
    const { manager, query } = managerWith();

    await undoScheduledPosting(
      actionOf({ ...recurring, estimatedAmount: -87.5 }),
      manager,
      jest.fn(),
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("amount_is_estimated = true"),
      [-87.5, SCHEDULE, USER],
    );
  });

  it("refuses before any write while a later occurrence holds a claim", async () => {
    const { manager, query } = managerWith({
      laterClaims: [{ d: "2025-03-15" }],
    });
    const removeMoney = jest.fn();

    await expect(
      undoScheduledPosting(actionOf(recurring), manager, removeMoney),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "SCHEDULED_POSTING_UNDO_LATER_OCCURRENCE",
        dueDate: "2025-03-15",
      }),
    });
    expect(removeMoney).not.toHaveBeenCalled();
    expect(rewind).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("DELETE")),
    ).toBe(false);
  });

  it("does not count a later claim the posting itself found", async () => {
    const { manager } = managerWith({ laterClaims: [{ d: "2025-03-15" }] });
    const removeMoney = jest.fn();

    await undoScheduledPosting(
      actionOf({ ...recurring, laterClaimedSlots: ["2025-03-15"] }),
      manager,
      removeMoney,
    );

    expect(removeMoney).toHaveBeenCalled();
    expect(rewind).toHaveBeenCalled();
  });

  it("refuses before any write when the cursor has moved since the posting", async () => {
    const { manager, query } = managerWith({ nextDueDate: "2025-03-15" });
    const removeMoney = jest.fn();

    await expect(
      undoScheduledPosting(actionOf(recurring), manager, removeMoney),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: "SCHEDULED_POSTING_UNDO_CURSOR_MOVED",
      }),
    });
    expect(removeMoney).not.toHaveBeenCalled();
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("DELETE")),
    ).toBe(false);
  });

  describe("an occurrence the auto-post cron would post again is left skipped", () => {
    const released = (query: jest.Mock) =>
      query.mock.calls.some(([sql]) =>
        String(sql).includes("DELETE FROM scheduled_transaction_postings"),
      );

    it("removes the money and frees the claim, but does not rewind a due auto-post schedule", async () => {
      const { manager, query } = managerWith({ autoPost: true });
      const removeMoney = jest.fn();

      await undoScheduledPosting(actionOf(recurring), manager, removeMoney);

      expect(removeMoney).toHaveBeenCalled();
      expect(released(query)).toBe(true);
      expect(rewind).not.toHaveBeenCalled();
      // As a skip leaves it: the posting's stamp goes, the cursor stays.
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("SET last_posted_date = $1"),
        [null, SCHEDULE, USER, "2025-02-15"],
      );
    });

    it("rewinds an auto-post schedule posted ahead of its due date", async () => {
      const { manager } = managerWith({
        autoPost: true,
        nextDueDate: "2099-02-15",
      });
      const ahead = {
        ...recurring,
        dueDate: "2099-01-15",
        cursor: {
          ...cursorChange,
          before: { ...cursorChange.before, nextDueDate: "2099-01-15" },
          after: { ...cursorChange.after, nextDueDate: "2099-02-15" },
        },
      };

      await undoScheduledPosting(actionOf(ahead), manager, jest.fn());

      expect(rewind).toHaveBeenCalled();
    });

    it("rewinds an auto-post occurrence whose override postpones it", async () => {
      const { manager } = managerWith({ autoPost: true });
      const postponed = {
        ...recurring,
        cursor: {
          ...cursorChange,
          prunedOverrides: [
            {
              originalDate: "2025-01-15",
              overrideDate: "2099-01-01",
            } as cursor.PrunedScheduleOverride,
          ],
        },
      };

      await undoScheduledPosting(actionOf(postponed), manager, jest.fn());

      expect(rewind).toHaveBeenCalled();
    });

    it("does not bring back a due one-time auto-post bill", async () => {
      const { manager, query } = managerWith({ scheduleExists: false });
      const removedSchedule = {
        schedule: {
          id: SCHEDULE,
          auto_post: true,
          is_active: true,
          amount_is_estimated: false,
          next_due_date: "2025-01-15",
        },
        splits: [],
        splitTags: [],
        overrides: [],
        payrollRules: [],
        payrollRulePeriods: [],
        linkedAccountIds: [],
      };

      await undoScheduledPosting(
        actionOf({ ...recurring, cursor: undefined, removedSchedule }),
        manager,
        jest.fn(),
      );

      expect(restore).not.toHaveBeenCalled();
      expect(released(query)).toBe(true);
    });

    it("brings back a one-time auto-post bill an override postpones", async () => {
      const { manager } = managerWith({ scheduleExists: false });
      const removedSchedule = {
        schedule: {
          id: SCHEDULE,
          auto_post: true,
          is_active: true,
          amount_is_estimated: false,
          next_due_date: "2025-01-15",
        },
        splits: [],
        splitTags: [],
        overrides: [
          { original_date: "2025-01-15", override_date: "2099-01-01" },
        ],
        payrollRules: [],
        payrollRulePeriods: [],
        linkedAccountIds: [],
      };

      await undoScheduledPosting(
        actionOf({ ...recurring, cursor: undefined, removedSchedule }),
        manager,
        jest.fn(),
      );

      expect(restore).toHaveBeenCalled();
    });
  });

  it("re-inserts a one-time schedule the posting deleted", async () => {
    const { manager } = managerWith({ scheduleExists: false });
    const removedSchedule = {
      schedule: { id: SCHEDULE },
      splits: [],
      splitTags: [],
      overrides: [],
      payrollRules: [],
      payrollRulePeriods: [],
      linkedAccountIds: [],
    };

    await undoScheduledPosting(
      actionOf({ ...recurring, cursor: undefined, removedSchedule }),
      manager,
      jest.fn(),
    );

    expect(restore).toHaveBeenCalledWith(manager, USER, removedSchedule);
    expect(rewind).not.toHaveBeenCalled();
  });

  it("leaves a recurring schedule deleted since alone, after removing the money", async () => {
    const { manager, query } = managerWith({ scheduleExists: false });
    const removeMoney = jest.fn();

    await undoScheduledPosting(actionOf(recurring), manager, removeMoney);

    expect(removeMoney).toHaveBeenCalled();
    expect(rewind).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    // No later-claim read on a schedule that is not there.
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("stp.original_due_date > $2"),
      ),
    ).toBe(false);
  });

  it("does not re-insert a one-time schedule that exists again", async () => {
    const { manager } = managerWith({ scheduleExists: true });

    await undoScheduledPosting(
      actionOf({
        ...recurring,
        cursor: undefined,
        removedSchedule: {
          schedule: { id: SCHEDULE },
          splits: [],
          splitTags: [],
          overrides: [],
          payrollRules: [],
          payrollRulePeriods: [],
          linkedAccountIds: [],
        },
      }),
      manager,
      jest.fn(),
    );

    expect(restore).not.toHaveBeenCalled();
  });

  it("names an investment posting's security for the after-commit reprice", async () => {
    const { manager } = managerWith();

    const result = await undoScheduledPosting(
      actionOf({
        ...recurring,
        money: {
          kind: "investment",
          investmentTransactionId: "inv-1",
          securityId: "sec-1",
        },
      }),
      manager,
      jest.fn(),
    );

    expect(result.securityIds).toEqual(["sec-1"]);
  });

  it("names no security for an investment posting without one", async () => {
    const { manager } = managerWith();

    const result = await undoScheduledPosting(
      actionOf({
        ...recurring,
        money: {
          kind: "investment",
          investmentTransactionId: "inv-1",
          securityId: null,
        },
      }),
      manager,
      jest.fn(),
    );

    expect(result.securityIds).toEqual([]);
  });

  it("does nothing for an entry without a snapshot", async () => {
    const { manager, query } = managerWith();
    const removeMoney = jest.fn();

    await expect(
      undoScheduledPosting(actionOf(null), manager, removeMoney),
    ).resolves.toEqual({ scheduleIds: [], securityIds: [] });
    await expect(
      undoScheduledPosting(
        actionOf({ scheduledTransactionId: SCHEDULE }),
        manager,
        removeMoney,
      ),
    ).resolves.toEqual({ scheduleIds: [], securityIds: [] });
    expect(query).not.toHaveBeenCalled();
    expect(removeMoney).not.toHaveBeenCalled();
  });
});

describe("assertScheduledPostingRedoable", () => {
  it("always refuses: posting again is post()'s job", () => {
    expect(() => assertScheduledPostingRedoable()).toThrow(ConflictException);
    try {
      assertScheduledPostingRedoable();
    } catch (error) {
      expect((error as ConflictException).getResponse()).toMatchObject({
        errorCode: "SCHEDULED_POSTING_REDO",
      });
    }
  });
});
