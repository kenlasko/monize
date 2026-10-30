import { createHash } from "crypto";
import {
  GemSignalService,
  GEM_HISTORY_PERIODS,
  GEM_SIGNAL_ALGORITHM_VERSION,
  GEM_SIGNAL_STRATEGY_MISMATCH,
  gemConfigFingerprint,
} from "./gem-signal.service";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  GemStrategyAsset,
  GEM_ASSET_ROLES,
} from "./entities/gem-strategy-asset.entity";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const userId = "user-1";

const strategy = (overrides: Partial<GemStrategy> = {}): GemStrategy =>
  ({
    id: "strategy-1",
    userId,
    accountId: "acct-1",
    cadence: "MONTHLY",
    lookbackMonths: 12,
    taxRatePercent: 19,
    commissionAmount: 29.9,
    rulesSourceUrl: null,
    rulesSourceLabel: null,
    ...overrides,
  }) as GemStrategy;

const assets = (): GemStrategyAsset[] =>
  [
    { role: "US_EQUITY", securityId: "sec-spy" },
    { role: "EX_US_EQUITY", securityId: "sec-ewa" },
    { role: "EM_EQUITY", securityId: "sec-emim" },
    { role: "SAFE", securityId: "sec-ief" },
  ] as GemStrategyAsset[];

/**
 * Straight-line price series so momentum per role is predictable.
 *
 * It has to reach the newest period these specs evaluate. Since algorithm
 * version 2 a boundary close only counts within `BOUNDARY_LAG_DAYS` of the
 * boundary, so a series stopping short leaves the last periods unpriced and
 * unevaluated -- which reads as a bug in the service rather than in the
 * fixture. 42 months from January 2022 is 2025-07-28, three days before the
 * 2025-07-31 evaluation the specs' `asOf` of 2025-08-14 falls after.
 *
 * It also has to reach *past* that period: a span settles only once the series
 * holds a close dated at or after its far boundary, because "the market was
 * shut on the 31st" and "the 31st's close has not been fetched yet" look
 * identical from a series that stops before it. A live series always carries
 * that later close -- the quote job keeps running -- so the monthly-on-the-28th
 * fixture gets one appended rather than an exemption. It is a settled marker
 * only: every boundary these specs evaluate resolves to a close at or before
 * it, so no assertion reads its value.
 */
function seriesFor(growthPercent: number) {
  const points: Array<{ date: string; close: number }> = [];
  for (let month = 0; month <= 42; month += 1) {
    const date = new Date(Date.UTC(2022, month, 28));
    points.push({
      date: date.toISOString().slice(0, 10),
      close: 100 * (1 + (growthPercent / 100) * (month / 12)),
    });
  }
  points.push({
    date: "2025-08-01",
    close: 100 * (1 + (growthPercent / 100) * (43 / 12)),
  });
  return points;
}

