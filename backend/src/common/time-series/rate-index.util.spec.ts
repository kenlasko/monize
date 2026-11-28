import { requestContextStorage } from "../request-context";
import { FX_MAX_RATE_AGE_DAYS } from "./fx-rate-resolver";
import {
  RateIndexRow,
  buildRateIndex,
  convertAtDate,
  indexRateRows,
  resolveIndexedRate,
} from "./rate-index.util";

const row = (
  from: string,
  to: string,
  rate: number,
  date: string,
): RateIndexRow => ({
  from_currency: from,
  to_currency: to,
  rate: String(rate),
  rate_date: date,
});

describe("rate-index.util", () => {
  describe("buildRateIndex", () => {
    it("asks for nothing when no currency needs converting", async () => {
      const query = jest.fn();
      const index = await buildRateIndex(
        query,
        new Set(),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );
      expect(index.size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it("loads both directions of every pair, ordered by date", async () => {
      const query = jest.fn().mockResolvedValue([]);
      await buildRateIndex(
        query,
        new Set(["USD", "EUR"]),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );

      const [sql, params] = query.mock.calls[0];
      // Both directions: the resolver takes the more recent admissible
      // observation whichever way it is stored, so loading one direction would
      // make half the pairs resolve from a staler row than the history holds.
      expect(sql).toContain(
        "SELECT c AS from_currency, $2::TEXT AS to_currency",
      );
      expect(sql).toContain(
        "SELECT $2::TEXT AS from_currency, c AS to_currency",
      );
      expect(sql).toContain("ORDER BY rate_date");
      expect(params).toEqual([
        ["USD", "EUR"],
        "CAD",
        "2026-06-01",
        "2026-06-30",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      ]);
    });

    it("anchors the window on the user's day, not the database server's CURRENT_DATE", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-06-10T11:00:00Z"));
      try {
        const query = jest.fn().mockResolvedValue([]);
        // 11:00Z is already 06-11 in Kiritimati (UTC+14).
        await requestContextStorage.run(
          { timezone: "Pacific/Kiritimati" },
          () =>
            buildRateIndex(
              query,
              new Set(["USD"]),
              "CAD",
              "2026-06-20",
              "2026-06-30",
            ),
        );
        const [sql, params] = query.mock.calls[0];
        expect(sql).not.toContain("CURRENT_DATE");
        expect(params).toContain("2026-06-11");
      } finally {
        jest.useRealTimers();
      }
    });

    it("uses the day the caller gives, not the request's zone", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-06-10T11:00:00Z"));
      try {
        const query = jest
          .fn()
          .mockResolvedValue([row("USD", "CAD", 1.3, "2026-04-26")]);
        // Request zone says 06-10 (Los Angeles); the owner's day is 06-11.
        const index = await requestContextStorage.run(
          { timezone: "America/Los_Angeles" },
          () =>
            buildRateIndex(
              query,
              new Set(["USD"]),
              "CAD",
              "2026-06-20",
              "2026-06-30",
              undefined,
              "2026-06-11",
            ),
        );
        expect(query.mock.calls[0][1]).toContain("2026-06-11");
        expect(query.mock.calls[0][1]).not.toContain("2026-06-10");
        // 46 days old on the owner's 06-11 (45 on the request's 06-10).
        expect(
          resolveIndexedRate(index, "USD", "CAD", "2026-07-01").rate,
        ).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it("loads the window plus the one preceding observation per pair, and nothing ahead of it", async () => {
      const query = jest.fn().mockResolvedValue([]);
      await buildRateIndex(
        query,
        new Set(["USD"]),
        "CAD",
        "2026-06-01",
        "2026-06-30",
      );
      const [sql] = query.mock.calls[0];
      // The last row before the window, bounded by the age policy -- not a
      // fixed day margin, which made a point's answer depend on chart width.
      expect(sql).toContain("ORDER BY er.rate_date DESC");
      expect(sql).toContain("LIMIT 1");
      expect(sql).toContain(`INTERVAL '${FX_MAX_RATE_AGE_DAYS} days'`);
      // No forward margin: a date is never priced by an observation from its
      // future (issue #1390).
      expect(sql).not.toContain("+ INTERVAL");
      expect(sql).not.toContain("90 days");
    });

    /**
     * Issue #1390: `buildRateIndex` loaded a fixed 90-day-back / 31-day-ahead
     * margin, so the same date resolved differently depending on how wide the
     * chart around it was. The rows a window loads are now exactly the ones
     * any date in it can be priced by, whatever its width.
     */
    it("gives one date the same answer from a narrow window and a wide one", async () => {
      const history = [
        row("USD", "CAD", 1.3, "2026-05-28"),
        row("USD", "CAD", 1.365, "2026-06-15"),
        row("USD", "CAD", 1.4, "2026-07-20"),
      ];
      // The database is asked for [LEAST(start, today) - 45d, end]; simulate it.
      const serve = (start: string, end: string) =>
        jest.fn().mockImplementation(async () => {
          const floor = new Date(Date.parse(`${start}T00:00:00Z`));
          floor.setUTCDate(floor.getUTCDate() - FX_MAX_RATE_AGE_DAYS);
          const from = floor.toISOString().slice(0, 10);
          return history.filter(
            (r) => String(r.rate_date) >= from && String(r.rate_date) <= end,
          );
        });

      const narrow = await buildRateIndex(
        serve("2026-06-10", "2026-06-20"),
        new Set(["USD"]),
        "CAD",
        "2026-06-10",
        "2026-06-20",
      );
      const wide = await buildRateIndex(
        serve("2026-01-01", "2026-12-31"),
        new Set(["USD"]),
        "CAD",
        "2026-01-01",
        "2026-12-31",
      );

      expect(convertAtDate(1000, "USD", "CAD", "2026-06-17", narrow)).toBe(
        1365,
      );
      expect(convertAtDate(1000, "USD", "CAD", "2026-06-17", wide)).toBe(1365);
    });

    /**
     * Issue #1390. A caller that converts at a date later than the window it
     * asked for -- a monthly series requested to mid-month prices its last
     * point at the month end -- got an index that stopped short of that date,
     * so the point was priced by an older observation and moved when the same
     * chart was asked for a wider range. The horizon is stated by the caller
     * and the loader reads to it.
     */
    it("loads out to a conversion horizon later than the requested end", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await buildRateIndex(
        query,
        new Set(["EUR"]),
        "USD",
        "2024-06-01",
        "2024-06-15",
        "2024-06-30",
      );

      expect(query.mock.calls[0][1]).toEqual([
        ["EUR"],
        "USD",
        "2024-06-01",
        "2024-06-30",
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      ]);
    });

    it("never narrows the window when the horizon is earlier than the end", async () => {
      const query = jest.fn().mockResolvedValue([]);

      await buildRateIndex(
        query,
        new Set(["EUR"]),
        "USD",
        "2024-06-01",
        "2024-07-31",
        "2024-06-30",
      );

      expect(query.mock.calls[0][1][3]).toBe("2024-07-31");
    });

    it("prices a month end that falls after the requested end from the observation dated on it", async () => {
      const history = [
        row("EUR", "USD", 1.07, "2024-06-14"),
        row("EUR", "USD", 1.09, "2024-06-28"),
      ];
      // The database answers the upper bound the loader actually sent, so the
      // fixture cannot hand back a row the query did not ask for.
      const serve = jest
        .fn()
        .mockImplementation(async (_sql: string, params: unknown[]) =>
          history.filter((r) => String(r.rate_date) <= String(params[3])),
        );

      // The window stops at 2024-06-15, but June's point is converted at
      // 2024-06-30: without the horizon the 06-28 observation is not loaded and
      // the point is priced at 1.07.
      const index = await buildRateIndex(
        serve,
        new Set(["EUR"]),
        "USD",
        "2024-06-01",
        "2024-06-15",
        "2024-06-30",
      );

      expect(convertAtDate(10000, "EUR", "USD", "2024-06-30", index)).toBe(
        10900,
      );
    });
  });

  describe("indexRateRows", () => {
    it("keys by pair and coerces the numeric and date columns", () => {
      const index = indexRateRows([
        row("USD", "CAD", 1.365, "2026-06-15"),
        row("USD", "CAD", 1.37, "2026-06-16"),
        row("CAD", "USD", 0.73, "2026-06-15"),
      ]);

      expect(index.get("USD->CAD")).toEqual([
        { date: "2026-06-15", rate: 1.365 },
        { date: "2026-06-16", rate: 1.37 },
      ]);
      expect(index.get("CAD->USD")).toEqual([
        { date: "2026-06-15", rate: 0.73 },
      ]);
    });

    it("reads a Date the driver handed back as a calendar date", () => {
      const index = indexRateRows([
        {
          from_currency: "USD",
          to_currency: "CAD",
          rate: 1.5,
          rate_date: new Date("2026-06-15T00:00:00.000Z"),
        },
      ]);
      expect(index.get("USD->CAD")).toEqual([
        { date: "2026-06-15", rate: 1.5 },
      ]);
    });
  });

  describe("resolveIndexedRate", () => {
    const index = indexRateRows([
      row("USD", "CAD", 1.3, "2026-06-10"),
      row("USD", "CAD", 1.365, "2026-06-15"),
      row("USD", "CAD", 1.4, "2026-06-20"),
    ]);

    it("takes the most recent rate on or before the date", () => {
      expect(
        resolveIndexedRate(index, "USD", "CAD", "2026-06-17"),
      ).toMatchObject({ rate: 1.365, observedOn: "2026-06-15" });
      expect(
        resolveIndexedRate(index, "USD", "CAD", "2026-06-15"),
      ).toMatchObject({ rate: 1.365 });
    });

    /**
     * Was: "takes the latest rate when the date is past the whole history".
     * A rate is a price; an arbitrarily old one does not describe a later date
     * (`docs/time-series-contract.md` section 2.2).
     */
    it("is unknown once the newest rate is past the age bound", () => {
      expect(
        resolveIndexedRate(index, "USD", "CAD", "2027-01-01"),
      ).toMatchObject({ rate: null, reason: "stale_observation" });
    });

    it("is unknown when the pair has no rates at all", () => {
      expect(
        resolveIndexedRate(new Map(), "USD", "CAD", "2026-06-17"),
      ).toMatchObject({ rate: null, reason: "no_observation" });
    });

    /**
     * Was: "falls back to the earliest rate before the history, and says so
     * once" -- the look-ahead DR-02 recorded. Issue #1390 settles it: a March
     * valuation is not evidence about a June rate, and the June rate is not
     * evidence about March.
     */
    it("never prices a date with an observation from its future", () => {
      expect(
        resolveIndexedRate(index, "USD", "CAD", "2026-01-01"),
      ).toMatchObject({ rate: null, reason: "only_after_date" });
    });

    /**
     * A daily valuation asks for the same pair on the same day once per
     * holding; resolving it afresh each time was most of a since-inception
     * fold (issue #1888). The answer is remembered per index, so a repeat is
     * the resolution already made rather than a second walk of the history.
     */
    it("answers a repeated pair and date with the resolution it already made", () => {
      const fresh = indexRateRows([row("USD", "CAD", 1.365, "2026-06-15")]);
      const first = resolveIndexedRate(fresh, "USD", "CAD", "2026-06-17");
      expect(resolveIndexedRate(fresh, "USD", "CAD", "2026-06-17")).toBe(first);
    });

    it("keys the remembered answer on the date and the direction", () => {
      const fresh = indexRateRows([
        row("USD", "CAD", 1.3, "2026-06-10"),
        row("USD", "CAD", 1.4, "2026-06-20"),
      ]);
      expect(
        resolveIndexedRate(fresh, "USD", "CAD", "2026-06-12"),
      ).toMatchObject({ rate: 1.3 });
      expect(
        resolveIndexedRate(fresh, "USD", "CAD", "2026-06-21"),
      ).toMatchObject({ rate: 1.4 });
      expect(
        resolveIndexedRate(fresh, "CAD", "USD", "2026-06-21").rate,
      ).toBeCloseTo(1 / 1.4, 10);
    });

    it("never answers one index from another index's resolutions", () => {
      const before = indexRateRows([row("USD", "CAD", 1.3, "2026-06-15")]);
      const after = indexRateRows([row("USD", "CAD", 1.5, "2026-06-15")]);
      expect(
        resolveIndexedRate(before, "USD", "CAD", "2026-06-17"),
      ).toMatchObject({ rate: 1.3 });
      expect(
        resolveIndexedRate(after, "USD", "CAD", "2026-06-17"),
      ).toMatchObject({ rate: 1.5 });
    });

    describe("the user's day caps a future date and bounds the age", () => {
      // 11:00Z is 2026-06-11 in Kiritimati and 2026-06-10 in Los Angeles. The
      // row dated 2026-04-26 is 46 days old on the 11th and 45 on the 10th.
      const at = (timezone: string) => {
        jest.useFakeTimers().setSystemTime(new Date("2026-06-10T11:00:00Z"));
        return requestContextStorage.run({ timezone }, () =>
          indexRateRows([row("USD", "CAD", 1.3, "2026-04-26")]),
        );
      };
      afterEach(() => jest.useRealTimers());

      it("refuses the 46-day-old row on the user's day (Kiritimati)", () => {
        const index = at("Pacific/Kiritimati");
        expect(
          resolveIndexedRate(index, "USD", "CAD", "2026-07-01").rate,
        ).toBeNull();
        expect(convertAtDate(10, "USD", "CAD", "2026-07-01", index)).toBeNull();
      });

      it("accepts the 45-day-old row on the user's day (Los Angeles)", () => {
        const index = at("America/Los_Angeles");
        expect(resolveIndexedRate(index, "USD", "CAD", "2026-07-01").rate).toBe(
          1.3,
        );
        expect(convertAtDate(10, "USD", "CAD", "2026-07-01", index)).toBe(13);
      });
    });
  });

  describe("convertAtDate", () => {
    const index = indexRateRows([
      row("USD", "CAD", 1.3, "2026-06-10"),
      row("USD", "CAD", 1.365, "2026-06-15"),
    ]);

    it("converts at the rate that stood on the day, not the latest one", () => {
      expect(convertAtDate(1000, "USD", "CAD", "2026-06-12", index)).toBe(1300);
      expect(convertAtDate(1000, "USD", "CAD", "2026-06-15", index)).toBe(1365);
    });

    it("returns the amount unchanged for the reporting currency itself", () => {
      expect(convertAtDate(1234.56, "CAD", "CAD", "2026-06-15", index)).toBe(
        1234.56,
      );
    });

    it("uses the reciprocal when only the inverse pair is stored", () => {
      const inverse = indexRateRows([row("CAD", "USD", 0.8, "2026-06-15")]);
      expect(convertAtDate(80, "USD", "CAD", "2026-06-15", inverse)).toBe(100);
    });

    it("is null, never the amount unchanged, when no rate exists", () => {
      const logger = { warn: jest.fn() };
      expect(
        convertAtDate(1000, "JPY", "CAD", "2026-06-15", index, logger),
      ).toBeNull();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(
        "rather than converted 1:1",
      );
    });

    // A fresh index per case: the once-per-computation warning is keyed by the
    // index object, which is the behaviour being pinned here.
    const ownIndex = () =>
      indexRateRows([
        row("USD", "CAD", 1.3, "2026-06-10"),
        row("USD", "CAD", 1.365, "2026-06-15"),
      ]);

    it("warns once per pair per computation, not once per point", () => {
      const own = ownIndex();
      const logger = { warn: jest.fn() };
      convertAtDate(1000, "JPY", "CAD", "2026-06-15", own, logger);
      convertAtDate(2000, "JPY", "CAD", "2026-06-16", own, logger);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("is null for a date that predates the pair's whole history", () => {
      const logger = { warn: jest.fn() };
      expect(
        convertAtDate(1000, "USD", "CAD", "2026-01-01", ownIndex(), logger),
      ).toBeNull();
      expect(logger.warn.mock.calls[0][0]).toContain("dated after 2026-01-01");
    });

    it("is null for a date the newest stored rate is too old for", () => {
      const logger = { warn: jest.fn() };
      expect(
        convertAtDate(1000, "USD", "CAD", "2027-01-01", ownIndex(), logger),
      ).toBeNull();
      expect(logger.warn.mock.calls[0][0]).toContain("days old");
    });

    it("converts zero to zero with no rate and records no gap", () => {
      const logger = { warn: jest.fn() };
      expect(convertAtDate(0, "JPY", "CAD", "2026-06-15", index, logger)).toBe(
        0,
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("treats a zero or negative stored rate as absent", () => {
      const broken = indexRateRows([row("USD", "CAD", 0, "2026-06-15")]);
      expect(
        convertAtDate(1000, "USD", "CAD", "2026-06-15", broken),
      ).toBeNull();
    });
  });
});
