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
    it("reads every row the delete takes with it in one statement, as the database's own jsonb", async () => {
      const snapshot = {
        schedule: { id: SCHEDULE, name: "Trip" },
        splits: [{ id: "split-1" }],
        splitTags: [{ tag_id: "tag-1" }],
        overrides: [{ id: "o-1" }],
        payrollRules: [{ id: "rule-1" }],
        payrollRulePeriods: [{ id: "period-1" }],
        linkedAccountIds: ["loan-1"],
      };
      const query = jest.fn().mockResolvedValue([snapshot]);
      const m = { query } as unknown as EntityManager;

      await expect(snapshotRemovedSchedule(m, SCHEDULE)).resolves.toEqual(
        snapshot,
      );
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      for (const table of [
        "scheduled_transaction_splits",
        "scheduled_transaction_split_tags",
        "scheduled_transaction_overrides",
        "payroll_deduction_rules",
        "payroll_deduction_rule_periods",
        "accounts",
      ]) {
        expect(sql).toContain(`FROM ${table}`);
      }
      expect(params).toEqual([SCHEDULE]);
    });
  });

  describe("restoreRemovedSchedule", () => {
    const snapshot: RemovedScheduleSnapshot = {
      schedule: { id: SCHEDULE, user_id: "someone-else" },
      splits: [{ id: "split-1", scheduled_transaction_id: SCHEDULE }],
      splitTags: [{ scheduled_transaction_split_id: "split-1", tag_id: "t" }],
      overrides: [{ id: "o-1", scheduled_transaction_id: SCHEDULE }],
      payrollRules: [{ id: "rule-1", scheduled_transaction_id: SCHEDULE }],
      payrollRulePeriods: [{ id: "period-1", rule_id: "rule-1" }],
      linkedAccountIds: ["loan-1"],
    };
    const empty: RemovedScheduleSnapshot = {
      schedule: { id: SCHEDULE },
      splits: [],
      splitTags: [],
      overrides: [],
      payrollRules: [],
      payrollRulePeriods: [],
      linkedAccountIds: [],
    };

    /** The catalogue: every table has an id, a user and a parent column. */
    const CATALOGUE = ["id", "user_id", "scheduled_transaction_id", "rule_id"];
    const TABLES = [
      "scheduled_transactions",
      "scheduled_transaction_splits",
      "scheduled_transaction_split_tags",
      "scheduled_transaction_overrides",
      "payroll_deduction_rules",
      "payroll_deduction_rule_periods",
    ];
    const catalogued = (answer: (sql: string) => unknown) =>
      jest.fn(async (sql: string) =>
        sql.includes("information_schema.columns")
          ? TABLES.flatMap((table_name) =>
              CATALOGUE.map((column_name) => ({ table_name, column_name })),
            )
          : answer(sql),
      );
    const writes = (query: jest.Mock) =>
      (query.mock.calls as unknown as [string, unknown[]][]).filter(
        ([sql]) => !sql.includes("information_schema.columns"),
      );

    it("writes the schedule under the acting user, then each child under it", async () => {
      const query = catalogued((sql) =>
        sql.startsWith("INSERT INTO scheduled_transactions ")
          ? [{ id: SCHEDULE }]
          : [],
      );
      const m = { query } as unknown as EntityManager;

      await expect(restoreRemovedSchedule(m, USER, snapshot)).resolves.toBe(
        true,
      );

      const calls = writes(query);
      expect(calls).toHaveLength(7);
      // The columns the table has now that the snapshot carries, by name.
      expect(calls[0][0]).toContain(
        'INSERT INTO scheduled_transactions ("id", "user_id")',
      );
      expect(calls[0][0]).toContain('SELECT r."id", r."user_id"');
      expect(calls[0][0]).toContain("'user_id', $2::text");
      // A category, payee or transfer account deleted since is cleared.
      expect(calls[0][0]).toContain("FROM categories c");
      expect(calls[0][0]).toContain("FROM payees p");
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
      // A rule whose category is gone stays gone, as the cascade left it.
      expect(calls[4][0]).toContain(
        "JOIN categories c ON c.id = r.category_id",
      );
      expect(calls[5][0]).toContain(
        "INSERT INTO payroll_deduction_rule_periods",
      );
      expect(calls[6][0]).toContain("scheduled_transaction_id IS NULL");
      expect(calls[6][1]).toEqual([SCHEDULE, ["loan-1"], USER]);
    });

    it("writes nothing more when the schedule already exists", async () => {
      const query = catalogued(() => []);
      const m = { query } as unknown as EntityManager;

      await expect(restoreRemovedSchedule(m, USER, snapshot)).resolves.toBe(
        false,
      );
      expect(writes(query)).toHaveLength(1);
    });

    it("skips the child writes a schedule without children needs", async () => {
      const query = catalogued(() => [{ id: SCHEDULE }]);
      const m = { query } as unknown as EntityManager;

      await restoreRemovedSchedule(m, USER, empty);
      expect(writes(query)).toHaveLength(1);
    });

    it("refuses with a named reason when a row it needs has been deleted since", async () => {
      const m = {
        query: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("fk"), { driverError: { code: "23503" } }),
          ),
      } as unknown as EntityManager;

      await expect(
        restoreRemovedSchedule(m, USER, empty),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: "SCHEDULED_POSTING_UNDO_REFERENCE_GONE",
        }),
      });
    });

    it("rethrows any other database error", async () => {
      const boom = new Error("boom");
      const m = {
        query: jest.fn().mockRejectedValue(boom),
      } as unknown as EntityManager;

      await expect(restoreRemovedSchedule(m, USER, empty)).rejects.toBe(boom);
    });
  });
});
