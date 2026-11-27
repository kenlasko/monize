import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The automation rows of `docs/specs/transfer-categories.md` section 4.4
 * (INV-CATEGORY-001 FIT, INV-CATEGORY-002 ONE): a rule's `set_category` on a
 * transfer and on an ordinary row, and `convert_to_transfer` naming, keeping
 * or clearing a category; on the create path and in a manual run, with its
 * undo.
 */
describe("Category fit and one category per transfer: rules (integration)", () => {
  jest.setTimeout(120000);

  /**
   * Rows whose behaviour a later step of PR 3 builds. Each runs as
   * `it.failing`; the step that builds a row removes it here. Shrink-only.
   */
  const NOT_YET_BUILT = new Set<string>([]);
  const row = (title: string, fn: () => Promise<void>) =>
    (NOT_YET_BUILT.has(title) ? it.failing : it)(title, fn);

  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let runs: TransactionRulesRunService;
  let history: ActionHistoryService;
  let userId: string;
  let chequingId: string;
  let savingsId: string;
  let transferCat: string;
  let expenseCat: string;
  let feesCat: string;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    module = await createIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    db = module.get(DataSource);
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    runs = module.get(TransactionRulesRunService, { strict: false });
    history = module.get(ActionHistoryService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await module.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
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
  const rule = (
    triggers: string[],
    actions: unknown[],
    condition: unknown = {
      field: "description",
      op: "contains",
      value: "Rule me",
    },
  ) =>
    asUser(() =>
      rules.create(userId, {
        name: "Rule",
        triggers,
        condition,
        actions,
      } as unknown as CreateTransactionRuleDto),
    );
  const createOrdinary = (categoryId: string | null = null) =>
    asUser(() =>
      transactions.create(userId, {
        accountId: chequingId,
        transactionDate: "2026-03-02",
        amount: -25,
        currencyCode: "USD",
        description: "Rule me",
        ...(categoryId ? { categoryId } : {}),
      } as never),
    );
  const createTransfer = async (categoryId: string | null = null) => {
    const result = await asUser(() =>
      transactions.createTransfer(userId, {
        fromAccountId: chequingId,
        toAccountId: savingsId,
        transactionDate: "2026-03-03",
        amount: 100,
        description: "Rule me",
        ...(categoryId ? { categoryId } : {}),
      } as never),
    );
    return { fromId: result.fromTransaction.id, toId: result.toTransaction.id };
  };
  const runNow = async (ruleId: string) => {
    const preview = await asUser(() => runs.previewRun(userId, ruleId, {}));
    await asUser(() =>
      runs.run(userId, ruleId, { fingerprint: preview.fingerprint }),
    );
    return preview;
  };

  describe("set_category", () => {
    for (const [label, pick] of [
      ["a Transfer category", () => transferCat],
      ["an Expense category", () => expenseCat],
    ] as const) {
      row(
        `set_category on create: a transfer takes ${label} on both legs`,
        async () => {
          await rule(
            ["create"],
            [{ type: "set_category", categoryId: pick(), onlyIfEmpty: false }],
          );
          const { fromId, toId } = await createTransfer();
          expect(await categoryOf(fromId)).toBe(pick());
          expect(await categoryOf(toId)).toBe(pick());
        },
      );

      row(
        `set_category in a run: a transfer takes ${label} on both legs`,
        async () => {
          const { fromId, toId } = await createTransfer(feesCat);
          const created = await rule(
            ["import"],
            [{ type: "set_category", categoryId: pick(), onlyIfEmpty: false }],
          );
          await runNow(created.id);
          expect(await categoryOf(fromId)).toBe(pick());
          expect(await categoryOf(toId)).toBe(pick());
        },
      );
    }

    row(
      "set_category on create: an ordinary row skips a Transfer category",
      async () => {
        await rule(
          ["create"],
          [
            {
              type: "set_category",
              categoryId: transferCat,
              onlyIfEmpty: false,
            },
          ],
        );
        const created = await createOrdinary(expenseCat);
        expect(await categoryOf(created.id)).toBe(expenseCat);
      },
    );

    row(
      "set_category in a run: an ordinary row is skipped with the reason that names the type",
      async () => {
        const ordinary = await createOrdinary(expenseCat);
        const created = await rule(
          ["import"],
          [
            {
              type: "set_category",
              categoryId: transferCat,
              onlyIfEmpty: false,
            },
          ],
        );
        const preview = await asUser(() =>
          runs.previewRun(userId, created.id, {}),
        );
        expect(JSON.stringify(preview)).toContain(
          "transfer_category_on_category_row",
        );
        await asUser(() =>
          runs.run(userId, created.id, { fingerprint: preview.fingerprint }),
        );
        expect(await categoryOf(ordinary.id)).toBe(expenseCat);
      },
    );

    row(
      "set_category in a run: a split's linked row takes its line with it, and undo returns both",
      async () => {
        const parent = await asUser(() =>
          transactions.create(userId, {
            accountId: chequingId,
            transactionDate: "2026-03-04",
            amount: -150,
            currencyCode: "USD",
            splits: [
              { amount: -100, transferAccountId: savingsId },
              { amount: -50, categoryId: expenseCat },
            ],
          } as never),
        );
        const [line] = await db.query(
          `SELECT id, linked_transaction_id FROM transaction_splits
          WHERE transaction_id = $1 AND transfer_account_id IS NOT NULL`,
          [parent.id],
        );
        // Both sides start on a category of their own, so the undo is seen
        // restoring it, not clearing to what was never there.
        await db.query(
          `UPDATE transaction_splits SET category_id = $2 WHERE id = $1`,
          [line.id, feesCat],
        );
        await db.query(
          `UPDATE transactions SET category_id = $2 WHERE id = $1`,
          [line.linked_transaction_id, feesCat],
        );
        const created = await rule(
          ["import"],
          [
            {
              type: "set_category",
              categoryId: transferCat,
              onlyIfEmpty: false,
            },
          ],
          { field: "type", op: "eq", value: "TRANSFER" },
        );
        await runNow(created.id);
        const lineCategory = async () =>
          (
            await db.query(
              `SELECT category_id FROM transaction_splits WHERE id = $1`,
              [line.id],
            )
          )[0].category_id;
        expect(await categoryOf(line.linked_transaction_id)).toBe(transferCat);
        expect(await lineCategory()).toBe(transferCat);

        await settlePendingHistoryWrites();
        await asUser(() => history.undo(userId));
        expect(await categoryOf(line.linked_transaction_id)).toBe(feesCat);
        expect(await lineCategory()).toBe(feesCat);
      },
    );

    row(
      "set_category in a run: a split's linked row whose parent is reconciled is skipped under the strict lock, the rest written",
      async () => {
        // The category would reach the reconciled parent's line
        // (INV-CATEGORY-002), so the row is kept as it is with a reason, not
        // a refusal of the whole run.
        await db.query(
          `INSERT INTO user_preferences (user_id, lock_reconciled_transactions)
           VALUES ($1, true)
           ON CONFLICT (user_id) DO UPDATE SET lock_reconciled_transactions = true`,
          [userId],
        );
        const parent = await asUser(() =>
          transactions.create(userId, {
            accountId: chequingId,
            transactionDate: "2026-03-04",
            amount: -150,
            currencyCode: "USD",
            splits: [
              { amount: -100, transferAccountId: savingsId },
              { amount: -50, categoryId: expenseCat },
            ],
          } as never),
        );
        await db.query(
          `UPDATE transactions SET status = 'RECONCILED' WHERE id = $1`,
          [parent.id],
        );
        const [line] = await db.query(
          `SELECT id, linked_transaction_id FROM transaction_splits
          WHERE transaction_id = $1 AND transfer_account_id IS NOT NULL`,
          [parent.id],
        );
        const { fromId, toId } = await createTransfer();
        const created = await rule(
          ["import"],
          [
            {
              type: "set_category",
              categoryId: transferCat,
              onlyIfEmpty: false,
            },
          ],
          { field: "type", op: "eq", value: "TRANSFER" },
        );
        const preview = await runNow(created.id);
        expect(preview.skipped).toEqual(
          expect.arrayContaining([
            {
              transactionId: line.linked_transaction_id,
              reason: "reconciled_locked",
            },
          ]),
        );
        expect(await categoryOf(line.linked_transaction_id)).toBeNull();
        expect(await categoryOf(fromId)).toBe(transferCat);
        expect(await categoryOf(toId)).toBe(transferCat);
      },
    );
  });

  describe("set_category on a transfer whose sides differ", () => {
    const transferRule = () =>
      rule(
        ["import"],
        [{ type: "set_category", categoryId: feesCat, onlyIfEmpty: false }],
        { field: "type", op: "eq", value: "TRANSFER" },
      );

    row(
      "set_category in a run: naming the category the outgoing leg holds sets the other leg too, and undo returns each",
      async () => {
        // A QIF import put the payee default on one leg only.
        const { fromId, toId } = await createTransfer(feesCat);
        await db.query(
          `UPDATE transactions SET category_id = NULL WHERE id = $1`,
          [toId],
        );
        const created = await transferRule();
        const preview = await runNow(created.id);
        expect(preview.matched.map((r) => r.transactionId)).toEqual([fromId]);
        expect(await categoryOf(fromId)).toBe(feesCat);
        expect(await categoryOf(toId)).toBe(feesCat);

        await settlePendingHistoryWrites();
        await asUser(() => history.undo(userId));
        expect(await categoryOf(fromId)).toBe(feesCat);
        expect(await categoryOf(toId)).toBeNull();
      },
    );

    row(
      "set_category in a run: a split's linked row holding the category gives it to its line",
      async () => {
        const parent = await asUser(() =>
          transactions.create(userId, {
            accountId: chequingId,
            transactionDate: "2026-03-04",
            amount: -150,
            currencyCode: "USD",
            splits: [
              { amount: -100, transferAccountId: savingsId },
              { amount: -50, categoryId: expenseCat },
            ],
          } as never),
        );
        const [line] = await db.query(
          `SELECT id, linked_transaction_id FROM transaction_splits
          WHERE transaction_id = $1 AND transfer_account_id IS NOT NULL`,
          [parent.id],
        );
        await db.query(
          `UPDATE transactions SET category_id = $2 WHERE id = $1`,
          [line.linked_transaction_id, feesCat],
        );
        const created = await transferRule();
        await runNow(created.id);
        const [stored] = await db.query(
          `SELECT category_id FROM transaction_splits WHERE id = $1`,
          [line.id],
        );
        expect(stored.category_id).toBe(feesCat);
        expect(await categoryOf(line.linked_transaction_id)).toBe(feesCat);
      },
    );

    row(
      "set_category in a run: a transfer whose legs already agree is no change",
      async () => {
        await createTransfer(feesCat);
        const created = await transferRule();
        const preview = await asUser(() =>
          runs.previewRun(userId, created.id, {}),
        );
        expect(preview.matched).toEqual([]);
      },
    );
  });

  describe("split", () => {
    row(
      "split in a run: a category line naming a Transfer category skips the row with the reason, and the run writes nothing",
      async () => {
        const ordinary = await asUser(() =>
          transactions.create(userId, {
            accountId: chequingId,
            transactionDate: "2026-03-02",
            amount: -100,
            currencyCode: "USD",
            payeeName: "PAY 60 FEE 40",
          } as never),
        );
        const created = await rule(
          ["import"],
          [
            {
              type: "split",
              parts: [
                { amount: "{pay}", transferAccountId: savingsId },
                { amount: "{fee}", categoryId: transferCat },
              ],
            },
          ],
          { field: "payeeText", op: "matches", value: "PAY {pay} FEE {fee}" },
        );
        const preview = await asUser(() =>
          runs.previewRun(userId, created.id, {}),
        );
        expect(preview.matched).toEqual([]);
        expect(preview.skipped).toEqual([
          {
            transactionId: ordinary.id,
            reason: "transfer_category_on_category_row",
          },
        ]);
        await asUser(() =>
          runs.run(userId, created.id, { fingerprint: preview.fingerprint }),
        );
        const [stored] = await db.query(
          `SELECT is_split FROM transactions WHERE id = $1`,
          [ordinary.id],
        );
        expect(stored.is_split).toBe(false);
      },
    );
  });

  describe("convert_to_transfer", () => {
    const convert = (extra: Record<string, unknown>) =>
      rule(
        ["create"],
        [
          {
            type: "convert_to_transfer",
            toAccountId: savingsId,
            clearCategory: true,
            ...extra,
          },
        ],
      );
    const legsOf = async (id: string) => {
      const [leg] = await db.query(
        `SELECT linked_transaction_id FROM transactions WHERE id = $1`,
        [id],
      );
      return [
        await categoryOf(id),
        await categoryOf(leg.linked_transaction_id),
      ];
    };

    row(
      "convert_to_transfer: a named Transfer category goes on both legs",
      async () => {
        await convert({ categoryId: transferCat });
        const created = await createOrdinary(expenseCat);
        expect(await legsOf(created.id)).toEqual([transferCat, transferCat]);
      },
    );

    row("convert_to_transfer: a kept category goes on both legs", async () => {
      await convert({ clearCategory: false });
      const created = await createOrdinary(expenseCat);
      expect(await legsOf(created.id)).toEqual([expenseCat, expenseCat]);
    });

    row(
      "convert_to_transfer: a cleared category leaves none on either",
      async () => {
        await convert({});
        const created = await createOrdinary(expenseCat);
        expect(await legsOf(created.id)).toEqual([null, null]);
      },
    );
  });
});
