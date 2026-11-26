import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { withUserContext } from "@/common/db/with-context";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
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
 * A QIF split line that transfers into an account in another currency
 * (A26-M18, INV-CURRENCY-001, MON-H11 QIF half).
 *
 * The split-transfer leg lives in the target account, so it is denominated
 * there: converted at the stored rate for the row's date, labelled with the
 * target's currency and carrying that rate, and written provisional in
 * `amount_is_provisional` as the plain transfer path writes it, with no note
 * in its description (the market rate is not the bank's; issues #2390 and
 * #2400, design
 * docs/future-plans/provisional-amounts.md). The target's own file confirms
 * it. Without a rate the row is refused, naming the pair, rather than moving
 * the target's balance by a number in the wrong currency.
 */
describe("QIF split transfer across currencies (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let rates: ExchangeRateService;

  let aliceId: string;
  let checkingId: string;
  let savingsId: string;

  // USD checking pays 100.00: 40.00 groceries, 60.00 into the CAD savings.
  const QIF =
    "!Type:Bank\nD01/15/2025\nT-100.00\nPShop\n" +
    "SGroceries\n$-40.00\nS[Savings CAD]\n$-60.00\n^\n";

  const importQif = () =>
    withUserContext(aliceId, () =>
      importer.importQifFile(aliceId, {
        content: QIF,
        accountId: checkingId,
        categoryMappings: [],
        accountMappings: [
          { originalName: "Savings CAD", accountId: savingsId },
        ],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );

  // The CAD savings statement for the same transfer: the bank credited 85.00.
  const SAVINGS_QIF =
    "!Type:Bank\nD01/15/2025\nT85.00\nMFrom chequing\nL[Checking]\n^\n";
  const importSavingsQif = () =>
    withUserContext(aliceId, () =>
      importer.importQifFile(aliceId, {
        content: SAVINGS_QIF,
        accountId: savingsId,
        categoryMappings: [],
        accountMappings: [{ originalName: "Checking", accountId: checkingId }],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );

  const balanceOf = async (id: string): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          id,
        ])
      )[0].current_balance,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([ImportModule]);
    module = harness.module;
    db = harness.owner;
    importer = module.get(ImportService);
    rates = module.get(ExchangeRateService);
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
      "exchange_rates",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2), ('CAD', 'Canadian Dollar', 'CA$', 2)
       ON CONFLICT DO NOTHING`,
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
    savingsId = (
      await createTestAccount(db, aliceId, {
        name: "Savings CAD",
        currencyCode: "CAD",
        openingBalance: 0,
        currentBalance: 0,
      })
    ).id;
    // Stay inside the database: a missing rate must read as missing, not
    // send the import out to a provider.
    const stored = rates.getRateForDate.bind(rates);
    jest
      .spyOn(rates, "getRateForDate")
      .mockImplementation((from, to, date) =>
        stored(from, to, date, { fetchMissing: false }),
      );
  });

  it("writes the leg in the target's currency at the date's rate, flagged pending", async () => {
    // USD->CAD 1.35; the resolver reads either orientation.
    await db.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('USD', 'CAD', '2025-01-15'::DATE, 1.35, 'test')`,
    );

    await importQif();

    const legs = (await db.query(
      `SELECT amount, currency_code, exchange_rate, description,
              amount_is_provisional
         FROM transactions WHERE account_id = $1`,
      [savingsId],
    )) as Array<{
      amount: string;
      currency_code: string;
      exchange_rate: string;
      description: string | null;
      amount_is_provisional: boolean;
    }>;
    expect(legs).toHaveLength(1);
    const [cadLeg] = legs;
    expect(cadLeg.currency_code).toBe("CAD");
    expect(Number(cadLeg.amount)).toBe(81);
    expect(Number(cadLeg.exchange_rate)).toBeCloseTo(1.35, 8);
    expect(cadLeg.amount_is_provisional).toBe(true);
    // The split line carries no memo, so the leg has no description (the
    // parser's empty memo, as a same-currency leg's): the state is the column
    // alone.
    expect(cadLeg.description || null).toBeNull();
    expect(await balanceOf(savingsId)).toBe(81);
    expect(await balanceOf(checkingId)).toBe(900);
  });

  it("the target's own file confirms the leg: the file's amount, the flag cleared, the balance moved by the difference", async () => {
    await db.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('USD', 'CAD', '2025-01-15'::DATE, 1.35, 'test')`,
    );
    await importQif();

    const result = await importSavingsQif();

    expect(result.imported).toBe(1);
    const legs = (await db.query(
      `SELECT amount, description, amount_is_provisional
         FROM transactions WHERE account_id = $1`,
      [savingsId],
    )) as Array<{
      amount: string;
      description: string | null;
      amount_is_provisional: boolean;
    }>;
    expect(legs).toHaveLength(1);
    expect(Number(legs[0].amount)).toBe(85);
    expect(legs[0].amount_is_provisional).toBe(false);
    expect(legs[0].description).toBe("From chequing");
    // 81 at import, then a further 4 on confirmation.
    expect(await balanceOf(savingsId)).toBe(85);
    expect(await balanceOf(checkingId)).toBe(900);
  });

  it("refuses the row, naming the pair, when no rate covers the date", async () => {
    const result = await importQif();

    // The row's savepoint rolled it back and the result names the pair.
    expect(result.imported).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.errorMessages.join("\n")).toContain("USD -> CAD");
    expect(
      Number(
        (await db.query(`SELECT COUNT(*)::int AS n FROM transactions`))[0].n,
      ),
    ).toBe(0);
    expect(await balanceOf(savingsId)).toBe(0);
    expect(await balanceOf(checkingId)).toBe(1000);
  });
});
