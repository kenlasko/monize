import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { manifest, manifestDocument } from "./adapters/pl/pl-test-input";
import { BondTerms, parseBondTerms } from "./domain/bond-terms";
import { BondPriceService } from "./bond-price.service";
import {
  BondReferenceData,
  BondValuationService,
} from "./bond-valuation.service";
import { engineWritesPrice, marketPriceRequired } from "./engine/price-policy";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("../securities/holding-accounts-dirty.util", () => ({
  markHoldingAccountsDirty: jest.fn(async () => []),
}));
jest.mock("../securities/portfolio-summary-memo", () => ({
  invalidatePortfolioSummary: jest.fn(),
}));

type Doc = Record<string, any>;

/** A marketable coupon series: three yearly coupons, paid at maturity only. */
function marketableCouponDoc(): Doc {
  const doc = manifestDocument("tos1029");
  doc.instrument.marketability = "MARKETABLE";
  doc.saleWindow = null;
  doc.redemption = { type: "MATURITY_ONLY" };
  return doc;
}

/** A marketable discount bill: 100 face at 97.833694, 182 days. */
function marketableBillDoc(): Doc {
  const doc = marketableCouponDoc();
  doc.instrument.faceValue = "100";
  doc.instrument.issuePrice = "97.833694";
  doc.schedule = {
    anchor: "ISSUE_DATE",
    issueDate: "2026-10-01",
    maturityDate: "2027-04-01",
    periodCount: 1,
    calendarId: "PL",
  };
  doc.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
  doc.capitalization = { type: "NONE" };
  return doc;
}

const retail = manifest("tos1029");
const marketableCoupon = parseBondTerms(marketableCouponDoc());
const marketableBill = parseBondTerms(marketableBillDoc());

describe("the price policy per marketability (INV-BOND-005)", () => {
  it("lets the engine price a retail series and a discount instrument, not a marketable coupon", () => {
    expect(engineWritesPrice(retail)).toBe(true);
    expect(engineWritesPrice(marketableBill)).toBe(true);
    expect(engineWritesPrice(marketableCoupon)).toBe(false);
  });

  it("requires a market price when any series held is not priced by its terms", () => {
    const list = (...terms: BondTerms[]) => marketPriceRequired(terms);
    expect(list()).toBe(false);
    expect(list(retail, marketableBill)).toBe(false);
    expect(list(marketableCoupon)).toBe(true);
    expect(list(retail, marketableCoupon)).toBe(true);
  });
});

const USER = "user-1";
const SECURITY = "sec-1";
const SERIES_A = "11111111-1111-5111-8111-111111111111";
const SERIES_B = "22222222-2222-5222-8222-222222222222";

function referenceOf(id: string, terms: BondTerms): BondReferenceData {
  return {
    instrument: {
      id,
      issuerCountryCode: terms.instrument.issuerCountryCode,
      issuerCode: terms.instrument.issuerCode,
      programCode: terms.instrument.programCode,
      seriesCode: terms.instrument.seriesCode,
      currencyCode: terms.instrument.currency,
      termsProvider: "curated",
    },
    termsVersion: 1,
    terms,
    announcedRates: new Map(),
    benchmarks: new Map(),
  };
}

function setup(held: Array<{ id: string; terms: BondTerms }>) {
  const { manager, dataSource } = createScopedDbMocks();
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  manager.query.mockImplementation(async (sql: string, params: unknown[]) => {
    statements.push({ sql, params });
    if (sql.includes("pg_advisory_xact_lock")) return [];
    if (sql.includes("FROM user_preferences")) return [];
    if (sql.includes("FROM securities")) {
      return [
        {
          id: SECURITY,
          user_id: USER,
          symbol: "SEC",
          currency_code: "PLN",
          bond_program_id: "program-1",
          bond_auto_fetch: false,
        },
      ];
    }
    if (sql.includes("FROM investment_transactions")) {
      return held.map((h, i) => ({
        action: "BUY",
        status: "UNRECONCILED",
        tx_date: `2026-10-0${i + 2}`,
        quantity: "10",
        account_id: "acct-1",
        counterpart_account_id: null,
        bond_instrument_id: h.id,
      }));
    }
    if (sql.includes("INSERT INTO security_prices")) {
      return [{ id: 1 }];
    }
    if (sql.includes("DELETE FROM security_prices")) return [[], 0];
    throw new Error(`unexpected query: ${sql}`);
  });
  const valuation = new BondValuationService(
    dataSource as unknown as DataSource,
  );
  jest
    .spyOn(valuation, "loadReference")
    .mockImplementation(async (_m, id) =>
      referenceOf(id, held.find((h) => h.id === id)?.terms as BondTerms),
    );
  const service = new BondPriceService(
    dataSource as unknown as DataSource,
    valuation,
    { triggerDebouncedRecalc: jest.fn() } as never,
    { withLease: jest.fn() } as never,
  );
  const call = (part: string) => statements.find((s) => s.sql.includes(part));
  return { service, call };
}

describe("BondPriceService writes no engine price for a series that trades", () => {
  it("writes nothing and deletes the engine rows of a security that holds a marketable coupon series", async () => {
    const { service, call } = setup([
      { id: SERIES_A, terms: marketableCoupon },
    ]);
    const result = await service.recomputeSecurity(USER, SECURITY, {
      today: "2026-10-10",
    });
    expect(call("INSERT INTO security_prices")).toBeUndefined();
    const stale = call("DELETE FROM security_prices");
    expect(stale?.params).toEqual([SECURITY, [], "bond_engine"]);
    expect(result).toEqual({ written: 0, deleted: 0 });
  });

  it("writes none when only one of the held series trades", async () => {
    const { service, call } = setup([
      { id: SERIES_A, terms: retail },
      { id: SERIES_B, terms: marketableCoupon },
    ]);
    await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-10" });
    expect(call("INSERT INTO security_prices")).toBeUndefined();
  });

  it("still prices a marketable discount instrument from its terms", async () => {
    const { service, call } = setup([{ id: SERIES_A, terms: marketableBill }]);
    const result = await service.recomputeSecurity(USER, SECURITY, {
      today: "2026-10-10",
    });
    const upsert = call("INSERT INTO security_prices");
    expect(upsert).toBeDefined();
    expect(upsert?.params[3]).toBe("bond_engine");
    expect(result.written).toBe(1);
  });

  it("still prices a retail series", async () => {
    const { service, call } = setup([{ id: SERIES_A, terms: retail }]);
    await service.recomputeSecurity(USER, SECURITY, { today: "2026-10-10" });
    expect(call("INSERT INTO security_prices")).toBeDefined();
  });
});
