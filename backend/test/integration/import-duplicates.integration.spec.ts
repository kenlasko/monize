import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { withUserContext } from "@/common/db/with-context";
import { ImportModule } from "@/import/import.module";
import { ImportService } from "@/import/import.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * A file import compares its rows with the transactions already in the
 * account and writes a possible duplicate only on the person's decision
 * (INV-IMPORT-004, docs/specs/import-duplicate-review.md section 5), against a
 * real PostgreSQL enforcing RLS.
 */
describe("file import possible duplicates (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;

  let aliceId: string;
  let checkingId: string;
  let manualId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);

  const row = (fitId: string, date: string, amount: string, name: string) =>
    `<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>${date}\n<TRNAMT>${amount}\n` +
    `<FITID>${fitId}\n<NAME>${name}\n</STMTTRN>\n`;
  const ofx = (...rows: string[]) =>
    "OFXHEADER:100\n<OFX>\n<BANKMSGSRSV1>\n<STMTTRNRS>\n<STMTRS>\n" +
    `<BANKTRANLIST>\n${rows.join("")}</BANKTRANLIST>\n` +
    "</STMTRS>\n</STMTTRNRS>\n</BANKMSGSRSV1>\n</OFX>\n";

  /** The statement's line for the hydro bill entered by hand, and an unrelated one. */
  const HYDRO = row("20260115-1", "20260115", "-80.00", "HYDRO ONE");
  const FUEL = row("20260116-1", "20260116", "-20.00", "Fuel");

  const body = (
    content: string,
    duplicateDecisions?: Array<{
      row: number;
      transactionId: string;
      action: "import" | "merge" | "keep" | "replace";
    }>,
  ) =>
    ({
      content,
      accountId: checkingId,
      categoryMappings: [],
      accountMappings: [],
      duplicateDecisions,
    }) as never;

  const stored = () =>
    db.query(
      `SELECT id, payee_name, amount, status, external_id,
              TO_CHAR(transaction_date, 'YYYY-MM-DD') AS transaction_date
         FROM transactions WHERE account_id = $1
        ORDER BY transaction_date, payee_name`,
      [checkingId],
    ) as Promise<
      Array<{
        id: string;
        payee_name: string;
        amount: string;
        status: string;
        external_id: string | null;
        transaction_date: string;
      }>
    >;
  const balance = async (): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          checkingId,
        ])
      )[0].current_balance,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([ImportModule]);
    module = harness.module;
    db = harness.owner;
    importer = module.get(ImportService);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await cleanTables(db, [
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
    checkingId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 920,
      })
    ).id;
    [{ id: manualId }] = await db.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code, payee_name, status)
       VALUES ($1, $2, '2026-01-13', -80, 'USD', 'Hydro bill', 'UNRECONCILED')
       RETURNING id`,
      [aliceId, checkingId],
    );
  });

  it("lists the pair with the transaction it looks like, and writes nothing", async () => {
    const answer = await asAlice(() =>
      importer.findOfxDuplicates(aliceId, body(ofx(HYDRO, FUEL))),
    );
    expect(answer.rows).toEqual([
      expect.objectContaining({
        row: 0,
        transactionDate: "2026-01-15",
        amount: -80,
        existingTransaction: expect.objectContaining({
          id: manualId,
          transactionDate: "2026-01-13",
          payeeName: "Hydro bill",
        }),
      }),
    ]);
    expect(await stored()).toHaveLength(1);
  });

  it("keeps the transaction when nobody decided, imports the rest", async () => {
    const result = await asAlice(() =>
      importer.importOfxFile(aliceId, body(ofx(HYDRO, FUEL))),
    );
    expect(result.imported).toBe(1);
    expect(result.skippedRows).toEqual([
      expect.objectContaining({ reason: "possibleDuplicate", amount: -80 }),
    ]);
    expect((await stored()).map((r) => r.payee_name)).toEqual([
      "Hydro bill",
      "Fuel",
    ]);
    expect(await balance()).toBe(900);
  });

  it("merges: one row, the statement's date and bank id, Cleared; a second import of the statement skips it", async () => {
    const first = await asAlice(() =>
      importer.importOfxFile(
        aliceId,
        body(ofx(HYDRO, FUEL), [
          { row: 0, transactionId: manualId, action: "merge" },
        ]),
      ),
    );
    expect(first.duplicatesMerged).toBe(1);
    const rows = await stored();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: manualId,
      payee_name: "Hydro bill",
      transaction_date: "2026-01-15",
      status: "CLEARED",
      external_id: "ofx:20260115-1",
    });
    expect(await balance()).toBe(900);

    const again = await asAlice(() =>
      importer.importOfxFile(aliceId, body(ofx(HYDRO, FUEL))),
    );
    expect(again.imported).toBe(0);
    expect(again.skippedRows.map((r) => r.reason)).toEqual([
      "alreadyImported",
      "alreadyImported",
    ]);
  });

  it("delete-and-import replaces the transaction with the statement's row", async () => {
    const result = await asAlice(() =>
      importer.importOfxFile(
        aliceId,
        body(ofx(HYDRO), [
          { row: 0, transactionId: manualId, action: "replace" },
        ]),
      ),
    );
    expect(result).toMatchObject({ imported: 1, duplicatesReplaced: 1 });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(manualId);
    expect(rows[0].payee_name).toBe("HYDRO ONE");
    expect(await balance()).toBe(920);
    // The delete ran inside the import's transaction, which records no
    // history entry per row, so none was written into it before the commit.
    expect(
      await db.query(`SELECT id FROM action_history WHERE user_id = $1`, [
        aliceId,
      ]),
    ).toEqual([]);
  });

  it("refuses a decision about a pair that changed, with nothing written", async () => {
    await db.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code, payee_name, status)
       VALUES ($1, $2, '2026-01-15', -80, 'USD', 'Entered twice', 'UNRECONCILED')`,
      [aliceId, checkingId],
    );
    await expect(
      asAlice(() =>
        importer.importOfxFile(
          aliceId,
          body(ofx(HYDRO, FUEL), [
            { row: 0, transactionId: manualId, action: "merge" },
          ]),
        ),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await stored()).toHaveLength(2);
    expect(await balance()).toBe(920);
  });
});
