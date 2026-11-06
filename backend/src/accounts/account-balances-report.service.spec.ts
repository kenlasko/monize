import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountBalancesReportService } from "./account-balances-report.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SecurityPriceService } from "../securities/security-price.service";
import {
  BondValuationService,
  SecurityValueByAccount,
} from "../bonds/bond-valuation.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// The market date is clamped against today, so today has to be a fixture --
// otherwise "is this date in the future" is a question about the day the suite
// happens to run on.
jest.mock("../common/date-utils", () => ({
  todayYMD: jest.fn(() => "2026-08-18"),
}));

/**
 * Point-in-time balances, per `docs/specs/account-balances-as-of.md` section 8.
 *
 * The queries are dispatched by what they select rather than by call order:
 * the prices and the security currencies are fetched concurrently, so an
 * ordered `mockResolvedValueOnce` chain would be asserting the scheduler.
 */
interface Fixture {
  accounts?: any[];
  balances?: Array<{ id: string; balance: string; decimal_places?: number }>;
  investmentTransactions?: any[];
  prices?: Array<{
    security_id: string;
    price_date: string;
    close_price: string;
  }>;
  securities?: Array<{ id: string; currency_code: string }>;
  /** The held securities a bond program links (the `bond_program_id` read). */
  linkedSecurities?: Array<{ id: string }>;
  firstActivity?: Array<{ id: string; first_activity: string | null }>;
  rates?: Array<{
    from_currency: string;
    to_currency: string;
    rate_date: string;
    rate: string;
  }>;
}

/**
 * The holdings replay, told apart from the inception read beside it.
 *
 * Both name `investment_transactions`, so matching on the table alone finds
 * whichever call the scheduler ran first -- and the assertions that no replay
 * happened at all would pass for the wrong reason. The select list is what
 * identifies the replay.
 */
const isReplayQuery = (sql: string): boolean =>
  sql.includes("security_id, action");

/**
 * The two reads of one table, told apart.
 *
 * The bounded read loads the window `closeAt` accepts; the nearest read is the
 * approximation door of section 4.2 / 7.2, which has no lower bound and returns
 * at most one row either side of the date. Both name the same table, so a test
 * counting one of them has to say which -- an assertion that "the prices were
 * re-read" is worthless if the nearest lookup satisfies it.
 */
const isNearestRead = (sql: string): boolean =>
  sql.includes("CROSS JOIN LATERAL");
const isBoundedPriceRead = (sql: string): boolean =>
  sql.includes("FROM security_prices") && !isNearestRead(sql);
const isBoundedRateRead = (sql: string): boolean =>
  sql.includes("FROM exchange_rates") && !isNearestRead(sql);

/**
 * The rows the database would return for a nearest-observation read: for each
 * subject, the last observation at or before the date and the first after it.
 *
 * Simulating the query rather than handing the fixture straight back is what
 * keeps the fixture honest -- one set of stored rows, read two different ways,
 * so a test cannot accidentally give the fallback a series the bounded read
 * never saw.
 */
function nearestRows<T extends { date: string }>(rows: T[], date: string): T[] {
  const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const before = [...ordered].reverse().find((r) => r.date <= date);
  const after = ordered.find((r) => r.date > date);
  return [before, after].filter((r): r is T => r != null);
}

