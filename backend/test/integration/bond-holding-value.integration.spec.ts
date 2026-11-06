import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { withUserContext } from "@/common/db/with-context";
import { PortfolioCalculationService } from "@/securities/portfolio-calculation.service";
import { SecuritiesModule } from "@/securities/securities.module";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  storeFixtureSeries,
  storeUsFixtureSeries,
} from "../helpers/integration-setup";

/**
 * Audit H2 against a real PostgreSQL: two accounts hold one linked security, lots
 * bought on different days, and each holding is worth its own account's lots, not
 * quantity x the daily blend (bond-program-securities.md 2.4).
 *
 * A marketable coupon note (INV-BOND-010: the engine does not price it) is worth
 * the person's price times its quantity, and is unpriced without one.
 *
 * Expected figures come from the issue letter's formula with integers (100 x
 * (1 + 0.044 a / 365), half-up to the cent, a days into the first period), never
 * read back from the code under test.
 */
describe("bond-linked holding value (integration, audit H2)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let calculation: PortfolioCalculationService;
  let userId: string;
  const TOS_ID = bondInstrumentId("PL", "PL_MF", "TOS1029");
  const TOS_PROGRAM = bondProgramId("PL", "PL_MF", "TOS");

  /** Per-bond gross value `a` days into a 365-day period, in cents. */
  function grossCents(a: number): bigint {
    const num = 10000n * (365000n + 44n * BigInt(a));
    return (2n * num + 365000n) / (2n * 365000n);
  }
  const money = (c: bigint) => Number(c) / 100;

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    calculation = module.get(PortfolioCalculationService);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "holdings",
      "security_prices",
      "investment_transactions",
      "securities",
      "accounts",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('PLN', 'Zloty', 'zl', 2, true), ('USD', 'Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    await storeFixtureSeries(dataSource, module.get(BondCatalogService));
    userId = (await createTestUserDirect(dataSource)).id;
    // The financial today of the lots below; only Date is faked.
    jest.useFakeTimers({
      now: new Date("2027-04-15T12:00:00Z"),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "setInterval",
        "clearTimeout",
        "clearInterval",
        "clearImmediate",
        "queueMicrotask",
        "performance",
        "hrtime",
      ],
    });
  });

  afterEach(() => jest.useRealTimers());

  async function account(name: string): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', $2, 'PLN', 0, 0)
       RETURNING id`,
      [userId, name],
    );
    return rows[0].id;
  }

  async function buy(
    accountId: string,
    securityId: string,
    date: string,
    quantity: number,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO investment_transactions
         (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
       VALUES ($1, $2, $3, $4, 'BUY', $5, $6, 100, $7, 'UNRECONCILED')`,
      [userId, accountId, securityId, TOS_ID, date, quantity, quantity * 100],
    );
    await dataSource.query(
      `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
       VALUES ($1, $2, $3, 100)
       ON CONFLICT (account_id, security_id) DO UPDATE SET quantity = $3`,
      [accountId, securityId, quantity],
    );
  }

  it("values each account by its own lots, and the total is their sum", async () => {
    const ike = await account("IKE");
    const regular = await account("Regular");
    const sec = (
      await dataSource.query(
        `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
         VALUES ($1, 'TOS', 'TOS', 'BOND', 'PLN', $2) RETURNING id`,
        [userId, TOS_PROGRAM],
      )
    )[0].id as string;
    // 2026-10-15 is 182 days before 2027-04-15; 2026-10-20 is 177.
    await buy(ike, sec, "2026-10-15", 10);
    await buy(regular, sec, "2026-10-20", 10);

    // The blend the daily price would carry: every lot, every account.
    const blend = Number((grossCents(182) * 10n + grossCents(177) * 10n) / 20n);

    const result = await withUserContext(userId, () =>
      calculation.calculateHoldingsWithValues(
        userId,
        [ike, regular],
        "PLN",
        new Map(),
        async () => new Map([[sec, blend / 100]]),
      ),
    );

    const byAccount = new Map(
      result.holdingsWithValues.map((h) => [h.accountId, h]),
    );
    expect(byAccount.get(ike)?.marketValue).toBe(money(grossCents(182) * 10n));
    expect(byAccount.get(regular)?.marketValue).toBe(
      money(grossCents(177) * 10n),
    );
    expect(byAccount.get(ike)?.marketValue).not.toBe(
      byAccount.get(regular)?.marketValue,
    );
    expect(result.totalHoldingsValue).toBeCloseTo(
      money((grossCents(182) + grossCents(177)) * 10n),
      6,
    );
    expect(result.pricesComplete).toBe(true);
  });

  describe("a series the engine does not price (basis MARKET_PRICE)", () => {
    const NOTE_ID = bondInstrumentId("US", "US_TREASURY", "91282CZK0");

    async function noteHolding(): Promise<{ account: string; sec: string }> {
      await storeUsFixtureSeries(
        dataSource,
        module.get(BondCatalogService),
        "NOTE",
      );
      const account = await dataSource
        .query(
          `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                                 currency_code, current_balance, opening_balance)
           VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Notes', 'USD', 0, 0)
           RETURNING id`,
          [userId],
        )
        .then((rows) => rows[0].id as string);
      const sec = await dataSource
        .query(
          `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
           VALUES ($1, 'NOTE', 'NOTE', 'BOND', 'USD', $2) RETURNING id`,
          [userId, bondProgramId("US", "US_TREASURY", "NOTE")],
        )
        .then((rows) => rows[0].id as string);
      await dataSource.query(
        `INSERT INTO investment_transactions
           (user_id, account_id, security_id, bond_instrument_id, action, transaction_date, quantity, price, total_amount, status)
         VALUES ($1, $2, $3, $4, 'BUY', '2026-11-04', 10, 99.5, 995, 'UNRECONCILED')`,
        [userId, account, sec, NOTE_ID],
      );
      await dataSource.query(
        `INSERT INTO holdings (account_id, security_id, quantity, average_cost)
         VALUES ($1, $2, 10, 99.5)`,
        [account, sec],
      );
      return { account, sec };
    }

    it("is the person's price times the quantity: 10 x 99.75 = 997.50", async () => {
      const { account, sec } = await noteHolding();
      const result = await withUserContext(userId, () =>
        calculation.calculateHoldingsWithValues(
          userId,
          [account],
          "USD",
          new Map(),
          async () => new Map([[sec, 99.75]]),
        ),
      );
      expect(result.holdingsWithValues).toHaveLength(1);
      expect(result.holdingsWithValues[0].marketValue).toBe(997.5);
      expect(result.pricesComplete).toBe(true);
    });

    it("is unpriced without a price, never the engine's value of the lot", async () => {
      const { account, sec } = await noteHolding();
      const result = await withUserContext(userId, () =>
        calculation.calculateHoldingsWithValues(
          userId,
          [account],
          "USD",
          new Map(),
          async () => new Map(),
        ),
      );
      expect(result.holdingsWithValues[0].marketValue).toBeNull();
      expect(result.pricesComplete).toBe(false);
      expect(result.unpricedSecurityIds).toContain(sec);
    });
  });
});
