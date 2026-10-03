import { TestingModule } from "@nestjs/testing";
import { DataSource, EntityManager } from "typeorm";

import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";
import { MappedTransaction } from "@/import/mny/model/mny-import-model";
import { applyImportRules } from "@/import/mny/writers/apply-import-rules";
import { writeTransactions } from "@/import/mny/writers/write-transactions";
import { Tag } from "@/tags/entities/tag.entity";
import { TransactionStatus } from "@/transactions/entities/transaction.entity";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesApplierService } from "@/transaction-rules/transaction-rules-applier.service";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Import-trigger rules against a real PostgreSQL enforcing RLS (design 6.3,
 * INV-RULE-002): the QIF and multi-account QIF importers apply them inside each
 * row's savepoint, the `.mny` writer in one bulk pass inside its transaction,
 * and a rule with only the create trigger stays out of an import.
 */
describe("Transaction rules on the import paths (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let rules: TransactionRulesService;
  let applier: TransactionRulesApplierService;

  let aliceId: string;
  let accountId: string;
  let groceriesId: string;
  let tagId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const newRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
    ({
      name: "Biedronka",
      triggers: ["import"],
      condition: { field: "payeeText", op: "contains", value: "biedronka" },
      actions: [
        { type: "set_category", categoryId: groceriesId },
        { type: "add_tags", tagIds: [tagId] },
      ],
      ...over,
    }) as CreateTransactionRuleDto;

  const QIF =
    "!Type:Bank\nD01/15/2025\nT-50.00\nPBIEDRONKA 123\n^\n" +
    "D01/16/2025\nT-20.00\nPLidl\n^\n";
  const importQif = () =>
    asAlice(() =>
      importer.importQifFile(aliceId, {
        content: QIF,
        accountId,
        categoryMappings: [],
        accountMappings: [],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );

  const rows = () =>
    db.query(
      `SELECT id, payee_name, category_id FROM transactions ORDER BY transaction_date`,
    ) as Promise<
      Array<{ id: string; payee_name: string; category_id: string | null }>
    >;
  const tagLinks = async (): Promise<string[]> =>
    (
      (await db.query(`SELECT transaction_id FROM transaction_tags`)) as Array<{
        transaction_id: string;
      }>
    ).map((r) => r.transaction_id);
  const count = async (table: string): Promise<number> =>
    Number((await db.query(`SELECT COUNT(*)::int AS n FROM ${table}`))[0].n);

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      ImportModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    importer = module.get(ImportService);
    rules = module.get(TransactionRulesService);
    applier = module.get(TransactionRulesApplierService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
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
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    groceriesId = (await createTestCategory(db, aliceId, { name: "Groceries" }))
      .id;
    tagId = (
      await db.getRepository(Tag).save({ userId: aliceId, name: "food" })
    ).id;
  });

  describe("QIF / OFX / CSV (importParsedTransactions)", () => {
    it("tags and categorises the row whose raw payee text matches, and leaves the other alone", async () => {
      const rule = await asAlice(() => rules.create(aliceId, newRule()));

      const result = await importQif();

      expect(result.imported).toBe(2);
      expect(result.errors).toBe(0);
      expect(result.transactionsChangedByRules).toBe(1);
      const stored = await rows();
      expect(stored.map((r) => [r.payee_name, r.category_id])).toEqual([
        ["BIEDRONKA 123", groceriesId],
        ["Lidl", null],
      ]);
      expect(await tagLinks()).toEqual([stored[0].id]);
      const applications = await db.query(
        `SELECT rule_id, transaction_id, source FROM transaction_rule_applications`,
      );
      expect(applications).toEqual([
        {
          rule_id: rule.id,
          transaction_id: stored[0].id,
          source: "import",
        },
      ]);
      // I1: the amounts are what the file says.
      const amounts = await db.query(
        `SELECT amount FROM transactions ORDER BY transaction_date`,
      );
      expect(amounts.map((r: { amount: string }) => Number(r.amount))).toEqual([
        -50, -20,
      ]);
    });

    it("does not apply a rule that has only the create trigger", async () => {
      await asAlice(() =>
        rules.create(aliceId, newRule({ triggers: ["create"] } as never)),
      );

      const result = await importQif();

      expect(result.imported).toBe(2);
      expect(result.transactionsChangedByRules).toBeUndefined();
      expect((await rows()).every((r) => r.category_id === null)).toBe(true);
      expect(await count("transaction_tags")).toBe(0);
      expect(await count("transaction_rule_applications")).toBe(0);
    });

    it("leaves no rule effects for a row that fails after the rules ran, and keeps the other row", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));
      const real = applier.applyToNew.bind(applier);
      let calls = 0;
      jest
        .spyOn(applier, "applyToNew")
        .mockImplementation(async (...args: Parameters<typeof real>) => {
          const applied = await real(...args);
          if (++calls === 1) throw new Error("late failure");
          return applied;
        });

      const result = await importQif();

      expect(calls).toBe(2);
      expect(result.errors).toBe(1);
      expect(result.imported).toBe(1);
      // The failed row (BIEDRONKA, the first) is gone with its category, its
      // tag link and its trace; the second row is the only one stored.
      expect((await rows()).map((r) => r.payee_name)).toEqual(["Lidl"]);
      expect(await count("transaction_tags")).toBe(0);
      expect(await count("transaction_rule_applications")).toBe(0);
      expect(result.transactionsChangedByRules).toBeUndefined();
    });
  });

  describe("multi-account QIF", () => {
    it("applies the import rules to the rows of every account block", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));
      const content =
        "!Account\nNChecking Two\nTBank\n^\n!Type:Bank\nD01/15/2025\nT-50.00\nPBIEDRONKA 1\n^\n" +
        "D01/16/2025\nT-20.00\nPLidl\n^\n" +
        "!Account\nNSavings Two\nTBank\n^\n!Type:Bank\nD01/17/2025\nT-5.00\nPBiedronka 2\n^\n";

      const result = await asAlice(() =>
        importer.importQifMultiAccountFile(aliceId, {
          content,
          currencyCode: "USD",
          dateFormat: "MM/DD/YYYY",
        } as never),
      );

      expect(result.imported).toBe(3);
      expect(result.transactionsChangedByRules).toBe(2);
      const stored = await rows();
      expect(stored.map((r) => [r.payee_name, r.category_id])).toEqual([
        ["BIEDRONKA 1", groceriesId],
        ["Lidl", null],
        ["Biedronka 2", groceriesId],
      ]);
      expect(await count("transaction_tags")).toBe(2);
    });
  });

  describe("MNY bulk pass", () => {
    const mapped = (
      id: string,
      over: Partial<MappedTransaction> = {},
    ): MappedTransaction =>
      ({
        id,
        handle: 1,
        accountKey: "acct-1",
        transactionDate: "2025-01-15",
        amount: -50,
        currencyCode: "USD",
        status: TransactionStatus.UNRECONCILED,
        payeeHandle: 5,
        categoryHandle: null,
        description: null,
        referenceNumber: null,
        isTransfer: false,
        linkedTransactionId: null,
        splits: [],
        collapsedTradeHandle: null,
        ...over,
      }) as MappedTransaction;

    it("runs the rules over the regular rows written by writeTransactions, in the same transaction", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));
      const payeeId = (
        await db.query(
          `INSERT INTO payees (user_id, name) VALUES ($1, 'BIEDRONKA 123') RETURNING id`,
          [aliceId],
        )
      )[0].id as string;
      const ids = [
        "aaaaaaaa-0000-4000-8000-000000000001",
        "aaaaaaaa-0000-4000-8000-000000000002",
      ];
      const transactions = [
        mapped(ids[0]),
        mapped(ids[1], { payeeHandle: null, transactionDate: "2025-01-16" }),
      ];

      const { changed, affectedAccountIds } = await asAlice(() =>
        withScopedDb(harness.app, async (manager: EntityManager) => {
          const written = await writeTransactions(manager, aliceId, {
            transactions,
            accountIdByKey: new Map([["acct-1", accountId]]),
            categoryIdByHandle: new Map(),
            payeeIdByHandle: new Map([[5, payeeId]]),
            payeeNameByHandle: new Map([[5, "BIEDRONKA 123"]]),
          });
          return applyImportRules(manager, applier, aliceId, {
            transactions,
            writtenTransactionIds: written.writtenTransactionIds,
            payeeNameByHandle: new Map([[5, "BIEDRONKA 123"]]),
            investmentCashTransactionIds: new Set(),
          });
        }),
      );

      expect(changed).toBe(1);
      // A rule that only sets a category moves no other account's balance.
      expect(affectedAccountIds.size).toBe(0);
      const stored = await rows();
      expect(stored.map((r) => [r.id, r.category_id])).toEqual([
        [ids[0], groceriesId],
        [ids[1], null],
      ]);
      expect(await tagLinks()).toEqual([ids[0]]);
      expect(
        await db.query(
          `SELECT transaction_id, source FROM transaction_rule_applications`,
        ),
      ).toEqual([{ transaction_id: ids[0], source: "import" }]);
    });

    it("rolls the rule effects back with the transaction", async () => {
      await asAlice(() => rules.create(aliceId, newRule()));
      const id = "aaaaaaaa-0000-4000-8000-000000000003";
      const transactions = [mapped(id)];

      await expect(
        asAlice(() =>
          withScopedDb(harness.app, async (manager: EntityManager) => {
            const written = await writeTransactions(manager, aliceId, {
              transactions,
              accountIdByKey: new Map([["acct-1", accountId]]),
              categoryIdByHandle: new Map(),
              payeeIdByHandle: new Map(),
              payeeNameByHandle: new Map([[5, "BIEDRONKA 123"]]),
            });
            await applyImportRules(manager, applier, aliceId, {
              transactions,
              writtenTransactionIds: written.writtenTransactionIds,
              payeeNameByHandle: new Map([[5, "BIEDRONKA 123"]]),
              investmentCashTransactionIds: new Set(),
            });
            throw new Error("import failed after the rules");
          }),
        ),
      ).rejects.toThrow("import failed after the rules");

      expect(await count("transactions")).toBe(0);
      expect(await count("transaction_tags")).toBe(0);
      expect(await count("transaction_rule_applications")).toBe(0);
    });
  });
});