describe("AccountBalancesReportService", () => {
  let service: AccountBalancesReportService;
  let query: jest.Mock;
  let preferencesRepo: { findOne: jest.Mock };
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  let securityPrices: { ensurePricesForDate: jest.Mock };
  let bondValuation: { valueByAccount: jest.Mock };

  const program = (fixture: Fixture) => {
    query.mockImplementation(async (sql: string, params: any[] = []) => {
      if (sql.includes("FROM accounts\n") && sql.includes("account_sub_type")) {
        return fixture.accounts ?? [];
      }
      // Checked before the ledger and investment reads: this one names both
      // tables, so an earlier arm would swallow it.
      if (sql.includes("AS first_activity")) {
        return fixture.firstActivity ?? [];
      }
      if (
        sql.includes("opening_balance") &&
        sql.includes("LEFT JOIN transactions")
      ) {
        return fixture.balances ?? [];
      }
      if (isReplayQuery(sql)) {
        return fixture.investmentTransactions ?? [];
      }
      if (isNearestRead(sql) && sql.includes("FROM security_prices")) {
        const [securityIds, date] = params as [string[], string];
        return securityIds.flatMap((securityId) =>
          nearestRows(
            (fixture.prices ?? [])
              .filter((row) => row.security_id === securityId)
              .map((row) => ({ ...row, date: row.price_date })),
            date,
          ).map(({ date: _date, ...row }) => row),
        );
      }
      if (isNearestRead(sql) && sql.includes("FROM exchange_rates")) {
        const [froms, tos, date] = params as [string[], string[], string];
        return froms.flatMap((from, index) => {
          const to = tos[index];
          return nearestRows(
            (fixture.rates ?? [])
              .filter(
                (row) =>
                  (row.from_currency === from && row.to_currency === to) ||
                  (row.from_currency === to && row.to_currency === from),
              )
              .map((row) => ({ ...row, date: row.rate_date })),
            date,
          ).map((row) => ({
            stored_from: row.from_currency,
            stored_to: row.to_currency,
            rate_date: row.rate_date,
            rate: row.rate,
          }));
        });
      }
      if (sql.includes("FROM security_prices")) {
        return fixture.prices ?? [];
      }
      if (sql.includes("bond_program_id IS NOT NULL")) {
        return fixture.linkedSecurities ?? [];
      }
      if (sql.includes("FROM securities")) {
        return fixture.securities ?? [];
      }
      if (sql.includes("FROM exchange_rates")) {
        return fixture.rates ?? [];
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  };

  beforeEach(async () => {
    preferencesRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };
    const mocks = createScopedDbMocks([[UserPreference, preferencesRepo]]);
    query = mocks.manager.query;

    // Nothing to fetch by default: the provider is only reached for a pair the
    // database cannot answer, and most fixtures either supply the rate or are
    // asserting what happens when nobody can.
    exchangeRates = { ensureRatesForDate: jest.fn().mockResolvedValue(0) };
    securityPrices = { ensurePricesForDate: jest.fn().mockResolvedValue(0) };
    bondValuation = { valueByAccount: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountBalancesReportService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: ExchangeRateService, useValue: exchangeRates },
        { provide: SecurityPriceService, useValue: securityPrices },
        { provide: BondValuationService, useValue: bondValuation },
      ],
    }).compile();

    service = module.get(AccountBalancesReportService);
  });

  const cheque = {
    id: "acc-1",
    currency_code: "CAD",
    account_type: "CHEQUING",
    account_sub_type: null,
  };
  const brokerage = {
    id: "acc-b",
    currency_code: "CAD",
    account_type: "INVESTMENT",
    account_sub_type: "INVESTMENT_BROKERAGE",
  };

  // An empty answer still has a reporting currency; leaving it out would make
  // the client guess which currency its zeroes are in.
  it("returns nothing at all when the caller has no accounts", async () => {
    program({ accounts: [] });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result).toEqual({
      asOfDate: "2026-03-01",
      displayCurrency: "CAD",
      displayRates: { CAD: 1 },
      approximatedDisplayRates: {},
      accounts: [],
    });
  });

  describe("presenting every account in one currency", () => {
    const usdSavings = {
      id: "acc-usd",
      currency_code: "USD",
      account_type: "SAVINGS",
      account_sub_type: null,
    };

    // A point-in-time report converts at that point in time: asked what an
    // account held in 2019, "what it was worth then" is the question, and
    // today's rate answers a different one.
    it("resolves each account currency at the rate stored for the date", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2026-02-27",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayCurrency).toBe("CAD");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.35 });
    });

    // Same currency is 1:1 by definition, and it has to stay distinguishable
    // from the missing case -- which is why the map carries it explicitly.
    it("carries the display currency at 1", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "1" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1 });
    });

    // Omitted, never 1. A currency given a fallback rate is an account
    // presented at a number nobody quoted.
    it("omits a currency with no accepted rate rather than defaulting it", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1 });
      expect(result.displayRates.USD).toBeUndefined();
    });

    it("resolves a pair stored only in the reverse direction", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate_date: "2026-02-27",
            rate: "0.8",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates.USD).toBeCloseTo(1.25, 10);
    });

    it("falls back to USD when the user has stated no reporting currency", async () => {
      preferencesRepo.findOne.mockResolvedValue(null);
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "1" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayCurrency).toBe("USD");
    });
  });

  // The ledger runs ahead of the market: a transaction can be dated next year,
  // a close cannot. Without the clamp `closeAt` refuses its own inputs -- a
  // report dated a year out finds today's close 365 days stale and calls every
  // position unpriced.
  describe("a date in the future", () => {
    it("sums the ledger to the requested date but reads the market at today", async () => {
      program({
        accounts: [brokerage],
        balances: [{ id: "acc-b", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-b",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
        ],
        prices: [
          { security_id: "sec-1", price_date: "2026-08-17", close_price: "22" },
        ],
        securities: [{ id: "sec-1", currency_code: "CAD" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2027-06-30");

      // The ledger is asked about the future date...
      const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("LEFT JOIN transactions"),
      );
      expect(ledgerCall[1][1]).toBe("2027-06-30");
      const replayCall = query.mock.calls.find(([sql]: [string]) =>
        isReplayQuery(sql),
      );
      expect(replayCall[1][1]).toBe("2027-06-30");

      // ...and the market about today.
      const priceCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM security_prices"),
      );
      expect(priceCall[1][1]).toBe("2026-08-18");
      expect(priceCall[1][2]).toBe("2026-08-04");
      const rateCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("FROM exchange_rates"),
      );
      expect(rateCall[1]).toEqual(["2026-08-18", "2026-08-04"]);

      // The position is held at the latest close, not called unpriced.
      expect(result.accounts[0]).toMatchObject({
        marketValue: 220,
        valuationComplete: true,
      });
    });

    it("still converts for presentation on a far-future date", async () => {
      program({
        accounts: [
          {
            id: "acc-usd",
            currency_code: "USD",
            account_type: "SAVINGS",
            account_sub_type: null,
          },
        ],
        balances: [{ id: "acc-usd", balance: "50" }],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2026-08-17",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2030-01-01");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.35 });
    });
  });

  it("echoes the date it measured, so the payload carries its own request key", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "150" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.asOfDate).toBe("2026-03-01");
  });

  // The ledger sum is the one `recalculateCurrentBalance` uses with the
  // caller's date in place of today; the SQL predicate is the claim.
  it("sums the ledger with the caller's date, excluding void and split-child rows", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "150" }],
    });
    await service.getBalancesAsOf("user-1", "2026-03-01");

    const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN transactions"),
    );
    expect(ledgerCall[0]).toContain("t.status != 'VOID'");
    expect(ledgerCall[0]).toContain("t.parent_transaction_id IS NULL");
    expect(ledgerCall[0]).toContain("t.transaction_date <= $2");
    expect(ledgerCall[1]).toEqual(["user-1", "2026-03-01", [], null]);
  });

  it("reports the ledger balance in the account's own currency", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "175.5000" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0]).toMatchObject({
      accountId: "acc-1",
      currencyCode: "CAD",
      balance: 175.5,
    });
  });

  it("reports a BTC wallet's ledger balance at its eight places, before any conversion (INV-MONEY-001)", async () => {
    program({
      accounts: [
        {
          id: "acc-btc",
          currency_code: "BTC",
          account_type: "CRYPTO",
          account_sub_type: null,
        },
      ],
      balances: [{ id: "acc-btc", balance: "0.01247493", decimal_places: 8 }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    // At four places this wallet read 0.0125.
    expect(result.accounts[0]).toMatchObject({
      accountId: "acc-btc",
      currencyCode: "BTC",
      balance: 0.01247493,
    });
    const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN transactions"),
    );
    expect(ledgerCall[0]).toContain(
      "LEFT JOIN currencies c ON c.code = a.currency_code",
    );
  });

  it("rounds a fiat ledger balance at four places, as before", async () => {
    program({
      accounts: [cheque],
      balances: [{ id: "acc-1", balance: "175.50004", decimal_places: 2 }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0].balance).toBe(175.5);
  });

  // A ledger sum over rows the database holds is always known, and an account
  // with nothing before the date sits at its opening balance -- the query
  // returns that, and a row the query did not answer for is 0, not null.
  it("never reports an unknown ledger balance", async () => {
    program({ accounts: [cheque], balances: [] });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0].balance).toBe(0);
  });

  /**
   * A balance is a fact about something that exists, so a date before the
   * account came into existence has no balance to report -- not an opening
   * balance carried backwards, which is the sum the account *started* at.
   *
   * Inception is `date_acquired` for an asset that carries one, and otherwise
   * the first movement on either ledger.
   */
  describe("a bond-linked position is its own account's lots", () => {
    const second = { ...brokerage, id: "acc-b2" };
    const buy = (accountId: string) => ({
      account_id: accountId,
      security_id: "sec-1",
      action: "BUY",
      quantity: "10",
    });
    const fixture = (): Fixture => ({
      accounts: [brokerage, second],
      balances: [
        { id: "acc-b", balance: "0" },
        { id: "acc-b2", balance: "0" },
      ],
      investmentTransactions: [buy("acc-b"), buy("acc-b2")],
      // The blend over every account's lots: what quantity x price would use.
      prices: [
        {
          security_id: "sec-1",
          price_date: "2026-02-27",
          close_price: "117.74",
        },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
      linkedSecurities: [{ id: "sec-1" }],
    });
    const lots = (
      a: string | null,
      b: string | null,
    ): SecurityValueByAccount => ({
      asOf: "2026-03-01",
      accounts: new Map([
        ["acc-b", { quantity: 10, grossValue: a }],
        ["acc-b2", { quantity: 10, grossValue: b }],
      ]),
    });

    it("values each account by its own lots at the report's date", async () => {
      program(fixture());
      bondValuation.valueByAccount.mockResolvedValue(
        lots("1354.00", "1000.80"),
      );

      const result = await service.getBalancesAsOf("user-1", "2026-03-01");

      expect(result.accounts[0]).toMatchObject({
        marketValue: 1354,
        valuationComplete: true,
      });
      expect(result.accounts[1]).toMatchObject({
        marketValue: 1000.8,
        valuationComplete: true,
      });
      // One valuation per linked security, on the report's date.
      expect(bondValuation.valueByAccount).toHaveBeenCalledTimes(1);
      expect(bondValuation.valueByAccount).toHaveBeenCalledWith(
        "user-1",
        "sec-1",
        "2026-03-01",
      );
    });

    it("leaves an account with an unknown lot unpriced, never the blend", async () => {
      program(fixture());
      bondValuation.valueByAccount.mockResolvedValue(lots(null, "1000.80"));

      const result = await service.getBalancesAsOf("user-1", "2026-03-01");

      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        unpricedHoldingsCount: 1,
        pricesComplete: false,
        valuationComplete: false,
      });
      expect(result.accounts[1].marketValue).toBe(1000.8);
    });

    it("leaves the positions unpriced when the valuation throws", async () => {
      program(fixture());
      bondValuation.valueByAccount.mockRejectedValue(new Error("boom"));

      const result = await service.getBalancesAsOf("user-1", "2026-03-01");

      expect(result.accounts.map((a) => a.marketValue)).toEqual([null, null]);
    });
  });

  describe("a date before the account existed", () => {
    const asset = {
      id: "acc-asset",
      currency_code: "CAD",
      account_type: "ASSET",
      account_sub_type: null,
      date_acquired: "2024-06-15",
    };

    it("reports an asset as absent before the day it was acquired", async () => {
      program({
        accounts: [asset],
        balances: [{ id: "acc-asset", balance: "450000" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2024-06-14");
      expect(result.accounts[0]).toMatchObject({
        accountId: "acc-asset",
        existsAsOf: false,
        balance: 0,
      });
    });

    // The day itself is the day it started existing, not the day before it did.
    it("reports the asset from its acquisition date onwards", async () => {
      program({
        accounts: [asset],
        balances: [{ id: "acc-asset", balance: "450000" }],
      });
      for (const date of ["2024-06-15", "2026-03-01"]) {
        const result = await service.getBalancesAsOf("user-1", date);
        expect(result.accounts[0]).toMatchObject({
          existsAsOf: true,
          balance: 450000,
        });
      }
    });

    // The field says when the asset started existing. A transaction filed
    // earlier is what the user has already corrected by setting it.
    it("lets the acquisition date win over an earlier transaction", async () => {
      program({
        accounts: [asset],
        balances: [{ id: "acc-asset", balance: "450000" }],
        firstActivity: [{ id: "acc-asset", first_activity: "2020-01-01" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2024-06-14");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: false,
        balance: 0,
      });
    });

    // `date_acquired` is an asset field; the account form offers it nowhere
    // else, and net worth zeroes on it only for an ASSET. A stray value on
    // another type must not hide a chequing account from its own history.
    it("ignores an acquisition date on an account that is not an asset", async () => {
      program({
        accounts: [{ ...cheque, date_acquired: "2024-06-15" }],
        balances: [{ id: "acc-1", balance: "5000" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2020-01-01");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: true,
        balance: 5000,
      });
    });

    // The opening balance is what the account started at, so before the first
    // transaction there is nothing to start from yet.
    it("withholds an opening balance from dates before the first transaction", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "2500" }],
        firstActivity: [{ id: "acc-1", first_activity: "2023-04-10" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2023-04-09");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: false,
        balance: 0,
      });
    });

    it("reports the opening balance from the first transaction's own date", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "2500" }],
        firstActivity: [{ id: "acc-1", first_activity: "2023-04-10" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2023-04-10");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: true,
        balance: 2500,
      });
    });

    // Nothing dates this account's inception, and `created_at` is when the row
    // was typed in rather than when the account came to exist -- so an account
    // imported today would otherwise vanish from its own history.
    it("reports an account with no acquisition date and no movements at every date", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "2500" }],
        firstActivity: [{ id: "acc-1", first_activity: null }],
      });
      const result = await service.getBalancesAsOf("user-1", "1999-01-01");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: true,
        balance: 2500,
      });
    });

    // A brokerage's movements are trades, not ledger rows, so the inception
    // read has to look at both tables or the account reports as timeless.
    it("dates a brokerage from its investment transactions", async () => {
      program({
        accounts: [brokerage],
        balances: [{ id: "acc-b", balance: "0" }],
        firstActivity: [{ id: "acc-b", first_activity: "2025-02-03" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2025-02-02");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: false,
        balance: 0,
      });
    });

    // The row is in `accounts` as the query runs, so the account exists now
    // whatever its ledger says about next week. Today is the fixture's
    // 2026-08-18.
    it("reports an account whose only movement is still ahead of it", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "500" }],
        firstActivity: [{ id: "acc-1", first_activity: "2026-09-01" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-08-18");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: true,
        balance: 500,
      });
    });

    // Capped at today, not waived: nothing says the account was there in 2010.
    it("still withholds that account from a date before today", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "500" }],
        firstActivity: [{ id: "acc-1", first_activity: "2026-09-01" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-08-17");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: false,
        balance: 0,
      });
    });

    // The user's own statement about an asset they do not own yet, so it is
    // honoured as written rather than capped.
    it("honours an acquisition date that has not arrived", async () => {
      program({
        accounts: [{ ...asset, date_acquired: "2027-01-01" }],
        balances: [{ id: "acc-asset", balance: "450000" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-08-18");
      expect(result.accounts[0]).toMatchObject({
        existsAsOf: false,
        balance: 0,
      });
    });

    it("asks both ledgers for the first movement, unbounded by the report's date", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "1" }],
      });
      await service.getBalancesAsOf("user-1", "2026-03-01");

      const inceptionCall = query.mock.calls.find(([sql]: [string]) =>
        sql.includes("AS first_activity"),
      );
      expect(inceptionCall[0]).toContain("FROM transactions t");
      expect(inceptionCall[0]).toContain("FROM investment_transactions it");
      expect(inceptionCall[0]).toContain("t.parent_transaction_id IS NULL");
      expect(inceptionCall[0]).toContain("t.status != 'VOID'");
      expect(inceptionCall[0]).toContain("it.status != 'VOID'");
      // A window ending at the report's date cannot tell "before the first
      // movement" from "has never had one".
      expect(inceptionCall[0]).not.toContain("$4");
      expect(inceptionCall[1]).toEqual(["user-1", [], null]);
    });
  });

  it("does not report a market value for an account that holds no securities", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "10" }] });
    const result = await service.getBalancesAsOf("user-1", "2026-06-30");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 0,
      // "Does not apply" is not "could not be worked out".
      valuationComplete: true,
      pricesComplete: true,
      fxComplete: true,
    });
    // No holdings accounts, so no replay and no price lookup at all.
    expect(query.mock.calls.some(([sql]: [string]) => isReplayQuery(sql))).toBe(
      false,
    );
  });

  it("values a holding at the last close on or before the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 220,
      knownMarketValueSubtotal: 220,
      valuationComplete: true,
    });

    const priceCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM security_prices"),
    );
    expect(priceCall[0]).toContain("price_date <= $2");
    expect(priceCall[1][1]).toBe("2026-03-01");
    // Bounded below as well, so the query loads exactly the window `closeAt`
    // will accept -- the read and the door agree on one staleness rule.
    expect(priceCall[0]).toContain("price_date >= $3");
    expect(priceCall[1][2]).toBe("2026-02-15");
  });

  // `docs/time-series-contract.md` section 2.1: an instrument last quoted
  // months ago has no price *for* this date. The bounded door still refuses it
  // -- what changed in section 4.2 is what happens next: rather than reporting
  // the account as unvaluable, the report falls back to that close and says so,
  // which `approximatedPriceCount` is. The two halves are asserted together
  // because the marker is the only thing separating this from the defect the
  // bound exists to prevent.
  it("values a close older than the boundary window as a marked approximation", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2025-01-02", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 220,
      unpricedHoldingsCount: 0,
      pricesComplete: true,
      approximatedPriceCount: 1,
    });
  });

  // A close a few days old is what prices a boundary the market was shut on.
  it("carries a close forward across a weekend", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(220);
  });

  it("takes the latest close in the window, not the first", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-20", close_price: "18" },
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(220);
  });

  // A SPLIT's quantity is a ratio, and every replay in the codebase folds it
  // through `applyActionToQuantity` for exactly this reason.
  it("multiplies by a split ratio and honours ADD_SHARES / REMOVE_SHARES", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "SPLIT",
          quantity: "2",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "ADD_SHARES",
          quantity: "5",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "REMOVE_SHARES",
          quantity: "3",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "10" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    // 10 shares, doubled to 20, +5, -3 = 22 at 10 = 220.
    expect(result.accounts[0].marketValue).toBe(220);
  });

  it("excludes void investment rows and rows after the date in SQL", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [],
    });
    await service.getBalancesAsOf("user-1", "2026-03-01");
    const replayCall = query.mock.calls.find(([sql]: [string]) =>
      isReplayQuery(sql),
    );
    expect(replayCall[0]).toContain("status != 'VOID'");
    expect(replayCall[0]).toContain("transaction_date <= $2");
    expect(replayCall[1][1]).toBe("2026-03-01");
  });

  // A total whose components are not all known is null; the part that is known
  // travels beside it under a name that says what it is.
  it("withholds the total when a held position has no price at the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-2",
          action: "BUY",
          quantity: "4",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "22" },
      ],
      securities: [
        { id: "sec-1", currency_code: "CAD" },
        { id: "sec-2", currency_code: "CAD" },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 220,
      unpricedHoldingsCount: 1,
      pricesComplete: false,
      fxComplete: true,
      valuationComplete: false,
    });
  });

  it("withholds the total and names the pair when a position cannot be converted", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: null,
      knownMarketValueSubtotal: 0,
      unpricedHoldingsCount: 0,
      missingRatePairs: ["USD->CAD"],
      fxComplete: false,
      pricesComplete: true,
      valuationComplete: false,
    });
  });

  it("converts a foreign-currency position at the rate stored for the date", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate_date: "2026-02-27",
          rate: "1.35",
        },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0].marketValue).toBe(270);

    const rateCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("FROM exchange_rates"),
    );
    expect(rateCall[0]).toContain("rate_date <= $1");
    expect(rateCall[0]).toContain("rate_date >= $2");
    expect(rateCall[1]).toEqual(["2026-03-01", "2026-02-15"]);
  });

  // A rate is an observation on a date exactly as a close is: one long out of
  // date is not the rate *for* this date. As with a stale close, the report
  // converts at it rather than refusing the figure, and names the approximation
  // -- an exchange rate from another era is only a defect while it wears this
  // date's clothes.
  it("converts at a rate older than the boundary window as a marked approximation", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "20" },
      ],
      securities: [{ id: "sec-1", currency_code: "USD" }],
      rates: [
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate_date: "2024-05-01",
          rate: "1.35",
        },
      ],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 270,
      missingRatePairs: [],
      fxComplete: true,
      approximatedRatePairs: ["USD->CAD"],
    });
    expect(result.approximatedDisplayRates).toEqual({});
  });

  // An empty portfolio is worth zero. Reporting that as unknown tells the user
  // a settled question could not be worked out.
  it("reports a holdings account with no positions as worth zero", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 0,
      knownMarketValueSubtotal: 0,
      valuationComplete: true,
    });
  });

  it("treats a position sold down to nothing as no position, not an unpriced one", async () => {
    program({
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "SELL",
          quantity: "10",
        },
      ],
      prices: [],
      securities: [],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      marketValue: 0,
      unpricedHoldingsCount: 0,
      valuationComplete: true,
    });
  });

  // The cash sleeve of a linked pair is an ordinary ledger account: valuing it
  // as a holdings account is the double-count the pairing exists to avoid.
  it("does not value an INVESTMENT_CASH sleeve as a holdings account", async () => {
    program({
      accounts: [
        {
          id: "acc-c",
          currency_code: "CAD",
          account_type: "INVESTMENT",
          account_sub_type: "INVESTMENT_CASH",
        },
      ],
      balances: [{ id: "acc-c", balance: "5000" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      balance: 5000,
      marketValue: null,
    });
    expect(query.mock.calls.some(([sql]: [string]) => isReplayQuery(sql))).toBe(
      false,
    );
  });

  it("values a standalone investment account, which carries its own holdings", async () => {
    program({
      accounts: [
        {
          id: "acc-s",
          currency_code: "CAD",
          account_type: "INVESTMENT",
          account_sub_type: null,
        },
      ],
      balances: [{ id: "acc-s", balance: "100" }],
      investmentTransactions: [
        {
          account_id: "acc-s",
          security_id: "sec-1",
          action: "BUY",
          quantity: "2",
        },
      ],
      prices: [
        { security_id: "sec-1", price_date: "2026-02-27", close_price: "50" },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    });
    const result = await service.getBalancesAsOf("user-1", "2026-03-01");
    expect(result.accounts[0]).toMatchObject({
      balance: 100,
      marketValue: 100,
    });
  });

  // An empty restriction means "no accounts". Falling through to the owner's
  // whole list would hand a delegate granted nothing every balance there is.
  it("answers an empty restriction with nothing, reading no account", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    const result = await service.getBalancesAsOf(
      "user-1",
      "2026-03-01",
      [],
      [],
    );
    expect(result).toEqual({
      asOfDate: "2026-03-01",
      displayCurrency: "CAD",
      displayRates: { CAD: 1 },
      approximatedDisplayRates: {},
      accounts: [],
    });
    // The caller's own preference is not an account: no balance, holding or
    // price query may run for a grant that names nothing.
    expect(query).not.toHaveBeenCalled();
  });

  it("restricts every read to the accounts a delegate may see", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    await service.getBalancesAsOf("user-1", "2026-03-01", [], ["acc-1"]);

    const accountsCall = query.mock.calls.find(
      ([sql]: [string]) =>
        sql.includes("FROM accounts\n") && sql.includes("account_sub_type"),
    );
    expect(accountsCall[1][2]).toEqual(["acc-1"]);
    const ledgerCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("LEFT JOIN transactions"),
    );
    expect(ledgerCall[1][3]).toEqual(["acc-1"]);
    const inceptionCall = query.mock.calls.find(([sql]: [string]) =>
      sql.includes("AS first_activity"),
    );
    expect(inceptionCall[1][2]).toEqual(["acc-1"]);
  });

  it("widens the ownership predicate to the authorized joint accounts only", async () => {
    program({ accounts: [cheque], balances: [{ id: "acc-1", balance: "1" }] });
    await service.getBalancesAsOf("user-1", "2026-03-01", ["joint-1"]);

    for (const [sql, params] of query.mock.calls) {
      if (!sql.includes("FROM accounts")) continue;
      expect(sql).toContain("id = ANY(");
      expect(params).toContain("user-1");
      expect(params).toContainEqual(["joint-1"]);
    }
  });
  /**
   * The daily refresh writes today and `backfillHistoricalRates` skips a pair
   * that already has any row at all, so a user whose USD/CAD history begins at
   * their import has nothing whatsoever for 2017 -- and the report, correctly
   * refusing to convert at a rate nobody quoted, showed "Total unavailable" for
   * accounts that plainly existed and held money (the warning in the backend
   * log named the pair). The rate is not wrong, it is absent, so the report
   * asks for it.
   */
  describe("a date the database has no rate for", () => {
    const usdSavings = {
      id: "acc-usd",
      currency_code: "USD",
      account_type: "SAVINGS",
      account_sub_type: null,
    };
    const usdBrokerage = {
      id: "acc-ub",
      currency_code: "USD",
      account_type: "INVESTMENT",
      account_sub_type: "INVESTMENT_BROKERAGE",
    };
    const twoAccounts = {
      accounts: [cheque, usdSavings],
      balances: [
        { id: "acc-1", balance: "100" },
        { id: "acc-usd", balance: "50" },
      ],
    };

    it("asks the provider for the pair it cannot convert", async () => {
      program({ ...twoAccounts, rates: [] });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );
    });

    it("presents the account at the fetched rate once it lands", async () => {
      const fixture: Fixture = { ...twoAccounts, rates: [] };
      program(fixture);
      exchangeRates.ensureRatesForDate.mockImplementation(async () => {
        fixture.rates = [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2017-08-17",
            rate: "1.27",
          },
        ];
        return 1;
      });

      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.27 });
    });

    // The fetched rows are read back out of the database rather than patched
    // into the map in memory, so the report converts with exactly what a second
    // request would find.
    it("re-reads the stored rates rather than trusting the fetch", async () => {
      program({ ...twoAccounts, rates: [] });
      exchangeRates.ensureRatesForDate.mockResolvedValue(3);
      await service.getBalancesAsOf("user-1", "2017-08-18");
      const rateReads = query.mock.calls.filter(([sql]: [string]) =>
        isBoundedRateRead(sql),
      );
      expect(rateReads).toHaveLength(2);
    });

    it("does not re-read when the provider had nothing to add", async () => {
      program({ ...twoAccounts, rates: [] });
      exchangeRates.ensureRatesForDate.mockResolvedValue(0);
      await service.getBalancesAsOf("user-1", "2017-08-18");
      const rateReads = query.mock.calls.filter(([sql]: [string]) =>
        isBoundedRateRead(sql),
      );
      expect(rateReads).toHaveLength(1);
    });

    // Absent, exactly as before this existed -- a pair nobody has a rate for is
    // still a pair nobody has a rate for, and the report says so rather than
    // failing a read the database answered for everything else.
    it("leaves the report standing when the fetch finds nothing", async () => {
      program({ ...twoAccounts, rates: [] });
      exchangeRates.ensureRatesForDate.mockResolvedValue(0);
      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.displayRates).toEqual({ CAD: 1 });
      expect(result.accounts).toHaveLength(2);
    });

    it("leaves the report standing when the fetch throws", async () => {
      program({ ...twoAccounts, rates: [] });
      exchangeRates.ensureRatesForDate.mockRejectedValue(
        new Error("provider unreachable"),
      );
      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.displayRates).toEqual({ CAD: 1 });
      expect(result.accounts).toHaveLength(2);
    });

    it("does not ask for a pair the date already has a rate for", async () => {
      program({
        ...twoAccounts,
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2017-08-17",
            rate: "1.27",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
    });

    // `convertWithRateLookup` answers a pair from its reciprocal, so a
    // reverse-only row is not a missing rate and must not send anyone to the
    // provider.
    it("does not ask for a pair stored only in the reverse direction", async () => {
      program({
        ...twoAccounts,
        rates: [
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate_date: "2017-08-17",
            rate: "0.8",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
    });

    // Two jobs need rates and they are not the same pairs: presenting each
    // account in the user's currency, and pricing a foreign security into the
    // currency of the account holding it. The report was blank for the second
    // reason as well as the first.
    it("asks for a held security's currency against its account's", async () => {
      program({
        accounts: [usdBrokerage],
        balances: [{ id: "acc-ub", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-ub",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
        ],
        prices: [
          { security_id: "sec-1", price_date: "2017-08-17", close_price: "20" },
        ],
        securities: [{ id: "sec-1", currency_code: "EUR" }],
        rates: [],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      const [pairs] = exchangeRates.ensureRatesForDate.mock.calls[0];
      expect(pairs).toEqual(
        expect.arrayContaining([
          { from: "USD", to: "CAD" },
          { from: "EUR", to: "USD" },
        ]),
      );
      expect(pairs).toHaveLength(2);
    });

    it("values the holding once the security's rate lands", async () => {
      const fixture: Fixture = {
        accounts: [usdBrokerage],
        balances: [{ id: "acc-ub", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-ub",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
        ],
        prices: [
          { security_id: "sec-1", price_date: "2017-08-17", close_price: "20" },
        ],
        securities: [{ id: "sec-1", currency_code: "EUR" }],
        rates: [],
      };
      program(fixture);
      exchangeRates.ensureRatesForDate.mockImplementation(async () => {
        fixture.rates = [
          {
            from_currency: "EUR",
            to_currency: "USD",
            rate_date: "2017-08-17",
            rate: "1.18",
          },
        ];
        return 2;
      });

      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 236,
        missingRatePairs: [],
        valuationComplete: true,
      });
    });

    // A round trip spent on a currency nothing holds any more is a round trip
    // spent on nothing, and the provider is rate limited.
    it("does not ask for a security sold down to nothing", async () => {
      program({
        accounts: [usdBrokerage],
        balances: [{ id: "acc-ub", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-ub",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
          {
            account_id: "acc-ub",
            security_id: "sec-1",
            action: "SELL",
            quantity: "10",
          },
        ],
        securities: [{ id: "sec-1", currency_code: "EUR" }],
        rates: [],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "USD", to: "CAD" }],
        "2017-08-18",
      );
    });

    // Prices and rates cannot run ahead of today, so the fetch is asked for the
    // market date the rest of the report reads at -- not the ledger's date.
    it("fetches at the market date, not a future report date", async () => {
      program({ ...twoAccounts, rates: [] });
      await service.getBalancesAsOf("user-1", "2027-05-04");
      expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
        [{ from: "USD", to: "CAD" }],
        "2026-08-18",
      );
    });

    it("asks for nothing when every account is already in the display currency", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "100" }],
        rates: [],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
    });
  });

  /**
   * The price half of the same absence. A security backfilled with one year of
   * history from the day it was created has no close at all for 2017, so
   * `closeAt` answers null, the position is unpriced, and the account's market
   * value is null -- "Total unavailable" again, for a different missing series.
   */
  describe("a date the database has no price for", () => {
    const held = {
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    };

    it("asks the provider for the securities it cannot price", async () => {
      program({ ...held, prices: [] });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(securityPrices.ensurePricesForDate).toHaveBeenCalledWith(
        ["sec-1"],
        "2017-08-18",
      );
    });

    it("values the position once the fetched close lands", async () => {
      const fixture: Fixture = { ...held, prices: [] };
      program(fixture);
      securityPrices.ensurePricesForDate.mockImplementation(async () => {
        fixture.prices = [
          {
            security_id: "sec-1",
            price_date: "2017-08-17",
            close_price: "20",
          },
        ];
        return 22;
      });

      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 200,
        unpricedHoldingsCount: 0,
        pricesComplete: true,
        valuationComplete: true,
      });
    });

    // "The last close is from 2016" and "there are no closes" are the same
    // absence from a 2017 report's point of view, and only the fetch tells them
    // apart -- so a close refused by the staleness bound is asked for too.
    it("asks for a security whose only close is outside the boundary window", async () => {
      program({
        ...held,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2017-06-30",
            close_price: "20",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(securityPrices.ensurePricesForDate).toHaveBeenCalledWith(
        ["sec-1"],
        "2017-08-18",
      );
    });

    it("does not ask for a security the date already has a close for", async () => {
      program({
        ...held,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2017-08-17",
            close_price: "20",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(securityPrices.ensurePricesForDate).not.toHaveBeenCalled();
    });

    it("does not ask for a security sold down to nothing", async () => {
      program({
        ...held,
        investmentTransactions: [
          {
            account_id: "acc-b",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
          {
            account_id: "acc-b",
            security_id: "sec-1",
            action: "SELL",
            quantity: "10",
          },
        ],
        prices: [],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(securityPrices.ensurePricesForDate).not.toHaveBeenCalled();
    });

    it("re-reads the stored prices rather than trusting the fetch", async () => {
      program({ ...held, prices: [] });
      securityPrices.ensurePricesForDate.mockResolvedValue(22);
      await service.getBalancesAsOf("user-1", "2017-08-18");
      const priceReads = query.mock.calls.filter(([sql]: [string]) =>
        isBoundedPriceRead(sql),
      );
      expect(priceReads).toHaveLength(2);
    });

    it("does not re-read when the provider had nothing to add", async () => {
      program({ ...held, prices: [] });
      securityPrices.ensurePricesForDate.mockResolvedValue(0);
      await service.getBalancesAsOf("user-1", "2017-08-18");
      const priceReads = query.mock.calls.filter(([sql]: [string]) =>
        isBoundedPriceRead(sql),
      );
      expect(priceReads).toHaveLength(1);
    });

    it("leaves the position unpriced when the fetch finds nothing", async () => {
      program({ ...held, prices: [] });
      securityPrices.ensurePricesForDate.mockResolvedValue(0);
      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        unpricedHoldingsCount: 1,
        pricesComplete: false,
      });
    });

    it("leaves the report standing when the fetch throws", async () => {
      program({ ...held, prices: [] });
      securityPrices.ensurePricesForDate.mockRejectedValue(
        new Error("provider unreachable"),
      );
      const result = await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        unpricedHoldingsCount: 1,
      });
    });

    // Prices cannot run ahead of today any more than rates can.
    it("fetches at the market date, not a future report date", async () => {
      program({ ...held, prices: [] });
      await service.getBalancesAsOf("user-1", "2027-05-04");
      expect(securityPrices.ensurePricesForDate).toHaveBeenCalledWith(
        ["sec-1"],
        "2026-08-18",
      );
    });

    it("asks for nothing when the account holds no securities", async () => {
      program({
        accounts: [brokerage],
        balances: [{ id: "acc-b", balance: "0" }],
        investmentTransactions: [],
      });
      await service.getBalancesAsOf("user-1", "2017-08-18");
      expect(securityPrices.ensurePricesForDate).not.toHaveBeenCalled();
    });
  });

  /**
   * Spec sections 4.2 and 7.2: when neither the window nor the provider can
   * answer for the date, the report values at the closest observation the
   * database holds either side of it, and says which figures those are.
   *
   * The point of every case here is the pair: a figure *and* its marker. A
   * number without the marker is the defect the staleness bound exists to
   * prevent, and a marker without the number is the "Total unavailable" this
   * replaced.
   */
  describe("falling back to the closest observation", () => {
    const heldOne = {
      accounts: [brokerage],
      balances: [{ id: "acc-b", balance: "0" }],
      investmentTransactions: [
        {
          account_id: "acc-b",
          security_id: "sec-1",
          action: "BUY",
          quantity: "10",
        },
      ],
      securities: [{ id: "sec-1", currency_code: "CAD" }],
    };

    const usdSavings = {
      id: "acc-usd",
      currency_code: "USD",
      account_type: "SAVINGS",
      account_sub_type: null,
    };

    // A close struck after the date is still the closest thing anybody
    // observed, and the user asked for the closest -- before or after.
    it("prices from the closer of the two neighbours when it comes after the date", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2025-11-14",
            close_price: "10",
          },
          {
            security_id: "sec-1",
            price_date: "2026-03-20",
            close_price: "22",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 220,
        approximatedPriceCount: 1,
        unpricedHoldingsCount: 0,
        valuationComplete: true,
      });
    });

    it("prices from the earlier neighbour when that is the closer one", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-01-30",
            close_price: "10",
          },
          {
            security_id: "sec-1",
            price_date: "2026-08-14",
            close_price: "22",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 100,
        approximatedPriceCount: 1,
      });
    });

    // A tie goes to the close that had already been struck when the date
    // arrived; the later one is a price the date could not have known.
    it("prefers the earlier observation when both are equally close", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-02-01",
            close_price: "10",
          },
          {
            security_id: "sec-1",
            price_date: "2026-03-29",
            close_price: "22",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0].marketValue).toBe(100);
    });

    // The fallback fills a gap in coverage. It does not invent an observation
    // nobody made, so a security nobody ever priced is still unpriced and the
    // total is still null.
    it("leaves a security with no stored close at any date unpriced", async () => {
      program({ ...heldOne, prices: [] });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        unpricedHoldingsCount: 1,
        pricesComplete: false,
        approximatedPriceCount: 0,
      });
    });

    // A close of zero is a row that says nothing, and substituting it would
    // report a held position as worthless.
    it("ignores a non-positive close when looking for the closest one", async () => {
      program({
        ...heldOne,
        prices: [
          { security_id: "sec-1", price_date: "2026-02-01", close_price: "0" },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        unpricedHoldingsCount: 1,
      });
    });

    it("presents an account currency at the closest rate and names the day it was struck", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2024-05-01",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1, USD: 1.35 });
      expect(result.approximatedDisplayRates).toEqual({ USD: "2024-05-01" });
    });

    // The same observation seen from the other side. `convertWithRateLookup`
    // turns it back around for an approximation exactly as it does for a rate
    // inside the window.
    it("uses a closest rate stored only in the reverse direction", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [
          {
            from_currency: "CAD",
            to_currency: "USD",
            rate_date: "2024-05-01",
            rate: "0.8",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates.USD).toBeCloseTo(1.25, 10);
      expect(result.approximatedDisplayRates).toEqual({ USD: "2024-05-01" });
    });

    // A pair nobody ever stored has nothing to approximate from: the currency
    // stays out of the map, which is what tells a consumer its accounts are
    // unconvertible rather than converted at 1.
    it("omits a currency with no stored rate at any date", async () => {
      program({
        accounts: [cheque, usdSavings],
        balances: [
          { id: "acc-1", balance: "100" },
          { id: "acc-usd", balance: "50" },
        ],
        rates: [],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.displayRates).toEqual({ CAD: 1 });
      expect(result.approximatedDisplayRates).toEqual({});
    });

    // Nothing that stood on the date is displaced by the fallback -- the reads
    // only ever run for what is still missing.
    it("does not look for a closest observation when the date answers everything", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-02-27",
            close_price: "22",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 220,
        approximatedPriceCount: 0,
        approximatedRatePairs: [],
      });
      expect(
        query.mock.calls.filter(([sql]: [string]) => isNearestRead(sql)),
      ).toHaveLength(0);
    });

    it("asks only for the securities still missing a price", async () => {
      program({
        accounts: [brokerage],
        balances: [{ id: "acc-b", balance: "0" }],
        investmentTransactions: [
          {
            account_id: "acc-b",
            security_id: "sec-1",
            action: "BUY",
            quantity: "10",
          },
          {
            account_id: "acc-b",
            security_id: "sec-2",
            action: "BUY",
            quantity: "5",
          },
        ],
        securities: [
          { id: "sec-1", currency_code: "CAD" },
          { id: "sec-2", currency_code: "CAD" },
        ],
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-02-27",
            close_price: "22",
          },
          {
            security_id: "sec-2",
            price_date: "2024-01-05",
            close_price: "4",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2026-03-01");
      const nearest = query.mock.calls.find(
        ([sql]: [string]) =>
          isNearestRead(sql) && sql.includes("FROM security_prices"),
      );
      expect(nearest[1][0]).toEqual(["sec-2"]);
    });

    // Prices and rates cannot be observed for a day that has not happened, so
    // the fallback searches around the market date like everything else.
    it("searches around the market date rather than a future report date", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2024-01-05",
            close_price: "4",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2027-05-04");
      const nearest = query.mock.calls.find(
        ([sql]: [string]) =>
          isNearestRead(sql) && sql.includes("FROM security_prices"),
      );
      expect(nearest[1][1]).toBe("2026-08-18");
    });

    // A holding priced in another currency needs a rate to reach its account's
    // currency, and that rate is approximated on the same terms -- named on the
    // row it valued, not only in the display map.
    it("names an approximated rate used to price a foreign holding", async () => {
      program({
        ...heldOne,
        securities: [{ id: "sec-1", currency_code: "USD" }],
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-02-27",
            close_price: "20",
          },
        ],
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate_date: "2024-05-01",
            rate: "1.35",
          },
        ],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: 270,
        approximatedRatePairs: ["USD->CAD"],
        approximatedPriceCount: 0,
        fxComplete: true,
      });
    });

    // A pair with nothing at all is a gap, not an approximation: saying both
    // about one component would be two contradictory claims.
    it("names a pair it could not resolve as missing, never as approximated", async () => {
      program({
        ...heldOne,
        securities: [{ id: "sec-1", currency_code: "USD" }],
        prices: [
          {
            security_id: "sec-1",
            price_date: "2026-02-27",
            close_price: "20",
          },
        ],
        rates: [],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        marketValue: null,
        missingRatePairs: ["USD->CAD"],
        approximatedRatePairs: [],
        fxComplete: false,
      });
    });

    // The provider is still asked first: an approximation is the last resort,
    // not a reason to stop fetching the real thing.
    it("falls back only after the provider fetch has had its turn", async () => {
      program({
        ...heldOne,
        prices: [
          {
            security_id: "sec-1",
            price_date: "2024-01-05",
            close_price: "4",
          },
        ],
      });
      await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(securityPrices.ensurePricesForDate).toHaveBeenCalledWith(
        ["sec-1"],
        "2026-03-01",
      );
      expect(
        query.mock.calls.filter(
          ([sql]: [string]) =>
            isNearestRead(sql) && sql.includes("FROM security_prices"),
        ),
      ).toHaveLength(1);
    });

    // A non-holdings row has no market value to approximate, and the fields
    // still have to be there: a consumer reading them per row cannot have one
    // shape for brokerages and another for chequing.
    it("reports no approximation on an account that holds nothing", async () => {
      program({
        accounts: [cheque],
        balances: [{ id: "acc-1", balance: "5" }],
      });
      const result = await service.getBalancesAsOf("user-1", "2026-03-01");
      expect(result.accounts[0]).toMatchObject({
        approximatedPriceCount: 0,
        approximatedRatePairs: [],
      });
    });
  });
});
