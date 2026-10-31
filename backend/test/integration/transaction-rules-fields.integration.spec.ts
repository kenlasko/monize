import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import {
  ActionHistoryService,
  settlePendingHistoryWrites,
} from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { Tag } from "@/tags/entities/tag.entity";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesRunService } from "@/transaction-rules/transaction-rules-run.service";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The X3 condition fields (design 10.3) against a real PostgreSQL enforcing
 * RLS: `referenceNumber`, `dayOfMonth` and `hasAttachment` in a manual run over
 * existing rows, and `status` at create.
 *
 * What a mocked manager cannot show: the attachment presence really comes from
 * one query over `transaction_attachments` with a scanned document's hidden
 * original left out, the calendar date is read from the DATE column as text
 * (the session timezone cannot move it), and the trace and the tag land on the
 * rows the rule matched, in the caller's transaction.
 */
describe("Transaction rules: condition fields (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let rules: TransactionRulesService;
  let run: TransactionRulesRunService;

  let aliceId: string;
  let accountId: string;
  let tagId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const tagRule = (
    condition: unknown,
    triggers: Array<"create" | "import"> = ["create"],
  ) =>
    ({
      name: "Tag matches",
      triggers,
      condition,
      actions: [{ type: "add_tags", tagIds: [tagId] }],
    }) as unknown as CreateTransactionRuleDto;

  const create = (over: Record<string, unknown>) =>
    asAlice(() =>
      transactions.create(aliceId, {
        accountId,
        transactionDate: "2026-03-10",
        amount: -50,
        currencyCode: "USD",
        payeeName: "SHOP",
        ...over,
      } as never),
    );

  const tagged = async (): Promise<string[]> =>
    (
      await db.query(
        `SELECT transaction_id FROM transaction_tags WHERE tag_id = $1 ORDER BY transaction_id`,
        [tagId],
      )
    ).map((r: { transaction_id: string }) => r.transaction_id);

  /** A visible attachment, and with `withOriginal` the hidden original of a scan pair. */
  const attach = async (transactionId: string, withOriginal = false) => {
    const insert = (name: string, originalOf: string | null) =>
      db.query(
        `INSERT INTO transaction_attachments
           (user_id, transaction_id, filename, content_type, byte_size, sha256, storage_key, original_of_attachment_id)
         VALUES ($1, $2, $3, 'image/png', 10, $4, $5, $6) RETURNING id`,
        [
          aliceId,
          transactionId,
          name,
          "a".repeat(64),
          `${name}-${transactionId}`,
          originalOf,
        ],
      ) as Promise<Array<{ id: string }>>;
    const [visible] = await insert("receipt.png", null);
    if (withOriginal) await insert("original.png", visible.id);
  };

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
    module.get(ActionHistoryService, { strict: false });
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
      "transaction_attachments",
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
    tagId = (await db.getRepository(Tag).save({ userId: aliceId, name: "hit" }))
      .id;
  });

  it("a manual run matches existing rows on the reference number", async () => {
    const check = await create({ referenceNumber: "CHK-1001" });
    const other = await create({ referenceNumber: "INV-7" });
    const none = await create({});
    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({ field: "referenceNumber", op: "startsWith", value: "chk-" }),
      ),
    );
    // The create-time rule ran on none of them: they were written before it.
    expect(await tagged()).toEqual([]);

    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(preview.matched.map((r) => r.transactionId)).toEqual([check.id]);
    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );

    expect(await tagged()).toEqual([check.id]);
    expect(await tagged()).not.toContain(other.id);
    expect(await tagged()).not.toContain(none.id);

    const empty = await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({ field: "referenceNumber", op: "isEmpty" }),
      ),
    );
    const emptyPreview = await asAlice(() =>
      run.previewRun(aliceId, empty.id, {}),
    );
    expect(emptyPreview.matched.map((r) => r.transactionId)).toEqual([none.id]);
  });

  it("a manual run matches on the day of the month, month boundaries included, whatever the session timezone", async () => {
    const jan31 = await create({ transactionDate: "2026-01-31" });
    const mar01 = await create({ transactionDate: "2026-03-01" });
    const feb28 = await create({ transactionDate: "2026-02-28" });
    const apr30 = await create({ transactionDate: "2026-04-30" });
    const mid = await create({ transactionDate: "2026-03-15" });

    const ids = async (condition: unknown): Promise<string[]> => {
      const rule = await asAlice(() =>
        rules.create(aliceId, tagRule(condition)),
      );
      const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
      return preview.matched.map((r) => r.transactionId).sort();
    };

    expect(await ids({ field: "dayOfMonth", op: "eq", value: 1 })).toEqual([
      mar01.id,
    ]);
    expect(await ids({ field: "dayOfMonth", op: "eq", value: 31 })).toEqual([
      jan31.id,
    ]);
    expect(
      await ids({ field: "dayOfMonth", op: "between", value: [28, 31] }),
    ).toEqual([jan31.id, feb28.id, apr30.id].sort());
    expect(
      await ids({ field: "dayOfMonth", op: "in", value: [15, 30] }),
    ).toEqual([mid.id, apr30.id].sort());
    // 2026-01-31 and 2026-02-28 are Saturdays; 2026-03-01 and 2026-03-15 are
    // Sundays; 2026-04-30 is a Thursday.
    expect(await ids({ field: "weekday", op: "eq", value: "SUN" })).toEqual(
      [mar01.id, mid.id].sort(),
    );
    expect(
      await ids({ field: "weekday", op: "in", value: ["SAT", "SUN"] }),
    ).toEqual([jan31.id, feb28.id, mar01.id, mid.id].sort());
    expect(await ids({ field: "weekday", op: "eq", value: "THU" })).toEqual([
      apr30.id,
    ]);
  });

  it("a manual run matches on attachment presence: a scan pair counts once, a row without one is false", async () => {
    const plain = await create({});
    const receipt = await create({});
    const scanned = await create({});
    await attach(receipt.id);
    await attach(scanned.id, true);

    const ids = async (value: boolean): Promise<string[]> => {
      const rule = await asAlice(() =>
        rules.create(
          aliceId,
          tagRule({ field: "hasAttachment", op: "eq", value }),
        ),
      );
      const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
      return preview.matched.map((r) => r.transactionId).sort();
    };

    expect(await ids(true)).toEqual([receipt.id, scanned.id].sort());
    expect(await ids(false)).toEqual([plain.id]);

    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({ field: "hasAttachment", op: "eq", value: true }),
      ),
    );
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    await asAlice(() =>
      run.run(aliceId, rule.id, { fingerprint: preview.fingerprint }),
    );
    expect(await tagged()).toEqual([receipt.id, scanned.id].sort());
  });

  it("refuses an original on another transaction without making that transaction match attachment rules", async () => {
    const a = await create({});
    const b = await create({});
    const [visible] = (await db.query(
      `INSERT INTO transaction_attachments
         (user_id, transaction_id, filename, content_type, byte_size, sha256, storage_key)
       VALUES ($1, $2, 'v.png', 'image/png', 10, $3, 'v') RETURNING id`,
      [aliceId, a.id, "b".repeat(64)],
    )) as Array<{ id: string }>;
    // Scan pairs now share a parent at the database boundary. A rejected
    // cross-parent original must neither persist nor make b match the rule.
    await expect(
      db.query(
        `INSERT INTO transaction_attachments
         (user_id, transaction_id, filename, content_type, byte_size, sha256, storage_key, original_of_attachment_id)
       VALUES ($1, $2, 'o.png', 'image/png', 10, $3, 'o', $4)`,
        [aliceId, b.id, "c".repeat(64), visible.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await db.query(
        "SELECT id FROM transaction_attachments WHERE transaction_id = $1",
        [b.id],
      ),
    ).toEqual([]);
    const rule = await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({ field: "hasAttachment", op: "eq", value: true }),
      ),
    );
    const preview = await asAlice(() => run.previewRun(aliceId, rule.id, {}));
    expect(preview.matched.map((r) => r.transactionId)).toEqual([a.id]);
  });

  it("status at create: a rule on CLEARED tags a cleared row and leaves the unreconciled one", async () => {
    await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({
          field: "status",
          op: "in",
          value: ["CLEARED", "RECONCILED"],
        }),
      ),
    );
    const cleared = await create({ status: "CLEARED" });
    const open = await create({});
    const reconciled = await create({ status: "RECONCILED" });

    expect(await tagged()).toEqual([cleared.id, reconciled.id].sort());
    expect(await tagged()).not.toContain(open.id);
    const [application] = await db.query(
      `SELECT source FROM transaction_rule_applications WHERE transaction_id = $1`,
      [cleared.id],
    );
    expect(application.source).toBe("create");
  });

  it("create-time rules read the reference and the calendar date of the new row; a new row has no attachment", async () => {
    await asAlice(() =>
      rules.create(
        aliceId,
        tagRule({
          all: [
            { field: "referenceNumber", op: "eq", value: "chk-9" },
            { field: "dayOfMonth", op: "eq", value: 1 },
            { field: "weekday", op: "eq", value: "SUN" },
            { field: "hasAttachment", op: "eq", value: false },
          ],
        }),
      ),
    );
    const hit = await create({
      referenceNumber: "CHK-9",
      transactionDate: "2026-03-01",
    });
    const wrongDay = await create({
      referenceNumber: "CHK-9",
      transactionDate: "2026-03-02",
    });
    expect(await tagged()).toEqual([hit.id]);
    expect(await tagged()).not.toContain(wrongDay.id);
  });
});
