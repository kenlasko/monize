import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withUserContext } from "@/common/db/with-context";
import { todayYMD } from "@/common/date-utils";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import {
  ScheduledAmountEstimateService,
  estimatedAmountFor,
} from "@/scheduled-transactions/scheduled-amount-estimate.service";
import { addMonthsClamped } from "@/common/recurrence";
import { addDaysYMD } from "@/common/date-utils";
import { computeStatementCycle } from "@/accounts/statement-cycle.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * The history read behind an estimated schedule (issue #2096,
 * docs/specs/scheduled-amount-estimate.md section 3) against real PostgreSQL:
 * which rows the one statement counts, and that the list read and the
 * occurrence expansion price the schedule from it rather than from its
 * stored snapshot.
 */
describe("Scheduled amount estimate (integration)", () => {
  jest.setTimeout(60000);

  let module: TestingModule;
  let db: DataSource;
  let estimates: ScheduledAmountEstimateService;
  let scheduled: ScheduledTransactionsService;
  let userId: string;
  let accountId: string;
  let otherAccountId: string;
  let payeeId: string;
  let categoryId: string;
  let otherCategoryId: string;

  const today = todayYMD();
  const monthsAgo = (n: number) => addMonthsClamped(today, -n);

  beforeAll(async () => {
    module = await createIntegrationModule([ScheduledTransactionsModule]);
    db = module.get(DataSource);
    estimates = module.get(ScheduledAmountEstimateService);
    scheduled = module.get(ScheduledTransactionsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "payees",
      "categories",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId, { name: "Chequing" })).id;
    otherAccountId = (await createTestAccount(db, userId, { name: "Visa" })).id;
    categoryId = (await createTestCategory(db, userId, { name: "Heating" })).id;
    otherCategoryId = (
      await createTestCategory(db, userId, { name: "Groceries" })
    ).id;
    payeeId = (await createTestPayee(db, userId, { name: "Gas Co" })).id;
  });

  const insertTransaction = async (
    date: string,
    amount: number,
    columns: Record<string, unknown> = {},
  ): Promise<string> => {
    const values = {
      account_id: accountId,
      payee_id: payeeId,
      category_id: categoryId,
      ...columns,
    };
    const keys = Object.keys(values);
    const [{ id }] = await db.query(
      `INSERT INTO transactions (user_id, transaction_date, amount, currency_code
         ${keys.map((k) => `, ${k}`).join("")})
       VALUES ($1, $2, $3, 'USD' ${keys.map((_k, i) => `, $${i + 4}`).join("")})
       RETURNING id`,
      [userId, date, amount, ...Object.values(values)],
    );
    return id;
  };

  const basis = () => ({ payeeId, categoryId, currencyCode: "USD" });

  it("counts plain rows and split lines on the category, and nothing else", async () => {
    // Counted: two plain payments in two accounts, and a split's heating line.
    await insertTransaction(monthsAgo(1), -100);
    await insertTransaction(monthsAgo(2), -110, { account_id: otherAccountId });
    const split = await insertTransaction(monthsAgo(3), -150, {
      category_id: null,
      is_split: true,
    });
    await db.query(
      `INSERT INTO transaction_splits (transaction_id, kind, category_id, amount)
       VALUES ($1, 'category', $2, -120), ($1, 'category', $3, -30)`,
      [split, categoryId, otherCategoryId],
    );
    // Not counted: void, another category, a transfer, outside the window,
    // and a future-dated row.
    await insertTransaction(monthsAgo(1), -900, { status: "VOID" });
    await insertTransaction(monthsAgo(1), -900, {
      category_id: otherCategoryId,
    });
    await insertTransaction(monthsAgo(1), -900, { is_transfer: true });
    await insertTransaction(monthsAgo(30), -900);
    await insertTransaction(addMonthsClamped(today, 1), -900);

    const estimate = await withUserContext(userId, () =>
      estimates.estimateFor(userId, basis()),
    );

    expect(estimate.status).toBe("estimated");
    expect(
      estimate.profile?.payments.map((p) => p.amount).sort((a, b) => a - b),
    ).toEqual([-120, -110, -100]);
    // Not seasonal (one year), so every month is the newest three's mean.
    expect(estimatedAmountFor(estimate, addMonthsClamped(today, 1))).toBe(-110);
  });

  it("is no-history for a payee with no matching payment", async () => {
    await insertTransaction(monthsAgo(1), -100, {
      category_id: otherCategoryId,
    });
    const estimate = await withUserContext(userId, () =>
      estimates.estimateFor(userId, basis()),
    );
    expect(estimate.status).toBe("no-history");
  });

  it("prices the list read and every occurrence from the history, not the snapshot", async () => {
    await insertTransaction(monthsAgo(1), -80);
    await insertTransaction(monthsAgo(2), -90);
    await insertTransaction(monthsAgo(3), -100);
    const nextDue = addMonthsClamped(today, 1);
    const [{ id }] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date, payee_id,
         category_id, amount_is_estimated)
       VALUES ($1, $2, 'Heating', -999, 'USD', 'MONTHLY', $3, $3, $4, $5, true)
       RETURNING id`,
      [userId, accountId, nextDue, payeeId, categoryId],
    );

    const [row] = await withUserContext(userId, () =>
      scheduled.findAll(userId),
    );
    expect(row.id).toBe(id);
    expect(row.effectiveAmount).toBe(-90);
    expect(row.amountEstimate?.status).toBe("estimated");
    expect(row.amountEstimate?.paymentCount).toBe(3);

    const occurrences = await withUserContext(userId, () =>
      scheduled.findEffectiveOccurrences(userId, {
        through: addMonthsClamped(today, 3),
      }),
    );
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
    expect(occurrences.every((o) => o.amount === -90 && o.estimated)).toBe(
      true,
    );
  });

  describe("an estimated transfer (issue #2164)", () => {
    /** A transfer from chequing into the card, both legs linked. */
    const insertTransfer = async (
      date: string,
      amount: number,
      cardId: string,
      columns: Record<string, unknown> = {},
    ) => {
      const [{ id: from }] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
           currency_code, is_transfer, status)
         VALUES ($1, $2, $3, $4, 'USD', true, $5) RETURNING id`,
        [userId, accountId, date, -amount, columns.status ?? "UNRECONCILED"],
      );
      const [{ id: to }] = await db.query(
        `INSERT INTO transactions (user_id, account_id, transaction_date, amount,
           currency_code, is_transfer, status, linked_transaction_id)
         VALUES ($1, $2, $3, $4, 'USD', true, $5, $6) RETURNING id`,
        [userId, cardId, date, amount, columns.status ?? "UNRECONCILED", from],
      );
      await db.query(
        `UPDATE transactions SET linked_transaction_id = $1 WHERE id = $2`,
        [to, from],
      );
    };

    it("matches the transfers into the card and raises the next cycles to its ledger", async () => {
      const card = await createTestAccount(db, userId, {
        name: "Card",
        accountType: "CREDIT_CARD",
        openingBalance: 0,
        currentBalance: 0,
        statementSettlementDay: 5,
        statementDueDay: 26,
      } as never);
      const cycle = computeStatementCycle(5, null, today);
      const lastSettlement = cycle.lastSettlementDate;
      const following = computeStatementCycle(
        5,
        null,
        addDaysYMD(cycle.nextSettlementDate, 1),
      ).nextSettlementDate;

      // History: three payments of 2000 into the card, one void, one into
      // another account, all well before the closed statement.
      await insertTransfer(monthsAgo(4), 2000, card.id);
      await insertTransfer(monthsAgo(3), 2000, card.id);
      await insertTransfer(monthsAgo(2), 2000, card.id);
      await insertTransfer(monthsAgo(2), 9000, card.id, { status: "VOID" });
      await insertTransfer(monthsAgo(2), 9000, otherAccountId);
      // The card: 8700 charged before the close (2700 owed on the statement
      // once the 6000 paid in is counted), 2100 since.
      await insertTransaction(monthsAgo(5), -8700, { account_id: card.id });
      await insertTransaction(addDaysYMD(lastSettlement, 1), -2100, {
        account_id: card.id,
      });

      const estimate = await withUserContext(userId, () =>
        estimates.estimateFor(userId, {
          payeeId: null,
          categoryId: null,
          currencyCode: "USD",
          transfer: {
            accountId,
            transferAccountId: card.id,
            frequency: "MONTHLY",
            nextOccurrenceDueDate: cycle.nextSettlementDate,
          },
        }),
      );

      expect(estimate.status).toBe("estimated");
      expect(estimate.profile?.payments.map((p) => p.amount)).toEqual([
        -2000, -2000, -2000,
      ]);
      // The closed statement, what the card owes beyond it, then the baseline.
      expect(estimatedAmountFor(estimate, cycle.nextSettlementDate)).toBe(
        -2700,
      );
      expect(estimatedAmountFor(estimate, following)).toBe(-2100);
      expect(estimatedAmountFor(estimate, addMonthsClamped(following, 1))).toBe(
        -2000,
      );
    });

    it("raises the next occurrence of a transfer into an account with no statement days to what it owes", async () => {
      const line = await createTestAccount(db, userId, {
        name: "Line of credit",
        accountType: "LINE_OF_CREDIT",
        openingBalance: -2500,
        currentBalance: -2500,
      } as never);
      await insertTransfer(monthsAgo(3), 1000, line.id);
      await insertTransfer(monthsAgo(2), 1000, line.id);
      // Future-dated: not owed yet.
      await insertTransaction(addMonthsClamped(today, 1), -900, {
        account_id: line.id,
      });
      const next = addMonthsClamped(today, 1);

      const estimate = await withUserContext(userId, () =>
        estimates.estimateFor(userId, {
          payeeId: null,
          categoryId: null,
          currencyCode: "USD",
          transfer: {
            accountId,
            transferAccountId: line.id,
            frequency: "MONTHLY",
            nextOccurrenceDueDate: next,
          },
        }),
      );

      // -2500 opening, +2000 paid in: 500 owed, under the 1000 baseline.
      expect(estimatedAmountFor(estimate, next)).toBe(-1000);
      await insertTransaction(today, -1700, { account_id: line.id });
      const raised = await withUserContext(userId, () =>
        estimates.estimateFor(userId, {
          payeeId: null,
          categoryId: null,
          currencyCode: "USD",
          transfer: {
            accountId,
            transferAccountId: line.id,
            frequency: "MONTHLY",
            nextOccurrenceDueDate: next,
          },
        }),
      );
      expect(estimatedAmountFor(raised, next)).toBe(-2200);
      expect(estimatedAmountFor(raised, addMonthsClamped(next, 1))).toBe(-1000);
    });
  });
});
