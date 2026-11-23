import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import { fxBaseFromCharged } from "@/common/foreign-entry.util";
import { roundFxRate } from "@/common/fx-entry.util";
import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * The issue #2358 heal over the rows the old update path left behind: a plain
 * transaction given originalAmount and originalCurrencyCode without a rate kept
 * the column's default exchange_rate 1 and its own account-currency amount.
 * Since #2344 the reports read that 1 as a recorded rate, so the migration
 * rewrites it to the rate the row's two amounts imply, and leaves every 1 the
 * amounts agree with.
 *
 * The assertion is about what a SQL predicate concludes from rows the old code
 * wrote, so the fixture is a real database and the migration is read from disk.
 * The expected rates come from fxBaseFromCharged and roundFxRate, the code the
 * migration restates, so the two cannot drift apart.
 */
describe("migration 20261123221734 heals a foreign entry's inherited default rate", () => {
  let dataSource: DataSource;
  let userId: string;
  let plainCardId: string;
  let feeCardId: string;
  let fullFeeCardId: string;

  const MIGRATION = path.join(
    __dirname,
    "../../../database/migrations/20261123221734_heal_foreign_entry_default_rate.sql",
  );

  const applyMigration = () =>
    dataSource.query(fs.readFileSync(MIGRATION, "utf8"));

  /** A transaction as the old update path could leave it: no rate check. */
  const seed = async (row: {
    accountId: string;
    amount: number;
    originalAmount: number | null;
    originalCurrencyCode: string | null;
    exchangeRate: number;
  }): Promise<string> => {
    const [{ id }] = (await dataSource.query(
      `INSERT INTO transactions
         (user_id, account_id, transaction_date, amount, currency_code,
          exchange_rate, original_amount, original_currency_code)
       VALUES ($1, $2, '2026-08-14', $3, 'USD', $4, $5, $6)
       RETURNING id`,
      [
        userId,
        row.accountId,
        row.amount,
        row.exchangeRate,
        row.originalAmount,
        row.originalCurrencyCode,
      ],
    )) as { id: string }[];
    return id;
  };

  const rowOf = async (id: string) => {
    const [row] = (await dataSource.query(
      `SELECT exchange_rate, amount, original_amount
         FROM transactions WHERE id = $1`,
      [id],
    )) as {
      exchange_rate: string;
      amount: string;
      original_amount: string | null;
    }[];
    return {
      rate: Number(row.exchange_rate),
      amount: Number(row.amount),
      originalAmount:
        row.original_amount === null ? null : Number(row.original_amount),
    };
  };

  /** What resolveForeignEntry derives from the two amounts and the fee. */
  const derivedRate = (amount: number, original: number, fee: number | null) =>
    roundFxRate(fxBaseFromCharged(amount, fee, 4) / original);

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
      "transaction_splits",
      "transactions",
      "accounts",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES
         ('EUR', 'Euro', 'E', 2),
         ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    plainCardId = (
      await createTestAccount(dataSource, userId, {
        name: "US Card",
        currencyCode: "USD",
      })
    ).id;
    feeCardId = (
      await createTestAccount(dataSource, userId, {
        name: "US Travel Card",
        currencyCode: "USD",
      })
    ).id;
    fullFeeCardId = (
      await createTestAccount(dataSource, userId, {
        name: "US Prepaid",
        currencyCode: "USD",
      })
    ).id;
    await dataSource.query(
      `UPDATE accounts SET fx_fee_percent = CASE id
         WHEN $1::uuid THEN 2.5 WHEN $2::uuid THEN 100 END
       WHERE id IN ($1, $2)`,
      [feeCardId, fullFeeCardId],
    );
  });

  it("rewrites the inherited 1 to the rate the two amounts imply", async () => {
    // EUR 100 added to a USD 117.50 row without a rate: read at the stored 1
    // it was EUR 117.50; at the amounts' own 1.175 it is EUR 100.
    const id = await seed({
      accountId: plainCardId,
      amount: -117.5,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });

    await applyMigration();

    expect(await rowOf(id)).toEqual({
      rate: 1.175,
      amount: -117.5,
      originalAmount: -100,
    });
  });

  it("backs the account's fee out of an expense and an income alike", async () => {
    const expense = await seed({
      accountId: feeCardId,
      amount: -120.44,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });
    const income = await seed({
      accountId: feeCardId,
      amount: 114.56,
      originalAmount: 100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });

    await applyMigration();

    // -120.44 / 1.025 = -117.5024 before the fee; 114.56 / 0.975 = 117.4974.
    expect((await rowOf(expense)).rate).toBe(derivedRate(-120.44, -100, 2.5));
    expect((await rowOf(expense)).rate).toBe(1.175024);
    expect((await rowOf(income)).rate).toBe(derivedRate(114.56, 100, 2.5));
    expect((await rowOf(income)).rate).toBe(1.174974);
    expect((await rowOf(expense)).amount).toBe(-120.44);
    expect((await rowOf(income)).amount).toBe(114.56);
  });

  it("keeps every 1 the amounts agree with, the fee included", async () => {
    // EUR 100 charged as USD 100 (issue #2344's recorded 1:1), the same with
    // the 2.5% fee folded in, and one cent of rounding inside the tolerance.
    const atPar = await seed({
      accountId: plainCardId,
      amount: -100,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });
    const atParWithFee = await seed({
      accountId: feeCardId,
      amount: -102.5,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });
    const withinACent = await seed({
      accountId: plainCardId,
      amount: -100.01,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });

    await applyMigration();

    expect((await rowOf(atPar)).rate).toBe(1);
    expect((await rowOf(atParWithFee)).rate).toBe(1);
    expect((await rowOf(withinACent)).rate).toBe(1);
  });

  it("leaves a plain row, a recorded rate and the rows no rate can come from", async () => {
    const plain = await seed({
      accountId: plainCardId,
      amount: -50,
      originalAmount: null,
      originalCurrencyCode: null,
      exchangeRate: 1,
    });
    const ownRate = await seed({
      accountId: plainCardId,
      amount: -120,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1.2,
    });
    const zeroCharged = await seed({
      accountId: plainCardId,
      amount: 0,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });
    // An income on a 100% fee: the base behind it is a division by zero,
    // which must skip the row rather than abort the migration.
    const fullFeeIncome = await seed({
      accountId: fullFeeCardId,
      amount: 50,
      originalAmount: 100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });

    await applyMigration();

    expect((await rowOf(plain)).rate).toBe(1);
    expect((await rowOf(ownRate)).rate).toBe(1.2);
    expect((await rowOf(zeroCharged)).rate).toBe(1);
    expect((await rowOf(fullFeeIncome)).rate).toBe(1);
  });

  it("changes nothing on a second pass", async () => {
    const id = await seed({
      accountId: feeCardId,
      amount: -120.44,
      originalAmount: -100,
      originalCurrencyCode: "EUR",
      exchangeRate: 1,
    });

    await applyMigration();
    const [{ updated_at: first }] = (await dataSource.query(
      `SELECT updated_at FROM transactions WHERE id = $1`,
      [id],
    )) as { updated_at: Date }[];
    await applyMigration();
    const [{ updated_at: second }] = (await dataSource.query(
      `SELECT updated_at FROM transactions WHERE id = $1`,
      [id],
    )) as { updated_at: Date }[];

    expect((await rowOf(id)).rate).toBe(1.175024);
    // Not touched at all: the trigger would have restamped updated_at.
    expect(second).toEqual(first);
  });
});
