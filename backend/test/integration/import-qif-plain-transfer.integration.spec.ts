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
 * A plain QIF transfer into an account in another currency (issue #2390,
 * design docs/future-plans/provisional-amounts.md sections 6 and 7).
 *
 * The other account's leg is the importer's estimate at the stored rate for
 * the row's date, flagged in `amount_is_provisional`, and the balance moves by
 * that estimate. The other account's own file later states the amount: one
 * update writes it and clears the flag, and the balance moves by the
 * difference. The lookups read the column, never the description. Without a
 * rate the row is refused and nothing is written for either account.
 */
describe("QIF plain transfer across currencies (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let importer: ImportService;
  let rates: ExchangeRateService;

  let aliceId: string;
  let usdId: string;
  let eurId: string;

  // The USD statement: 100.00 out to the EUR account.
  const USD_QIF =
    "!Type:Bank\nD01/15/2025\nT-100.00\nPWire\nMRent\nL[Savings EUR]\n^\n";
  // The EUR statement for the same transfer: the bank credited 90.00.
  const EUR_QIF =
    "!Type:Bank\nD01/15/2025\nT90.00\nPWire\nMReceived\nL[Checking]\n^\n";

  const importInto = (
    accountId: string,
    content: string,
    mapping: { originalName: string; accountId: string },
  ) =>
    withUserContext(aliceId, () =>
      importer.importQifFile(aliceId, {
        content,
        accountId,
        categoryMappings: [],
        accountMappings: [mapping],
        dateFormat: "MM/DD/YYYY",
      } as never),
    );
  const importUsdFile = () =>
    importInto(usdId, USD_QIF, {
      originalName: "Savings EUR",
      accountId: eurId,
    });
  const importEurFile = () =>
    importInto(eurId, EUR_QIF, { originalName: "Checking", accountId: usdId });

  const storeRate = () =>
    db.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate_date, rate, source)
       VALUES ('USD', 'EUR', '2025-01-15'::DATE, 0.8, 'test')`,
    );

  type Leg = {
    id: string;
    amount: string;
    currency_code: string;
    exchange_rate: string;
    description: string | null;
    amount_is_provisional: boolean;
    linked_transaction_id: string | null;
  };
  const legsOf = (accountId: string): Promise<Leg[]> =>
    db.query(
      `SELECT id, amount, currency_code, exchange_rate, description,
              amount_is_provisional, linked_transaction_id
         FROM transactions WHERE account_id = $1 ORDER BY amount`,
      [accountId],
    ) as Promise<Leg[]>;
  const onlyLegOf = async (accountId: string): Promise<Leg> => {
    const legs = await legsOf(accountId);
    expect(legs).toHaveLength(1);
    return legs[0];
  };
  const balanceOf = async (id: string): Promise<number> =>
    Number(
      (
        await db.query(`SELECT current_balance FROM accounts WHERE id = $1`, [
          id,
        ])
      )[0].current_balance,
    );
  const rowCount = async (): Promise<number> =>
    Number(
      (await db.query(`SELECT COUNT(*)::int AS n FROM transactions`))[0].n,
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
       VALUES ('USD', 'US Dollar', '$', 2), ('EUR', 'Euro', 'E', 2)
       ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    usdId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    eurId = (
      await createTestAccount(db, aliceId, {
        name: "Savings EUR",
        currencyCode: "EUR",
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

  it("writes the other leg at the date's rate, flagged provisional, and moves the balance by the estimate (section 7, row 2)", async () => {
    await storeRate();

    const result = await importUsdFile();

    expect(result.imported).toBe(1);
    expect(result.errors).toBe(0);
    const eurLeg = await onlyLegOf(eurId);
    expect(eurLeg.currency_code).toBe("EUR");
    expect(Number(eurLeg.amount)).toBe(80);
    expect(Number(eurLeg.exchange_rate)).toBeCloseTo(0.8, 8);
    expect(eurLeg.amount_is_provisional).toBe(true);
    expect(eurLeg.description).toContain("Rent");
    expect(eurLeg.description).toContain("PENDING IMPORT");
    const usdLeg = await onlyLegOf(usdId);
    expect(Number(usdLeg.amount)).toBe(-100);
    expect(usdLeg.amount_is_provisional).toBe(false);
    expect(usdLeg.linked_transaction_id).toBe(eurLeg.id);
    expect(eurLeg.linked_transaction_id).toBe(usdLeg.id);
    expect(await balanceOf(eurId)).toBe(80);
    expect(await balanceOf(usdId)).toBe(900);
  });

  it("the other account's file confirms the leg: the file's amount, the flag cleared, the balance moved by the difference (row 3)", async () => {
    await storeRate();
    await importUsdFile();

    const result = await importEurFile();

    expect(result.imported).toBe(1);
    expect(await rowCount()).toBe(2);
    const eurLeg = await onlyLegOf(eurId);
    expect(Number(eurLeg.amount)).toBe(90);
    expect(eurLeg.amount_is_provisional).toBe(false);
    expect(eurLeg.description).toBe("Received");
    expect(eurLeg.linked_transaction_id).toBe((await onlyLegOf(usdId)).id);
    // 80 at import, then a further 10 on confirmation.
    expect(await balanceOf(eurId)).toBe(90);
    expect(await balanceOf(usdId)).toBe(900);
    // Both amounts are stated now, so the legs hold the settlement rate they
    // imply (source 1, destination 90 / 100), not the estimate's 0.8.
    expect(Number(eurLeg.exchange_rate)).toBeCloseTo(0.9, 8);
    expect(Number((await onlyLegOf(usdId)).exchange_rate)).toBe(1);
  });

  it("confirms the leg when the other file states exactly the estimate: imported, not skipped as a duplicate, no balance move", async () => {
    await storeRate();
    await importUsdFile();

    const result = await importInto(
      eurId,
      "!Type:Bank\nD01/15/2025\nT80.00\nPWire\nMReceived\nL[Checking]\n^\n",
      { originalName: "Checking", accountId: usdId },
    );

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(await rowCount()).toBe(2);
    const eurLeg = await onlyLegOf(eurId);
    expect(Number(eurLeg.amount)).toBe(80);
    expect(eurLeg.amount_is_provisional).toBe(false);
    expect(eurLeg.description).toBe("Received");
    expect(Number(eurLeg.exchange_rate)).toBeCloseTo(0.8, 8);
    expect(await balanceOf(eurId)).toBe(80);
    expect(await balanceOf(usdId)).toBe(900);

    // The confirmed leg is now a recorded transfer: the same file again is a
    // duplicate and changes nothing.
    const again = await importInto(
      eurId,
      "!Type:Bank\nD01/15/2025\nT80.00\nPWire\nMReceived\nL[Checking]\n^\n",
      { originalName: "Checking", accountId: usdId },
    );
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await rowCount()).toBe(2);
    expect(await balanceOf(eurId)).toBe(80);
  });

  it("writes a zero transfer's other leg as a confirmed zero without a rate", async () => {
    // No rate is stored: zero needs none.
    const result = await importInto(
      usdId,
      "!Type:Bank\nD01/15/2025\nT0.00\nPWire\nMVoided\nL[Savings EUR]\n^\n",
      { originalName: "Savings EUR", accountId: eurId },
    );

    expect(result.errors).toBe(0);
    expect(result.imported).toBe(1);
    const eurLeg = await onlyLegOf(eurId);
    expect(Number(eurLeg.amount)).toBe(0);
    expect(eurLeg.currency_code).toBe("EUR");
    expect(eurLeg.amount_is_provisional).toBe(false);
    expect(eurLeg.description).toBe("Voided");
    expect(await balanceOf(eurId)).toBe(0);
    expect(await balanceOf(usdId)).toBe(1000);
  });

  it("holds in the other file order: the EUR file estimates the USD leg at the inverse rate and the USD file confirms it", async () => {
    await storeRate();

    await importEurFile();

    const usdEstimate = await onlyLegOf(usdId);
    expect(Number(usdEstimate.amount)).toBe(-112.5);
    expect(usdEstimate.amount_is_provisional).toBe(true);
    expect(Number(usdEstimate.exchange_rate)).toBeCloseTo(1.25, 8);
    expect(await balanceOf(usdId)).toBe(887.5);
    expect(await balanceOf(eurId)).toBe(90);

    await importUsdFile();

    expect(await rowCount()).toBe(2);
    const usdLeg = await onlyLegOf(usdId);
    expect(usdLeg.id).toBe(usdEstimate.id);
    expect(Number(usdLeg.amount)).toBe(-100);
    expect(usdLeg.amount_is_provisional).toBe(false);
    expect(await balanceOf(usdId)).toBe(900);
    const eurLeg = await onlyLegOf(eurId);
    expect(eurLeg.amount_is_provisional).toBe(false);
    // The source leg holds 1 and the destination leg the stated ratio.
    expect(Number(usdLeg.exchange_rate)).toBe(1);
    expect(Number(eurLeg.exchange_rate)).toBeCloseTo(0.9, 8);
  });

  it("refuses the row, naming the pair and the date, when no rate covers it, and writes nothing (row 6)", async () => {
    const result = await importUsdFile();

    expect(result.imported).toBe(0);
    expect(result.errors).toBe(1);
    const message = result.errorMessages.join("\n");
    expect(message).toContain("USD -> EUR");
    expect(message).toContain("2025-01-15");
    expect(await rowCount()).toBe(0);
    expect(await balanceOf(usdId)).toBe(1000);
    expect(await balanceOf(eurId)).toBe(0);
  });

  it("does not match a confirmed row whose description says PENDING IMPORT", async () => {
    await storeRate();
    await importUsdFile();
    // The reader confirmed the leg some other way and typed the old words
    // into its description; the column, not the text, says it is confirmed.
    const confirmedId = (await onlyLegOf(eurId)).id;
    await db.query(
      `UPDATE transactions
          SET amount_is_provisional = false,
              description = 'Received PENDING IMPORT'
        WHERE id = $1`,
      [confirmedId],
    );

    await importEurFile();

    const eurLegs = await legsOf(eurId);
    expect(eurLegs).toHaveLength(2);
    const confirmed = eurLegs.find((leg) => leg.id === confirmedId);
    expect(Number(confirmed?.amount)).toBe(80);
    expect(confirmed?.amount_is_provisional).toBe(false);
    expect(confirmed?.description).toBe("Received PENDING IMPORT");
    expect(await balanceOf(eurId)).toBe(170);
  });

  it("still matches a provisional leg whose description was cleared", async () => {
    await storeRate();
    await importUsdFile();
    await db.query(
      `UPDATE transactions SET description = NULL
        WHERE account_id = $1 AND amount_is_provisional = true`,
      [eurId],
    );

    const result = await importEurFile();

    expect(result.imported).toBe(1);
    expect(await rowCount()).toBe(2);
    const eurLeg = await onlyLegOf(eurId);
    expect(Number(eurLeg.amount)).toBe(90);
    expect(eurLeg.amount_is_provisional).toBe(false);
    expect(await balanceOf(eurId)).toBe(90);
  });
});
