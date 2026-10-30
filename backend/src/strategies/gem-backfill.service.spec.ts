import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { GemBackfillService } from "./gem-backfill.service";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * Read at call time, so a test can move "today" onto a date that exercises the
 * month arithmetic (the 31st).
 */
let today = "2025-08-14";

jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: () => today,
}));

const userId = "user-1";

describe("GemBackfillService", () => {
  let service: GemBackfillService;
  let securityRepo: Record<string, jest.Mock>;
  let priceService: { loadSeries: jest.Mock };
  let securityPrices: { backfillSecurityRange: jest.Mock };
  let exchangeRates: { ensureRatesForDate: jest.Mock };

  const security = (id: string, overrides: Partial<Security> = {}) =>
    ({
      id,
      userId,
      symbol: id.toUpperCase(),
      historicalBackfillAttemptedAt: null,
      ...overrides,
    }) as Security;

  /**
   * A weekly series between two dates. Weekly is dense enough that every
   * boundary is inside `BOUNDARY_LAG_DAYS`, so a series built this way covers
   * the calendar and one with a hole or a stopped feed does not -- which is the
   * distinction the service now makes and the earliest-date check could not.
   */
  const weekly = (from: string, to: string) => {
    const points: Array<{ date: string; close: number }> = [];
    for (
      let at = Date.parse(`${from}T00:00:00Z`);
      at <= Date.parse(`${to}T00:00:00Z`);
      at += 7 * 86_400_000
    ) {
      points.push({
        date: new Date(at).toISOString().slice(0, 10),
        close: 100,
      });
    }
    // Always land exactly on `to`, so a test can say how old the newest close
    // is rather than depending on where the weekly grid happens to stop.
    if (points[points.length - 1]?.date !== to) {
      points.push({ date: to, close: 100 });
    }
    return points;
  };

  /** Prices that satisfy every boundary a 12-month monthly strategy needs. */
  const fullCoverage = () =>
    new Map([["spy", weekly("2018-01-01", "2025-08-14")]]);

  beforeEach(() => {
    today = "2025-08-14";
    securityRepo = {
      find: jest.fn().mockResolvedValue([security("spy")]),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const mocks = createScopedDbMocks([
      [Security, securityRepo],
      [UserPreference, { findOne: jest.fn().mockResolvedValue(null) }],
    ]);
    // No prices at all unless a test supplies them.
    priceService = { loadSeries: jest.fn().mockResolvedValue(new Map()) };
    securityPrices = {
      backfillSecurityRange: jest.fn().mockResolvedValue(500),
    };
    exchangeRates = { ensureRatesForDate: jest.fn().mockResolvedValue(10) };
    service = new GemBackfillService(
      mocks.dataSource as never,
      priceService as never,
      securityPrices as never,
      exchangeRates as never,
    );
  });

  it("fetches history for a security that has never been priced", async () => {
    const fetched = await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");

    expect(fetched).toEqual(["spy"]);
    // 12 months of momentum plus the 24 periods the history table shows.
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.objectContaining({ id: "spy" }),
      "5y",
    );
    // The attempt is stamped so a save moments later does not refetch, and the
    // write is scoped to the owner like every other one in this module.
    expect(securityRepo.update).toHaveBeenCalledWith(
      { id: expect.anything(), userId },
      { historicalBackfillAttemptedAt: expect.any(Date) },
    );
  });

  it("fetches deeper history for a long momentum window", async () => {
    await service.ensureHistory(userId, ["spy"], 60, "MONTHLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "10y",
    );
  });

  it("reaches back three times as far for a quarterly strategy", async () => {
    // 24 history periods are 24 months monthly but 72 quarterly, so the
    // quarterly strategy needs a deeper provider range or its oldest periods
    // never get prices.
    await service.ensureHistory(userId, ["spy"], 12, "QUARTERLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "10y",
    );
  });

  it("clamps the coverage floor to a short month instead of overflowing past it", async () => {
    // 31 March, 37 months back: February. `setUTCMonth` overflows a day-31 date
    // into the following month (3 March 2023), which moves the floor *forward*
    // past closes that would have satisfied it -- so a series reaching back to
    // late February reads as short and the provider is asked again on every
    // save, forever. `addMonthsUtc` clamps to 28 February 2023, and the series
    // window opens a fortnight before that because a boundary may be priced by
    // a close struck up to `BOUNDARY_LAG_DAYS` earlier.
    today = "2026-03-31";

    await service.ensureHistory(userId, ["spy"], 13, "MONTHLY");

    expect(priceService.loadSeries).toHaveBeenCalledWith(
      ["spy"],
      "2023-02-14",
      "day",
    );
  });

  it("checks coverage on the native series, so a missing FX rate cannot look like missing prices", async () => {
    // A converted series drops a close with no rate, which made a security
    // with every price stored read as short and re-fetched on each run.
    await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");
    for (const call of priceService.loadSeries.mock.calls) {
      expect(call[4]).toBeUndefined();
    }
  });

  it("counts a monthly strategy's history in single months", async () => {
    await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");
    expect(securityPrices.backfillSecurityRange).toHaveBeenCalledWith(
      expect.anything(),
      "5y",
    );
  });

  it("leaves a security that can price every boundary", async () => {
    priceService.loadSeries.mockResolvedValue(fullCoverage());
    const fetched = await service.ensureHistory(userId, ["spy"], 12, "MONTHLY");

    expect(fetched).toEqual([]);
    expect(securityPrices.backfillSecurityRange).not.toHaveBeenCalled();
    // The rate check reads the security's currency; nothing is stamped or fetched.
    expect(securityRepo.update).not.toHaveBeenCalled();
    expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
  });

  it("fetches for a security priced only since last month", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([["spy", weekly("2025-07-01", "2025-08-14")]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  /**
   * The three shapes the earliest-date check waved through. Each reaches back
   * far enough and can price none of what the report shows, so the strategy sat
   * without a signal while the save reported that it had ensured the history.
   */
  it("fetches when one old observation is all there is", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([["spy", [{ date: "2015-01-02", close: 100 }]]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("fetches when the feed stopped and the recent boundaries are unpriced", async () => {
    priceService.loadSeries.mockResolvedValue(
      new Map([["spy", weekly("2018-01-01", "2025-02-01")]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("fetches when a middle boundary is missing", async () => {
    const holed = [
      ...weekly("2018-01-01", "2024-01-01"),
      // Nothing at all through 2024: every boundary inside it is unpriceable.
      ...weekly("2025-01-06", "2025-08-14"),
    ];
    priceService.loadSeries.mockResolvedValue(new Map([["spy", holed]]));
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("accepts a quote just inside the boundary lag and refuses one just outside", async () => {
    // Last close 13 days before today: inside the fortnight, so the newest
    // boundary is priced and nothing is fetched.
    priceService.loadSeries.mockResolvedValue(
      new Map([["spy", weekly("2018-01-01", "2025-08-01")]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      [],
    );

    // Last close 21 days before today: outside it.
    priceService.loadSeries.mockResolvedValue(
      new Map([["spy", weekly("2018-01-01", "2025-07-24")]]),
    );
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("respects the provider cooldown", async () => {
    securityRepo.find.mockResolvedValue([
      security("spy", { historicalBackfillAttemptedAt: new Date() }),
    ]);
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      [],
    );
    expect(securityPrices.backfillSecurityRange).not.toHaveBeenCalled();
  });

  it("retries once the cooldown has passed", async () => {
    securityRepo.find.mockResolvedValue([
      security("spy", {
        historicalBackfillAttemptedAt: new Date(Date.now() - 24 * 3600 * 1000),
      }),
    ]);
    expect(await service.ensureHistory(userId, ["spy"], 12, "MONTHLY")).toEqual(
      ["spy"],
    );
  });

  it("survives a provider failure so the save still completes", async () => {
    securityPrices.backfillSecurityRange.mockRejectedValue(
      new Error("provider unavailable"),
    );
    // The report warns about the incomplete history; the save does not fail.
    await expect(
      service.ensureHistory(userId, ["spy"], 12, "MONTHLY"),
    ).resolves.toEqual(["spy"]);
    expect(securityRepo.update).toHaveBeenCalled();
  });

  it("does nothing without securities", async () => {
    expect(await service.ensureHistory(userId, [], 12, "MONTHLY")).toEqual([]);
    expect(priceService.loadSeries).not.toHaveBeenCalled();
  });

  it("only touches the caller's own securities", async () => {
    await service.ensureHistory(userId, ["spy", "spy"], 12, "MONTHLY");
    expect(securityRepo.find).toHaveBeenCalledWith({
      where: { id: expect.anything(), userId },
    });
  });

  it("fetches the exchange-rate history, not prices, when only the rate is missing", async () => {
    // Prices cover every boundary in EUR; the USD series (no rates) is empty.
    securityRepo.find.mockResolvedValue([
      security("eur-fund", { currencyCode: "EUR" }),
    ]);
    priceService.loadSeries.mockImplementation(
      async (
        _ids: string[],
        _from: string,
        _s: string,
        _m: unknown,
        user?: string,
      ) =>
        user
          ? new Map()
          : new Map([["eur-fund", weekly("2018-01-01", "2025-08-14")]]),
    );

    const fetched = await service.ensureHistory(
      userId,
      ["eur-fund"],
      12,
      "MONTHLY",
    );

    expect(fetched).toEqual([]);
    expect(securityPrices.backfillSecurityRange).not.toHaveBeenCalled();
    expect(exchangeRates.ensureRatesForDate).toHaveBeenCalledWith(
      [{ from: "EUR", to: "USD" }],
      "2025-08-14",
    );
  });

  it("asks for no rates when the converted series covers every boundary", async () => {
    securityRepo.find.mockResolvedValue([
      security("eur-fund", { currencyCode: "EUR" }),
    ]);
    priceService.loadSeries.mockResolvedValue(
      new Map([["eur-fund", weekly("2018-01-01", "2025-08-14")]]),
    );

    await service.ensureHistory(userId, ["eur-fund"], 12, "MONTHLY");

    expect(exchangeRates.ensureRatesForDate).not.toHaveBeenCalled();
  });
});