describe("GemSignalService", () => {
  let service: GemSignalService;
  let manager: ManagerMock;
  let signalRepo: Record<string, jest.Mock>;
  /** The configuration the database holds, which materialize reloads itself. */
  let strategyRepo: Record<string, jest.Mock>;
  let assetRepo: Record<string, jest.Mock>;
  let prefRepo: Record<string, jest.Mock>;
  /** Rows the mocked insert reports back; null means "the insert won". */
  let insertedRows: Array<Record<string, unknown>> | null;
  /** Every row the loop managed to insert, in order. */
  let savedSignals: Array<Record<string, unknown>>;
  let priceService: {
    loadSeries: jest.Mock;
    earliestPriceDates: jest.Mock;
  };

  beforeEach(() => {
    // Inserting a signal goes through an INSERT ... ON CONFLICT DO NOTHING,
    // because a plain save() inside the transaction would abort it on a
    // concurrent duplicate. `insertedRows` is what the builder pretends the
    // database returned: an empty array stands for "someone else got there
    // first" and is how the concurrency case is exercised.
    insertedRows = null;
    savedSignals = [];
    signalRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      // Present so a test can prove nothing is deleted; the service should
      // never reach for either.
      remove: jest.fn(),
      delete: jest.fn(),
      create: jest.fn((row) => ({ ...row })),
      save: jest.fn((row) =>
        Promise.resolve({ id: `sig-${row.evaluatedOn}`, ...row }),
      ),
      createQueryBuilder: jest.fn(() => {
        let pending: Record<string, unknown> = {};
        const builder = {
          insert: () => builder,
          values: (row: Record<string, unknown>) => {
            pending = row;
            return builder;
          },
          orIgnore: () => builder,
          returning: () => builder,
          execute: jest.fn(async () => {
            const rows = insertedRows ?? [
              { id: `sig-${pending.evaluatedOn as string}`, ...pending },
            ];
            savedSignals.push(...rows);
            // What the real driver returns on ON CONFLICT DO NOTHING: `raw`
            // is empty because nothing was written, but `generatedMaps` is
            // built from the value sets and still holds an object. A spec
            // that returns an empty `generatedMaps` describes a database
            // TypeORM does not have, and the branch it was meant to cover
            // could never run in production.
            return {
              generatedMaps: rows.length > 0 ? rows : [{}],
              raw: rows,
              identifiers: rows,
            };
          }),
        };
        return builder;
      }),
    };
    // materialize does not trust the strategy it was handed: it takes a
    // per-strategy advisory lock and reloads the configuration inside it, so
    // what it writes answers what the database holds now rather than what the
    // report read some milliseconds ago. By default the two agree; `dbHolds`
    // is how a test makes them disagree.
    strategyRepo = { findOne: jest.fn().mockResolvedValue(strategy()) };
    assetRepo = { find: jest.fn().mockResolvedValue(assets()) };
    prefRepo = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "USD" }),
    };
    const mocks = createScopedDbMocks([
      [GemStrategySignal, signalRepo],
      [GemStrategy, strategyRepo],
      [GemStrategyAsset, assetRepo],
      [UserPreference, prefRepo],
    ]);
    manager = mocks.manager;
    priceService = {
      loadSeries: jest.fn().mockResolvedValue(
        new Map([
          ["sec-spy", seriesFor(15)],
          ["sec-ewa", seriesFor(8)],
          ["sec-emim", seriesFor(30)],
          ["sec-ief", seriesFor(4)],
        ]),
      ),
      // The fixtures' series start in January 2022, well before every period
      // the tests evaluate, so nothing is bounded out by default.
      earliestPriceDates: jest.fn().mockResolvedValue(
        new Map([
          ["sec-spy", "2022-01-28"],
          ["sec-ief", "2022-01-28"],
        ]),
      ),
    };
    service = new GemSignalService(
      mocks.dataSource as never,
      priceService as never,
    );
  });

  /** Make the stored configuration differ from the one the caller was handed. */
  const dbHolds = (
    stored: GemStrategy,
    storedAssets: GemStrategyAsset[] = assets(),
  ) => {
    strategyRepo.findOne.mockResolvedValue(stored);
    assetRepo.find.mockResolvedValue(storedAssets);
  };

  describe("materialize", () => {
    it("evaluates and stores every missing period, newest first", async () => {
      const inserted = savedSignals;
      signalRepo.find
        .mockResolvedValueOnce([]) // stored history: empty
        .mockResolvedValueOnce([
          {
            id: "sig-latest",
            configFingerprint: gemConfigFingerprint(strategy(), assets()),
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          } as GemStrategySignal,
        ]);

      const signals = await service.materialize(
        userId,
        strategy(),
        assets(),
        "2025-08-14",
      );

      expect(inserted).toHaveLength(GEM_HISTORY_PERIODS);
      // Strongest momentum wins while equities beat the safe asset.
      expect(inserted[0]).toMatchObject({
        state: "RISK_ON",
        targetRole: "EM_EQUITY",
        targetSecurityId: "sec-emim",
        previousRole: null,
        executed: false,
      });
      // Each later period knows what the previous one held.
      expect(inserted[1]).toMatchObject({ previousRole: "EM_EQUITY" });
      expect(signals.signals.map((signal) => signal.id)).toEqual([
        "sig-latest",
      ]);
    });

    it("skips a period whose absolute test cannot be run", async () => {
      priceService.loadSeries.mockResolvedValue(
        new Map([["sec-spy", seriesFor(15)]]), // no safe-asset prices
      );
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("stores nothing for a period an instrument stopped being quoted in", async () => {
      // The safe asset was last quoted in early 2023 and every later lookup
      // answers with that one close. Momentum then reads as exactly zero for
      // every period after it -- a real reading a real market can produce, so
      // nothing downstream can tell it from a genuine flat year -- and the
      // absolute test would hand a RISK-ON to whichever equity leg beat that
      // invented zero, on every period, permanently.
      const stopped = seriesFor(4).filter(
        (point) => point.date <= "2023-02-28",
      );
      priceService.loadSeries.mockResolvedValue(
        new Map([
          ["sec-spy", seriesFor(15)],
          ["sec-ewa", seriesFor(8)],
          ["sec-emim", seriesFor(30)],
          ["sec-ief", stopped],
        ]),
      );

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      expect(savedSignals).toHaveLength(0);
    });

    it("defers a period whose boundary close has not been stored yet", async () => {
      // 09:00 on 1 August, before the quote job has stored 31 July's close. The
      // newest observation is 28 July, three days old, so the boundary-lag test
      // passes and the period *looks* priceable -- from the wrong day. And a
      // stored period is skipped forever under the same fingerprint and
      // version, so that answer would never be corrected, including where the
      // real month-end close flips the decision.
      //
      // Every earlier period is unaffected: each has a later close behind it.
      const untilJuly30 = (points: Array<{ date: string; close: number }>) =>
        points.filter((point) => point.date <= "2025-07-30");
      const seriesUntilJuly30 = () =>
        new Map([
          ["sec-spy", untilJuly30(seriesFor(15))],
          ["sec-ewa", untilJuly30(seriesFor(8))],
          ["sec-emim", untilJuly30(seriesFor(30))],
          ["sec-ief", untilJuly30(seriesFor(4))],
        ]);
      priceService.loadSeries.mockResolvedValue(seriesUntilJuly30());

      await service.materialize(userId, strategy(), assets(), "2025-08-01");

      expect(savedSignals.length).toBeGreaterThan(0);
      expect(savedSignals.map((signal) => signal.evaluatedOn)).not.toContain(
        "2025-07-31",
      );
    });

    it("answers the deferred period once its boundary close arrives", async () => {
      // Same strategy, same fingerprint, one day later: the close dated at or
      // after the boundary is what settles it, and the period is then answered
      // from the close that stands for it.
      priceService.loadSeries.mockResolvedValue(
        new Map([
          ["sec-spy", seriesFor(15)],
          ["sec-ewa", seriesFor(8)],
          ["sec-emim", seriesFor(30)],
          ["sec-ief", seriesFor(4)],
        ]),
      );

      await service.materialize(userId, strategy(), assets(), "2025-08-01");

      expect(savedSignals.map((signal) => signal.evaluatedOn)).toContain(
        "2025-07-31",
      );
    });

    it("keeps every period when a version bump doubles the rows", async () => {
      // Two rows can share a date now that the unique key carries the
      // algorithm version. A 24-*row* cap counted a superseded row against its
      // own replacement, so the first read after a bump returned the newest
      // twelve dates and called that the history -- and raised no legacy
      // warning, because every date it did return had a current row.
      const periods = 24;
      signalRepo.find.mockImplementation(({ take }: { take?: number }) => {
        expect(take).toBeUndefined();
        return Promise.resolve([]);
      });

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      expect(savedSignals).toHaveLength(periods);
    });

    it("does not re-evaluate a period that is already stored", async () => {
      signalRepo.find.mockResolvedValue([
        {
          id: "sig-1",
          evaluatedOn: "2025-07-31",
          targetRole: "EM_EQUITY",
          configFingerprint: gemConfigFingerprint(strategy(), assets()),
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        } as GemStrategySignal,
      ]);

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      const stored = signalRepo.save.mock.calls.map(
        ([row]) => row.evaluatedOn as string,
      );
      expect(stored).not.toContain("2025-07-31");
    });

    describe("when the configuration behind a signal changed", () => {
      /** One stored period, decided under a 12-month lookback. */
      const storedUnder12Months = (overrides: Record<string, unknown> = {}) => {
        signalRepo.find.mockResolvedValue([
          {
            id: "sig-1",
            evaluatedOn: "2025-07-31",
            effectiveFrom: "2025-08-01",
            state: "RISK_ON",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            executed: true,
            executedAt: new Date("2025-08-02T00:00:00Z"),
            configFingerprint: gemConfigFingerprint(strategy(), assets()),
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
            ...overrides,
          } as GemStrategySignal,
        ]);
      };

      it("recomputes the period in place instead of trusting the old row", async () => {
        // The bug: the row survived a lookback change and was still served as
        // the current instruction, with the new instruments' names on it.
        storedUnder12Months();

        dbHolds(strategy({ lookbackMonths: 6 }));
        await service.materialize(
          userId,
          strategy({ lookbackMonths: 6 }),
          assets(),
          "2025-08-14",
        );

        const rewritten = signalRepo.save.mock.calls
          .map(([row]) => row)
          .find((row) => row.evaluatedOn === "2025-07-31");
        expect(rewritten).toBeDefined();
        // Same row, not a second answer for the same month.
        expect(rewritten.id).toBe("sig-1");
        expect(rewritten.configFingerprint).toBe(
          gemConfigFingerprint(strategy({ lookbackMonths: 6 }), assets()),
        );
      });

      it("recomputes a row stored under another reporting currency", async () => {
        // Momentum is compared on closes converted into the reporting
        // currency, so a row stamped under USD answers a different question
        // once the user reports in PLN.
        storedUnder12Months();
        prefRepo.findOne.mockResolvedValue({ defaultCurrency: "PLN" });

        await service.materialize(userId, strategy(), assets(), "2025-08-14");

        const rewritten = signalRepo.save.mock.calls
          .map(([row]) => row)
          .find((row) => row.evaluatedOn === "2025-07-31");
        expect(rewritten?.configFingerprint).toBe(
          gemConfigFingerprint(strategy(), assets(), "PLN"),
        );
      });

      it("supersedes a row from an earlier algorithm version, leaving it intact", async () => {
        // The settings are untouched -- same cadence, same lookback, same
        // instruments -- so the fingerprint matches. The rules do not: version
        // 1 accepted a boundary close struck months before the boundary, and
        // the momentum on that row can be a figure this version refuses to
        // produce. It must not be served as the current instruction, and it
        // must not be rewritten either: it records what the strategy decided
        // then and what the user executed against it.
        //
        // So this version writes its own row for the period, beside the old
        // one -- the unique key carries the version. Blocking instead cost the
        // user the signal governing today on the day a release shipped, with a
        // quarterly strategy waiting out the quarter for it.
        storedUnder12Months({
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
          executed: true,
        });

        await service.materialize(userId, strategy(), assets(), "2025-08-14");

        // The old row is not touched.
        expect(signalRepo.save).not.toHaveBeenCalled();
        // A new one is written for the same period, under this version.
        const replacement = savedSignals.find(
          (row) => row.evaluatedOn === "2025-07-31",
        );
        expect(replacement).toMatchObject({
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          configFingerprint: gemConfigFingerprint(strategy(), assets()),
          targetRole: "EM_EQUITY",
        });
        // And the trade the user reported making carries over, because this
        // version asks for the same instrument. Nobody re-confirms a trade the
        // new rules agree with.
        expect(replacement?.executed).toBe(true);
      });

      it("gives a quarterly strategy a signal the day after an upgrade", async () => {
        // The reviewer's case: a release ships one day after an evaluation. If
        // the version-1 row for the active period blocked this version, the
        // report would have no actionable signal for the rest of the quarter.
        signalRepo.find.mockResolvedValue([
          {
            id: "sig-q",
            evaluatedOn: "2025-06-30",
            effectiveFrom: "2025-07-01",
            state: "RISK_ON",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-emim",
            configFingerprint: gemConfigFingerprint(
              strategy({ cadence: "QUARTERLY" }),
              assets(),
            ),
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
          } as GemStrategySignal,
        ]);
        dbHolds(strategy({ cadence: "QUARTERLY" }));

        await service.materialize(
          userId,
          strategy({ cadence: "QUARTERLY" }),
          assets(),
          "2025-07-01",
        );

        // The period governing today is evaluated again under this version,
        // rather than waiting three months for the next one.
        expect(
          savedSignals.find((row) => row.evaluatedOn === "2025-06-30"),
        ).toMatchObject({ algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION });
      });

      it("does not inherit executed when the new rules ask for something else", async () => {
        storedUnder12Months({
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
          executed: true,
          targetRole: "US_EQUITY",
          targetSecurityId: "sec-spy",
        });

        await service.materialize(userId, strategy(), assets(), "2025-08-14");

        const replacement = savedSignals.find(
          (row) => row.evaluatedOn === "2025-07-31",
        );
        expect(replacement).toMatchObject({
          targetRole: "EM_EQUITY",
          executed: false,
        });
      });

      it("keeps the executed flag when the instruction is unchanged", async () => {
        // The recomputation lands on the same instrument, so the trade the
        // user reported making is still the trade this row asks for.
        storedUnder12Months();

        dbHolds(strategy({ lookbackMonths: 6 }));
        await service.materialize(
          userId,
          strategy({ lookbackMonths: 6 }),
          assets(),
          "2025-08-14",
        );

        const rewritten = signalRepo.save.mock.calls
          .map(([row]) => row)
          .find((row) => row.evaluatedOn === "2025-07-31");
        expect(rewritten.targetSecurityId).toBe("sec-emim");
        expect(rewritten.executed).toBe(true);
      });

      it("clears the executed flag when the new instruction differs", async () => {
        // Nobody carried out an instruction that did not exist until now.
        storedUnder12Months({
          targetRole: "US_EQUITY",
          targetSecurityId: "sec-spy",
        });

        dbHolds(strategy({ lookbackMonths: 6 }));
        await service.materialize(
          userId,
          strategy({ lookbackMonths: 6 }),
          assets(),
          "2025-08-14",
        );

        const rewritten = signalRepo.save.mock.calls
          .map(([row]) => row)
          .find((row) => row.evaluatedOn === "2025-07-31");
        expect(rewritten.targetSecurityId).toBe("sec-emim");
        expect(rewritten.executed).toBe(false);
        expect(rewritten.executedAt).toBeNull();
      });

      it("reads and returns only the dates the current calendar evaluates on", async () => {
        // Switching monthly to quarterly replaces the calendar. The months
        // that are not quarter-ends are never revisited by the loop, so left
        // in the result they sat in the quarterly history as decisions from a
        // cadence the strategy no longer runs -- interleaved with its own.
        dbHolds(strategy({ cadence: "QUARTERLY" }));
        await service.materialize(
          userId,
          strategy({ cadence: "QUARTERLY" }),
          assets(),
          "2025-08-14",
        );

        const [where] = signalRepo.find.mock.calls[0];
        const dates = where.where.evaluatedOn._value as string[];
        expect(dates).toContain("2025-06-30");
        expect(dates).not.toContain("2025-07-31");
        // Filtered, not deleted: switching the cadence back has to bring the
        // monthly rows and their executed flags with it.
        expect(signalRepo.remove).not.toHaveBeenCalled();
        expect(signalRepo.delete).not.toHaveBeenCalled();
      });

      it("never takes previousRole from a row the old configuration wrote", async () => {
        // A stale row answers a different question, so letting it stand in as
        // the predecessor stamps the old target onto a freshly computed
        // period -- and previousRole is what history renders as "switched out
        // of". With no answered predecessor the honest answer is null.
        signalRepo.find.mockResolvedValue([
          {
            id: "sig-old",
            evaluatedOn: "2025-06-30",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            configFingerprint: "written-under-other-settings",
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          } as GemStrategySignal,
        ]);

        dbHolds(strategy({ lookbackMonths: 6 }));
        await service.materialize(
          userId,
          strategy({ lookbackMonths: 6 }),
          assets(),
          "2025-08-14",
        );

        // Every period is recomputed here, so the oldest one has nothing
        // before it and each later one follows the row just written.
        const written = savedSignals.concat(
          signalRepo.save.mock.calls.map(([row]) => row),
        );
        const june = written.find((row) => row.evaluatedOn === "2025-06-30");
        expect(june?.previousRole).not.toBe("US_EQUITY");
      });

      it("never takes previousRole from a row an older algorithm version wrote", async () => {
        // A period can hold two rows: the one a superseded version wrote and
        // its replacement. Both sit on the same date, `stored` is ordered by
        // date alone, and the chain used to be seeded by asking only whether
        // the *date* had an answer -- so whichever row happened to come last
        // won the map. When that was the old one, the next period was stored
        // naming a target the current rules never chose, and the history table
        // renders exactly that as "switched out of".
        const fingerprint = gemConfigFingerprint(strategy(), assets());
        signalRepo.find.mockResolvedValue([
          {
            id: "sig-jun-current",
            evaluatedOn: "2025-06-30",
            targetRole: "SAFE",
            targetSecurityId: "sec-ief",
            configFingerprint: fingerprint,
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          },
          // Ordered after its own replacement, which the (evaluatedOn DESC)
          // read makes possible and nothing about the schema forbids.
          {
            id: "sig-jun-superseded",
            evaluatedOn: "2025-06-30",
            targetRole: "US_EQUITY",
            targetSecurityId: "sec-spy",
            configFingerprint: fingerprint,
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
          },
        ] as GemStrategySignal[]);

        await service.materialize(userId, strategy(), assets(), "2025-08-14");

        const july = savedSignals.find(
          (row) => row.evaluatedOn === "2025-07-31",
        );
        expect(july).toBeDefined();
        expect(july?.previousRole).toBe("SAFE");
      });

      it("returns nothing the current configuration did not produce", async () => {
        // A period that cannot be recomputed keeps its old row on a date the
        // current calendar still uses. Returning it mixed a counterfactual
        // history with a real one: the backtest replayed a run that never
        // existed under one configuration, and the history resolves "switched
        // out of" by position in this array, so a stale row wedged between two
        // fresh ones was named as the predecessor of a period computed against
        // an earlier one.
        const fingerprint = gemConfigFingerprint(strategy(), assets());
        signalRepo.find.mockResolvedValue([
          {
            id: "sig-jul",
            evaluatedOn: "2025-07-31",
            targetRole: "SAFE",
            configFingerprint: fingerprint,
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          },
          {
            id: "sig-jun",
            evaluatedOn: "2025-06-30",
            targetRole: "EM_EQUITY",
            targetSecurityId: "sec-retired",
            configFingerprint: "written-under-other-settings",
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          },
          {
            id: "sig-may",
            evaluatedOn: "2025-05-31",
            targetRole: "US_EQUITY",
            configFingerprint: fingerprint,
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          },
        ] as GemStrategySignal[]);
        // June cannot be recomputed: the price history does not reach it.
        priceService.earliestPriceDates.mockResolvedValue(
          new Map([
            ["sec-spy", "2030-01-02"],
            ["sec-ief", "2030-01-02"],
          ]),
        );

        const result = await service.materialize(
          userId,
          strategy(),
          assets(),
          "2025-08-14",
        );

        expect(result.signals.map((signal) => signal.id)).toEqual([
          "sig-jul",
          "sig-may",
        ]);
        // And the report is told what that cost, so the history does not just
        // come up short with nothing saying why.
        expect(result.legacyPeriods).toBe(1);
      });

      it("refuses to serve a stale row as the current signal", async () => {
        // Recomputation is not always possible -- a lookback stretched past
        // the instrument's first close leaves nothing to evaluate. The row
        // stays in the history; it just cannot be today's instruction.
        const stale = {
          id: "sig-1",
          evaluatedOn: "2025-07-31",
          targetRole: "EM_EQUITY",
          configFingerprint: "written-under-other-settings",
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        } as GemStrategySignal;

        expect(
          service.currentSignal(
            [stale],
            strategy(),
            assets(),
            "USD",
            "2025-08-14",
          ),
        ).toBeNull();
        expect(
          service.currentSignal(
            [
              {
                ...stale,
                configFingerprint: gemConfigFingerprint(strategy(), assets()),
                algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
              },
            ],
            strategy(),
            assets(),
            "USD",
            "2025-08-14",
          ),
        ).not.toBeNull();
      });
    });

    describe("gemConfigFingerprint", () => {
      it("changes with every input that changes what a signal says", () => {
        const base = gemConfigFingerprint(strategy(), assets());
        expect(
          gemConfigFingerprint(strategy({ lookbackMonths: 6 }), assets()),
        ).not.toBe(base);
        expect(
          gemConfigFingerprint(strategy({ cadence: "QUARTERLY" }), assets()),
        ).not.toBe(base);
        const swapped = assets().map((asset) =>
          asset.role === "EM_EQUITY"
            ? ({ ...asset, securityId: "sec-eem" } as GemStrategyAsset)
            : asset,
        );
        expect(gemConfigFingerprint(strategy(), swapped)).not.toBe(base);
        // Clearing the risk-free leg moves the absolute test onto the safe
        // asset, which is a different comparison, not a cosmetic change.
        expect(
          gemConfigFingerprint(strategy(), [
            ...assets(),
            { role: "RISK_FREE", securityId: "sec-bil" } as GemStrategyAsset,
          ]),
        ).not.toBe(base);
        // Closes are compared in the reporting currency, so a preference
        // change must retire the signals stored under the old one.
        expect(gemConfigFingerprint(strategy(), assets(), "PLN")).not.toBe(
          base,
        );
      });

      it("leaves the algorithm version out: that is a column, not a hash", () => {
        // The two mismatches are answered differently -- settings are
        // recomputed in place, a rules change is not -- so the fingerprint
        // cannot be the place that carries both. It hashes the settings only,
        // and `algorithm_version` is stored beside it.
        expect(gemConfigFingerprint(strategy(), assets())).toBe(
          createHash("sha256")
            .update(
              `MONTHLY|12|` +
                [...GEM_ASSET_ROLES]
                  .sort()
                  .map((role) => {
                    const asset = assets().find(
                      (candidate) => candidate.role === role,
                    );
                    return `${role}=${asset?.securityId ?? "-"}`;
                  })
                  .join(",") +
                `|USD`,
            )
            .digest("hex")
            .slice(0, 64),
        );
      });

      it("ignores what cannot change a signal", () => {
        // Correcting a commission must not rewrite the evaluation history.
        const base = gemConfigFingerprint(strategy(), assets());
        expect(
          gemConfigFingerprint(
            strategy({ commissionAmount: 9.9, taxRatePercent: 23 }),
            assets(),
          ),
        ).toBe(base);
        // Nor does the order the roles happen to come back in.
        expect(gemConfigFingerprint(strategy(), [...assets()].reverse())).toBe(
          base,
        );
      });
    });

    it("returns the stored history untouched when no role has an instrument", async () => {
      const unassigned = [
        { role: "SAFE", securityId: null },
      ] as GemStrategyAsset[];
      const stored = [
        {
          id: "sig-1",
          configFingerprint: gemConfigFingerprint(strategy(), unassigned),
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        } as GemStrategySignal,
      ];
      signalRepo.find.mockResolvedValue(stored);
      dbHolds(strategy(), unassigned);
      const result = await service.materialize(
        userId,
        strategy(),
        unassigned,
        "2025-08-14",
      );
      expect(result.signals).toEqual(stored);
      expect(result.legacyPeriods).toBe(0);
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("does not re-read prices for periods the history cannot reach", async () => {
      // Instruments listed this year against a strategy whose calendar goes
      // back two: every one of those older periods evaluates to nothing, and
      // re-reading a year of closes to rediscover that on every report load is
      // what this bound removes.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2030-01-02"],
          ["sec-ief", "2030-01-02"],
        ]),
      );
      const stored = [
        {
          id: "sig-1",
          configFingerprint: gemConfigFingerprint(strategy(), assets()),
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        } as GemStrategySignal,
      ];
      signalRepo.find.mockResolvedValue(stored);

      const result = await service.materialize(
        userId,
        strategy(),
        assets(),
        "2025-08-14",
      );

      expect(result.signals).toEqual(stored);
      expect(result.legacyPeriods).toBe(0);
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("evaluates nothing when a required leg has never been priced", async () => {
      // The absolute test needs both the US equity leg and the benchmark, so
      // one of them missing settles it without reading any series.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([["sec-spy", "2022-01-28"]]),
      );
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      expect(priceService.loadSeries).not.toHaveBeenCalled();
    });

    it("evaluates the periods the history does reach", async () => {
      // A first close halfway through the calendar bounds out the older
      // periods and keeps the rest, rather than giving up on the strategy.
      priceService.earliestPriceDates.mockResolvedValue(
        new Map([
          ["sec-spy", "2023-08-31"],
          ["sec-ief", "2023-08-31"],
        ]),
      );

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      expect(priceService.loadSeries).toHaveBeenCalled();
      expect(savedSignals.length).toBeGreaterThan(0);
      expect(savedSignals.length).toBeLessThan(GEM_HISTORY_PERIODS);
      // Every stored period's window opens at or after the first close.
      for (const signal of savedSignals) {
        expect(String(signal.evaluatedOn) >= "2024-08-01").toBe(true);
      }
    });

    it("tolerates a concurrent insert of the same period", async () => {
      signalRepo.save.mockRejectedValue({ code: "23505" });
      await expect(
        service.materialize(userId, strategy(), assets(), "2025-08-14"),
      ).resolves.toEqual({
        signals: [],
        legacyPeriods: 0,
        // The settings the caller was handed are the ones in the table: the
        // duplicate came from another request materializing the same
        // configuration, not from a save landing mid-flight.
        configChanged: false,
        strategyMissing: false,
      });
    });

    it("chains the next period onto the row that won the race", async () => {
      // Losing one period and winning the next is the dangerous interleaving:
      // without the winner's row in hand, the period after it is *stored*
      // believing nothing preceded it, and the final re-read cannot undo that.
      // History would call it a BUY for as long as the row lives.
      const fingerprint = gemConfigFingerprint(strategy(), assets());
      const winner = {
        id: "sig-winner",
        evaluatedOn: "2023-08-31",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        configFingerprint: fingerprint,
        algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
      } as GemStrategySignal;
      // The first insert loses; every later one wins.
      let attempt = 0;
      signalRepo.createQueryBuilder.mockImplementation(() => {
        let pending: Record<string, unknown> = {};
        const builder = {
          insert: () => builder,
          values: (row: Record<string, unknown>) => {
            pending = row;
            return builder;
          },
          orIgnore: () => builder,
          returning: () => builder,
          execute: jest.fn(async () => {
            attempt += 1;
            const rows =
              attempt === 1
                ? []
                : [{ id: `sig-${pending.evaluatedOn as string}`, ...pending }];
            savedSignals.push(...rows);
            return {
              generatedMaps: rows.length > 0 ? rows : [{}],
              raw: rows,
              identifiers: rows,
            };
          }),
        };
        return builder;
      });
      signalRepo.findOne.mockResolvedValue(winner);

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      // The row the loop skipped is fetched, and the next period follows it.
      expect(signalRepo.findOne).toHaveBeenCalledWith({
        where: {
          strategyId: "strategy-1",
          evaluatedOn: "2023-08-31",
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        },
      });
      expect(savedSignals[0]).toMatchObject({ previousRole: "US_EQUITY" });
    });

    it("reads the winner of the key this version writes, not a superseded row", async () => {
      // (strategy, date) stopped selecting one row when the unique key took on
      // the algorithm version. The insert collided with the row *this* version
      // wrote, so that is the row to read back; an unversioned lookup could
      // return the older one instead, fail the configuration check and abandon
      // a materialization that had lost the race to a perfectly valid winner.
      const fingerprint = gemConfigFingerprint(strategy(), assets());
      const rows = [
        // First, so an unversioned findOne would answer with this one.
        {
          id: "sig-superseded",
          evaluatedOn: "2023-08-31",
          targetRole: "US_EQUITY",
          targetSecurityId: "sec-spy",
          configFingerprint: "written-under-other-settings",
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
        },
        {
          id: "sig-winner",
          evaluatedOn: "2023-08-31",
          targetRole: "SAFE",
          targetSecurityId: "sec-ief",
          configFingerprint: fingerprint,
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        },
      ] as GemStrategySignal[];
      signalRepo.findOne.mockImplementation(
        ({ where }: { where: Record<string, unknown> }) =>
          Promise.resolve(
            rows.find(
              (row) =>
                row.evaluatedOn === where.evaluatedOn &&
                (where.algorithmVersion === undefined ||
                  row.algorithmVersion === where.algorithmVersion),
            ) ?? null,
          ),
      );
      // The oldest period loses the key; every later one wins.
      let attempt = 0;
      signalRepo.createQueryBuilder.mockImplementation(() => {
        let pending: Record<string, unknown> = {};
        const builder = {
          insert: () => builder,
          values: (row: Record<string, unknown>) => {
            pending = row;
            return builder;
          },
          orIgnore: () => builder,
          returning: () => builder,
          execute: jest.fn(async () => {
            attempt += 1;
            const inserted =
              attempt === 1
                ? []
                : [{ id: `sig-${pending.evaluatedOn as string}`, ...pending }];
            savedSignals.push(...inserted);
            return {
              generatedMaps: inserted.length > 0 ? inserted : [{}],
              raw: inserted,
              identifiers: inserted,
            };
          }),
        };
        return builder;
      });

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      // The run carried on past the lost period rather than abandoning...
      expect(savedSignals.length).toBeGreaterThan(0);
      // ...and the period after it was chained onto the current version's row,
      // not the superseded one.
      expect(savedSignals[0]).toMatchObject({ previousRole: "SAFE" });
    });

    it("abandons the run when a row from another configuration wins the key", async () => {
      // Two things must not happen here, and only stopping avoids both.
      //
      // The foreign row cannot go into the chain: a later period would be
      // stored naming a predecessor the current rules never chose. And it must
      // not be overwritten with this run's evaluation either -- materialization
      // is serialized per strategy and reads the configuration under the lock,
      // so a row that appeared anyway may well be newer than anything this run
      // knows, and stamping over it would file an out-of-date decision as the
      // current one.
      //
      // So the run stops. What it already wrote is correct and stays; the rest
      // is left to the next read, which reloads the configuration first.
      const foreignWinner = {
        id: "sig-foreign",
        evaluatedOn: "2023-08-31",
        targetRole: "US_EQUITY",
        targetSecurityId: "sec-spy",
        configFingerprint: "written-under-other-settings",
        algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
      } as GemStrategySignal;
      // The very first insert -- the oldest period -- loses the key.
      let attempt = 0;
      signalRepo.createQueryBuilder.mockImplementation(() => {
        let pending: Record<string, unknown> = {};
        const builder = {
          insert: () => builder,
          values: (row: Record<string, unknown>) => {
            pending = row;
            return builder;
          },
          orIgnore: () => builder,
          returning: () => builder,
          execute: jest.fn(async () => {
            attempt += 1;
            const rows =
              attempt === 1
                ? []
                : [{ id: `sig-${pending.evaluatedOn as string}`, ...pending }];
            savedSignals.push(...rows);
            return {
              generatedMaps: rows.length > 0 ? rows : [{}],
              raw: rows,
              identifiers: rows,
            };
          }),
        };
        return builder;
      });
      signalRepo.findOne.mockResolvedValue(foreignWinner);

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      // Nothing was written over the stranger's row...
      expect(signalRepo.save).not.toHaveBeenCalled();
      // ...and no dependent period was stored on a guess about what preceded
      // it: the loop stopped at the conflict instead of continuing.
      expect(savedSignals).toHaveLength(0);
    });

    it("materializes against the stored configuration, not the caller's", async () => {
      // The report loaded the strategy in an earlier transaction and the user
      // has saved since. Writing the caller's configuration would put an
      // answer to a replaced question into the table -- and, on the conflict
      // path, over a row the newer configuration had already written.
      dbHolds(strategy({ lookbackMonths: 6 }));

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      const stored = gemConfigFingerprint(
        strategy({ lookbackMonths: 6 }),
        assets(),
      );
      expect(savedSignals.length).toBeGreaterThan(0);
      for (const row of savedSignals) {
        expect(row.configFingerprint).toBe(stored);
        expect(row.algorithmVersion).toBe(GEM_SIGNAL_ALGORITHM_VERSION);
      }
      // And the lock is taken before that read, so the reload cannot race a
      // concurrent materialization of the same strategy.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("pg_advisory_xact_lock"),
        ["strategy-1"],
      );
    });

    it("does nothing when the strategy was deleted while the report ran", async () => {
      strategyRepo.findOne.mockResolvedValue(null);

      await expect(
        service.materialize(userId, strategy(), assets(), "2025-08-14"),
      ).resolves.toEqual({
        signals: [],
        legacyPeriods: 0,
        // A strategy that is gone is not the configuration the caller is
        // building a report from, so the caller starts over rather than
        // rendering the snapshot it still holds.
        configChanged: true,
        // ...and it is told *why*, because the two are answered differently:
        // an unstable configuration is eventually refused, a deleted scenario
        // resolves to the unconfigured report.
        strategyMissing: true,
      });
      expect(savedSignals).toHaveLength(0);
    });

    it("re-reads after losing the race rather than serving its own snapshot", async () => {
      // Losing is not the same as having nothing to do: the winner's rows
      // exist and this request's snapshot predates them. Returning the
      // snapshot rendered a report without the period the user came for -- and
      // the next read, finding it answered, had no reason to look again.
      const fingerprint = gemConfigFingerprint(strategy(), assets());
      insertedRows = []; // every insert loses
      signalRepo.find
        .mockResolvedValueOnce([]) // the snapshot this request started from
        .mockResolvedValueOnce([
          {
            id: "sig-from-the-winner",
            evaluatedOn: "2025-07-31",
            configFingerprint: fingerprint,
            algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          } as GemStrategySignal,
        ]);

      const result = await service.materialize(
        userId,
        strategy(),
        assets(),
        "2025-08-14",
      );

      expect(signalRepo.find).toHaveBeenCalledTimes(2);
      expect(result.signals.map((signal) => signal.id)).toEqual([
        "sig-from-the-winner",
      ]);
    });

    it("propagates a genuine database failure", async () => {
      signalRepo.createQueryBuilder.mockImplementation(() => {
        const builder = {
          insert: () => builder,
          values: () => builder,
          orIgnore: () => builder,
          returning: () => builder,
          execute: () => Promise.reject(new Error("connection lost")),
        };
        return builder;
      });
      await expect(
        service.materialize(userId, strategy(), assets(), "2025-08-14"),
      ).rejects.toThrow("connection lost");
    });

    it("loads prices from one lookback window before the oldest period", async () => {
      await service.materialize(userId, strategy(), assets(), "2025-08-14");
      const [securityIds, from] = priceService.loadSeries.mock.calls[0];
      expect(securityIds).toHaveLength(4);
      // 24 monthly periods back from 2025-07-31 is 2023-08-31, minus 12 months
      // is 2022-08-31, minus the two-week lead the momentum base needs.
      expect(from).toBe("2022-08-17");
    });

    it("still evaluates when the window start is not a trading day", async () => {
      // Friday-only closes, and a mock that honours the requested start date:
      // the momentum base is the last close at or before the window start, so
      // a window starting on a non-trading day only resolves if the query
      // reaches back past it.
      const fridays = (growthPercent: number) => {
        const points: Array<{ date: string; close: number }> = [];
        const cursor = new Date(Date.UTC(2022, 0, 7));
        for (let week = 0; week <= 260; week += 1) {
          points.push({
            date: cursor.toISOString().slice(0, 10),
            close: 100 * (1 + (growthPercent / 100) * (week / 52)),
          });
          cursor.setUTCDate(cursor.getUTCDate() + 7);
        }
        return points;
      };
      priceService.loadSeries.mockImplementation((_ids, from: string) =>
        Promise.resolve(
          new Map([
            ["sec-spy", fridays(15).filter((p) => p.date >= from)],
            ["sec-ewa", fridays(8).filter((p) => p.date >= from)],
            ["sec-emim", fridays(30).filter((p) => p.date >= from)],
            ["sec-ief", fridays(4).filter((p) => p.date >= from)],
          ]),
        ),
      );
      const inserted = savedSignals;

      await service.materialize(userId, strategy(), assets(), "2025-08-14");

      // 2023-08-31 minus 12 months is a Wednesday; without the lead there is
      // no close on or before it and every period would be skipped.
      expect(inserted).toHaveLength(GEM_HISTORY_PERIODS);
      expect(inserted[0].momentum).toMatchObject({
        US_EQUITY: expect.any(Number),
      });
    });
  });

  describe("currentSignal", () => {
    it("picks the signal governing the period the date falls in", () => {
      const fingerprint = gemConfigFingerprint(strategy(), assets());
      const signals = [
        {
          evaluatedOn: "2025-07-31",
          configFingerprint: fingerprint,
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        },
        {
          evaluatedOn: "2025-06-30",
          configFingerprint: fingerprint,
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
        },
      ] as GemStrategySignal[];
      expect(
        service.currentSignal(
          signals,
          strategy(),
          assets(),
          "USD",
          "2025-08-14",
        )?.evaluatedOn,
      ).toBe("2025-07-31");
    });

    it("does not serve a row an older algorithm version produced", () => {
      // Same settings, so the fingerprint matches; different rules, so the
      // momentum on that row is one this version would refuse to compute. It
      // remains in the history as a record of what was decided then.
      const signals = [
        {
          evaluatedOn: "2025-07-31",
          configFingerprint: gemConfigFingerprint(strategy(), assets()),
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION - 1,
        },
      ] as GemStrategySignal[];
      expect(
        service.currentSignal(
          signals,
          strategy(),
          assets(),
          "USD",
          "2025-08-14",
        ),
      ).toBeNull();
    });

    it("is null when the current period was never evaluated", () => {
      const signals = [{ evaluatedOn: "2025-06-30" }] as GemStrategySignal[];
      expect(
        service.currentSignal(
          signals,
          strategy(),
          assets(),
          "USD",
          "2025-08-14",
        ),
      ).toBeNull();
    });
  });

  describe("hasSignalsBefore", () => {
    it("asks the table, not the chain in hand", async () => {
      // `previousRole` is null whenever the predecessor belonged to another
      // configuration or version, or fell out of the 24-period window -- none
      // of which mean the strategy started there. Only the table knows.
      signalRepo.count = jest.fn().mockResolvedValue(3);

      await expect(
        service.hasSignalsBefore(userId, "strategy-1", "2023-08-31"),
      ).resolves.toBe(true);
      const [{ where }] = signalRepo.count.mock.calls[0];
      expect(where).toMatchObject({ userId, strategyId: "strategy-1" });

      signalRepo.count.mockResolvedValue(0);
      await expect(
        service.hasSignalsBefore(userId, "strategy-1", "2023-08-31"),
      ).resolves.toBe(false);
    });
  });

  describe("markExecuted", () => {
    it("stamps the signal as executed", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: false,
      } as GemStrategySignal);

      // The owning strategy comes back, not a bare boolean: the caller builds
      // the report from it rather than from whatever scenario it had selected.
      await expect(service.markExecuted(userId, "sig-1")).resolves.toBe(
        "strategy-1",
      );
      const [saved] = signalRepo.save.mock.calls[0];
      expect(saved.executed).toBe(true);
      expect(saved.executedAt).toBeInstanceOf(Date);
    });

    it("is idempotent for an already executed signal", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: true,
      } as GemStrategySignal);
      await expect(service.markExecuted(userId, "sig-1")).resolves.toBe(
        "strategy-1",
      );
      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("reports an unknown signal", async () => {
      signalRepo.findOne.mockResolvedValue(null);
      await expect(service.markExecuted(userId, "sig-x")).resolves.toBeNull();
    });

    /**
     * A rejected request must not change persistent state. The ownership check
     * used to sit in the caller, *after* this method had committed: the row
     * came back `executed`, the client got a 409, and a stale tab could mark
     * the wrong scenario's operation as done while being told it had failed.
     */
    it("writes nothing when the expected strategy does not match", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: false,
        executedAt: null,
      } as GemStrategySignal);

      await expect(
        service.markExecuted(userId, "sig-1", "strategy-2"),
      ).resolves.toBe(GEM_SIGNAL_STRATEGY_MISMATCH);

      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("refuses a mismatch even for an already executed signal", async () => {
      // The early return for an executed row must not become a way past the
      // ownership check.
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: true,
      } as GemStrategySignal);

      await expect(
        service.markExecuted(userId, "sig-1", "strategy-2"),
      ).resolves.toBe(GEM_SIGNAL_STRATEGY_MISMATCH);
      expect(signalRepo.save).not.toHaveBeenCalled();
    });

    it("proceeds when the expected strategy is the owning one", async () => {
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: false,
      } as GemStrategySignal);

      await expect(
        service.markExecuted(userId, "sig-1", "strategy-1"),
      ).resolves.toBe("strategy-1");
      expect(signalRepo.save).toHaveBeenCalled();
    });

    it("takes the owning strategy's lock before writing", async () => {
      // Materialization rewrites these rows and carries `executed` across from
      // a snapshot it read earlier. Without the lock a confirmation landing in
      // that window was overwritten, and the report asked for the trade again.
      signalRepo.findOne.mockResolvedValue({
        id: "sig-1",
        strategyId: "strategy-1",
        executed: false,
      } as GemStrategySignal);

      await service.markExecuted(userId, "sig-1");

      const locks = manager.query.mock.calls.filter(([sql]: [string]) =>
        sql.includes("pg_advisory_xact_lock"),
      );
      expect(locks).toHaveLength(1);
      expect(locks[0][1]).toEqual(["strategy-1"]);
      // ...and the lock is taken before the row is written, not after.
      expect(manager.query.mock.invocationCallOrder[0]).toBeLessThan(
        signalRepo.save.mock.invocationCallOrder[0],
      );
    });

    it("scopes the lookup to the caller", async () => {
      signalRepo.findOne.mockResolvedValue(null);
      await service.markExecuted(userId, "sig-1");
      expect(signalRepo.findOne).toHaveBeenCalledWith({
        where: { id: "sig-1", userId },
      });
      expect(manager.getRepository).toHaveBeenCalledWith(GemStrategySignal);
    });
  });
});
