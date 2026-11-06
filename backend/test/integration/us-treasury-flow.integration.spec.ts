import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { UNITED_STATES_BOND_ADAPTER } from "@/bonds/adapters/us";
import { BondCatalogService } from "@/bonds/bond-catalog.service";
import { BondHoldingsService } from "@/bonds/bond-holdings.service";
import { bondInstrumentId, bondProgramId } from "@/bonds/bond-instrument-id";
import { BondPriceService } from "@/bonds/bond-price.service";
import { BondValuationService } from "@/bonds/bond-valuation.service";
import { withSystemContext, withUserContext } from "@/common/db/with-context";
import { CreateInvestmentTransactionDto } from "@/securities/dto/create-investment-transaction.dto";
import { InvestmentAction } from "@/securities/entities/investment-transaction.entity";
import { InvestmentTransactionsService } from "@/securities/investment-transactions.service";
import { PortfolioCalculationService } from "@/securities/portfolio-calculation.service";
import { SecuritiesModule } from "@/securities/securities.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
  storeUsFixtureSeries,
} from "../helpers/integration-setup";

/**
 * A US Treasury bill, note and TIPS through the real write path against a real
 * PostgreSQL (docs/specs/us-treasury-securities.md, bond-marketable-primitives.md):
 * the purchase row, the lot's valuation, the engine's price or the person's,
 * the redemption split and the REDEEM fill.
 *
 * Every expected figure is worked by hand from the official formula (spec
 * section 9 and 31 CFR 356 Appendix B), never read back from the code under
 * test:
 *  - bill 912797WM5, 100 units bought for 9783.3694 (100 x 97.833694): the cost
 *    9783.3694 is 9783.37 on the holding; 216.63 of discount over 182 days;
 *    day 91 is half of it: 9783.37 + 108.315 = 9891.685, HALF_UP 9891.69.
 *  - note 91282CZK0, 3.75 %, dated 2026-09-30: a coupon of 100 x 0.0375 / 2 per
 *    100 face, 187.50 on 10,000; accrued over 35 of 182 days is 187.50 x 35 /
 *    182 = 36.0577, 36.06.
 *  - TIPS 912810FQ6, 3 3/8 %, base Ref CPI 177.5, CPI-U of Mar, Apr, May 2026
 *    330.213, 333.020, 335.123: Ref CPI of 2026-07-15 is 333.020 + 14/31 x
 *    2.103 = 333.969741, index ratio 1.88152; of 2026-07-31 335.055161, 1.88763.
 */
