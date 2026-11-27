import { BadRequestException } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { CategoriesModule } from "@/categories/categories.module";
import { CategoriesService } from "@/categories/categories.service";
import { withUserContext } from "@/common/db/with-context";
import { TransactionConversionService } from "@/transactions/transaction-conversion.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The entry-point matrix of `docs/specs/transfer-categories.md` sections 4.1
 * and 4.2 (INV-CATEGORY-001 FIT, INV-CATEGORY-002 ONE): for every path that
 * writes a category onto a transaction, a split line or the row a split's
 * transfer line links, what each leg and line holds afterwards with a
 * Transfer category, an Income or Expense category, and none. A refusal
 * leaves nothing written.
 *
 * "Both legs" is checked on both legs. A path missing here is a finding.
 */
describe("Category fit and one category per transfer: transactions (integration)", () => {
  jest.setTimeout(90000);

  /**
   * Rows whose behaviour a later step of PR 3 builds
   * (`docs/future-plans/transfer-categories-tasks.md`). Each runs as
   * `it.failing`, so it fails the suite the moment it passes without being
   * taken off this list: the step that builds a row removes it here.
   * Shrink-only, and empty when PR 3 is done.
   */
  const NOT_YET_BUILT = new Set<string>([]);
  const row = (title: string, fn: () => Promise<void>) =>
    (NOT_YET_BUILT.has(title) ? it.failing : it)(title, fn);
  const EVERY_KIND: readonly [string, () => string | null][] = [
    ["a Transfer category", () => transferCat],
    ["an Expense category", () => expenseCat],
    ["no category", () => null],
  ];
  const A_CATEGORY = EVERY_KIND.slice(0, 2);
  const NOT_TRANSFER = EVERY_KIND.slice(1);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let conversion: TransactionConversionService;
  let categories: CategoriesService;
  let history: ActionHistoryService;

  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let brokerageId: string;
  /** Transfer: Savings contributions. */
  let transferCat: string;
  /** Expense: Groceries. */
  let expenseCat: string;
  /** Expense: Fees, a second Income or Expense category. */
  let feesCat: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      CategoriesModule,
    ]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    conversion = module.get(TransactionConversionService, { strict: false });
    categories = module.get(CategoriesService);
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "accounts",
      "payees",
      "categories",
      "monthly_account_balances",
      "users",
    ]);
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
    brokerageId = await account("Brokerage");
    const category = async (name: string, type: string) =>
      (
        await db.query(
          `INSERT INTO categories (user_id, name, category_type, is_income)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [userId, name, type, type === "income"],
        )
      )[0].id as string;
    transferCat = await category("Savings contributions", "transfer");
    expenseCat = await category("Groceries", "expense");
    feesCat = await category("Fees", "expense");
  });

  const categoryOf = async (id: string): Promise<string | null> =>
    (
      await db.query(`SELECT category_id FROM transactions WHERE id = $1`, [id])
    )[0]?.category_id ?? null;
  const lineOf = async (id: string) =>
    (
      await db.query(
        `SELECT id, category_id, linked_transaction_id, transfer_account_id
           FROM transaction_splits WHERE id = $1`,
        [id],
      )
    )[0] as {
      id: string;
      category_id: string | null;
      linked_transaction_id: string | null;
      transfer_account_id: string | null;
    };
  const linesOf = async (parentId: string) =>
    (await db.query(
      `SELECT id, category_id, linked_transaction_id, transfer_account_id
         FROM transaction_splits WHERE transaction_id = $1 ORDER BY amount`,
      [parentId],
    )) as {
      id: string;
      category_id: string | null;
      linked_transaction_id: string | null;
      transfer_account_id: string | null;
    }[];
  const rowCount = async () =>
    (
      await db.query(
        `SELECT count(*)::int AS n FROM transactions WHERE user_id = $1`,
        [userId],
      )
    )[0].n as number;
  /** Write a category onto a row behind the service's back. */
  const setCategory = (id: string, categoryId: string | null) =>
    db.query(`UPDATE transactions SET category_id = $2 WHERE id = $1`, [
      id,
      categoryId,
    ]);

  const createOrdinary = (categoryId?: string | null, payeeId?: string) =>
    asUser(() =>
      transactions.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-03-02",
        amount: -25,
        currencyCode: "USD",
        ...(categoryId !== undefined ? { categoryId } : {}),
        ...(payeeId ? { payeeId } : {}),
      } as never),
    );
  const createTransfer = async (categoryId?: string | null) => {
    const result = await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: chequingId,
        toAccountId: savingsId,
        transactionDate: "2026-03-03",
        amount: 100,
        ...(categoryId !== undefined ? { categoryId } : {}),
      } as never),
    );
    return { fromId: result.fromTransaction.id, toId: result.toTransaction.id };
  };
  /** A split with a category line and a transfer line to Savings. */
  const createSplit = async (
    transferLine: { categoryId?: string | null } = {},
    categoryLine: { categoryId?: string | null } = { categoryId: expenseCat },
  ) => {
    const parent = await asUser(() =>
      transactions.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-03-04",
        amount: -150,
        currencyCode: "USD",
        splits: [
          { amount: -100, transferAccountId: savingsId, ...transferLine },
          { amount: -50, ...categoryLine },
        ],
      } as never),
    );
    const lines = await linesOf(parent.id);
    const transferLineRow = lines.find((l) => l.transfer_account_id)!;
    const categoryLineRow = lines.find((l) => !l.transfer_account_id)!;
    return {
      parentId: parent.id,
      transferLineId: transferLineRow.id,
      linkedRowId: transferLineRow.linked_transaction_id!,
      categoryLineId: categoryLineRow.id,
    };
  };
  /**
   * A transfer between two owners, written as the transfer service writes
   * one: each leg its owner's, linked to the other, the other owner's leg
   * holding a category of its own.
   */
  const createCrossOwnerPair = async () => {
    const otherId = (await createTestUserDirect(db)).id;
    const otherAccount = (
      await createTestAccount(db, otherId, { name: "Their savings" })
    ).id;
    const [theirCategory] = await db.query(
      `INSERT INTO categories (user_id, name) VALUES ($1, 'Theirs') RETURNING id`,
      [otherId],
    );
    const [mine] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, is_transfer, category_id)
       VALUES ($1, $2, '2026-03-05', -40, 'USD', true, $3) RETURNING id`,
      [userId, chequingId, feesCat],
    );
    const [theirs] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, is_transfer, category_id, linked_transaction_id)
       VALUES ($1, $2, '2026-03-05', 40, 'USD', true, $3, $4) RETURNING id`,
      [otherId, otherAccount, theirCategory.id, mine.id],
    );
    await db.query(
      `UPDATE transactions SET linked_transaction_id = $2 WHERE id = $1`,
      [mine.id, theirs.id],
    );
    return {
      mineId: mine.id,
      theirsId: theirs.id,
      theirCategory: theirCategory.id,
    };
  };
  const refusedWithNothingWritten = async (
    write: () => Promise<unknown>,
    stored: () => Promise<unknown>,
  ) => {
    const before = await stored();
    const rows = await rowCount();
    await expect(write()).rejects.toBeInstanceOf(BadRequestException);
    expect(await stored()).toEqual(before);
    expect(await rowCount()).toBe(rows);
  };

  describe("4.1 create a transaction", () => {
    row("create: refuses a Transfer category, writing nothing", async () => {
      await refusedWithNothingWritten(
        () => createOrdinary(transferCat),
        async () => null,
      );
    });

    row("create: writes an Income or Expense category", async () => {
      const row = await createOrdinary(expenseCat);
      expect(await categoryOf(row.id)).toBe(expenseCat);
    });

    row(
      "create: applies the payee's default when the request names none",
      async () => {
        const [payee] = await db.query(
          `INSERT INTO payees (user_id, name, default_category_id) VALUES ($1, 'Store', $2) RETURNING id`,
          [userId, feesCat],
        );
        const row = await createOrdinary(undefined, payee.id);
        expect(await categoryOf(row.id)).toBe(feesCat);
      },
    );

    row(
      "create: skips a payee default that is a Transfer category, writing the row uncategorized",
      async () => {
        // Only a pod of the previous release can have stored one.
        const [payee] = await db.query(
          `INSERT INTO payees (user_id, name, default_category_id) VALUES ($1, 'Bank', $2) RETURNING id`,
          [userId, transferCat],
        );
        const row = await createOrdinary(undefined, payee.id);
        expect(await categoryOf(row.id)).toBeNull();
      },
    );
  });

  describe("4.1 create a transfer", () => {
    for (const [label, pick] of EVERY_KIND) {
      row(`create transfer: writes ${label} on both legs`, async () => {
        const { fromId, toId } = await createTransfer(pick());
        expect(await categoryOf(fromId)).toBe(pick());
        expect(await categoryOf(toId)).toBe(pick());
      });
    }
  });

  describe("4.1 edit a transfer through the transfer route", () => {
    for (const [label, pick] of EVERY_KIND) {
      row(`transfer route: writes ${label} on both legs`, async () => {
        const { fromId, toId } = await createTransfer(feesCat);
        await asUser(() =>
          transactions.updateTransfer(userId, toId, { categoryId: pick() }),
        );
        expect(await categoryOf(fromId)).toBe(pick());
        expect(await categoryOf(toId)).toBe(pick());
      });
    }

    row(
      "transfer route: sets both legs of a transfer whose legs differ, even with the category one shows",
      async () => {
        const { fromId, toId } = await createTransfer(feesCat);
        await setCategory(toId, expenseCat);
        await asUser(() =>
          transactions.updateTransfer(userId, fromId, { categoryId: feesCat }),
        );
        expect(await categoryOf(fromId)).toBe(feesCat);
        expect(await categoryOf(toId)).toBe(feesCat);
      },
    );

    for (const [label, pick] of EVERY_KIND) {
      row(
        `transfer route: writes ${label} on the linked row of a split's transfer line and on the line`,
        async () => {
          const split = await createSplit({ categoryId: feesCat });
          await asUser(() =>
            transactions.updateTransfer(userId, split.linkedRowId, {
              categoryId: pick(),
            }),
          );
          expect(await categoryOf(split.linkedRowId)).toBe(pick());
          expect((await lineOf(split.transferLineId)).category_id).toBe(pick());
        },
      );
    }
  });

  describe("4.1 plain patch", () => {
    row(
      "plain patch: refuses a Transfer category on an ordinary row, writing nothing",
      async () => {
        const row = await createOrdinary(expenseCat);
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              transactions.update(userId, row.id, { categoryId: transferCat }),
            ),
          () => categoryOf(row.id),
        );
      },
    );

    row(
      "plain patch: writes and clears a category on an ordinary row",
      async () => {
        const row = await createOrdinary(expenseCat);
        await asUser(() =>
          transactions.update(userId, row.id, { categoryId: feesCat }),
        );
        expect(await categoryOf(row.id)).toBe(feesCat);
        await asUser(() =>
          transactions.update(userId, row.id, { categoryId: null } as never),
        );
        expect(await categoryOf(row.id)).toBeNull();
      },
    );

    for (const [label, pick] of EVERY_KIND) {
      row(
        `plain patch: writes ${label} on both legs of a transfer`,
        async () => {
          const { fromId, toId } = await createTransfer(feesCat);
          await asUser(() =>
            transactions.update(userId, toId, { categoryId: pick() } as never),
          );
          expect(await categoryOf(fromId)).toBe(pick());
          expect(await categoryOf(toId)).toBe(pick());
        },
      );
    }

    row(
      "plain patch: across two owners writes the writer's leg only",
      async () => {
        const pair = await createCrossOwnerPair();
        await asUser(() =>
          transactions.update(userId, pair.mineId, { categoryId: transferCat }),
        );
        expect(await categoryOf(pair.mineId)).toBe(transferCat);
        expect(await categoryOf(pair.theirsId)).toBe(pair.theirCategory);
      },
    );

    row(
      "plain patch: leaves both legs alone when the patch names no category",
      async () => {
        const { fromId, toId } = await createTransfer(feesCat);
        await setCategory(toId, expenseCat);
        await asUser(() =>
          transactions.update(userId, toId, { description: "Moved" }),
        );
        expect(await categoryOf(fromId)).toBe(feesCat);
        expect(await categoryOf(toId)).toBe(expenseCat);
      },
    );

    for (const [label, pick] of EVERY_KIND) {
      row(
        `plain patch: writes ${label} on the linked row of a split's transfer line and on the line`,
        async () => {
          const split = await createSplit({ categoryId: feesCat });
          await asUser(() =>
            transactions.update(userId, split.linkedRowId, {
              categoryId: pick(),
            } as never),
          );
          expect(await categoryOf(split.linkedRowId)).toBe(pick());
          expect((await lineOf(split.transferLineId)).category_id).toBe(pick());
        },
      );
    }
  });

  describe("4.1 bulk update", () => {
    const bulk = (ids: string[], categoryId: string | null) =>
      asUser(() =>
        transactions.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: ids,
          categoryId,
        } as never),
      );

    row(
      "bulk update: writes a Transfer category to each transfer leg and its other leg, and skips each category row with a reason",
      async () => {
        const ordinary = await createOrdinary(expenseCat);
        const { fromId, toId } = await createTransfer(feesCat);

        const result = await bulk([ordinary.id, fromId], transferCat);

        expect(await categoryOf(fromId)).toBe(transferCat);
        expect(await categoryOf(toId)).toBe(transferCat);
        expect(await categoryOf(ordinary.id)).toBe(expenseCat);
        expect(result.updated).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.skippedReasons.join(" ")).toMatch(/Transfer category/);
      },
    );

    for (const [label, pick] of NOT_TRANSFER) {
      row(
        `bulk update: writes ${label} to every selected row, and a transfer's other leg follows`,
        async () => {
          const ordinary = await createOrdinary(feesCat);
          const { fromId, toId } = await createTransfer(feesCat);

          await bulk([ordinary.id, toId], pick());

          expect(await categoryOf(ordinary.id)).toBe(pick());
          expect(await categoryOf(toId)).toBe(pick());
          expect(await categoryOf(fromId)).toBe(pick());
        },
      );
    }

    row(
      "bulk update: across two owners writes the writer's leg only",
      async () => {
        const pair = await createCrossOwnerPair();
        await bulk([pair.mineId], transferCat);
        expect(await categoryOf(pair.mineId)).toBe(transferCat);
        expect(await categoryOf(pair.theirsId)).toBe(pair.theirCategory);
      },
    );

    row(
      "bulk update: writes a split transfer line's linked row together with its line",
      async () => {
        const split = await createSplit();
        await bulk([split.linkedRowId], transferCat);
        expect(await categoryOf(split.linkedRowId)).toBe(transferCat);
        expect((await lineOf(split.transferLineId)).category_id).toBe(
          transferCat,
        );
      },
    );

    row(
      "bulk update: a status and a category together on a split's linked row write the row and its line",
      async () => {
        // The status pass locks the line's split parent with the parents,
        // before the linked row, as the category write needs it.
        const split = await createSplit();
        await asUser(() =>
          transactions.bulkUpdate(userId, {
            mode: "ids",
            transactionIds: [split.linkedRowId],
            categoryId: transferCat,
            status: "CLEARED",
          } as never),
        );
        expect(await categoryOf(split.linkedRowId)).toBe(transferCat);
        expect((await lineOf(split.transferLineId)).category_id).toBe(
          transferCat,
        );
      },
    );

    row(
      "bulk update: skips a split parent's category lines with a reason and leaves its transfer line alone",
      async () => {
        const split = await createSplit({ categoryId: feesCat });
        const result = await bulk([split.parentId], transferCat);
        expect((await lineOf(split.categoryLineId)).category_id).toBe(
          expenseCat,
        );
        expect((await lineOf(split.transferLineId)).category_id).toBe(feesCat);
        expect(result.skippedReasons.join(" ")).toMatch(/Transfer category/);
      },
    );
  });

  describe("4.1 conversion", () => {
    for (const [label, pick] of EVERY_KIND) {
      row(`convert: to a transfer writes ${label} on both legs`, async () => {
        const row = await createOrdinary(feesCat);
        const result = await asUser(() =>
          conversion.convertToTransfer(userId, row.id, {
            fromAccountId: chequingId,
            toAccountId: savingsId,
            transactionDate: "2026-03-02",
            amount: 25,
            categoryId: pick(),
          } as never),
        );
        expect(await categoryOf(result.fromTransaction.id)).toBe(pick());
        expect(await categoryOf(result.toTransaction.id)).toBe(pick());
      });
    }

    row(
      "convert: to a transaction clears the kept leg's Transfer category",
      async () => {
        const { fromId } = await createTransfer(transferCat);
        await asUser(() => conversion.convertToTransaction(userId, fromId, {}));
        expect(await categoryOf(fromId)).toBeNull();
      },
    );

    row(
      "convert: to a transaction keeps an Income or Expense category",
      async () => {
        const { fromId } = await createTransfer(expenseCat);
        await asUser(() => conversion.convertToTransaction(userId, fromId, {}));
        expect(await categoryOf(fromId)).toBe(expenseCat);
      },
    );

    row(
      "convert: to a transaction refuses a request naming a Transfer category, writing nothing",
      async () => {
        const { fromId, toId } = await createTransfer(expenseCat);
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              conversion.convertToTransaction(userId, fromId, {
                categoryId: transferCat,
              }),
            ),
          async () => [await categoryOf(fromId), await categoryOf(toId)],
        );
      },
    );
  });

  describe("4.1 reassign", () => {
    row(
      "reassign: to a Transfer category is refused, nothing moved, when a category row would move",
      async () => {
        const ordinary = await createOrdinary(expenseCat);
        const { fromId } = await createTransfer(expenseCat);
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              categories.reassignTransactions(userId, expenseCat, transferCat),
            ),
          async () => [await categoryOf(ordinary.id), await categoryOf(fromId)],
        );
      },
    );

    row(
      "reassign: to a Transfer category is refused when a split's category line would move",
      async () => {
        const split = await createSplit();
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              categories.reassignTransactions(userId, expenseCat, transferCat),
            ),
          async () => (await lineOf(split.categoryLineId)).category_id,
        );
      },
    );

    row(
      "reassign: to a Transfer category moves transfers when only transfer rows hold the source",
      async () => {
        const { fromId, toId } = await createTransfer(feesCat);
        await asUser(() =>
          categories.reassignTransactions(userId, feesCat, transferCat),
        );
        expect(await categoryOf(fromId)).toBe(transferCat);
        expect(await categoryOf(toId)).toBe(transferCat);
      },
    );

    row(
      "reassign: to an Income or Expense category moves every row, transfers included",
      async () => {
        const ordinary = await createOrdinary(feesCat);
        const { fromId } = await createTransfer(feesCat);
        await asUser(() =>
          categories.reassignTransactions(userId, feesCat, expenseCat),
        );
        expect(await categoryOf(ordinary.id)).toBe(expenseCat);
        expect(await categoryOf(fromId)).toBe(expenseCat);
      },
    );
  });

  describe("4.2 splits", () => {
    for (const [label, pick] of A_CATEGORY) {
      row(
        `split create: a transfer line holds ${label}, and so does its linked row`,
        async () => {
          const split = await createSplit({ categoryId: pick() });
          expect((await lineOf(split.transferLineId)).category_id).toBe(pick());
          expect(await categoryOf(split.linkedRowId)).toBe(pick());
        },
      );
    }

    row(
      "split create: a category line refuses a Transfer category, writing nothing",
      async () => {
        await refusedWithNothingWritten(
          () => createSplit({}, { categoryId: transferCat }),
          async () => null,
        );
      },
    );

    row(
      "split replace: a transfer line's category reaches its new linked row",
      async () => {
        const split = await createSplit();
        await asUser(() =>
          transactions.updateSplits(userId, split.parentId, [
            {
              amount: -100,
              transferAccountId: savingsId,
              categoryId: transferCat,
            },
            { amount: -50, categoryId: expenseCat },
          ] as never),
        );
        const line = (await linesOf(split.parentId)).find(
          (l) => l.transfer_account_id,
        )!;
        expect(line.category_id).toBe(transferCat);
        expect(await categoryOf(line.linked_transaction_id!)).toBe(transferCat);
      },
    );

    row(
      "split replace: a category line refuses a Transfer category, writing nothing",
      async () => {
        const split = await createSplit();
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              transactions.updateSplits(userId, split.parentId, [
                { amount: -100, transferAccountId: savingsId },
                { amount: -50, categoryId: transferCat },
              ] as never),
            ),
          async () => linesOf(split.parentId),
        );
      },
    );

    row(
      "split add: a transfer line holds its category, and so does the row it creates",
      async () => {
        const split = await createSplit();
        const added = await asUser(() =>
          transactions.addSplit(userId, split.parentId, {
            amount: -10,
            transferAccountId: brokerageId,
            categoryId: transferCat,
          } as never),
        );
        const line = await lineOf(added.id);
        expect(line.category_id).toBe(transferCat);
        expect(await categoryOf(line.linked_transaction_id!)).toBe(transferCat);
      },
    );

    row(
      "split add: a category line refuses a Transfer category, writing nothing",
      async () => {
        const split = await createSplit();
        await refusedWithNothingWritten(
          () =>
            asUser(() =>
              transactions.addSplit(userId, split.parentId, {
                amount: -10,
                categoryId: transferCat,
              } as never),
            ),
          async () => linesOf(split.parentId),
        );
      },
    );

    row(
      "split remove, leaving one transfer line: the parent becomes a transfer holding the line's category",
      async () => {
        const split = await createSplit({ categoryId: transferCat });
        await asUser(() =>
          transactions.removeSplit(
            userId,
            split.parentId,
            split.categoryLineId,
          ),
        );
        const parent = (
          await db.query(
            `SELECT is_transfer, category_id, linked_transaction_id FROM transactions WHERE id = $1`,
            [split.parentId],
          )
        )[0];
        expect(parent.is_transfer).toBe(true);
        expect(parent.category_id).toBe(transferCat);
        expect(await categoryOf(parent.linked_transaction_id)).toBe(
          transferCat,
        );
      },
    );

    row(
      "split remove, leaving one category line: the parent takes its category",
      async () => {
        const split = await createSplit();
        await asUser(() =>
          transactions.removeSplit(
            userId,
            split.parentId,
            split.transferLineId,
          ),
        );
        expect(await categoryOf(split.parentId)).toBe(expenseCat);
      },
    );
  });
  describe("4.7 undo", () => {
    const undo = async () => {
      await settlePendingHistoryWrites();
      await asUser(() => history.undo(userId));
    };
    const redo = async () => {
      await settlePendingHistoryWrites();
      await asUser(() => history.redo(userId));
    };

    row(
      "undo: a plain patch that wrote both legs returns each to the value it held",
      async () => {
        const { fromId, toId } = await createTransfer(feesCat);
        await setCategory(toId, expenseCat);
        await asUser(() =>
          transactions.update(userId, fromId, { categoryId: transferCat }),
        );
        await undo();
        expect(await categoryOf(fromId)).toBe(feesCat);
        expect(await categoryOf(toId)).toBe(expenseCat);
        await redo();
        expect(await categoryOf(fromId)).toBe(transferCat);
        expect(await categoryOf(toId)).toBe(transferCat);
      },
    );

    row("undo: a bulk update returns the other legs it wrote", async () => {
      const { fromId, toId } = await createTransfer(feesCat);
      await asUser(() =>
        transactions.bulkUpdate(userId, {
          mode: "ids",
          transactionIds: [fromId],
          categoryId: transferCat,
        } as never),
      );
      expect(await categoryOf(toId)).toBe(transferCat);
      await undo();
      expect(await categoryOf(fromId)).toBe(feesCat);
      expect(await categoryOf(toId)).toBe(feesCat);
    });

    row(
      "undo: a bulk update that skipped a split parent still returns the transfer line it wrote",
      async () => {
        // The parent is selected with its line's linked row: the parent is
        // skipped (a Transfer category fits none of its category lines), the
        // linked row and the line take the category, and undo returns both.
        const split = await createSplit();
        const result = await asUser(() =>
          transactions.bulkUpdate(userId, {
            mode: "ids",
            transactionIds: [split.parentId, split.linkedRowId],
            categoryId: transferCat,
          } as never),
        );
        expect(result.updated).toBe(1);
        expect((await lineOf(split.transferLineId)).category_id).toBe(
          transferCat,
        );
        await undo();
        expect(await categoryOf(split.linkedRowId)).toBeNull();
        expect((await lineOf(split.transferLineId)).category_id).toBeNull();
      },
    );

    row(
      "undo: a plain patch of a split's linked row returns its line",
      async () => {
        const split = await createSplit();
        await asUser(() =>
          transactions.update(userId, split.linkedRowId, {
            categoryId: transferCat,
          }),
        );
        await undo();
        expect(await categoryOf(split.linkedRowId)).toBeNull();
        expect((await lineOf(split.transferLineId)).category_id).toBeNull();
      },
    );
  });
});
