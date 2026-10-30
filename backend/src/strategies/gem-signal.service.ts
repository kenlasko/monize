import { Injectable, Logger } from "@nestjs/common";
import { createHash } from "node:crypto";
import { DataSource, EntityManager, In, LessThan } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import {
  FALLBACK_DEFAULT_CURRENCY,
  preferredCurrency,
} from "../common/default-currency.util";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  GEM_ASSET_ROLES,
  GemAssetRole,
  GemStrategyAsset,
} from "./entities/gem-strategy-asset.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import {
  GemPriceService,
  PRICE_WINDOW_LEAD_DAYS,
  PricesByRole,
} from "./gem-price.service";
import {
  addMonthsUtc,
  benchmarkRoleFor,
  evaluate,
  momentumSnapshot,
  parseYmd,
  periodFor,
  recentPeriods,
} from "./gem-momentum.util";

/**
 * How many evaluation periods the report keeps. Two years of monthly signals is
 * enough for the history table and the "see full history" view without turning
 * the first read of a strategy into a long backfill.
 */
export const GEM_HISTORY_PERIODS = 24;

/**
 * `markExecuted` refused the request because the signal belongs to a strategy
 * other than the one the caller named. Distinct from `null`, which means there
 * is no such signal at all, because the two are different HTTP answers.
 */
export const GEM_SIGNAL_STRATEGY_MISMATCH = "STRATEGY_MISMATCH" as const;

/** What one materialization produced for the report to render. */
export interface GemMaterialization {
  /** Evaluations under the configuration in force now, newest first. */
  signals: GemStrategySignal[];
  /**
   * Periods on the current calendar that only an earlier configuration or an
   * earlier evaluation version could answer for, and so are not in `signals`.
   * Zero in the ordinary case.
   */
  legacyPeriods: number;
  /**
   * True when the configuration read under the lock was not the one the caller
   * was handed -- the user saved, or deleted the strategy, between the report's
   * read and this write.
   *
   * The signals below then answer a configuration the caller does not have, and
   * everything else it is about to build -- the role references, the position,
   * the safe asset, the cost assumptions, the metadata it returns -- still
   * comes from the stale one. A report assembled from both halves is not a
   * report of anything; the caller starts over instead.
   */
  configChanged: boolean;
  /**
   * True when the strategy was gone by the time the lock was taken -- deleted
   * between the report's read and this write.
   *
   * Distinct from `configChanged`, which it also sets. The caller answers the
   * two differently: an unstable configuration is a race worth rebuilding for
   * and, past the budget, worth refusing; a deleted scenario is settled, and
   * the honest report of it is the unconfigured one, not an error.
   */
  strategyMissing: boolean;
}

/**
 * Serialize everything that writes a strategy's signals, or the settings those
 * signals answer, against everything else that does.
 *
 * Materialization reloads the configuration and then writes rows stamped with
 * its fingerprint; a settings save changes what that fingerprint should be.
 * With only the materializers locking, a save could commit in the window
 * between one's reload and its first insert, leaving rows in the table that
 * answer a configuration the database no longer holds -- repaired only by some
 * later read happening to run, which is not a guarantee. Taking the same lock
 * on the save closes that window: whichever gets there first finishes, and the
 * other sees a settled world.
 *
 * Transaction-scoped, so it releases on commit or rollback with no unlock to
 * leak, and cluster-wide, so it holds across backend replicas.
 */
export async function lockGemStrategy(
  manager: EntityManager,
  strategyId: string,
): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    strategyId,
  ]);
}

/** The date a period's momentum window opens: one lookback before evaluation. */
function windowStartFor(evaluatedOn: string, lookbackMonths: number): string {
  return addMonthsUtc(parseYmd(evaluatedOn), -lookbackMonths)
    .toISOString()
    .slice(0, 10);
}

