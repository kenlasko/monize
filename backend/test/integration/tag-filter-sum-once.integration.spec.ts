import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  Transaction,
  TransactionStatus,
} from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { SplitKind } from "@/transactions/entities/split-kind.enum";
import { withUserContext } from "@/common/db/with-context";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * A tag filter selects a line once (split-line-equivalence, rule 3). The
 * parent C (-160) carries T1; its groceries line (-60) carries T1 and T2; its
 * other line (-100) is a transfer. Joining the parent's tags and the line's
 * tags multiplied the groceries line once per line tag, so SUM counted it
 * twice. The register's filtered total and the analytics reads must agree.
 */
describe("a tag filter sums a line once (integration)", () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let analytics: TransactionAnalyticsService;
  let transactions: TransactionsService;

  let userId: string;
  let accountId: string;
  let savingsId: string;
  let t1: string;
  let t2: string;

  const START = "2026-03-01";
  const END = "2026-03-31";
  const DAY = "2026-03-10";

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);
    analytics = module.get(TransactionAnalyticsService);
    transactions = module.get(TransactionsService);
  });

  afterAll(async () => {
    await module.close();
  });

  const asUser = <T>(fn: () => Promise<T>): Promise<T> =>
    withUserContext(userId, fn);

  const makeTag = async (name: string): Promise<string> =>
    (
      await dataSource.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
        [userId, name],
      )
    )[0].id;

  const link = (table: string, column: string, id: string, tagId: string) =>
    dataSource.query(
      `INSERT INTO ${table} (${column}, tag_id) VALUES ($1, $2)`,
      [id, tagId],
    );

  const insertRow = (overrides: Partial<Transaction>): Promise<Transaction> =>
    dataSource.manager.save(
      dataSource.manager.create(Transaction, {
        userId,
        accountId,
        transactionDate: DAY,
        status: TransactionStatus.UNRECONCILED,
        isSplit: false,
        isTransfer: false,
        currencyCode: "USD",
        exchangeRate: 1,
        ...overrides,
      } as Partial<Transaction>),
    );

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "transaction_split_tags",
      "transaction_tags",
      "tags",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "user_preferences",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    accountId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        accountType: "CHEQUING",
        currencyCode: "USD",
      })
    ).id;
    savingsId = (
      await createTestAccount(dataSource, userId, {
        name: "Savings",
        accountType: "SAVINGS",
        currencyCode: "USD",
      })
    ).id;
    t1 = await makeTag("scope:home");
    t2 = await makeTag("other:x");

    const groceries = await createTestCategory(dataSource, userId, {
      name: "Groceries",
    });
    const parent = await insertRow({ amount: -160, isSplit: true });
    const line = await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -60,
        categoryId: groceries.id,
      }),
    );
    await dataSource.manager.save(
      dataSource.manager.create(TransactionSplit, {
        transactionId: parent.id,
        amount: -100,
        kind: SplitKind.TRANSFER,
        transferAccountId: savingsId,
      }),
    );
    await link("transaction_tags", "transaction_id", parent.id, t1);
    await link("transaction_split_tags", "transaction_split_id", line.id, t1);
    await link("transaction_split_tags", "transaction_split_id", line.id, t2);
  });

  const summary = (tagIds: string[]) =>
    asUser(() =>
      analytics.getSummary(
        userId,
        undefined,
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        tagIds,
      ),
    );

  const registerTotal = async (tagIds: string[]) =>
    (
      await asUser(() =>
        transactions.findAll(
          userId,
          undefined,
          START,
          END,
          undefined,
          undefined,
          1,
          50,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          tagIds,
        ),
      )
    ).startingBalance;

  it("counts the groceries line once under {T1}", async () => {
    expect((await summary([t1])).totalExpenses).toBe(60);
    // The register has no transfer arm here: the whole parent, once.
    expect(await registerTotal([t1])).toBe(-160);
  });

  it("counts it once under {T1, T2}", async () => {
    expect((await summary([t1, t2])).totalExpenses).toBe(60);
    expect(await registerTotal([t1, t2])).toBe(-160);
  });

  it("counts it once under {T2}, where only the line matches", async () => {
    expect((await summary([t2])).totalExpenses).toBe(60);
  });

  it("sums monthly totals once", async () => {
    const rows = await asUser(() =>
      analytics.getMonthlyTotals(
        userId,
        undefined,
        START,
        END,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [t1],
      ),
    );
    expect(rows.reduce((s, r) => s + (r.total ?? 0), 0)).toBe(-160);
  });

  it("counts a whole row with two selected tags once", async () => {
    const whole = await insertRow({ amount: -25 });
    await link("transaction_tags", "transaction_id", whole.id, t1);
    await link("transaction_tags", "transaction_id", whole.id, t2);
    expect((await summary([t1, t2])).totalExpenses).toBe(85);
    expect(await registerTotal([t1, t2])).toBe(-185);
  });

  it("does not inflate the tag-key breakdown combined with tagIds", async () => {
    const rows = await asUser(() =>
      analytics.getTransactionBreakdownByTagKey(userId, "scope", {
        startDate: START,
        endDate: END,
        tagIds: [t1],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("home");
    // Groceries (60) once plus the transfer line (100), not 60 twice.
    expect(rows[0].total).toBe(160);
  });
});
