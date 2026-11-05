import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { bondProgramId } from "@/bonds/bond-instrument-id";
import { withScopedDb } from "@/common/db/scoped-db";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { fetchSeries } from "@/bonds/adapters/us/series/fetch-series";
import {
  fakeFetch,
  fixtureJson,
  fixtureText,
  treasuryAnswers,
} from "@/bonds/adapters/us/series/fixture-helpers";
import { SecuritiesModule } from "@/securities/securities.module";
import { SecurityPriceService } from "@/securities/security-price.service";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  insertBondProgram,
} from "../helpers/integration-setup";

/**
 * The manual price of a linked security (INV-BOND-005). For a marketable coupon
 * series it is the only source of the holding's value, so a price typed 100
 * times too large (9950 for 99.50) is refused in the write's own transaction,
 * as a trade at that price is (QUANTITY_NOT_BONDS). Other linked series keep
 * their behaviour.
 */
describe("a linked security's manual price is a cash price (integration, INV-BOND-005)", () => {
  jest.setTimeout(120000);

  let module: TestingModule;
  let dataSource: DataSource;
  let prices: SecurityPriceService;
  let catalog: BondCatalogService;
  let userId: string;

  const NOW = () => new Date("2026-11-04T10:00:00.000Z");

  beforeAll(async () => {
    module = await createIntegrationModule([SecuritiesModule]);
    dataSource = module.get(DataSource);
    prices = module.get(SecurityPriceService);
    catalog = module.get(BondCatalogService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "security_prices",
      "securities",
      "accounts",
      "bond_programs",
      "bond_instruments",
      "benchmark_series",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('USD', 'Dollar', '$', 2, true), ('PLN', 'Zloty', 'zl', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    const get = fakeFetch(
      treasuryAnswers("91282CZK0", fixtureJson("ta-ws-91282CZK0.json"), {
        "R_20260928_1.xml": fixtureText("R_20260928_1.xml"),
        "R_20261027_1.xml": fixtureText("R_20260928_1.xml"),
      }),
    );
    const { entry } = await fetchSeries("91282CZK0", get, NOW);
    await withSystemContext(() =>
      withScopedDb(dataSource, async (m) => {
        await catalog.storeEntry(m, entry);
      }),
    );
    await insertBondProgram(dataSource, "EDO", "PLN", "PL", "PL_MF");
    await insertBondProgram(dataSource, "BILL", "USD", "US", "US_TREASURY");
  });

  async function insertSecurity(
    symbol: string,
    currency: string,
    programId: string | null,
  ): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, $2, $2, 'BOND', $3, $4)
       RETURNING id`,
      [userId, symbol, currency, programId],
    );
    return rows[0].id;
  }

  const NOTE = bondProgramId("US", "US_TREASURY", "NOTE");
  const BILL = bondProgramId("US", "US_TREASURY", "BILL");
  const EDO = bondProgramId("PL", "PL_MF", "EDO");
  const refusal = { response: { errorCode: "MANUAL_PRICE_NOT_CASH_PRICE" } };

  const stored = async (securityId: string) =>
    dataSource.query(
      `SELECT price_date::text AS d, close_price::text AS p
         FROM security_prices WHERE security_id = $1 ORDER BY price_date`,
      [securityId],
    );

  it("refuses a price above five times the face value and writes nothing", async () => {
    const note = await insertSecurity("NOTE", "USD", NOTE);
    await expect(
      withUserContext(userId, () =>
        prices.createManualPrice(
          note,
          { priceDate: "2026-11-04", closePrice: 9950 },
          userId,
        ),
      ),
    ).rejects.toMatchObject(refusal);
    expect(await stored(note)).toEqual([]);
  });

  it("refuses a high, low or open price above the band too", async () => {
    const note = await insertSecurity("NOTE", "USD", NOTE);
    await expect(
      withUserContext(userId, () =>
        prices.createManualPrice(
          note,
          { priceDate: "2026-11-04", closePrice: 99.5, highPrice: 9950 },
          userId,
        ),
      ),
    ).rejects.toMatchObject(refusal);
    expect(await stored(note)).toEqual([]);
  });

  it("accepts a cash price and refuses an update of it to 100 times too much", async () => {
    const note = await insertSecurity("NOTE", "USD", NOTE);
    const created = await withUserContext(userId, () =>
      prices.createManualPrice(
        note,
        { priceDate: "2026-11-04", closePrice: 99.5 },
        userId,
      ),
    );
    expect(await stored(note)).toEqual([
      { d: "2026-11-04", p: "99.5000000000" },
    ]);
    await expect(
      withUserContext(userId, () =>
        prices.updatePrice(note, created.id, { closePrice: 9950 }, userId),
      ),
    ).rejects.toMatchObject(refusal);
    expect(await stored(note)).toEqual([
      { d: "2026-11-04", p: "99.5000000000" },
    ]);
  });

  it("leaves an engine-priced bill and a Polish bond as they were", async () => {
    const bill = await insertSecurity("BILL", "USD", BILL);
    const edo = await insertSecurity("EDO", "PLN", EDO);
    for (const id of [bill, edo]) {
      await withUserContext(userId, () =>
        prices.createManualPrice(
          id,
          { priceDate: "2026-11-04", closePrice: 9950 },
          userId,
        ),
      );
      expect(await stored(id)).toEqual([
        { d: "2026-11-04", p: "9950.0000000000" },
      ]);
    }
  });
});
