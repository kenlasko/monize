import {
  GemPriceService,
  rangeMonths,
  rangeSampling,
} from "./gem-price.service";
import { evaluate, momentumSnapshot } from "./gem-momentum.util";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("GemPriceService", () => {
  let service: GemPriceService;
  let manager: ManagerMock;

  beforeEach(() => {
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    service = new GemPriceService(mocks.dataSource as never);
  });

  describe("range configuration", () => {
    it("maps each range to a window and a sampling density", () => {
      expect(rangeMonths("3M")).toBe(3);
      expect(rangeMonths("MAX")).toBeNull();
      expect(rangeSampling("1Y")).toBe("day");
      expect(rangeSampling("3Y")).toBe("week");
      expect(rangeSampling("MAX")).toBe("month");
    });
  });

  describe("loadSeries", () => {
    it("groups daily closes per security, oldest first", async () => {
      manager.query.mockResolvedValue([
        {
          series_id: "sec-a",
          price_date: "2025-01-02",
          close_price: "10.5",
          has_adjusted: false,
        },
        {
          series_id: "sec-a",
          price_date: "2025-01-03",
          close_price: "11",
          has_adjusted: false,
        },
        {
          series_id: "sec-b",
          price_date: "2025-01-03",
          close_price: "20",
          has_adjusted: false,
        },
      ]);

      const series = await service.loadSeries(
        ["sec-a", "sec-b"],
        "2025-01-01",
        "day",
        manager as never,
      );

      expect(series.get("sec-a")).toEqual([
        { date: "2025-01-02", close: 10.5 },
        { date: "2025-01-03", close: 11 },
      ]);
      expect(series.get("sec-b")).toHaveLength(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("FROM security_prices");
      expect(params).toEqual([["sec-a", "sec-b"], "2025-01-01"]);
    });

    /**
     * Time-series contract rule 1: never mix adjusted and raw prices for the
     * same instrument inside one calculation.
     *
     * `adjusted_close` is nullable per row and only the provider backfill
     * writes it -- transaction-derived prices, the MNY import and the demo seed
     * insert a raw close beside it. A per-row COALESCE therefore spliced raw
     * rows into an adjusted series for any instrument the user had traded, and
     * around a split that is a fabricated several-hundred-percent return
     * running the absolute-momentum test.
     *
     * A unit spec with a mocked `query` cannot execute the SQL, so this asserts
     * the rule is expressed rather than the rows it produces: the per-row
     * fallback must not come back, and the per-security basis must be there.
     * The semantics belong in an integration test against a real database.
     */
    it("picks one price basis per security instead of per row", async () => {
      manager.query.mockResolvedValue([]);

      for (const sampling of ["day", "month"] as const) {
        manager.query.mockClear();
        await service.loadSeries(
          ["sec-a"],
          "2025-01-01",
          sampling,
          manager as never,
        );
        const sql = manager.query.mock.calls[0][0] as string;

        expect(sql).not.toMatch(/COALESCE\s*\(\s*adjusted_close/i);
        // One decision per security, over the window being read...
        expect(sql).toContain("bool_or(adjusted_close IS NOT NULL)");
        // ...and where there is adjusted data, the unadjusted rows are left
        // out rather than converted.
        expect(sql).toContain(
          "b.has_adjusted = false OR s.adjusted_close IS NOT NULL",
        );
      }
    });

    it("thins long ranges to one close per bucket and sorts ascending", async () => {
      manager.query.mockResolvedValue([
        {
          series_id: "sec-a",
          price_date: "2025-02-28",
          close_price: "12",
          has_adjusted: true,
        },
        {
          series_id: "sec-a",
          price_date: "2025-01-31",
          close_price: "11",
          has_adjusted: true,
        },
      ]);

      const series = await service.loadSeries(
        ["sec-a"],
        "2024-01-01",
        "month",
        manager as never,
      );

      expect(series.get("sec-a")?.map((p) => p.date)).toEqual([
        "2025-01-31",
        "2025-02-28",
      ]);
      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("DISTINCT ON");
      expect(params[2]).toBe("month");
    });

    describe("conversion into the reporting currency", () => {
      const priceRows = [
        ["sec-usd", "2024-01-31", "100"],
        ["sec-usd", "2025-01-31", "108"],
        ["sec-pln", "2024-01-31", "100"],
        ["sec-pln", "2025-01-31", "105"],
      ].map(([series_id, price_date, close_price]) => ({
        series_id,
        price_date,
        close_price,
        has_adjusted: false,
      }));

      const load = async (rateRows: unknown[]) => {
        const mocks = createScopedDbMocks([
          [
            UserPreference,
            {
              findOne: jest.fn().mockResolvedValue({ defaultCurrency: "PLN" }),
            },
          ],
          [
            Security,
            {
              find: jest.fn().mockResolvedValue([
                { id: "sec-usd", currencyCode: "USD" },
                { id: "sec-pln", currencyCode: "PLN" },
              ]),
            },
          ],
        ]);
        mocks.manager.query
          .mockResolvedValueOnce(priceRows)
          .mockResolvedValueOnce(rateRows);
        return new GemPriceService(mocks.dataSource as never).loadSeries(
          ["sec-usd", "sec-pln"],
          "2024-01-01",
          "day",
          mocks.manager as never,
          "user-1",
        );
      };
      const decide = (series: Map<string, { date: string; close: number }[]>) =>
        evaluate(
          momentumSnapshot(
            {
              US_EQUITY: series.get("sec-usd"),
              SAFE: series.get("sec-pln"),
            },
            "2025-01-31",
            12,
          ),
          ["US_EQUITY", "SAFE"],
        );

      it("compares returns in the reporting currency, not in native ones", async () => {
        const series = await load([
          {
            from_currency: "USD",
            to_currency: "PLN",
            rate: "4",
            rate_date: "2024-01-31",
          },
          {
            from_currency: "USD",
            to_currency: "PLN",
            rate: "3.6",
            rate_date: "2025-01-31",
          },
        ]);

        // +8% in USD is -2.8% in PLN once USD/PLN has fallen 10%.
        expect(series.get("sec-usd")?.map((p) => p.close)).toEqual([
          400, 388.8,
        ]);
        expect(series.get("sec-pln")?.[1].close).toBe(105);
        expect(decide(series)?.state).toBe("RISK_OFF");
      });

      it("leaves a close with no rate unknown instead of converting it 1:1", async () => {
        const series = await load([]);

        expect(series.get("sec-usd")).toEqual([]);
        expect(decide(series)).toBeNull();
      });
    });

    it("does not query for an empty security list", async () => {
      await expect(service.loadSeries([], "2025-01-01")).resolves.toEqual(
        new Map(),
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([]);
      await service.loadSeries(["sec-a"], "2025-01-01");
      expect(manager.query).toHaveBeenCalled();
    });
  });

  describe("latestPrices", () => {
    it("returns the newest close per security", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", close_price: "452.475" },
      ]);
      const prices = await service.latestPrices(["sec-a"], manager as never);
      expect(prices.get("sec-a")).toBe(452.475);
    });

    it("leaves an unpriced security out of the map", async () => {
      manager.query.mockResolvedValue([]);
      const prices = await service.latestPrices(["sec-a"], manager as never);
      expect(prices.has("sec-a")).toBe(false);
    });

    it("values a position on the raw close, not the adjusted one", async () => {
      // The mirror of the rule in loadSeries: a holding is worth what its
      // shares trade at today. The adjusted series answers a different
      // question -- what the return has been -- and would misprice the
      // portfolio by the whole distribution history of the fund.
      manager.query.mockResolvedValue([]);
      await service.latestPrices(["sec-a"], manager as never);
      expect(manager.query.mock.calls[0][0]).not.toContain("adjusted_close");
    });

    /**
     * Time-series contract rule 2 and financial contract rule 4: a price used
     * to value "now" must be dated within a bounded window of it.
     *
     * Unbounded, 1,000 units of a fund last quoted two years ago at 45 were
     * reported as a 45,000 position to move and a 25,000 gain to be taxed. No
     * warning fired either, because the report's staleness banner only checks
     * the strategy's own roles and a holding outside them filled none.
     */
    it("refuses a quote too old to stand for today", async () => {
      manager.query.mockResolvedValue([]);

      await service.latestPrices(["sec-a"], manager as never, "2025-08-14");

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("price_date >= $2::date");
      expect(sql).toContain("price_date <= $3::date");
      // The same fortnight every other boundary in this module is held to.
      expect(params[1]).toBe("2025-07-31");
      expect(params[2]).toBe("2025-08-14");
    });

    it("skips the query with no securities", async () => {
      await expect(service.latestPrices([])).resolves.toEqual(new Map());
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", close_price: "7" },
      ]);
      const prices = await service.latestPrices(["sec-a"]);
      expect(prices.get("sec-a")).toBe(7);
    });
  });

  describe("latestPriceDates", () => {
    it("returns the newest price date for each security separately", async () => {
      // Per security, not one MAX across them: an aggregate let a US quote
      // refreshed this morning hide an ex-US one from three weeks ago.
      manager.query.mockResolvedValue([
        { security_id: "sec-a", latest: "2025-08-02" },
        { security_id: "sec-b", latest: "2025-07-11" },
      ]);
      const dates = await service.latestPriceDates(
        ["sec-a", "sec-b"],
        manager as never,
      );
      expect(dates.get("sec-a")).toBe("2025-08-02");
      expect(dates.get("sec-b")).toBe("2025-07-11");
      expect(manager.query.mock.calls[0][0]).toContain("GROUP BY security_id");
    });

    it("opens its own scoped transaction when no manager is passed", async () => {
      manager.query.mockResolvedValue([
        { security_id: "sec-a", latest: "2025-08-02" },
      ]);
      const dates = await service.latestPriceDates(["sec-a"]);
      expect(dates.get("sec-a")).toBe("2025-08-02");
    });

    it("leaves a never-priced security out of the map", async () => {
      // Absent, not stale: the caller has to be able to tell the two apart.
      manager.query.mockResolvedValue([{ security_id: "sec-a", latest: null }]);
      const dates = await service.latestPriceDates(["sec-a"], manager as never);
      expect(dates.has("sec-a")).toBe(false);
      expect((await service.latestPriceDates([])).size).toBe(0);
    });
  });
});
