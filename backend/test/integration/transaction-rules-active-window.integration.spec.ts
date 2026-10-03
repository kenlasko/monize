import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

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
 * INV-RULE-004 against a real PostgreSQL enforcing RLS: a rule with
 * `activeFrom = 2026-10-01` never touches a row dated 2026-09-07 -- on create
 * and in a manual run -- the DATE columns read back as `YYYY-MM-DD` strings,
 * and an empty window is refused before anything is written, and, past the
 * DTO, by the database's own CHECK (`ck_transaction_rules_active_window`,
 * declared on the entity as well as in the migration and `schema.sql`, so this
 * suite's entity-built schema carries it).
 */
describe("Transaction rules active window (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let run: TransactionRulesRunService;

  let aliceId: string;
  let checkingId: string;
  let loansId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const mortgageRule = (over: Partial<CreateTransactionRuleDto> = {}) =>
    ({
      name: "Mortgage",
      triggers: ["create"],
      condition: { field: "payeeText", op: "contains", value: "kapital" },
      actions: [{ type: "set_category", categoryId: loansId }],
      activeFrom: "2026-10-01",
      ...over,
    }) as CreateTransactionRuleDto;

  const create = (transactionDate: string) =>
    asAlice(() =>
      transactions.create(aliceId, {
        accountId: checkingId,
        transactionDate,
        amount: -102.21,
        currencyCode: "USD",
        payeeName: "KAPITAL: 0,00 ODSETKI: 102,21",
      } as never),
    );

  const categoryOf = async (id: string): Promise<string | null> =>
    (
      await db.query(`SELECT category_id FROM transactions WHERE id = $1`, [id])
    )[0].category_id;

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      TransactionsModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    transactions = module.get(TransactionsService);
    rules = module.get(TransactionRulesService);
    run = module.get(TransactionRulesRunService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "action_history",
      "user_preferences",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    checkingId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    loansId = (await createTestCategory(db, aliceId, { name: "Loans" })).id;
  });

  it("stores the window and reads it back as YYYY-MM-DD strings", async () => {
    const created = await asAlice(() =>
      rules.create(aliceId, mortgageRule({ activeTo: "2026-12-31" })),
    );
    expect(created).toMatchObject({
      activeFrom: "2026-10-01",
      activeTo: "2026-12-31",
    });
    const [listed] = await asAlice(() => rules.list(aliceId));
    expect(listed).toMatchObject({
      activeFrom: "2026-10-01",
      activeTo: "2026-12-31",
    });
    const cleared = await asAlice(() =>
      rules.update(aliceId, created.id, {
        revision: created.revision,
        activeFrom: null,
      }),
    );
    expect(cleared).toMatchObject({
      activeFrom: null,
      activeTo: "2026-12-31",
      revision: created.revision + 1,
    });
  });

  it("leaves a row dated before activeFrom unchanged on create, and changes one inside the window", async () => {
    await asAlice(() => rules.create(aliceId, mortgageRule()));

    const before = await create("2026-09-07");
    const inside = await create("2026-10-05");
    const boundary = await create("2026-10-01");

    expect(await categoryOf(before.id)).toBeNull();
    expect(await categoryOf(inside.id)).toBe(loansId);
    expect(await categoryOf(boundary.id)).toBe(loansId);
    const applications = await db.query(
      `SELECT transaction_id FROM transaction_rule_applications`,
    );
    expect(
      applications
        .map((a: { transaction_id: string }) => a.transaction_id)
        .sort(),
    ).toEqual([inside.id, boundary.id].sort());
  });

  it("a manual run scans and changes only rows inside the window", async () => {
    const old = await create("2026-09-07");
    const rule = await asAlice(() =>
      rules.create(aliceId, mortgageRule({ triggers: ["import"] })),
    );
    const inside = await create("2026-10-05");

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(preview.scanned).toBe(1);
    expect(preview.matched.map((m) => m.transactionId)).toEqual([inside.id]);

    // A filter that asks for the old row never widens the window.
    const wide = await asAlice(() =>
      run.previewRun(aliceId, rule.id, { startDate: "2026-01-01" }),
    );
    expect(wide.matched.map((m) => m.transactionId)).toEqual([inside.id]);
    const outside = await asAlice(() =>
      run.previewRun(aliceId, rule.id, { endDate: "2026-09-30" }),
    );
    expect(outside).toMatchObject({ scanned: 0, matched: [] });

    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );
    expect(await categoryOf(old.id)).toBeNull();
    expect(await categoryOf(inside.id)).toBe(loansId);
  });

  it("a draft test honours the window it is given", async () => {
    const old = await create("2026-09-07");
    const inside = await create("2026-10-05");
    const draft = {
      condition: { field: "payeeText", op: "contains", value: "kapital" },
      actions: [{ type: "set_category", categoryId: loansId }],
    };

    const open = await asAlice(() => run.previewDraft(aliceId, draft));
    expect(open.matched.map((m) => m.transactionId).sort()).toEqual(
      [old.id, inside.id].sort(),
    );
    const windowed = await asAlice(() =>
      run.previewDraft(aliceId, { ...draft, activeFrom: "2026-10-01" }),
    );
    expect(windowed.matched.map((m) => m.transactionId)).toEqual([inside.id]);
  });

  it("refuses an inverted window before writing", async () => {
    await expect(
      asAlice(() =>
        rules.create(
          aliceId,
          mortgageRule({ activeFrom: "2026-12-31", activeTo: "2026-10-01" }),
        ),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: "ACTIVE_WINDOW_INVALID" }),
    });
    expect(await asAlice(() => rules.list(aliceId))).toEqual([]);
  });

  it("the database itself refuses an inverted window the DTO missed", async () => {
    const insert = (from: string | null, to: string | null) =>
      db.query(
        `INSERT INTO transaction_rules
           (user_id, name, position, triggers, condition, actions, active_from, active_to)
         VALUES ($1, 'Raw', 0, ARRAY['create'], '{}'::jsonb, '[]'::jsonb, $2, $3)`,
        [aliceId, from, to],
      );
    await expect(insert("2026-12-31", "2026-10-01")).rejects.toMatchObject({
      constraint: "ck_transaction_rules_active_window",
    });
    // Either side open, or an equal pair, is a valid window.
    await expect(insert("2026-10-01", null)).resolves.toBeDefined();
    await db.query(`DELETE FROM transaction_rules`);
    await expect(insert("2026-10-01", "2026-10-01")).resolves.toBeDefined();
  });
});