describe("US Treasury bill, note and TIPS (integration)", () => {
  jest.setTimeout(180000);

  let module: TestingModule;
  let dataSource: DataSource;
  let investments: InvestmentTransactionsService;
  let valuation: BondValuationService;
  let holdings: BondHoldingsService;
  let calculation: PortfolioCalculationService;
  let prices: BondPriceService;
  let catalog: BondCatalogService;
  let userId: string;
  let accountId: string;

  const BILL = bondInstrumentId("US", "US_TREASURY", "912797WM5261001");
  const NOTE = bondInstrumentId("US", "US_TREASURY", "91282CZK0");
  const TIPS = bondInstrumentId("US", "US_TREASURY", "912810FQ6");

  beforeAll(async () => {
    module = await createIntegrationModule([
      SecuritiesModule,
      TransactionsModule,
    ]);
    dataSource = module.get(DataSource);
    investments = module.get(InvestmentTransactionsService);
    valuation = module.get(BondValuationService);
    holdings = module.get(BondHoldingsService);
    calculation = module.get(PortfolioCalculationService);
    prices = module.get(BondPriceService);
    catalog = module.get(BondCatalogService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "holdings",
      "security_prices",
      "investment_transactions",
      "transaction_splits",
      "transactions",
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
       VALUES ('USD', 'Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    const brokerage = await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_BROKERAGE', 'Brokerage', 'USD', 0, 0)
       RETURNING id`,
      [userId],
    );
    accountId = brokerage[0].id;
    await dataSource.query(
      `INSERT INTO accounts (user_id, account_type, account_sub_type, name,
                             currency_code, current_balance, opening_balance,
                             linked_account_id)
       VALUES ($1, 'INVESTMENT', 'INVESTMENT_CASH', 'Brokerage Cash', 'USD', 0, 0, $2)`,
      [userId, accountId],
    );
  });

  async function security(program: "BILL" | "NOTE" | "TIPS"): Promise<string> {
    const rows = await dataSource.query(
      `INSERT INTO securities (user_id, symbol, name, security_type, currency_code, bond_program_id)
       VALUES ($1, $2, $2, 'BOND', 'USD', $3)
       RETURNING id`,
      [userId, program, bondProgramId("US", "US_TREASURY", program)],
    );
    return rows[0].id;
  }

  const asUser = <T>(work: () => Promise<T>) => withUserContext(userId, work);

  function trade(
    securityId: string,
    action: InvestmentAction,
    transactionDate: string,
    quantity: number,
    price: number | undefined,
    bondInstrumentId?: string,
  ): Promise<unknown> {
    return asUser(() =>
      investments.create(userId, {
        accountId,
        securityId,
        action,
        transactionDate,
        quantity,
        price,
        commission: 0,
        bondInstrumentId,
      } as CreateInvestmentTransactionDto),
    );
  }

  const rowsOf = (securityId: string) =>
    dataSource.query(
      `SELECT action, quantity::text AS quantity, price::text AS price,
              total_amount::text AS total, linked_transaction_id IS NOT NULL AS linked
         FROM investment_transactions
        WHERE security_id = $1
        ORDER BY transaction_date, created_at`,
      [securityId],
    );

  function holdingValue(
    securityId: string,
    quantity: string,
    asOf: string,
    price?: number,
  ) {
    return asUser(() =>
      calculation.valueBondHoldings(
        userId,
        [
          {
            id: "holding",
            accountId,
            securityId,
            quantity,
            security: { bondProgramId: "linked" },
          },
        ],
        price === undefined ? new Map() : new Map([[securityId, price]]),
        asOf,
      ),
    ).then((values) => values.get(`${accountId}:${securityId}`));
  }

  it("a bill: cost, value on day 91, the engine's price, the split and the REDEEM fill", async () => {
    await storeUsFixtureSeries(dataSource, catalog, "BILL");
    const bill = await security("BILL");
    await trade(bill, InvestmentAction.BUY, "2026-10-01", 100, 97.833694, BILL);

    expect(await rowsOf(bill)).toEqual([
      {
        action: "BUY",
        quantity: "100.00000000",
        price: "97.8336940000",
        total: "9783.36940000",
        linked: false,
      },
    ]);

    const valued = await asUser(() =>
      valuation.valueSecurity(userId, bill, "2026-12-31"),
    );
    expect(valued.marketPriceRequired).toBe(false);
    expect(valued.lots).toHaveLength(1);
    expect(valued.lots[0].cost).toBe("9783.3694");
    expect(valued.lots[0].valuation).toMatchObject({
      status: "OPEN",
      principalBasis: "LOT_COST",
      grossValue: "9891.69",
      accruedInterest: "108.32",
    });
    expect(valued.totals).toMatchObject({
      grossValue: "9891.69",
      accruedInterest: "108.32",
    });

    await asUser(() =>
      prices.recomputeSecurity(userId, bill, { today: "2026-12-31" }),
    );
    const stored = await dataSource.query(
      `SELECT price_date::text AS date, close_price::text AS price, source
         FROM security_prices WHERE security_id = $1 AND price_date = '2026-12-31'`,
      [bill],
    );
    expect(stored).toEqual([
      { date: "2026-12-31", price: "98.9169000000", source: "bond_engine" },
    ]);
    expect(await holdingValue(bill, "100", "2026-12-31")).toEqual({
      marketValue: 9891.69,
      unitPrice: 98.9169,
    });

    // All 100 units, then 40 of them: 9783.3694 x 40 / 100 = 3913.34776,
    // 3913.35 on the holding; 4000.00 - 3913.35 = 86.65.
    const all = await asUser(() =>
      holdings.redemptionSplit(
        userId,
        bill,
        accountId,
        BILL,
        "2027-04-01",
        100,
      ),
    );
    expect(all).toMatchObject({
      principal: "9783.37",
      interest: "216.63",
      principalReturned: "9783.37",
      payout: "10000.00",
      refusal: null,
    });
    const part = await asUser(() =>
      holdings.redemptionSplit(userId, bill, accountId, BILL, "2027-04-01", 40),
    );
    expect(part).toMatchObject({
      principal: "3913.35",
      interest: "86.65",
      payout: "4000.00",
    });

    await trade(bill, InvestmentAction.REDEEM, "2027-04-01", 100, undefined);
    expect(await rowsOf(bill)).toEqual([
      {
        action: "BUY",
        quantity: "100.00000000",
        price: "97.8336940000",
        total: "9783.36940000",
        linked: false,
      },
      {
        action: "INTEREST",
        quantity: null,
        price: "216.6300000000",
        total: "216.63000000",
        linked: true,
      },
      {
        action: "REDEEM",
        quantity: "100.00000000",
        price: "97.8337000000",
        total: "9783.37000000",
        linked: true,
      },
    ]);
    await expect(
      trade(bill, InvestmentAction.REDEEM, "2027-04-02", 1, undefined),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("a bill bought on the secondary market accrues from its purchase (E3)", async () => {
    await storeUsFixtureSeries(dataSource, catalog, "BILL");
    const bill = await security("BILL");
    await trade(bill, InvestmentAction.BUY, "2026-12-31", 100, 98.95, BILL);
    const valued = await asUser(() =>
      valuation.valueSecurity(userId, bill, "2027-04-01"),
    );
    expect(valued.lots[0].cost).toBe("9895.0000");
    expect(valued.lots[0].valuation).toMatchObject({
      status: "MATURED",
      grossValue: "10000.00",
      accruedInterest: "105.00",
    });
  });

  it("a note: the cash price band, the person's price, the split and the REDEEM fill", async () => {
    await storeUsFixtureSeries(dataSource, catalog, "NOTE");
    const note = await security("NOTE");
    await trade(note, InvestmentAction.BUY, "2026-11-04", 100, 99.5, NOTE);
    // 5 x the face value of 100 is the band's end.
    await expect(
      trade(note, InvestmentAction.BUY, "2026-11-04", 50, 501, NOTE),
    ).rejects.toMatchObject({
      response: { errorCode: "QUANTITY_NOT_BONDS" },
    });
    expect(await rowsOf(note)).toEqual([
      {
        action: "BUY",
        quantity: "100.00000000",
        price: "99.5000000000",
        total: "9950.00000000",
        linked: false,
      },
    ]);

    const valued = await asUser(() =>
      valuation.valueSecurity(userId, note, "2026-11-04"),
    );
    expect(valued.marketPriceRequired).toBe(true);
    expect(valued.lots[0].valuation).toMatchObject({
      grossValue: "10036.06",
      accruedInterest: "36.06",
    });

    // The engine does not price a marketable coupon note: no price, no value.
    expect(await holdingValue(note, "100", "2026-11-04")).toBeNull();
    expect(await holdingValue(note, "100", "2026-11-04", 99.75)).toEqual({
      marketValue: 9975,
      unitPrice: 99.75,
    });

    const atMaturity = await asUser(() =>
      holdings.redemptionSplit(
        userId,
        note,
        accountId,
        NOTE,
        "2028-10-02",
        100,
      ),
    );
    expect(atMaturity).toMatchObject({
      principal: "10000.00",
      interest: "187.50",
      principalReturned: "10000.00",
      payout: "10187.50",
      refusal: null,
    });
    const early = await asUser(() =>
      holdings.redemptionSplit(
        userId,
        note,
        accountId,
        NOTE,
        "2028-09-29",
        100,
      ),
    );
    expect(early).toMatchObject({ payout: null, refusal: "NOT_REDEEMABLE" });

    await trade(note, InvestmentAction.REDEEM, "2028-10-02", 100, undefined);
    expect(await rowsOf(note)).toEqual([
      {
        action: "BUY",
        quantity: "100.00000000",
        price: "99.5000000000",
        total: "9950.00000000",
        linked: false,
      },
      {
        action: "INTEREST",
        quantity: null,
        price: "187.5000000000",
        total: "187.50000000",
        linked: true,
      },
      {
        action: "REDEEM",
        quantity: "100.00000000",
        price: "100.0000000000",
        total: "10000.00000000",
        linked: true,
      },
    ]);
  });

  it("a TIPS: the principal on the index ratio of the day and the accrued interest on it", async () => {
    await storeUsFixtureSeries(dataSource, catalog, "TIPS");
    await withSystemContext(() =>
      catalog.seedBenchmarkSeries([UNITED_STATES_BOND_ADAPTER]),
    );
    for (const [month, level] of [
      ["2026-03-01", "330.213"],
      ["2026-04-01", "333.020"],
      ["2026-05-01", "335.123"],
    ]) {
      await dataSource.query(
        `INSERT INTO benchmark_values (benchmark_code, observation_date, value, published_on, source_url, retrieved_at)
         VALUES ('US_CPI_U_NSA', $1, $2, $1, 'https://example.test', NOW())`,
        [month, level],
      );
    }
    await dataSource.query(
      `UPDATE benchmark_series SET covered_through = '2026-05-31' WHERE code = 'US_CPI_U_NSA'`,
    );
    const tips = await security("TIPS");
    await trade(tips, InvestmentAction.BUY, "2026-07-15", 10, 200, TIPS);

    // 10 units = 1,000 face. Period 2026-04-15 to 2026-10-15 is 183 days.
    // 2026-07-15: ratio 1.88152, principal 1,881.52; accrued 16.875 x 91 / 183
    // = 8.391393, x 1.88152 = 15.79; value 1,897.31.
    // 2026-07-31: ratio 1.88763, principal 1,887.63; accrued 16.875 x 107 /
    // 183 = 9.866803, x 1.88763 = 18.62; value 1,906.25.
    const first = await asUser(() =>
      valuation.valueSecurity(userId, tips, "2026-07-15"),
    );
    expect(first.marketPriceRequired).toBe(true);
    expect(first.lots[0].valuation).toMatchObject({
      status: "OPEN",
      grossValue: "1897.31",
      accruedInterest: "15.79",
    });
    const second = await asUser(() =>
      valuation.valueSecurity(userId, tips, "2026-07-31"),
    );
    expect(second.lots[0].valuation).toMatchObject({
      grossValue: "1906.25",
      accruedInterest: "18.62",
    });

    expect(await holdingValue(tips, "10", "2026-07-31", 205)).toEqual({
      marketValue: 2050,
      unitPrice: 205,
    });
  });
});
