import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The issue #2445 repair of the cash legs the QIF/OFX/CSV importer wrote for a
 * brokerage with a linked cash account before issue #2436: the investment row
 * named a brokerage-side transfer counterpart instead of the cash row. The
 * migration points the investment row at the cash row, clears the cash row's
 * transfer link, deletes the counterpart and reverses what it contributed to
 * the brokerage's balance (nothing for a VOID or future-dated one), moves its
 * tags, drops the brokerage's derived monthly balances, skips a counterpart
 * something is attached to, leaves every other shape alone, and changes
 * nothing on a second run.
 *
 * A real database and the migration read from disk, since the assertion is
 * about what its SQL does to the rows.
 */
describe("migration 20261126140130_heal_imported_investment_cash_leg_shape.sql", () => {
  let dataSource: DataSource;
  let userId: string;
  let cashAccountId: string;
  let brokerageId: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations",
    "20261126140130_heal_imported_investment_cash_leg_shape.sql",
  );

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  const insertTransaction = async (row: {
    accountId: string;
    amount: number;
    date: string;
    status: string;
    isTransfer: boolean;
  }): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          status, is_transfer)
       VALUES ($1, $2, $3, $4, 'CAD', $5, $6)
       RETURNING id`,
      [userId, row.accountId, row.date, row.amount, row.status, row.isTransfer],
    )) as { id: string }[];
    return id;
  };

  const insertInvestment = async (
    transactionId: string,
    date: string,
    amount: number,
  ): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, transaction_id, action, transaction_date,
          total_amount)
       VALUES ($1, $2, $3, 'DIVIDEND', $4, $5)
       RETURNING id`,
      [userId, brokerageId, transactionId, date, amount],
    )) as { id: string }[];
    return id;
  };

  /**
   * An imported dividend as the importer wrote it before #2436: the cash row
   * in the linked cash account, a counterpart in the brokerage, mutually
   * linked, and the investment row naming the counterpart.
   */
  const seedOldShape = async ({
    amount = 100,
    date = "2026-08-14",
    status = "UNRECONCILED",
  }: { amount?: number; date?: string; status?: string } = {}) => {
    const cashId = await insertTransaction({
      accountId: cashAccountId,
      amount,
      date,
      status,
      isTransfer: true,
    });
    const counterpartId = await insertTransaction({
      accountId: brokerageId,
      amount: -amount,
      date,
      status,
      isTransfer: true,
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = CASE id
         WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [cashId, counterpartId],
    );
    const investmentId = await insertInvestment(counterpartId, date, amount);
    return { cashId, counterpartId, investmentId };
  };

  const setBalance = (accountId: string, balance: number) =>
    dataSource.query("UPDATE accounts SET current_balance = $2 WHERE id = $1", [
      accountId,
      balance,
    ]);

  const balanceOf = async (accountId: string): Promise<number> => {
    const [row] = (await dataSource.query(
      "SELECT current_balance FROM accounts WHERE id = $1",
      [accountId],
    )) as { current_balance: string }[];
    return Number(row.current_balance);
  };

  const transactionOf = async (id: string) => {
    const [row] = (await dataSource.query(
      `SELECT is_transfer, linked_transaction_id, amount, status, updated_at
         FROM transactions WHERE id = $1`,
      [id],
    )) as {
      is_transfer: boolean;
      linked_transaction_id: string | null;
      amount: string;
      status: string;
      updated_at: Date;
    }[];
    return row;
  };

  const cashLegOf = async (investmentId: string): Promise<string | null> => {
    const [row] = (await dataSource.query(
      "SELECT transaction_id FROM investment_transactions WHERE id = $1",
      [investmentId],
    )) as { transaction_id: string | null }[];
    return row.transaction_id;
  };

  beforeAll(async () => {
    if (!fs.existsSync(MIGRATION)) {
      throw new Error(`Migration not found at ${MIGRATION}`);
    }
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await applyRlsPolicies(dataSource);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "monthly_account_balances",
      "transaction_attachments",
      "transaction_tags",
      "tags",
      "investment_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    cashAccountId = (
      await createTestAccount(dataSource, userId, {
        name: "Brokerage - Cash",
        accountType: "INVESTMENT",
        currencyCode: "CAD",
      })
    ).id;
    brokerageId = (
      await createTestAccount(dataSource, userId, {
        name: "Brokerage",
        accountType: "INVESTMENT",
        currencyCode: "CAD",
      })
    ).id;
    await dataSource.query(
      `UPDATE accounts SET account_sub_type = CASE id
           WHEN $1::uuid THEN 'INVESTMENT_CASH'
           WHEN $2::uuid THEN 'INVESTMENT_BROKERAGE' END,
         linked_account_id = CASE id
           WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [cashAccountId, brokerageId],
    );
  });

  it("points the investment row at the cash row, unlinks it, deletes the counterpart and reverses its balance, twice", async () => {
    const { cashId, counterpartId, investmentId } = await seedOldShape();
    // What the post-import recalculation left: the cash account holds the
    // dividend and the brokerage the phantom counterpart.
    await setBalance(cashAccountId, 100);
    await setBalance(brokerageId, -100);
    const [{ id: tagId }] = (await dataSource.query(
      "INSERT INTO tags (user_id, name) VALUES ($1, 'Taxable') RETURNING id",
      [userId],
    )) as { id: string }[];
    await dataSource.query(
      "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)",
      [counterpartId, tagId],
    );
    await dataSource.query(
      `INSERT INTO monthly_account_balances (user_id, account_id, month, balance)
       VALUES ($1, $2, '2026-08-01', -100), ($1, $3, '2026-08-01', 100)`,
      [userId, brokerageId, cashAccountId],
    );

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(cashId);
    const cash = await transactionOf(cashId);
    expect(cash.is_transfer).toBe(false);
    expect(cash.linked_transaction_id).toBeNull();
    expect(Number(cash.amount)).toBe(100);
    expect(await transactionOf(counterpartId)).toBeUndefined();
    expect(await balanceOf(brokerageId)).toBe(0);
    expect(await balanceOf(cashAccountId)).toBe(100);
    expect(
      await dataSource.query(
        "SELECT tag_id FROM transaction_tags WHERE transaction_id = $1",
        [cashId],
      ),
    ).toEqual([{ tag_id: tagId }]);
    const snapshots = (await dataSource.query(
      "SELECT account_id FROM monthly_account_balances",
    )) as { account_id: string }[];
    expect(snapshots.map((s) => s.account_id)).toEqual([cashAccountId]);

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(cashId);
    // Never touched again, so not even its updated_at moved.
    expect(await transactionOf(cashId)).toEqual(cash);
    expect(await balanceOf(brokerageId)).toBe(0);
    expect(await balanceOf(cashAccountId)).toBe(100);
  });

  it("deletes a VOID and a future-dated counterpart without moving the balance either never entered", async () => {
    const voided = await seedOldShape({ status: "VOID" });
    const future = await seedOldShape({ date: "2999-01-01", amount: 40 });
    const counted = await seedOldShape({ amount: 25 });
    await setBalance(brokerageId, -25);

    await applyMigration();

    for (const row of [voided, future, counted]) {
      expect(await cashLegOf(row.investmentId)).toBe(row.cashId);
      expect(await transactionOf(row.counterpartId)).toBeUndefined();
    }
    // The VOID cash row keeps its status: VOID moved no balance and still
    // moves none (INV-TRANSFER-001).
    expect((await transactionOf(voided.cashId)).status).toBe("VOID");
    expect(await balanceOf(brokerageId)).toBe(0);
  });

  it("leaves a counterpart with an attachment in place", async () => {
    const { cashId, counterpartId, investmentId } = await seedOldShape();
    await setBalance(brokerageId, -100);
    await dataSource.query(
      `INSERT INTO transaction_attachments
         (user_id, transaction_id, filename, content_type, byte_size, sha256,
          storage_key)
       VALUES ($1, $2, 'slip.pdf', 'application/pdf', 1, repeat('0', 64), 'k')`,
      [userId, counterpartId],
    );

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(counterpartId);
    expect((await transactionOf(cashId)).linked_transaction_id).toBe(
      counterpartId,
    );
    expect(await transactionOf(counterpartId)).toBeDefined();
    expect(await balanceOf(brokerageId)).toBe(-100);
  });

  it("leaves the shape the native writer produces alone", async () => {
    const cashId = await insertTransaction({
      accountId: cashAccountId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: false,
    });
    const investmentId = await insertInvestment(cashId, "2026-08-14", 100);
    const before = await transactionOf(cashId);

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(cashId);
    expect(await transactionOf(cashId)).toEqual(before);
  });

  it("leaves a pair whose cash half is outside the brokerage's linked cash account alone", async () => {
    // A transfer between the brokerage and some other account is a real
    // transfer, not the importer's cash leg, whatever names it.
    const otherId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        currencyCode: "CAD",
      })
    ).id;
    const otherLeg = await insertTransaction({
      accountId: otherId,
      amount: 100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    const brokerageLeg = await insertTransaction({
      accountId: brokerageId,
      amount: -100,
      date: "2026-08-14",
      status: "UNRECONCILED",
      isTransfer: true,
    });
    await dataSource.query(
      `UPDATE transactions SET linked_transaction_id = CASE id
         WHEN $1::uuid THEN $2::uuid WHEN $2::uuid THEN $1::uuid END
       WHERE id IN ($1, $2)`,
      [otherLeg, brokerageLeg],
    );
    const investmentId = await insertInvestment(
      brokerageLeg,
      "2026-08-14",
      100,
    );
    await setBalance(brokerageId, -100);

    await applyMigration();

    expect(await cashLegOf(investmentId)).toBe(brokerageLeg);
    expect((await transactionOf(otherLeg)).is_transfer).toBe(true);
    expect(await balanceOf(brokerageId)).toBe(-100);
  });
});
