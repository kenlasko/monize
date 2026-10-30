import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import { SETTLE_LOAN_INSTALLMENT } from "../transaction-rules/rule-action.types";
import { RuleConditionNode } from "../transaction-rules/rule-condition.types";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  assertLoanSourceAccount,
  reassignLoanSourceAccount,
  replaceAccountLeaves,
} from "./loan-source-account";

const USER = "user-1";
const LOAN = "loan-1";
const OLD = "chequing-old";
const NEW = "chequing-new";

const settleAction = (loanAccountId: string) => ({
  type: SETTLE_LOAN_INSTALLMENT,
  loanAccountId,
  dueDateWindow: { daysBefore: 3, daysAfter: 3 },
  excess: "overpayment",
  shortfall: "skip",
});

const rule = (
  id: string,
  condition: RuleConditionNode,
  loanAccountId = LOAN,
): TransactionRule =>
  ({
    id,
    userId: USER,
    condition,
    actions: [settleAction(loanAccountId)],
    revision: 1,
  }) as unknown as TransactionRule;

describe("loan source account", () => {
  let manager: Record<string, jest.Mock>;
  const m = () => manager as unknown as EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ manager } = createScopedDbMocks([]));
    manager.findOne = jest.fn();
    manager.find = jest.fn().mockResolvedValue([]);
    manager.update = jest.fn().mockResolvedValue({ affected: 1 });
    manager.query = jest.fn().mockResolvedValue([]);
  });

  describe("assertLoanSourceAccount", () => {
    it("accepts an open account the caller owns", async () => {
      manager.findOne.mockResolvedValue({
        id: NEW,
        isClosed: false,
        currencyCode: "CAD",
      });
      await expect(
        assertLoanSourceAccount(m(), USER, LOAN, NEW, "CAD"),
      ).resolves.toBeUndefined();
      expect(manager.findOne).toHaveBeenCalledWith(Account, {
        where: { id: NEW, userId: USER },
      });
    });

    it.each([
      ["not owned", null],
      ["closed", { id: NEW, isClosed: true }],
    ])("refuses an account that is %s", async (_label, row) => {
      manager.findOne.mockResolvedValue(row);
      await expect(
        assertLoanSourceAccount(m(), USER, LOAN, NEW, "CAD"),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses an account in another currency than the loan", async () => {
      manager.findOne.mockResolvedValue({
        id: NEW,
        isClosed: false,
        currencyCode: "EUR",
      });
      await expect(
        assertLoanSourceAccount(m(), USER, LOAN, NEW, "CAD"),
      ).rejects.toThrow(BadRequestException);
    });

    it("refuses the loan itself without reading it", async () => {
      await expect(
        assertLoanSourceAccount(m(), USER, LOAN, LOAN, "CAD"),
      ).rejects.toThrow(BadRequestException);
      expect(manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe("reassignLoanSourceAccount", () => {
    it("moves the linked schedule to the new account under its row lock", async () => {
      manager.findOne.mockResolvedValue({ id: "sched-1", accountId: OLD });
      await reassignLoanSourceAccount(
        m(),
        USER,
        { id: LOAN, scheduledTransactionId: "sched-1" },
        OLD,
        NEW,
      );
      expect(manager.findOne).toHaveBeenCalledWith(ScheduledTransaction, {
        where: { id: "sched-1", userId: USER },
        lock: { mode: "pessimistic_write" },
      });
      expect(manager.update).toHaveBeenCalledWith(
        ScheduledTransaction,
        { id: "sched-1", userId: USER },
        { accountId: NEW },
      );
    });

    it("rewrites the source leaf of every rule settling this loan and bumps its revision", async () => {
      manager.find.mockResolvedValue([
        rule("matching", {
          all: [
            { field: "accountId", op: "eq", value: OLD },
            { field: "payeeText", op: "matches", value: "BANK*" },
          ],
        }),
        rule(
          "other-loan",
          {
            all: [{ field: "accountId", op: "eq", value: OLD }],
          },
          "loan-2",
        ),
        rule("other-source", {
          all: [{ field: "accountId", op: "eq", value: "savings" }],
        }),
      ]);
      await reassignLoanSourceAccount(
        m(),
        USER,
        { id: LOAN, scheduledTransactionId: null },
        OLD,
        NEW,
      );
      // The rule list lock is taken before the rules are read.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("pg_advisory_xact_lock"),
        expect.arrayContaining([USER]),
      );
      const ruleUpdates = manager.update.mock.calls.filter(
        ([entity]) => entity === TransactionRule,
      );
      expect(ruleUpdates).toHaveLength(1);
      const [, where, patch] = ruleUpdates[0];
      expect(where).toEqual({ id: "matching", userId: USER });
      expect(patch.condition).toEqual({
        all: [
          { field: "accountId", op: "eq", value: NEW },
          { field: "payeeText", op: "matches", value: "BANK*" },
        ],
      });
      expect(patch.revision()).toBe("revision + 1");
    });

    it("leaves the rules alone when the loan had no previous source", async () => {
      await reassignLoanSourceAccount(
        m(),
        USER,
        { id: LOAN, scheduledTransactionId: null },
        null,
        NEW,
      );
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe("replaceAccountLeaves", () => {
    it("replaces nested and list values and de-duplicates the list", () => {
      const condition: RuleConditionNode = {
        any: [
          { field: "accountId", op: "in", value: [OLD, NEW, "x"] },
          { all: [{ field: "accountId", op: "eq", value: OLD }], not: true },
        ],
      };
      expect(replaceAccountLeaves(condition, OLD, NEW)).toEqual({
        any: [
          { field: "accountId", op: "in", value: [NEW, "x"] },
          { all: [{ field: "accountId", op: "eq", value: NEW }], not: true },
        ],
      });
    });

    it("returns the same object when no leaf names the old account", () => {
      const condition: RuleConditionNode = {
        all: [
          { field: "accountId", op: "eq", value: "x" },
          { field: "payeeText", op: "eq", value: OLD },
        ],
      };
      expect(replaceAccountLeaves(condition, OLD, NEW)).toBe(condition);
    });
  });
});
