import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportJob } from "@/import/mny/entities/import-job.entity";
import { MnyImportJobService } from "@/import/mny/mny-import-job.service";
import { MnyImportService } from "@/import/mny/mny-import.service";
import { MnyStagingService } from "@/import/mny/mny-staging.service";
import {
  kmyAccount,
  kmyFile,
  kmyPayee,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";
import { CreateTransactionRuleDto } from "@/transaction-rules/dto/create-transaction-rule.dto";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestPayee } from "../helpers/test-factories";

/**
 * Imported payee aliases are written after the import's own rule pass, with the
 * real rules applier and RLS enforced (spec 5.5.4, K13): a rule whose
 * `set_payee_from_text` renders a name an imported alias would claim must not
 * move this import's rows, which already carry the payee KMyMoney assigned.
 * The control runs the same rule with the alias already in the user's data and
 * shows the rule does move the row, so the first case is not passing vacuously.
 */
describe("KMyMoney payee aliases and the import rule pass (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let userId: string;
  let rules: TransactionRulesService;
  let staging: MnyStagingService;
  let importService: MnyImportService;
  let jobs: MnyImportJobService;

  const asUser = <T>(fn: () => Promise<T>) => withUserContext(userId, fn);

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([
      ImportModule,
      TransactionRulesModule,
    ]);
    module = harness.module;
    db = harness.owner;
    rules = module.get(TransactionRulesService);
    staging = module.get(MnyStagingService);
    importService = module.get(MnyImportService);
    jobs = module.get(MnyImportJobService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_rule_applications",
      "transaction_rules",
      "import_jobs",
      "import_staged_files",
      "transaction_splits",
      "transactions",
      "monthly_account_balances",
      "accounts",
      "categories",
      "payee_aliases",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
  });

  /** Checking, Utilities; a Corner Market row (matching off) and a City Power row (key CITY POWER). */
  const file = () =>
    toKmyBytes(
      kmyFile({
        accounts: [
          kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
          kmyAccount({
            id: "A000002",
            name: "Utilities",
            type: 13,
            parentaccount: "AStd::Expense",
          }),
        ],
        payees: [
          kmyPayee({ id: "P1", name: "Corner Market" }),
          kmyPayee({
            id: "P2",
            name: "City Power",
            matchingenabled: 1,
            usingmatchkey: 1,
            matchignorecase: 1,
            matchkey: "CITY POWER\n",
          }),
        ],
        transactions: ["P1", "P2"].map((payee, index) =>
          kmyTransaction(
            [
              kmySplit({
                id: "S0001",
                account: "A000001",
                value: "-10/1",
                shares: "-10/1",
                payee,
              }),
              kmySplit({
                id: "S0002",
                account: "A000002",
                value: "10/1",
                shares: "10/1",
                payee,
              }),
            ],
            { id: kmyTxId(index + 1), postdate: `2024-01-1${index}` },
          ),
        ),
      }),
      "gzip",
    );

  async function importFile(): Promise<ImportJob> {
    const staged = await asUser(() =>
      staging.stage(userId, {
        filename: "books.kmy",
        data: file(),
        sourceFormat: "kmy",
      }),
    );
    const started = await asUser(() =>
      importService.start(userId, {
        stagedFileId: staged.id,
        options: { bills: [] },
        sourceFormat: "kmy",
      }),
    );
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const job = await asUser(() => jobs.findOne(userId, started.id));
      if (job && job.status !== "pending" && job.status !== "running") {
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("import job did not finish");
  }

  const payeeNames = async (): Promise<string[]> =>
    (
      (await db.query(
        `SELECT payee_name FROM transactions WHERE user_id = $1 ORDER BY transaction_date`,
        [userId],
      )) as { payee_name: string | null }[]
    ).map((row) => row.payee_name ?? "");

  /** On Corner Market's rows, set the payee from text "CITY POWER X"; never create one. */
  const moveCornerMarketRule = () =>
    asUser(() =>
      rules.create(userId, {
        name: "Corner Market to whoever CITY POWER X is",
        triggers: ["import"],
        condition: { field: "payeeText", op: "eq", value: "Corner Market" },
        actions: [
          {
            type: "set_payee_from_text",
            template: "CITY POWER X",
            createIfMissing: false,
            onlyIfEmpty: false,
          },
        ],
      } as CreateTransactionRuleDto),
    );

  it("keeps the payee KMyMoney assigned: the aliases are written after the rule pass", async () => {
    await moveCornerMarketRule();

    const job = await importFile();

    expect(job.status).toBe("completed");
    // The alias was written ...
    expect(
      await db.query(`SELECT alias FROM payee_aliases WHERE user_id = $1`, [
        userId,
      ]),
    ).toEqual([{ alias: "*CITY POWER*" }]);
    // ... but not before the rule pass, so "CITY POWER X" resolved to nothing,
    // createIfMissing left it so, and the row keeps its payee.
    expect(await payeeNames()).toEqual(["Corner Market", "City Power"]);
    expect(
      await db.query(`SELECT 1 FROM transaction_rule_applications`),
    ).toEqual([]);
  });

  it("control: with the alias already in the user's data, the same rule does move the row", async () => {
    const power = await createTestPayee(db, userId, { name: "City Power" });
    await db.query(
      `INSERT INTO payee_aliases (payee_id, user_id, alias) VALUES ($1, $2, '*CITY POWER*')`,
      [power.id, userId],
    );
    await moveCornerMarketRule();

    const job = await importFile();

    expect(job.status).toBe("completed");
    expect(await payeeNames()).toEqual(["City Power", "City Power"]);
  });
});
