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
});