/**
 * Version of the evaluation itself, as opposed to the configuration it runs on.
 *
 * The fingerprint below exists to spot "the user changed something", and a
 * stored row is trusted whenever it matches. But the code is the other half of
 * what a signal means: version 2 stopped accepting a boundary close struck more
 * than `BOUNDARY_LAG_DAYS` before the boundary, so a row written by version 1
 * can carry a momentum computed from a months-old quote -- a made-up figure --
 * under a fingerprint identical to the one this version would produce. Without
 * a version it would be counted as answered, never revisited, and served as the
 * instruction to act on now.
 *
 * It is stored in its own column rather than folded into the hash, because the
 * two mismatches are answered differently. A **settings** change is the user
 * asking for a different answer, so those periods are recomputed in place. An
 * **algorithm** change is not: the row records what the strategy actually
 * decided and what the user executed against it, and rewriting it with today's
 * code -- over prices that may themselves have been revised since -- would
 * replace a real decision with a counterfactual one and quietly reset an
 * `executed` flag that referred to a trade the user really made. Older-version
 * rows are left alone and reported as legacy periods instead.
 *
 * **Bump this whenever a change can alter momentum, the ranking, the risk state
 * or the target.** Do not bump it for a change that cannot move a number -- a
 * rename, a comment, a faster query -- because every bump retires that much
 * history from the current view until the 24-period window rolls past it.
 *
 * History:
 *   1 -- original dual-momentum evaluation.
 *   2 -- boundary closes must be within `BOUNDARY_LAG_DAYS` of the boundary.
 *   3 -- the roles are priced at one session: a role whose exit close trails
 *        the other roles' by more than `BOUNDARY_HOLIDAY_DAYS` is unpriced
 *        (a feed gap at the boundary, A26-M27).
 *   4 -- closes are converted into the reporting currency at each close's own
 *        date before momentum is compared across instruments.
 *
 * (The reporting currency itself is part of the configuration fingerprint, so
 * a currency preference change recomputes in place instead of bumping this.)
 */
export const GEM_SIGNAL_ALGORITHM_VERSION = 4;

/**
 * A hash of everything about a strategy that decides what its signals say.
 *
 * A stored signal used to be treated as permanently done, but the inputs behind
 * it are editable: shorten the lookback, switch to quarterly, or swap the fund
 * in a role and the same row now answers a question nobody asked. Stamping each
 * signal with this and comparing on read is what makes "the configuration
 * changed" visible to a table keyed only by (strategy, period).
 *
 * Every role is included, assigned or not: an empty role changes which markets
 * compete in the ranking, and clearing the risk-free leg moves the absolute
 * test onto the safe asset. What is deliberately *not* here is anything that
 * only affects presentation or cost estimates -- the tax rate, the commission,
 * the scenario's name, the accounts -- because rewriting the whole evaluation
 * history when someone corrects a commission would be worse than useless.
 *
 * The reporting currency is: momentum is compared on closes converted into it,
 * so a stored signal answers one currency's question only.
 *
 * The algorithm version is deliberately *not* in here: it lives in its own
 * column, because a rules change and a settings change call for opposite
 * treatment (see `GEM_SIGNAL_ALGORITHM_VERSION`).
 */
