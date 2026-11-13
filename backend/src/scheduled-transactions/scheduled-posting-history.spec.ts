import { EntityManager } from "typeorm";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import {
  RemovedScheduleSnapshot,
  cursorBaseline,
  cursorChangeOf,
  restoreRemovedSchedule,
  snapshotRemovedSchedule,
} from "./scheduled-posting-history";
import { todayYMD } from "../common/date-utils";

const SCHEDULE = "sched-1";
const USER = "user-1";

function override(originalDate: string, id: string) {
  return {
    id,
    scheduledTransactionId: SCHEDULE,
    originalDate,
    overrideDate: originalDate,
    amount: -60,
    categoryId: null,
    description: null,
    isSplit: null,
    splits: null,
    investmentQuantity: null,
    investmentPrice: null,
    investmentTotalAmount: null,
  } as unknown as ScheduledTransactionOverride;
}

describe("scheduled posting history (issue #2165)", () => {
  describe("cursorBaseline / cursorChangeOf", () => {
    const schedule = {
      id: SCHEDULE,
      nextDueDate: "2025-01-15",
      occurrencesRemaining: 2,
      isActive: true,
      lastPostedDate: null,
    } as unknown as ScheduledTransaction;

    it("keeps the cursor before, and the overrides the posting removed", async () => {
      const held = [
        override("2025-01-15", "o-due"),
        override("2025-03-15", "o-later"),
      ];
      const find = jest.fn().mockResolvedValue(held);
      const m = {
        getRepository: jest.fn().mockReturnValue({ find }),
      } as unknown as EntityManager;

      const baseline = await cursorBaseline(m, schedule);
      expect(find).toHaveBeenCalledWith({
        where: { scheduledTransactionId: SCHEDULE },
      });

      const change = cursorChangeOf(baseline, {
        nextDueDate: "2025-02-15",
        occurrencesRemaining: 1,
        deactivated: false,
        slotsConsumed: 1,
      });

      expect(change.before).toEqual({
        nextDueDate: "2025-01-15",
        occurrencesRemaining: 2,
        isActive: true,
        lastPostedDate: null,
      });
      expect(change.after).toEqual({
        nextDueDate: "2025-02-15",
        occurrencesRemaining: 1,
        isActive: true,
        lastPostedDate: todayYMD(),
      });
      // The occurrence's own override went; the one after the new cursor stays.
      expect(change.prunedOverrides.map((o) => o.id)).toEqual(["o-due"]);
    });

    it("records a deactivating advance as inactive", () => {
      const change = cursorChangeOf(
        {
          before: {
            nextDueDate: "2025-01-15",
            occurrencesRemaining: 1,
            isActive: true,
            lastPostedDate: null,
          },
          held: [],
        },
        {
          nextDueDate: "2025-02-15",
          occurrencesRemaining: 0,
          deactivated: true,
          slotsConsumed: 1,
        },
      );
      expect(change.after.isActive).toBe(false);
      expect(change.prunedOverrides).toEqual([]);
    });
  });

  describe("snapshotRemovedSchedule", () => {
    it("reads every row the delete cascades over, as the database's own jsonb", async () => {
      const query = jest.fn(async (sql: string) => {
        if (sql.includes("FROM scheduled_transactions s")) {
          return [{ row: { id: SCHEDULE, name: "Trip" } }];
        }
        if (sql.includes("FROM scheduled_transaction_splits sp\n")) {
          return [{ row: { id: "split-1" } }];
        }
        if (sql.includes("scheduled_transaction_split_tags")) {
          return [{ row: { tag_id: "tag-1" } }];
        }
        return [{ row: { id: "o-1" } }];
      });
      const m = { query } as unknown as EntityManager;

      await expect(snapshotRemovedSchedule(m, SCHEDULE)).resolves.toEqual({
        schedule: { id: SCHEDULE, name: "Trip" },
        splits: [{ id: "split-1" }],
        splitTags: [{ tag_id: "tag-1" }],
        overrides: [{ id: "o-1" }],
      });
      for (const [, params] of query.mock.calls as unknown as [
        string,
        unknown[],
      ][]) {
        expect(params).toEqual([SCHEDULE]);
      }
    });
  });

  describe("restoreRemovedSchedule", () => {
    const snapshot: RemovedScheduleSnapshot = {
      schedule: { id: SCHEDULE, user_id: "someone-else" },
      splits: [{ id: "split-1", scheduled_transaction_id: SCHEDULE }],
      splitTags: [{ scheduled_transaction_split_id: "split-1", tag_id: "t" }],
      overrides: [{ id: "o-1", scheduled_transaction_id: SCHEDULE }],
    };

    it("writes the schedule under the acting user, then its children under it", async () => {
      const query = jest.fn(async (sql: string) =>
        sql.includes("INSERT INTO scheduled_transactions\n")
          ? [{ id: SCHEDULE }]
          : [],
      );
      const m = { query } as unknown as EntityManager;

      await expect(restoreRemovedSchedule(m, USER, snapshot)).resolves.toBe(
        true,
      );

      const calls = query.mock.calls as unknown as [string, unknown[]][];
      expect(calls[0][0]).toContain("jsonb_build_object('user_id', $2::text)");
      expect(calls[0][1]).toEqual([JSON.stringify(snapshot.schedule), USER]);
      expect(calls[1][0]).toContain("INSERT INTO scheduled_transaction_splits");
      expect(calls[1][1]).toEqual([JSON.stringify(snapshot.splits), SCHEDULE]);
      expect(calls[2][0]).toContain("JOIN tags g ON g.id = r.tag_id");
      expect(calls[2][1]).toEqual([
        JSON.stringify(snapshot.splitTags),
        SCHEDULE,
        USER,
      ]);
      expect(calls[3][0]).toContain(
        "INSERT INTO scheduled_transaction_overrides",
      );
    });

    it("writes nothing more when the schedule already exists", async () => {
      const query = jest.fn().mockResolvedValue([]);
      const m = { query } as unknown as EntityManager;

      await expect(restoreRemovedSchedule(m, USER, snapshot)).resolves.toBe(
        false,
      );
      expect(query).toHaveBeenCalledTimes(1);
    });

    it("skips the child inserts a schedule without children needs", async () => {
      const query = jest.fn().mockResolvedValue([{ id: SCHEDULE }]);
      const m = { query } as unknown as EntityManager;

      await restoreRemovedSchedule(m, USER, {
        schedule: { id: SCHEDULE },
        splits: [],
        splitTags: [],
        overrides: [],
      });
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});
