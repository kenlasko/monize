import { BadRequestException, NotFoundException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The entry-point matrix of `docs/specs/transfer-categories.md` section 4.3
 * (INV-CATEGORY-001 FIT, INV-CATEGORY-002 ONE): scheduled transfers,
 * scheduled ordinary transactions, scheduled split lines, overrides and the
 * post, each with a Transfer, an Income or Expense category, and none. A
 * refusal leaves nothing written; a post that cannot write a line leaves the
 * occurrence due.
 */
describe("Category fit and one category per transfer: scheduled transactions (integration)", () => {
  jest.setTimeout(90000);

  /**
   * Rows whose behaviour a later step of PR 3 builds. Each runs as
   * `it.failing`; the step that builds a row removes it here. Shrink-only.
   */
  const NOT_YET_BUILT = new Set<string>([]);
  const row = (title: string, fn: () => Promise<void>) =>
    (NOT_YET_BUILT.has(title) ? it.failing : it)(title, fn);

  const DUE = "2026-03-15";

  let module: TestingModule;
  let db: DataSource;
  let scheduled: ScheduledTransactionsService;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let transferCat: string;
  let expenseCat: string;
  let feesCat: string;
  let strangerCat: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);
  const kinds: readonly [string, () => string | null][] = [
    ["a Transfer category", () => transferCat],
    ["an Expense category", () => expenseCat],
    ["no category", () => null],
  ];

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
    ]);
    db = module.get(DataSource);
    scheduled = module.get(ScheduledTransactionsService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_overrides",
      "scheduled_transaction_split_tags",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    const account = async (name: string) =>
      (
        await createTestAccount(db, userId, {
          name,
          openingBalance: 1000,
          currentBalance: 1000,
        })
      ).id;
    chequingId = await account("Chequing");
    savingsId = await account("Savings");
    const category = async (owner: string, name: string, type: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type, is_income)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [owner, name, type, type === "income"],
        )
      )[0].id as string;
    transferCat = await category(userId, "Savings contributions", "transfer");
    expenseCat = await category(userId, "Groceries", "expense");
    feesCat = await category(userId, "Fees", "expense");
    const stranger = (await createTestUserDirect(db)).id;
    strangerCat = await category(stranger, "Not yours", "expense");
  });

  const scheduleOf = async (id: string) =>
    (
      await db.query(
        `SELECT category_id, is_transfer, next_due_date::text AS due
           FROM scheduled_transactions WHERE id = $1`,
        [id],
      )
    )[0] as { category_id: string | null; is_transfer: boolean; due: string };
  const scheduleCount = async () =>
    (
      await db.query(
        `SELECT count(*)::int AS n FROM scheduled_transactions WHERE user_id = $1`,
        [userId],
      )
    )[0].n as number;
  const linesOf = async (id: string) =>
    (await db.query(
      `SELECT category_id, transfer_account_id FROM scheduled_transaction_splits
        WHERE scheduled_transaction_id = $1 ORDER BY amount`,
      [id],
    )) as { category_id: string | null; transfer_account_id: string | null }[];
  const overrideOf = async (id: string) =>
    (
      await db.query(
        `SELECT category_id, splits FROM scheduled_transaction_overrides WHERE id = $1`,
        [id],
      )
    )[0] as { category_id: string | null; splits: unknown };
  const postedRows = async () =>
    (await db.query(
      `SELECT id, account_id, category_id, is_transfer, is_split
         FROM transactions WHERE user_id = $1 ORDER BY amount`,
      [userId],
    )) as {
      id: string;
      account_id: string;
      category_id: string | null;
      is_transfer: boolean;
      is_split: boolean;
    }[];

  const base = {
    name: "Monthly",
    amount: -100,
    currencyCode: "USD",
    frequency: "MONTHLY",
    startDate: DUE,
    nextDueDate: DUE,
  };
  const createTransfer = (categoryId: string | null) =>
    asUser(() =>
      scheduled.create(userId, {
        ...base,
        accountId: chequingId,
        isTransfer: true,
        transferAccountId: savingsId,
        categoryId,
      } as never),
    );
  const createOrdinary = (categoryId: string | null) =>
    asUser(() =>
      scheduled.create(userId, {
        ...base,
        accountId: chequingId,
        categoryId,
      } as never),
    );
  const createSplit = (
    transferLine: string | null,
    categoryLine: string | null = expenseCat,
  ) =>
    asUser(() =>
      scheduled.create(userId, {
        ...base,
        accountId: chequingId,
        splits: [
          {
            amount: -60,
            transferAccountId: savingsId,
            categoryId: transferLine,
          },
          { amount: -40, categoryId: categoryLine },
        ],
      } as never),
    );
  const refusedWithNothingWritten = async (
    write: () => Promise<unknown>,
    stored: () => Promise<unknown>,
  ) => {
    const before = await stored();
    const schedules = await scheduleCount();
    await expect(write()).rejects.toBeInstanceOf(BadRequestException);
    expect(await stored()).toEqual(before);
    expect(await scheduleCount()).toBe(schedules);
  };

  describe("schedule create and update", () => {
    for (const [label, pick] of kinds) {
      row(`scheduled transfer: create keeps ${label}`, async () => {
        const created = await createTransfer(pick());
        expect((await scheduleOf(created.id)).category_id).toBe(pick());
      });
    }

    row(
      "scheduled ordinary: create refuses a Transfer category, writing nothing",
      async () => {
        await refusedWithNothingWritten(
          () => createOrdinary(transferCat),
          async () => null,
        );
      },
    );

    row("scheduled ordinary: create writes an Expense category", async () => {
      const created = await createOrdinary(expenseCat);
      expect((await scheduleOf(created.id)).category_id).toBe(expenseCat);
    });

    row(
      "scheduled create: refuses a category that is not the person's",
      async () => {
        await expect(createOrdinary(strangerCat)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        await expect(createTransfer(strangerCat)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(await scheduleCount()).toBe(0);
      },
    );

    row(
      "scheduled ordinary: update refuses a Transfer category, writing nothing",
      async () => {
        const created = await createOrdinary(expenseCat);
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              scheduled.update(userId, created.id, { categoryId: transferCat }),
            ),
          async () => (await scheduleOf(created.id)).category_id,
        );
      },
    );

    row("scheduled transfer: update writes a Transfer category", async () => {
      const created = await createTransfer(expenseCat);
      await asUser(() =>
        scheduled.update(userId, created.id, { categoryId: transferCat }),
      );
      expect((await scheduleOf(created.id)).category_id).toBe(transferCat);
    });

    row(
      "switch to ordinary: clears a Transfer category on the schedule and its overrides",
      async () => {
        const created = await createTransfer(transferCat);
        const override = await asUser(() =>
          scheduled.createOverride(userId, created.id, {
            originalDate: DUE,
            overrideDate: DUE,
            categoryId: transferCat,
          } as never),
        );
        await asUser(() =>
          scheduled.update(userId, created.id, {
            isTransfer: false,
            transferAccountId: null,
          } as never),
        );
        expect(await scheduleOf(created.id)).toMatchObject({
          category_id: null,
          is_transfer: false,
        });
        expect((await overrideOf(override.id)).category_id).toBeNull();
      },
    );

    row(
      "switch to ordinary: clears a Transfer category from an override's split category lines only, and leaves another override untouched",
      async () => {
        const created = await createTransfer(expenseCat);
        // Written as a previous release could have left them: a category
        // line holding a Transfer category, beside a transfer line holding one.
        const [held] = await db.query(
          `INSERT INTO scheduled_transaction_overrides
             (scheduled_transaction_id, original_date, override_date, is_split, splits)
           VALUES ($1, $2, $2, true, $3::jsonb) RETURNING id`,
          [
            created.id,
            DUE,
            JSON.stringify([
              { categoryId: transferCat, transferAccountId: null, amount: -40 },
              {
                categoryId: transferCat,
                transferAccountId: savingsId,
                amount: -60,
              },
            ]),
          ],
        );
        const [untouched] = await db.query(
          `INSERT INTO scheduled_transaction_overrides
             (scheduled_transaction_id, original_date, override_date, is_split, splits)
           VALUES ($1, '2026-05-01', '2026-05-01', true, $2::jsonb)
           RETURNING id, updated_at`,
          [
            created.id,
            JSON.stringify([
              { categoryId: expenseCat, transferAccountId: null, amount: -100 },
            ]),
          ],
        );
        await asUser(() =>
          scheduled.update(userId, created.id, {
            isTransfer: false,
            transferAccountId: null,
          } as never),
        );
        const lines = (await overrideOf(held.id)).splits as {
          categoryId: string | null;
        }[];
        expect(lines.map((line) => line.categoryId)).toEqual([
          null,
          transferCat,
        ]);
        const [after] = await db.query(
          `SELECT updated_at FROM scheduled_transaction_overrides WHERE id = $1`,
          [untouched.id],
        );
        expect(after.updated_at).toEqual(untouched.updated_at);
      },
    );

    row("switch to ordinary: keeps an Expense category", async () => {
      const created = await createTransfer(expenseCat);
      await asUser(() =>
        scheduled.update(userId, created.id, {
          isTransfer: false,
          transferAccountId: null,
        } as never),
      );
      expect((await scheduleOf(created.id)).category_id).toBe(expenseCat);
    });

    row(
      "switch to ordinary: refuses a request naming a Transfer category",
      async () => {
        const created = await createTransfer(transferCat);
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              scheduled.update(userId, created.id, {
                isTransfer: false,
                transferAccountId: null,
                categoryId: transferCat,
              } as never),
            ),
          async () => scheduleOf(created.id),
        );
      },
    );
  });

  describe("scheduled split lines", () => {
    row(
      "scheduled split: a transfer line keeps a Transfer category",
      async () => {
        const created = await createSplit(transferCat);
        const [transfer, category] = await linesOf(created.id);
        expect(transfer).toMatchObject({
          transfer_account_id: savingsId,
          category_id: transferCat,
        });
        expect(category.category_id).toBe(expenseCat);
      },
    );

    row(
      "scheduled split: a transfer line keeps an Expense category",
      async () => {
        const created = await createSplit(feesCat);
        const [transfer] = await linesOf(created.id);
        expect(transfer.category_id).toBe(feesCat);
      },
    );

    row(
      "scheduled split: a category line refuses a Transfer category, writing nothing",
      async () => {
        await refusedWithNothingWritten(
          () => createSplit(null, transferCat),
          async () => null,
        );
      },
    );
  });

  describe("overrides", () => {
    const override = (scheduleId: string, dto: Record<string, unknown>) =>
      asUser(() =>
        scheduled.createOverride(userId, scheduleId, {
          originalDate: DUE,
          overrideDate: DUE,
          ...dto,
        } as never),
      );

    row(
      "override: a scheduled transfer's override stores a Transfer category",
      async () => {
        const created = await createTransfer(null);
        const saved = await override(created.id, { categoryId: transferCat });
        expect((await overrideOf(saved.id)).category_id).toBe(transferCat);
      },
    );

    row(
      "override: a scheduled ordinary transaction's override refuses a Transfer category",
      async () => {
        const created = await createOrdinary(expenseCat);
        await expect(
          override(created.id, { categoryId: transferCat }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(
          await db.query(`SELECT 1 FROM scheduled_transaction_overrides`),
        ).toEqual([]);
      },
    );

    row(
      "override: an update refuses a Transfer category on an ordinary schedule",
      async () => {
        const created = await createOrdinary(expenseCat);
        const saved = await override(created.id, { categoryId: feesCat });
        await expect(
          asUser(() =>
            scheduled.updateOverride(userId, created.id, saved.id, {
              categoryId: transferCat,
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect((await overrideOf(saved.id)).category_id).toBe(feesCat);
      },
    );

    row("override: a split line takes the category its kind fits", async () => {
      const created = await createSplit(null);
      const lines = (
        categoryLine: string | null,
        transferLine: string | null,
      ) => ({
        amount: -100,
        isSplit: true,
        splits: [
          {
            amount: -60,
            transferAccountId: savingsId,
            categoryId: transferLine,
          },
          { amount: -40, categoryId: categoryLine },
        ],
      });
      await expect(
        override(created.id, lines(transferCat, null)),
      ).rejects.toBeInstanceOf(BadRequestException);
      const saved = await override(created.id, lines(expenseCat, transferCat));
      const stored = (await overrideOf(saved.id)).splits as {
        categoryId: string | null;
      }[];
      expect(stored.map((line) => line.categoryId)).toEqual([
        transferCat,
        expenseCat,
      ]);
    });

    row("override: refuses a category that is not the person's", async () => {
      const created = await createTransfer(null);
      await expect(
        override(created.id, { categoryId: strangerCat }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("posting", () => {
    for (const [label, pick] of kinds) {
      row(
        `post: a scheduled transfer writes ${label} on both legs`,
        async () => {
          const created = await createTransfer(pick());
          await asUser(() => scheduled.post(userId, created.id));
          const legs = await postedRows();
          expect(legs).toHaveLength(2);
          expect(legs.map((leg) => leg.category_id)).toEqual([pick(), pick()]);
        },
      );
    }

    row(
      "post: a split's transfer line writes its category on the line and its linked row",
      async () => {
        const created = await createSplit(transferCat);
        await asUser(() => scheduled.post(userId, created.id));
        const rows = await postedRows();
        const parent = rows.find((r) => r.is_split)!;
        const linked = rows.find((r) => r.account_id === savingsId)!;
        expect(linked.category_id).toBe(transferCat);
        const [line] = await db.query(
          `SELECT category_id FROM transaction_splits
          WHERE transaction_id = $1 AND transfer_account_id IS NOT NULL`,
          [parent.id],
        );
        expect(line.category_id).toBe(transferCat);
      },
    );

    row(
      "post: a line that does not fit refuses the post, and the occurrence stays due",
      async () => {
        const created = await createSplit(null);
        // An override line only a previous-release pod could have stored.
        await db.query(
          `INSERT INTO scheduled_transaction_overrides
           (scheduled_transaction_id, original_date, override_date, amount, is_split, splits)
         VALUES ($1, $2, $2, -100, true, $3::jsonb)`,
          [
            created.id,
            DUE,
            JSON.stringify([
              { amount: -60, transferAccountId: savingsId, categoryId: null },
              { amount: -40, categoryId: transferCat },
            ]),
          ],
        );
        const posting = asUser(() => scheduled.post(userId, created.id));
        await expect(posting).rejects.toBeInstanceOf(BadRequestException);
        await expect(posting).rejects.toThrow(/Transfer category/);
        expect(await postedRows()).toEqual([]);
        expect((await scheduleOf(created.id)).due).toBe(DUE);
      },
    );
  });
});