export function gemConfigFingerprint(
  strategy: Pick<GemStrategy, "cadence" | "lookbackMonths">,
  assets: GemStrategyAsset[],
  reportingCurrency: string = FALLBACK_DEFAULT_CURRENCY,
): string {
  const roles = [...GEM_ASSET_ROLES]
    .sort()
    .map((role) => {
      const asset = assets.find((candidate) => candidate.role === role);
      return `${role}=${asset?.securityId ?? "-"}`;
    })
    .join(",");
  const material = `${strategy.cadence}|${strategy.lookbackMonths}|${roles}|${reportingCurrency}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 64);
}

/**
 * Evaluates GEM periods and keeps them in `gem_strategy_signals`.
 *
 * Evaluation is materialized rather than derived on every read: the momentum
 * figures a decision was taken on must survive later price revisions, and the
 * user's "executed" flag needs a stable row to hang on. It runs on read (the
 * report request) instead of only in a scheduled job so a strategy that was
 * just configured -- or one whose prices arrived late -- produces its history
 * immediately; each period is inserted once and re-evaluating an existing period
 * is a no-op.
 */
@Injectable()
export class GemSignalService {
  private readonly logger = new Logger(GemSignalService.name);

  constructor(
    private dataSource: DataSource,
    private priceService: GemPriceService,
  ) {}

  /** Securities bound to roles, as a role -> securityId map (mapped roles only). */
  private securityByRole(
    assets: GemStrategyAsset[],
  ): Map<GemAssetRole, string> {
    const map = new Map<GemAssetRole, string>();
    for (const asset of assets) {
      if (asset.securityId) map.set(asset.role, asset.securityId);
    }
    return map;
  }

  /**
   * Load the price history the evaluation window needs: from one lookback
   * window before the oldest period being evaluated, up to now.
   *
   * The window start is pulled back by `PRICE_WINDOW_LEAD_DAYS`, because the
   * momentum base is the last close *at or before* the window start. Loading
   * from exactly that date leaves nothing to find whenever it falls on a
   * weekend or a market holiday, and the whole period would then evaluate to
   * "no momentum" and be skipped.
   */
  private async loadEvaluationPrices(
    assets: GemStrategyAsset[],
    oldestEvaluatedOn: string,
    lookbackMonths: number,
    manager: EntityManager,
    userId: string,
  ): Promise<PricesByRole> {
    const securityByRole = this.securityByRole(assets);
    const securityIds = [...securityByRole.values()];
    if (securityIds.length === 0) return {};

    const windowStart = addMonthsUtc(
      parseYmd(oldestEvaluatedOn),
      -lookbackMonths,
    );
    windowStart.setUTCDate(windowStart.getUTCDate() - PRICE_WINDOW_LEAD_DAYS);
    const from = windowStart.toISOString().slice(0, 10);
    const series = await this.priceService.loadSeries(
      securityIds,
      from,
      "day",
      manager,
      userId,
    );

    const prices: PricesByRole = {};
    for (const [role, securityId] of securityByRole) {
      prices[role] = series.get(securityId) ?? [];
    }
    return prices;
  }

  /**
   * The first period the price history can possibly answer for, or null when it
   * cannot answer for any.
   *
   * The absolute test needs a base close at or before the momentum window's
   * start for both the US equity leg and the benchmark, so a period whose
   * window opens before either instrument's first recorded close can never
   * evaluate. Left unchecked those periods are retried on every single report
   * load -- a strategy configured with two years of history but instruments
   * listed last year re-reads the whole price window each time to conclude the
   * same nothing. One cheap aggregate per load replaces that.
   *
   * This is a bound, not a watermark: nothing is remembered, so the moment a
   * backfill pushes an instrument's history further back the periods it unlocks
   * are evaluated on the next load with no state to reset.
   */
  private async earliestEvaluableWindowStart(
    assets: GemStrategyAsset[],
    manager: EntityManager,
  ): Promise<string | null> {
    const securityByRole = this.securityByRole(assets);
    const required = [
      "US_EQUITY" as GemAssetRole,
      benchmarkRoleFor([...securityByRole.keys()]),
    ];
    const securityIds = required.map((role) => securityByRole.get(role));
    // A required leg with no instrument at all: nothing can be evaluated.
    if (securityIds.some((id) => !id)) return null;

    const earliest = await this.priceService.earliestPriceDates(
      securityIds as string[],
      manager,
    );
    if (earliest.size < new Set(securityIds).size) return null;
    // Both legs must reach back that far, so the later first close governs.
    return [...earliest.values()].sort().pop() ?? null;
  }

  /**
   * Evaluate every period on the strategy's calendar that has no stored signal
   * yet, then return the stored history newest-first -- together with how many
   * periods were left out because only an earlier configuration could answer
   * for them.
   *
   * That count is not bookkeeping. Dropping those periods is what keeps the
   * history, the predecessor chain and the backtest coherent, but a history
   * that silently shrinks is its own kind of lie: the report says so instead.
   * It falls back to zero on its own as the 24-period window rolls past them.
   *
   * A period whose absolute test cannot be run -- no momentum for the US equity
   * leg or the benchmark -- is skipped rather than stored as a guess, so it can
   * be evaluated later once its prices exist.
   *
   * Materializing on a read is deliberate (see the class comment) and writes
   * nothing the caller supplies: every column is derived from the user's own
   * stored prices, and the unique index makes a repeat a no-op. That is why it
   * is not marked `@DemoRestricted()` -- there is no request body to abuse, and
   * a demo account materializing its own signals is what makes the demo's
   * report show anything at all.
   */
  async materialize(
    userId: string,
    requestedStrategy: GemStrategy,
    requestedAssets: GemStrategyAsset[],
    asOf: string = todayYMD(),
  ): Promise<GemMaterialization> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategySignal);

      // Serialize materialization per strategy, and only then read the
      // configuration this run will write under.
      //
      // The caller loaded the strategy in an earlier, already-closed
      // transaction, so by the time we write, the settings behind those objects
      // may be several saves out of date -- and the row we would be writing is
      // an answer to a question the user has since replaced. The lock plus the
      // reload inside it make the stored configuration authoritative: whoever
      // holds the lock materializes against what the database actually says,
      // and a save committed after that reload is picked up by the next run,
      // which sees these rows as stale by fingerprint and recomputes them.
      //
      // A transaction-scoped advisory lock releases itself on commit or
      // rollback, so there is no unlock to leak. It is cluster-wide, which is
      // what makes it work with more than one backend replica.
      await lockGemStrategy(manager, requestedStrategy.id);
      const strategy =
        (await manager.getRepository(GemStrategy).findOne({
          where: { id: requestedStrategy.id, userId },
        })) ?? null;
      // Deleted while the report was being built: nothing to materialize, and
      // nothing to report either.
      if (!strategy)
        return {
          signals: [],
          legacyPeriods: 0,
          configChanged: true,
          strategyMissing: true,
        };
      const assets = await manager
        .getRepository(GemStrategyAsset)
        .find({ where: { strategyId: strategy.id } });

      const periods = recentPeriods(
        asOf,
        strategy.cadence,
        GEM_HISTORY_PERIODS,
      );
      const calendar = periods.map((period) => period.evaluatedOn);

      // Only the dates this strategy's calendar evaluates on.
      //
      // A cadence change replaces the calendar: switch from monthly to
      // quarterly and 31 March is still an evaluation date while 30 April is
      // not. Reading the newest 24 rows regardless left the April, May, July
      // rows in place -- stale, never revisited, because the loop below only
      // walks the current periods -- and the quarterly report then showed
      // monthly decisions interleaved with its own.
      //
      // They are filtered rather than deleted: nothing about them is wrong,
      // they answer a calendar this strategy is not on today, and switching
      // the cadence back brings them and their `executed` flags with it.
      //
      // No row cap: `In(calendar)` already bounds this to the 24 dates the
      // history shows, and a period can hold more than one row now that the
      // unique key carries the algorithm version. Taking 24 *rows* counted a
      // superseded row against its own replacement, so the first read after a
      // version bump returned the newest twelve dates and called that the
      // history -- with no legacy warning, because every date it did return
      // had a current row.
      const stored = await repo.find({
        where: { strategyId: strategy.id, evaluatedOn: In(calendar) },
        order: { evaluatedOn: "DESC" },
      });
      // A period counts as answered only when its row was calculated under the
      // configuration in force now, by the evaluation code in force now.
      //
      // The two mismatches are not the same thing. A different *fingerprint*
      // means the user changed the settings, so the period is recomputed in
      // place: they asked for a different answer and the old one is of no
      // further use. A different *algorithm version* means the rules changed
      // under a row that recorded a real decision and a real `executed` flag;
      // recomputing that with today's code, over prices that may have been
      // revised since, would file a counterfactual as history. Those rows are
      // left exactly as they are and reported as legacy periods.
      const preference = await manager
        .getRepository(UserPreference)
        .findOne({ where: { userId } });
      const reportingCurrency = preferredCurrency(preference);
      const fingerprint = gemConfigFingerprint(
        strategy,
        assets,
        reportingCurrency,
      );
      // What the caller was handed, against what the database turned out to
      // hold. Same settings is the ordinary case and costs one hash.
      const configChanged =
        fingerprint !==
        gemConfigFingerprint(
          requestedStrategy,
          requestedAssets,
          reportingCurrency,
        );
      const isCurrentVersion = (signal: GemStrategySignal) =>
        signal.algorithmVersion === GEM_SIGNAL_ALGORITHM_VERSION;
      /**
       * A row this configuration produced, under the rules in force now.
       *
       * One predicate, because every place that asks the question has to
       * answer it the same way. It was written out four times and the fourth
       * -- the `previousRole` chain -- checked only the date, which let a
       * superseded row stand in for its own replacement and get stored as the
       * predecessor of the next period. A shared function cannot drift; four
       * copies of a two-clause condition demonstrably do.
       */
      const isThisConfiguration = (signal: GemStrategySignal) =>
        isCurrentVersion(signal) && signal.configFingerprint === fingerprint;
      /**
       * Rows an older version wrote, by period.
       *
       * They are not obstacles: the unique key carries the version, so this
       * version evaluates the same period and stores its answer beside the old
       * one. Blocking instead would have cost the user the signal governing
       * today on the day a release shipped, with a quarterly strategy waiting
       * out the quarter for an instruction it was owed at once.
       *
       * What they are is a record -- of a decision and of the trade the user
       * says they made against it -- so the superseding row inherits `executed`
       * when it asks for the same instrument. Nobody has to re-confirm a trade
       * the new rules agree with.
       */
      const supersededByPeriod = new Map(
        stored
          .filter((signal) => !isCurrentVersion(signal))
          .map((signal) => [signal.evaluatedOn, signal]),
      );
      const staleByPeriod = new Map(
        stored
          .filter(
            (signal) =>
              isCurrentVersion(signal) &&
              signal.configFingerprint !== fingerprint,
          )
          .map((signal) => [signal.evaluatedOn, signal]),
      );
      const answered = new Set(
        stored.filter(isThisConfiguration).map((signal) => signal.evaluatedOn),
      );

      /**
       * What this strategy, as configured now, has decided -- and nothing else.
       *
       * Filtering the *dates* was not enough. A period that cannot be
       * recomputed keeps its old row on a date the current calendar does use,
       * and returning it mixed a counterfactual history with a real one: the
       * caller cannot tell which rows the current rules produced, the backtest
       * replays a run that never existed under one configuration, and the
       * history's "switched out of" is resolved by position in this array, so
       * a stale row wedged between two fresh ones is named as the predecessor
       * of a period that was computed against an earlier one.
       *
       * The rows stay in the table -- deleting them would throw away real
       * decisions and their `executed` flags -- they are simply not this
       * configuration's history. A period it cannot answer for is absent from
       * the report rather than answered by an earlier set of rules.
       */
      const current = (rows: GemStrategySignal[]): GemMaterialization => {
        const signals = rows.filter(isThisConfiguration);
        // Counted by *period*, not by row. A period can hold a superseded row
        // and its replacement at once, and the replacement being present is
        // exactly the case where nothing is missing from the history.
        const answeredDates = new Set(
          signals.map((signal) => signal.evaluatedOn),
        );
        const unanswered = new Set(
          rows
            .map((signal) => signal.evaluatedOn)
            .filter((date) => !answeredDates.has(date)),
        );
        return {
          signals,
          legacyPeriods: unanswered.size,
          configChanged,
          strategyMissing: false,
        };
      };

      const unstored = periods.filter(
        (period) => !answered.has(period.evaluatedOn),
      );
      if (unstored.length === 0 || assets.every((a) => !a.securityId)) {
        return current(stored);
      }

      // Drop the periods whose momentum window opens before the price history
      // does. They would evaluate to nothing, and re-reading a year of prices
      // to establish that on every report load is the whole cost of a strategy
      // whose instruments are younger than its history window.
      const earliestWindowStart = await this.earliestEvaluableWindowStart(
        assets,
        manager,
      );
      if (earliestWindowStart === null) return current(stored);
      const missing = unstored.filter(
        (period) =>
          windowStartFor(period.evaluatedOn, strategy.lookbackMonths) >=
          earliestWindowStart,
      );
      if (missing.length === 0) return current(stored);

      const prices = await this.loadEvaluationPrices(
        assets,
        missing[0].evaluatedOn,
        strategy.lookbackMonths,
        manager,
        userId,
      );
      const evaluable = new Set(missing.map((period) => period.evaluatedOn));
      const eligibleRoles = [...this.securityByRole(assets).keys()];
      const securityByRole = this.securityByRole(assets);

      // Chronological order matters: each period's "previous role" is the target
      // of the newest evaluation before it, including ones written in this loop.
      //
      // Seeded with the answered rows only. A stale row is an answer to a
      // different question, so letting one stand in as the predecessor would
      // stamp the old configuration's target onto a freshly computed period --
      // and `previousRole` is what the history table renders as "switched out
      // of". A period with no answered predecessor gets null, which is the
      // truth: this configuration has decided nothing before it.
      //
      // Keyed off the row, not off `answered`. Filtering on that set asked
      // only whether the *date* had an answer, and a date can hold two rows:
      // after a version bump the superseded row and its replacement sit on the
      // same day, `stored` is ordered by date alone, and the last one to reach
      // the `Map` wins. The old row could therefore be handed to the next
      // period as its predecessor and written into the history as the role it
      // switched out of -- a wrong BUY/HOLD/SWITCH, persisted, from rules no
      // longer in force.
      const byEvaluatedOn = new Map(
        stored
          .filter(isThisConfiguration)
          .map((signal) => [signal.evaluatedOn, signal]),
      );
      const written: GemStrategySignal[] = [];
      /** Periods a concurrent request inserted first, so this one must re-read. */
      let lostRaces = 0;

      for (const period of periods) {
        if (answered.has(period.evaluatedOn)) continue;
        if (!evaluable.has(period.evaluatedOn)) continue;

        const momentum = momentumSnapshot(
          prices,
          period.evaluatedOn,
          strategy.lookbackMonths,
        );
        const outcome = evaluate(momentum, eligibleRoles);
        if (!outcome) continue;

        const previous = [...byEvaluatedOn.values()]
          .filter((signal) => signal.evaluatedOn < period.evaluatedOn)
          .sort((a, b) => b.evaluatedOn.localeCompare(a.evaluatedOn))[0];

        const targetSecurityId = outcome.targetRole
          ? (securityByRole.get(outcome.targetRole) ?? null)
          : null;
        const signal = repo.create({
          userId,
          strategyId: strategy.id,
          evaluatedOn: period.evaluatedOn,
          effectiveFrom: period.effectiveFrom,
          state: outcome.state,
          targetRole: outcome.targetRole,
          targetSecurityId,
          targetWeightPercent: 100,
          momentum,
          benchmarkRole: outcome.benchmarkRole,
          spreadPp: outcome.spreadPp,
          leadPp: outcome.leadPp,
          previousRole: previous?.targetRole ?? null,
          configFingerprint: fingerprint,
          algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
          executed: false,
        });

        // Superseding an older version's row for this period: the old row is
        // left untouched, but the trade the user reported making against it
        // carries over when this version asks for the same instrument.
        const superseded = supersededByPeriod.get(period.evaluatedOn);
        if (
          superseded?.executed &&
          superseded.targetSecurityId === targetSecurityId &&
          superseded.targetRole === outcome.targetRole
        ) {
          signal.executed = true;
          signal.executedAt = superseded.executedAt;
        }

        // A period already stored under an older configuration is replaced in
        // place: the unique index owns (strategy, period), and a second row for
        // the same month would be a second answer to one question.
        //
        // "I have carried this out" describes an instruction. It survives a
        // recomputation that lands on the same instrument -- the user did that
        // trade -- and is cleared when the instruction changes, because nobody
        // executed the new one.
        const replacing = (outdated: GemStrategySignal): GemStrategySignal => {
          const sameInstruction =
            outdated.targetSecurityId === targetSecurityId &&
            outdated.targetRole === outcome.targetRole;
          return {
            ...outdated,
            ...signal,
            id: outdated.id,
            executed: sameInstruction ? outdated.executed : false,
            executedAt: sameInstruction ? outdated.executedAt : null,
          } as GemStrategySignal;
        };

        const outdated = staleByPeriod.get(period.evaluatedOn);
        if (outdated) {
          const refreshed = replacing(outdated);
          await repo.save(refreshed);
          byEvaluatedOn.set(period.evaluatedOn, refreshed);
          written.push(refreshed);
          continue;
        }

        // A concurrent report request may be materializing the same period.
        // The unique index is the arbiter and the row it already inserted is
        // just as good -- but catching the violation is not an option here:
        // this runs inside a transaction, which Postgres aborts on the error,
        // so every later statement in the loop would fail with 25P02 and the
        // request would 500. Let the insert skip instead of raising.
        const result = await repo
          .createQueryBuilder()
          .insert()
          .values(signal)
          .orIgnore()
          .returning("*")
          .execute();
        // `raw` decides whether the row went in, not `generatedMaps`.
        //
        // TypeORM builds `generatedMaps` from the *value sets* it was handed,
        // not from what the database returned, so a conflict-ignored insert
        // still yields `[{}]` -- truthy. Every branch below this one was
        // therefore dead: a lost race was recorded as a successful write, the
        // winner was never read, and the abandon path never ran. With
        // `.returning("*")`, `raw` is the rows Postgres actually wrote, and it
        // is empty exactly when the insert was skipped.
        const inserted = Array.isArray(result.raw)
          ? result.raw.length > 0
          : true;
        const saved = inserted
          ? ({
              ...signal,
              ...(result.generatedMaps[0] ?? {}),
            } as GemStrategySignal)
          : null;
        if (saved) {
          byEvaluatedOn.set(period.evaluatedOn, {
            ...signal,
            ...saved,
          } as GemStrategySignal);
          written.push(saved);
        } else {
          lostRaces += 1;
          // Read the winner's row into the chain before moving on. Later
          // periods take their `previousRole` from this map, so skipping the
          // one that lost leaves the next period believing nothing preceded
          // it -- and that period is then *stored* with the wrong predecessor,
          // which the final re-read cannot undo. History would call it a BUY
          // for as long as the row lives.
          //
          // Only a row this configuration produced can play that part. The
          // unique key is (strategy, date), not (strategy, date, fingerprint),
          // so the winner may carry different settings -- and here that is not
          // a leftover to overwrite: materialization is serialized per strategy
          // and reads the stored configuration under the lock, so a row that
          // appeared anyway came from something this run cannot account for,
          // and the one thing that must not happen is stamping a configuration
          // read before the lock over a row that may well be newer.
          //
          // So this run stops writing. Everything already written stands and is
          // correct; the periods after this one are simply left for the next
          // read, which reloads the configuration and evaluates them against
          // whatever the database holds by then. Abandoning is the only option
          // that neither invents a predecessor nor overwrites a stranger's row.
          //
          // Scoped to this algorithm version. The unique key carries it, so
          // (strategy, date) selects more than one row once a version has been
          // superseded -- and the row the insert actually collided with is the
          // one this version wrote. Reading without the version could return
          // the older row, fail the check below and abandon a materialization
          // that had in fact lost the race to a perfectly valid winner.
          const winner = await repo.findOne({
            where: {
              strategyId: strategy.id,
              evaluatedOn: period.evaluatedOn,
              algorithmVersion: GEM_SIGNAL_ALGORITHM_VERSION,
            },
          });
          if (winner && isThisConfiguration(winner)) {
            byEvaluatedOn.set(period.evaluatedOn, winner);
            this.logger.debug(
              `GEM period ${period.evaluatedOn} was materialized concurrently`,
            );
          } else {
            this.logger.debug(
              `GEM period ${period.evaluatedOn} was written by another ` +
                `configuration; abandoning the rest of this materialization`,
            );
            break;
          }
        }
      }

      // Losing the race is not the same as having nothing to do. The winner's
      // row exists and this request's `stored` snapshot predates it, so
      // returning that snapshot renders a report missing the very period the
      // user came for -- and the next read, finding it already answered, has
      // no reason to look again. Re-read instead.
      if (written.length === 0 && lostRaces === 0) return current(stored);

      return current(
        await repo.find({
          where: { strategyId: strategy.id, evaluatedOn: In(calendar) },
          order: { evaluatedOn: "DESC" },
        }),
      );
    });
  }

  /**
   * The signal governing the period `asOf` falls in, or null when there is
   * none the strategy's current configuration would produce.
   *
   * `materialize` refreshes a period it can recompute, so a row still carrying
   * a foreign fingerprint here is one the price history cannot reach under the
   * new settings -- a lookback stretched past the instrument's first close, for
   * instance. Serving it would present a decision taken under rules that no
   * longer exist as the instruction to act on now, which is precisely the thing
   * the fingerprint exists to stop. It stays in the history, where it is a
   * true record of what was decided then.
   *
   * The algorithm version is checked for the same reason and is never
   * refreshed away: a row an older version wrote is a record, not an
   * instruction, however well its settings still match.
   */
  currentSignal(
    signals: GemStrategySignal[],
    strategy: GemStrategy,
    /** The role assignments in force, which the fingerprint is checked against. */
    assets: GemStrategyAsset[],
    /** The reporting currency the fingerprint is checked against. */
    reportingCurrency: string,
    asOf: string = todayYMD(),
  ): GemStrategySignal | null {
    const period = periodFor(asOf, strategy.cadence);
    const signal =
      signals.find((entry) => entry.evaluatedOn === period.evaluatedOn) ?? null;
    if (!signal) return null;
    return signal.algorithmVersion === GEM_SIGNAL_ALGORITHM_VERSION &&
      signal.configFingerprint ===
        gemConfigFingerprint(strategy, assets, reportingCurrency)
      ? signal
      : null;
  }

  /**
   * Whether the strategy evaluated anything before `evaluatedOn` -- under any
   * configuration and any algorithm version.
   *
   * The backtest needs this to know whether its first period is the strategy's
   * first allocation. `previousRole` cannot answer it: materialization sets
   * that from the *current* chain, so it is null whenever the predecessor was
   * written by another configuration, by an older version, or simply fell out
   * of the 24-period window -- none of which mean the strategy started there.
   * Reading it as "nothing came before" charges an opening commission for a
   * trade that never happened and dates the tax basis to the edge of the
   * visible history.
   */
  async hasSignalsBefore(
    userId: string,
    strategyId: string,
    evaluatedOn: string,
  ): Promise<boolean> {
    return withScopedDb(this.dataSource, async (manager) => {
      const count = await manager.getRepository(GemStrategySignal).count({
        where: {
          userId,
          strategyId,
          evaluatedOn: LessThan(evaluatedOn),
        },
      });
      return count > 0;
    });
  }

  /** Mark a signal's operation as carried out. Returns false when unknown. */
  /**
   * Record that the user carried out a signal's operation.
   *
   * Returns the id of the strategy the signal belongs to, `null` when there is
   * no such signal for this user, or `MISMATCH` when `expectedStrategyId` names
   * a different one. The **signal** decides which strategy this was, not the
   * caller: a client whose report is one scenario behind its selection would
   * otherwise mark scenario A's signal and be handed scenario B's report,
   * having been told the operation it just confirmed was B's.
   *
   * `expectedStrategyId` is checked **here**, inside the transaction and under
   * the lock, rather than by the caller afterwards. Comparing after this method
   * returned was too late by a whole commit: the row was already `executed` and
   * the request then answered 409, so a stale client got a failure on screen
   * and a completed operation in the database -- the one outcome a rejected
   * request must never produce.
   *
   * The strategy's lock is taken before the write, in the same order every
   * other writer takes it. Materialization reads the stored rows and writes
   * refreshed copies of them, carrying `executed` across; without the lock a
   * confirmation committed between that read and that write was overwritten by
   * the snapshot, and the report went back to asking for a trade the user had
   * just told it about.
   */
  async markExecuted(
    userId: string,
    signalId: string,
    expectedStrategyId?: string,
  ): Promise<string | null | typeof GEM_SIGNAL_STRATEGY_MISMATCH> {
    return withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategySignal);
      const found = await repo.findOne({ where: { id: signalId, userId } });
      if (!found) return null;
      await lockGemStrategy(manager, found.strategyId);
      // Re-read under the lock: the row may have been rewritten by a
      // materializer that was already holding it when we looked.
      const signal = await repo.findOne({ where: { id: signalId, userId } });
      if (!signal) return null;
      // Before any write, and before the early return for an already-executed
      // signal: a mismatched request is refused whatever state the row is in.
      if (expectedStrategyId && expectedStrategyId !== signal.strategyId) {
        return GEM_SIGNAL_STRATEGY_MISMATCH;
      }
      if (signal.executed) return signal.strategyId;
      signal.executed = true;
      signal.executedAt = new Date();
      await repo.save(signal);
      return signal.strategyId;
    });
  }
}
