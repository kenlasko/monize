import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { AccountsService } from "@/accounts/accounts.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { Tag } from "@/tags/entities/tag.entity";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount, createTestPayee } from "../helpers/test-factories";

/**
 * The rules step of a new transfer against a real PostgreSQL enforcing RLS
 * (design 6.3, B5): the rule effects share the legs' transaction, explicit and
 * rule tags end up as a union on both legs of a same-owner transfer, a
 * cross-owner transfer runs each owner's rules on that owner's leg only, and
 * with no rules the rows and tags are what they were before rules existed.
 */
describe("Transaction rules on the transfer create path (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let accounts: AccountsService;

  let aliceId: string;
  let bobId: string;
  let checkingId: string;
  let savingsId: string;
  let bobAccountId: string;
  let aliceRuleTag: string;
  let aliceExplicitTag: string;
  let bobRuleTag: string;
  let bobExplicitTag: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const transferRule = (
    tagIds: string[],
    over: Partial<CreateTransactionRuleDto> = {},
  ) =>
    ({
      name: "Tag transfers",
      triggers: ["create"],
      condition: { field: "type", op: "eq", value: "TRANSFER" },
      actions: [{ type: "add_tags", tagIds }],
      ...over,
    }) as CreateTransactionRuleDto;

  const transferDto = (over: Record<string, unknown> = {}) => ({
    fromAccountId: checkingId,
    toAccountId: savingsId,
    transactionDate: "2026-03-10",
    amount: 100,
    fromCurrencyCode: "USD",
    ...over,
  });

  const tagsOf = async (transactionId: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT tag_id FROM transaction_tags WHERE transaction_id = $1 ORDER BY tag_id`,
        [transactionId],
      )
    ).map((r: { tag_id: string }) => r.tag_id);
  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);
  const balanceOf = async (accountId: string): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          accountId,
        ])
      )[0].current_balance,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    accounts = module.get(AccountsService, { strict: false });
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "transaction_tags",
      "tags",
      "action_history",
      "account_delegate_grants",
      "account_delegates",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    const account = (userId: string, name: string) =>
      createTestAccount(db, userId, {
        name,
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      }).then((a) => a.id);
    checkingId = await account(aliceId, "Checking");
    savingsId = await account(aliceId, "Savings");
    bobAccountId = await account(bobId, "Bob Chequing");
    const tag = (userId: string, name: string) =>
      db
        .getRepository(Tag)
        .save({ userId, name })
        .then((t) => t.id);
    aliceRuleTag = await tag(aliceId, "rule-a");
    aliceExplicitTag = await tag(aliceId, "explicit-a");
    bobRuleTag = await tag(bobId, "rule-b");
    bobExplicitTag = await tag(bobId, "explicit-b");
  });

  it("tags both legs of a same-owner transfer and keeps the explicit tags: the union", async () => {
    const rule = await asAlice(() =>
      rules.create(aliceId, transferRule([aliceRuleTag])),
    );

    const result = await asAlice(() =>
      transactions.createTransfer(
        aliceId,
        transferDto({ tagIds: [aliceExplicitTag] }) as never,
      ),
    );

    const expected = [aliceRuleTag, aliceExplicitTag].sort();
    expect(await tagsOf(result.fromTransaction.id)).toEqual(expected);
    expect(await tagsOf(result.toTransaction.id)).toEqual(expected);

    // I1: the amounts and balances are exactly what the request asked for.
    expect(Number(result.fromTransaction.amount)).toBe(-100);
    expect(Number(result.toTransaction.amount)).toBe(100);
    expect(await balanceOf(checkingId)).toBe(900);
    expect(await balanceOf(savingsId)).toBe(1100);

    // One evaluation, written to both legs.
    const applications = await db.query(
      `SELECT rule_id, transaction_id, source FROM transaction_rule_applications ORDER BY transaction_id`,
    );
    expect(
      applications
        .map((a: { transaction_id: string }) => a.transaction_id)
        .sort(),
    ).toEqual([result.fromTransaction.id, result.toTransaction.id].sort());
    expect(
      applications.every(
        (a: { rule_id: string; source: string }) =>
          a.rule_id === rule.id && a.source === "create",
      ),
    ).toBe(true);
  });

  it("mirrors set_payee and set_category onto both legs of a transfer", async () => {
    const payee = await createTestPayee(db, aliceId, { name: "Landlord" });
    // A category the user owns, so the rule itself validates.
    const [{ id: categoryId }] = await db.query(
      `INSERT INTO categories (user_id, name, category_type) VALUES ($1, 'Housing', 'expense') RETURNING id`,
      [aliceId],
    );
    await asAlice(() =>
      rules.create(
        aliceId,
        transferRule([], {
          actions: [
            { type: "set_payee", payeeId: payee.id, onlyIfEmpty: false },
            { type: "set_category", categoryId, onlyIfEmpty: false },
          ],
        } as never),
      ),
    );

    const result = await asAlice(() =>
      transactions.createTransfer(aliceId, transferDto() as never),
    );

    const legs = await db.query(
      `SELECT id, payee_id, category_id FROM transactions WHERE id IN ($1, $2)`,
      [result.fromTransaction.id, result.toTransaction.id],
    );
    expect(legs).toHaveLength(2);
    // A transfer takes a category of any type, on both legs
    // (INV-CATEGORY-001, INV-CATEGORY-002).
    for (const leg of legs) {
      expect(leg.payee_id).toBe(payee.id);
      expect(leg.category_id).toBe(categoryId);
    }
  });

  it("with no rules the transfer writes exactly what it wrote before: explicit tags only, no trace", async () => {
    const result = await asAlice(() =>
      transactions.createTransfer(
        aliceId,
        transferDto({ tagIds: [aliceExplicitTag] }) as never,
      ),
    );
    expect(await tagsOf(result.fromTransaction.id)).toEqual([aliceExplicitTag]);
    expect(await tagsOf(result.toTransaction.id)).toEqual([aliceExplicitTag]);
    expect(await count("transaction_rule_applications")).toBe(0);

    const plain = await asAlice(() =>
      transactions.createTransfer(aliceId, transferDto() as never),
    );
    expect(await tagsOf(plain.fromTransaction.id)).toEqual([]);
    expect(await tagsOf(plain.toTransaction.id)).toEqual([]);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await count("transactions")).toBe(4);
    expect(await balanceOf(checkingId)).toBe(800);
    expect(await balanceOf(savingsId)).toBe(1200);
  });

  it("a failure after the rule step rolls the rule effects back with the legs", async () => {
    await asAlice(() => rules.create(aliceId, transferRule([aliceRuleTag])));
    jest
      .spyOn(accounts, "updateBalance")
      .mockRejectedValue(new Error("balance update failed"));

    await expect(
      asAlice(() =>
        transactions.createTransfer(aliceId, transferDto() as never),
      ),
    ).rejects.toThrow("balance update failed");

    expect(await count("transactions")).toBe(0);
    expect(await count("transaction_tags")).toBe(0);
    expect(await count("transaction_rule_applications")).toBe(0);
    expect(await balanceOf(checkingId)).toBe(1000);
    expect(await balanceOf(savingsId)).toBe(1000);
  });

  describe("cross-owner (Bob -> Alice's granted account)", () => {
    beforeEach(async () => {
      const [{ id: delegationId }] = await db.query(
        `INSERT INTO account_delegates (owner_user_id, delegate_user_id, status)
         VALUES ($1, $2, 'active') RETURNING id`,
        [aliceId, bobId],
      );
      await db.query(
        `INSERT INTO account_delegate_grants
           (delegation_id, account_id, can_read, can_create, can_edit, can_delete)
         VALUES ($1, $2, true, true, false, false)`,
        [delegationId, checkingId],
      );
    });

    const crossTransfer = (over: Record<string, unknown> = {}) =>
      asBob(() =>
        transactions.createTransfer(
          bobId,
          {
            fromAccountId: bobAccountId,
            toAccountId: checkingId,
            transactionDate: "2026-03-10",
            amount: 100,
            fromCurrencyCode: "USD",
            ...over,
          } as never,
          { effectiveUserId: bobId, realUserId: bobId },
        ),
      );

    it("runs each owner's rules on that owner's leg only", async () => {
      await asAlice(() => rules.create(aliceId, transferRule([aliceRuleTag])));
      await asBob(() => rules.create(bobId, transferRule([bobRuleTag])));

      const result = await crossTransfer({ tagIds: [bobExplicitTag] });

      expect(result.fromTransaction.userId).toBe(bobId);
      expect(result.toTransaction.userId).toBe(aliceId);
      // Bob's leg: his rule tag plus his explicit tag. Alice's leg: only her
      // rule tag -- never Bob's tags, and Alice's rule never touched Bob's leg.
      expect(await tagsOf(result.fromTransaction.id)).toEqual(
        [bobRuleTag, bobExplicitTag].sort(),
      );
      expect(await tagsOf(result.toTransaction.id)).toEqual([aliceRuleTag]);

      const applications = await db.query(
        `SELECT user_id, transaction_id FROM transaction_rule_applications`,
      );
      expect(
        applications
          .map(
            (a: { user_id: string; transaction_id: string }) =>
              `${a.user_id}:${a.transaction_id}`,
          )
          .sort(),
      ).toEqual(
        [
          `${bobId}:${result.fromTransaction.id}`,
          `${aliceId}:${result.toTransaction.id}`,
        ].sort(),
      );
      expect(await balanceOf(bobAccountId)).toBe(900);
      expect(await balanceOf(checkingId)).toBe(1100);
    });

    it("refuses set_payee on a cross-owner leg and still applies the owner's other actions", async () => {
      const payee = await createTestPayee(db, bobId, { name: "Bob payee" });
      await asBob(() =>
        rules.create(
          bobId,
          transferRule([], {
            actions: [
              { type: "set_payee", payeeId: payee.id, onlyIfEmpty: false },
              { type: "add_tags", tagIds: [bobRuleTag] },
            ],
          } as never),
        ),
      );

      const result = await crossTransfer();

      const [leg] = await db.query(
        `SELECT payee_id FROM transactions WHERE id = $1`,
        [result.fromTransaction.id],
      );
      expect(leg.payee_id).toBeNull();
      expect(await tagsOf(result.fromTransaction.id)).toEqual([bobRuleTag]);
      expect(await tagsOf(result.toTransaction.id)).toEqual([]);
    });
  });
});
