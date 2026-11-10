import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

import { DailyBalanceTotalsService } from "./daily-balance-totals.service";
import { AccountsService } from "./accounts.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { BalanceForecastResult } from "./balance-forecast.service";
import { UserPreference } from "../users/entities/user-preference.entity";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

// Pin only the clock: replacing the module would delete `addDaysYMD`, which the
// date walk needs, and the failure would name a missing function rather than
// anything this suite is about.
jest.mock("../common/date-utils", () => ({
  ...jest.requireActual("../common/date-utils"),
  todayYMD: jest.fn(() => "2026-06-15"),
}));

/**
 * The scoped-db door hands the callback a manager; every read in this service
 * goes through it, so one fake manager answers the scope query, the preference
 * read and the rate query. Each is matched on the statement it actually issues
 * rather than by call order, so a reordering inside the service does not read
 * as a failure here.
 */
interface FakeRow {
  [key: string]: unknown;
}

describe("DailyBalanceTotalsService", () => {
  const TODAY = "2026-06-15";
  let service: DailyBalanceTotalsService;
  let accountsService: { getDailyBalances: jest.Mock };
  let forecastService: { getBalanceForecast: jest.Mock };
  let accountRows: FakeRow[];
  let rateRows: FakeRow[];
  let preference: { defaultCurrency?: string | null } | null;
  let queries: Array<{ sql: string; params: unknown[] }>;

  let mocks: ReturnType<typeof createScopedDbMocks>;

  beforeEach(async () => {
    queries = [];
    accountRows = [];
    rateRows = [];
    preference = { defaultCurrency: "CAD" };
    accountsService = { getDailyBalances: jest.fn().mockResolvedValue([]) };
    forecastService = { getBalanceForecast: jest.fn() };

    const preferenceRepo = { findOne: jest.fn(async () => preference) };
    mocks = createScopedDbMocks([[UserPreference, preferenceRepo]]);
    mocks.manager.query.mockImplementation(
      async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        if (sql.includes("FROM accounts")) return accountRows;
        if (sql.includes("FROM exchange_rates")) return rateRows;
        throw new Error(`unexpected query: ${sql}`);
      },
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DailyBalanceTotalsService,
        { provide: DataSource, useValue: mocks.dataSource },
        { provide: AccountsService, useValue: accountsService },
        { provide: BalanceForecastService, useValue: forecastService },
      ],
    }).compile();

    service = module.get(DailyBalanceTotalsService);
  });

  afterEach(() => jest.restoreAllMocks());

  const account = (id: string, currency: string, owned = true): FakeRow => ({
    id,
    currency_code: currency,
    owned,
  });

  const rate = (
    from: string,
    to: string,
    value: number,
    date: string,
  ): FakeRow => ({
    from_currency: from,
    to_currency: to,
    rate: String(value),
    rate_date: date,
  });

  const balance = (
    accountId: string,
    date: string,
    amount: number,
    currencyCode: string,
  ) => ({ accountId, date, balance: amount, currencyCode });

  const completeForecast = (
    accountId: string,
    currencyCode: string,
    points: Array<{ date: string; balance: number }>,
  ): BalanceForecastResult => ({
    accountId,
    currencyCode,
    points,
    complete: true,
    gaps: [],
    overdue: null,
  });

  describe("withReportingCurrency (issue #2106)", () => {
    it("converts each per-account row at its own day's rate, and a future day at today's", async () => {
      rateRows = [
        rate("USD", "CAD", 1.25, "2026-01-10"),
        rate("USD", "CAD", 1.4, "2026-06-14"),
      ];

      const rows = await service.withReportingCurrency("user-1", [
        balance("savings", "2026-01-12", 100, "USD"),
        balance("savings", "2026-06-15", 100, "USD"),
        balance("savings", "2026-06-30", 100, "USD"),
        balance("chequing", "2026-01-12", 50, "CAD"),
      ]);

      expect(rows.map((r) => r.convertedBalance)).toEqual([125, 140, 140, 50]);
      expect(rows.every((r) => r.convertedCurrency === "CAD")).toBe(true);
      // The row keeps its own balance and currency beside the converted one.
      expect(rows[0]).toMatchObject({ balance: 100, currencyCode: "USD" });
    });

    it("answers null, not the row's own amount, without an admissible rate", async () => {
      rateRows = [rate("USD", "CAD", 1.4, "2026-06-14")];

      const rows = await service.withReportingCurrency("user-1", [
        balance("savings", "2026-01-12", 100, "USD"),
      ]);

      expect(rows[0].convertedBalance).toBeNull();
    });

    it("loads no rates for a reporting-currency scope, and nothing for no rows", async () => {
      const rows = await service.withReportingCurrency("user-1", [
        balance("chequing", "2026-01-12", 50, "CAD"),
      ]);

      expect(rows[0].convertedBalance).toBe(50);
      expect(queries.some((q) => q.sql.includes("exchange_rates"))).toBe(false);
      await expect(
        service.withReportingCurrency("user-1", []),
      ).resolves.toEqual([]);
    });
  });

  describe("table A: history", () => {
    it("totals a two-currency scope at each day's own rate (example 1)", async () => {
      accountRows = [account("chequing", "CAD"), account("savings", "USD")];
      rateRows = [rate("USD", "CAD", 1.365, "2026-06-15")];
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", "2026-06-15", 1234.56, "CAD"),
        balance("savings", "2026-06-15", 1000, "USD"),
      ]);

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-15",
        "2026-06-15",
        undefined,
        "CAD",
      );

      expect(res.currencyCode).toBe("CAD");
      expect(res.today).toBe(TODAY);
      expect(res.days).toHaveLength(1);
      // 1,234.56 + (1,000.00 x 1.3650) = 2,599.56
      expect(res.days[0]).toEqual({
        date: "2026-06-15",
        total: 2599.56,
        knownSubtotal: 2599.56,
        isProjected: false,
        missingRatePairs: [],
      });
    });

    it("withholds the day whose pair has no rate, naming the pair (example 1)", async () => {
      accountRows = [account("chequing", "CAD"), account("savings", "USD")];
      // No USD->CAD rate stored at all: the day is history, both balances are
      // known, and the total is still unknowable.
      rateRows = [];
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", "2026-06-14", 1234.56, "CAD"),
        balance("savings", "2026-06-14", 1000, "USD"),
      ]);

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-14",
        undefined,
        "CAD",
      );

      expect(res.days[0].total).toBeNull();
      expect(res.days[0].knownSubtotal).toBe(1234.56);
      expect(res.days[0].missingRatePairs).toEqual(["USD->CAD"]);
    });

    it("converts nothing and names the scope's own currency on a single-currency scope", async () => {
      accountRows = [account("chequing", "CAD"), account("savings", "CAD")];
      preference = { defaultCurrency: "USD" };
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", "2026-06-14", 100, "CAD"),
        balance("savings", "2026-06-14", 250.5, "CAD"),
      ]);

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-14",
      );

      // The scope's own currency, not the preference: this is what makes a
      // single account's calendar agree with its register's balance column.
      expect(res.currencyCode).toBe("CAD");
      expect(res.days[0].total).toBe(350.5);
      expect(res.days[0].missingRatePairs).toEqual([]);
      // No rate query at all.
      expect(queries.some((q) => q.sql.includes("exchange_rates"))).toBe(false);
    });

    it("totals an emptied scope as a known zero, never as unknown", async () => {
      accountRows = [account("chequing", "CAD")];
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", "2026-06-14", 0, "CAD"),
      ]);

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-14",
      );

      expect(res.days[0].total).toBe(0);
    });

    it("withholds a day the history series has no row for", async () => {
      accountRows = [account("chequing", "CAD")];
      accountsService.getDailyBalances.mockResolvedValue([]);

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-14",
      );

      expect(res.days[0].total).toBeNull();
      // Nothing to blame a currency pair for: an unknown component, not a gap.
      expect(res.days[0].missingRatePairs).toEqual([]);
    });

    it("asks the ledger series only for the days up to today", async () => {
      accountRows = [account("chequing", "CAD")];
      forecastService.getBalanceForecast.mockResolvedValue(
        completeForecast("chequing", "CAD", [{ date: TODAY, balance: 10 }]),
      );

      await service.getDailyBalanceTotals("user-1", "2026-06-13", "2026-06-17");

      expect(accountsService.getDailyBalances).toHaveBeenCalledWith(
        "user-1",
        "2026-06-13",
        TODAY,
        ["chequing"],
        false,
        [],
      );
    });
  });

  describe("table A: projection", () => {
    beforeEach(() => {
      accountRows = [account("chequing", "CAD")];
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", TODAY, 2600, "CAD"),
      ]);
    });

    it("carries each forecast point forward over the days it covers (example 2)", async () => {
      forecastService.getBalanceForecast.mockResolvedValue(
        completeForecast("chequing", "CAD", [
          { date: TODAY, balance: 2600 },
          { date: "2026-06-19", balance: 1100 },
          { date: "2026-06-23", balance: 3100 },
        ]),
      );

      const res = await service.getDailyBalanceTotals(
        "user-1",
        TODAY,
        "2026-06-24",
      );

      const byDate = new Map(res.days.map((d) => [d.date, d]));
      expect(byDate.get(TODAY)).toMatchObject({
        total: 2600,
        isProjected: false,
      });
      expect(byDate.get("2026-06-18")).toMatchObject({
        total: 2600,
        isProjected: true,
      });
      expect(byDate.get("2026-06-19")!.total).toBe(1100);
      expect(byDate.get("2026-06-22")!.total).toBe(1100);
      expect(byDate.get("2026-06-23")!.total).toBe(3100);
      expect(byDate.get("2026-06-24")!.total).toBe(3100);
      expect(res.forecast.complete).toBe(true);
    });

    it("withholds every projected day when one account's forecast is incomplete, and keeps history (example 2)", async () => {
      accountRows = [account("chequing", "CAD"), account("savings", "CAD")];
      accountsService.getDailyBalances.mockResolvedValue([
        balance("chequing", TODAY, 2600, "CAD"),
        balance("savings", TODAY, 400, "CAD"),
      ]);
      forecastService.getBalanceForecast.mockImplementation(
        async (_u: string, accountId: string) =>
          accountId === "chequing"
            ? {
                accountId,
                currencyCode: "CAD",
                points: [{ date: TODAY, balance: 2600 }],
                complete: false,
                gaps: [
                  {
                    scheduledTransactionId: "sched-rent",
                    name: "Rent",
                    reason: "crossCurrencyTransfer",
                    fromCurrency: "USD",
                    toCurrency: "CAD",
                  },
                ],
                overdue: null,
              }
            : completeForecast("savings", "CAD", [
                { date: TODAY, balance: 400 },
              ]),
      );

      const res = await service.getDailyBalanceTotals(
        "user-1",
        TODAY,
        "2026-06-17",
      );

      // Today is history and stays known.
      expect(res.days[0]).toMatchObject({ date: TODAY, total: 3000 });
      for (const day of res.days.slice(1)) {
        expect(day.total).toBeNull();
        // The account that COULD be projected still contributes its subtotal,
        // so the panel can say what part of the day is known.
        expect(day.knownSubtotal).toBe(400);
      }
      expect(res.forecast.complete).toBe(false);
      expect(res.forecast.gaps).toEqual([
        {
          scheduledTransactionId: "sched-rent",
          name: "Rent",
          reason: "crossCurrencyTransfer",
          fromCurrency: "USD",
          toCurrency: "CAD",
        },
      ]);
    });

    it("unions the gaps over the scope, once per schedule", async () => {
      accountRows = [account("a", "CAD"), account("b", "CAD")];
      const gap = {
        scheduledTransactionId: "sched-1",
        name: "Transfer",
        reason: "crossCurrencyTransfer" as const,
        fromCurrency: "USD",
        toCurrency: "CAD",
      };
      forecastService.getBalanceForecast.mockResolvedValue({
        accountId: "a",
        currencyCode: "CAD",
        points: [],
        complete: false,
        gaps: [gap],
        overdue: null,
      });

      const res = await service.getDailyBalanceTotals(
        "user-1",
        TODAY,
        "2026-06-16",
      );

      expect(res.forecast.gaps).toEqual([gap]);
    });

    it("prices a projected day at today's rate, not the day's", async () => {
      accountRows = [account("cad", "CAD"), account("usd", "USD")];
      rateRows = [
        rate("USD", "CAD", 1.3, TODAY),
        // A rate stored ahead of today exists, and must NOT be the one used: a
        // projection is priced today, because the day it is about has no rate.
        rate("USD", "CAD", 2, "2026-06-16"),
      ];
      accountsService.getDailyBalances.mockResolvedValue([]);
      forecastService.getBalanceForecast.mockImplementation(
        async (_u: string, accountId: string) =>
          completeForecast(accountId, accountId === "cad" ? "CAD" : "USD", [
            { date: TODAY, balance: accountId === "cad" ? 0 : 100 },
          ]),
      );

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-16",
        "2026-06-16",
        undefined,
        "CAD",
      );

      expect(res.days[0]).toMatchObject({ isProjected: true, total: 130 });
    });

    it("names a joint account it cannot project rather than guessing at one", async () => {
      accountRows = [account("own", "CAD"), account("joint", "CAD", false)];
      accountsService.getDailyBalances.mockResolvedValue([]);
      forecastService.getBalanceForecast.mockResolvedValue(
        completeForecast("own", "CAD", [{ date: TODAY, balance: 100 }]),
      );

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-16",
        "2026-06-16",
        undefined,
        undefined,
        ["joint"],
      );

      expect(res.days[0].total).toBeNull();
      expect(res.days[0].knownSubtotal).toBe(100);
      expect(res.forecast.complete).toBe(false);
      expect(res.forecast.unforecastableAccountIds).toEqual(["joint"]);
      expect(forecastService.getBalanceForecast).toHaveBeenCalledTimes(1);
    });

    it("asks for no forecast at all when the range ends today", async () => {
      await service.getDailyBalanceTotals("user-1", "2026-06-13", TODAY);
      expect(forecastService.getBalanceForecast).not.toHaveBeenCalled();
    });
  });

  describe("scope", () => {
    it("reports an empty scope rather than an empty month", async () => {
      accountRows = [];

      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-15",
      );

      expect(res.scopeEmpty).toBe(true);
      expect(res.days.map((d) => d.date)).toEqual(["2026-06-14", "2026-06-15"]);
      expect(res.days.every((d) => d.total === null)).toBe(true);
      expect(res.currencyCode).toBe("CAD");
      expect(accountsService.getDailyBalances).not.toHaveBeenCalled();
    });

    it("resolves the scope from open accounts, widened by the joint grants", async () => {
      accountRows = [account("chequing", "CAD")];
      accountsService.getDailyBalances.mockResolvedValue([]);

      await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-14",
        "2026-06-14",
        ["chequing"],
        undefined,
        ["joint-1"],
      );

      const scopeQuery = queries.find((q) => q.sql.includes("FROM accounts"))!;
      expect(scopeQuery.sql).toContain("is_closed = false");
      expect(scopeQuery.sql).toContain("user_id = $1 OR id = ANY($3::UUID[])");
      expect(scopeQuery.params).toEqual(["user-1", ["chequing"], ["joint-1"]]);
    });

    it("echoes the requested range on every response", async () => {
      accountRows = [account("chequing", "CAD")];
      const res = await service.getDailyBalanceTotals(
        "user-1",
        "2026-06-13",
        "2026-06-15",
      );
      expect(res.startDate).toBe("2026-06-13");
      expect(res.endDate).toBe("2026-06-15");
      expect(res.days.map((d) => d.date)).toEqual([
        "2026-06-13",
        "2026-06-14",
        "2026-06-15",
      ]);
    });
  });

  describe("the projection fan-out", () => {
    /**
     * One forecast is four to six round trips in its own transaction, so the
     * shape of this loop is the shape of the request's cost. Two properties
     * hold it: every owned account is asked exactly once (a joint account not
     * at all), and the calls overlap instead of queueing behind each other --
     * but only up to a bound, because an unbounded fan-out trades a slow
     * request for a drained connection pool.
     */
    const TWELVE = Array.from({ length: 12 }, (_, i) => `a-${i}`);

    it("asks each owned account once, and never a joint one", async () => {
      accountRows = [
        ...TWELVE.map((id) => account(id, "CAD")),
        account("joint-1", "CAD", false),
      ];
      forecastService.getBalanceForecast.mockImplementation(
        async (_userId: string, accountId: string) =>
          completeForecast(accountId, "CAD", [{ date: TODAY, balance: 100 }]),
      );

      const res = await service.getDailyBalanceTotals(
        "user-1",
        TODAY,
        "2026-06-18",
      );

      expect(forecastService.getBalanceForecast).toHaveBeenCalledTimes(12);
      const asked = forecastService.getBalanceForecast.mock.calls.map(
        (c) => c[1],
      );
      expect([...asked].sort()).toEqual([...TWELVE].sort());
      expect(asked).not.toContain("joint-1");
      expect(res.forecast.unforecastableAccountIds).toEqual(["joint-1"]);
    });

    it("overlaps the forecasts, bounded, instead of running them one at a time", async () => {
      accountRows = TWELVE.map((id) => account(id, "CAD"));

      let inFlight = 0;
      let peak = 0;
      forecastService.getBalanceForecast.mockImplementation(
        async (_userId: string, accountId: string) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setImmediate(resolve));
          inFlight--;
          return completeForecast(accountId, "CAD", [
            { date: TODAY, balance: 100 },
          ]);
        },
      );

      await service.getDailyBalanceTotals("user-1", TODAY, "2026-06-18");

      // Serial would peak at 1; unbounded would peak at 12.
      expect(peak).toBeGreaterThan(1);
      expect(peak).toBeLessThanOrEqual(5);
    });
  });
});
