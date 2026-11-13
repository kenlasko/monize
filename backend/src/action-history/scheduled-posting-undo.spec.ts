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
} = {}) {
  const statements: string[] = [];
  const query = jest.fn(async (sql: string) => {
    statements.push(sql);
    if (
      sql.includes("FROM scheduled_transactions") &&
      sql.includes("FOR UPDATE")
    ) {
      return scheduleExists ? [{ id: SCHEDULE }] : [];
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

  it("re-inserts a one-time schedule the posting deleted", async () => {
    const { manager } = managerWith({ scheduleExists: false });
    const removedSchedule = {
      schedule: { id: SCHEDULE },
      splits: [],
      splitTags: [],
      overrides: [],
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
