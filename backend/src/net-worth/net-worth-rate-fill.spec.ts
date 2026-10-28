jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
/**
 * The read-path FX fill, at the service seam.
 *
 * `series-rate-fill.spec.ts` covers the plan; this covers what the series does
 * with it: that a gap reaches the provider once per month-pair unit, that a
 * fill which stored rows makes the point complete because the index was
 * RE-READ from the database, and that every way the fill can come back empty --
 * nothing stored, a throw, an opt-out -- leaves the report exactly as honest as
 * it was, with the pair still named.
 *
 * The fixture is the issue's reproduction (#1390): a EUR cash sleeve reported
 * in PLN over a window the exchange_rates table has no row for at all.
 */
import { NetWorthService } from "./net-worth.service";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () => {
  const helpers = jest.requireActual("../test-helpers/scoped-db-testing");
  return {
    ...helpers.scopedDbMockModule(),
    runOutsideActiveScopedManager: (fn: () => unknown) => fn(),
  };
});

describe("NetWorthService read-path FX fill", () => {
  let service: NetWorthService;
  let mocks: ReturnType<typeof createScopedDbMocks>;
  let exchangeRates: { ensureRatesForDate: jest.Mock };
  /** Mutable, so a fill can be made to "persist" rows the re-read then sees. */
  let rateRows: Array<Record<string, unknown>>;
  let rateQueries: number;

  const EUR_PLN = {
    from_currency: "EUR",
    to_currency: "PLN",
    rate: "4.3",
    rate_date: "2026-01-01",
  };

  beforeEach(() => {
    rateRows = [];
    rateQueries = 0;

    mocks = createScopedDbMocks([
      [UserPreference, { findOne: jest.fn(async () => ({})) }],
    ]);
    mocks.manager.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM exchange_rates")) {
        rateQueries++;
        return rateRows;
      }
      if (sql.includes("target_accounts")) {
        // One EUR cash account holding 1,000 on every day of the window.
        return [
          { account_id: "cash-1", date: "2026-01-05", balance: "1000" },
          { account_id: "cash-1", date: "2026-01-06", balance: "1000" },
          { account_id: "cash-1", date: "2026-02-03", balance: "1000" },
        ];
      }
      if (sql.includes("FROM accounts a")) {
        return [
          {
            id: "cash-1",
            account_type: "INVESTMENT",
            account_sub_type: "INVESTMENT_CASH",
            currency_code: "EUR",
            opening_balance: 0,
          },
        ];
      }
      return [];
    });

    exchangeRates = { ensureRatesForDate: jest.fn().mockResolvedValue(0) };
    service = new NetWorthService(
      mocks.dataSource as never,
      undefined,
      exchangeRates as never,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const run = (options?: { fetchMissing?: boolean }) =>
    service.getDailyInvestments(
      "user-1",
      "2026-01-05",
      "2026-02-03",
      undefined,
      "PLN",
      options,
    );

  it("asks the provider once per month-pair unit for the pairs it could not convert", async () => {
    await run();

    expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledTimes(2);
    expect(exchangeRates.ensureRatesForDate).toHaveBeenNthCalledWith(
      1,
      [{ from: "EUR", to: "PLN" }],
      "2026-01-05",
    );
    expect(exchangeRates.ensureRatesForDate).toHaveBeenNthCalledWith(
      2,
      [{ from: "EUR", to: "PLN" }],
      "2026-02-03",
    );
  });

  it("re-reads the index from the database and completes the point when the fill stored rows", async () => {
    exchangeRates.ensureRatesForDate.mockImplementation(async () => {
      // What `ensureRatesForDate` does: it persists. The series must find the
      // rows by reading the table again, not by patching what it holds.
      rateRows = [EUR_PLN];
      return 22;
    });

    const series = await run();

    expect(rateQueries).toBe(2);
    expect(series[0]).toMatchObject({
      date: "2026-01-05",
      value: 4300,
      fxComplete: true,
      missingRatePairs: [],
    });
  });

  it("leaves the point incomplete, with the pair named, when the fill stored nothing", async () => {
    const series = await run();

    // The provider does not carry this pair for this era: unknown stays
    // unknown, and nothing is invented for it (INV-FX-001).
    expect(exchangeRates.ensureRatesForDate).toHaveBeenCalled();
    expect(rateQueries).toBe(1);
    expect(series[0]).toMatchObject({
      value: 0,
      fxComplete: false,
      missingRatePairs: ["EUR->PLN"],
    });
  });

  it("makes no provider call when the caller opted out", async () => {
    const series = await run({ fetchMissing: false });

    expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
    expect(series[0].fxComplete).toBe(false);
    expect(series[0].missingRatePairs).toEqual(["EUR->PLN"]);
  });

  it("renders the series when the provider throws", async () => {
    exchangeRates.ensureRatesForDate.mockRejectedValue(
      new Error("provider unreachable"),
    );

    const series = await run();

    // Best-effort: the request does not fail because a rate fetch did.
    expect(series).toHaveLength(30);
    expect(series[0].fxComplete).toBe(false);
    expect(series[0].missingRatePairs).toEqual(["EUR->PLN"]);
  });

  it("does nothing when no exchange-rate service is wired in", async () => {
    service = new NetWorthService(mocks.dataSource as never);

    const series = await run();

    expect(series[0].fxComplete).toBe(false);
    expect(rateQueries).toBe(1);
  });
});
