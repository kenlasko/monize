import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { todayYMD } from "../common/date-utils";
import { normalizeWebsite } from "../common/normalize-website";
import { tr } from "../i18n/translate";
import {
  Account,
  AccountSubType,
  AccountType,
} from "../accounts/entities/account.entity";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  GEM_ASSET_ROLES,
  GEM_EQUITY_ROLES,
  GEM_OPTIONAL_ROLES,
  GemAssetRole,
  GemStrategyAsset,
} from "./entities/gem-strategy-asset.entity";
import { GemStrategyAccount } from "./entities/gem-strategy-account.entity";
import { GemStrategySignal } from "./entities/gem-strategy-signal.entity";
import { GemStrategy } from "./entities/gem-strategy.entity";
import { UpdateGemStrategyDto } from "./dto/update-gem-strategy.dto";
import {
  addMonthsUtc,
  benchmarkRoleFor,
  cadenceMonths,
  historyAction,
  parseYmd,
  periodFor,
  rankEquities,
} from "./gem-momentum.util";
import { GemBackfillService } from "./gem-backfill.service";
import { GemBacktestService } from "./gem-backtest.service";
import { GemPerformanceService } from "./gem-performance.service";
import { GemPositionService } from "./gem-position.service";
import { GemPriceService } from "./gem-price.service";
import {
  GEM_SIGNAL_STRATEGY_MISMATCH,
  GemSignalService,
  lockGemStrategy,
} from "./gem-signal.service";
import {
  GemAccountRef,
  GemAssetMomentum,
  GemAssetRef,
  GemHistoryEntryView,
  GemRange,
  GemSignalView,
  GemStrategyMetaView,
  GemStrategyRef,
  GemStrategyReportView,
  GemWarning,
} from "./gem-report.types";
import { preferredCurrency } from "../common/default-currency.util";

/** Prices older than this make the signal provisional. */
const STALE_PRICE_DAYS = 5;

/** Lookback the unconfigured report reports, matching the column default. */
const DEFAULT_LOOKBACK_MONTHS = 12;

/** Name a scenario gets when its creator did not supply one. */
/**
 * Name a scenario gets before the user renames it, and the title of the report
 * shown to someone who has never saved one.
 *
 * Deliberately not translated. It is the strategy's own name -- the acronym of
 * Global Equities Momentum, the published rule set this report implements --
 * and it is also seeded into `gem_strategies.name`, a column the user edits, so
 * a localized default would mean the stored name depended on the locale of
 * whoever created it. It went through `tr()` once, against a `strategies`
 * catalog the backend does not ship: a key that could never resolve and always
 * returned this literal anyway.
 */
const DEFAULT_STRATEGY_NAME = "GEM";

/**
 * How many times the report may be built before it gives up.
 *
 * One rebuild covers the ordinary race -- a save landing while the first
 * attempt was in flight. A second mismatch means the settings are being written
 * faster than a report can be assembled, and there is no coherent answer to
 * give; see `getReport`.
 */
const GEM_REPORT_ATTEMPTS = 2;

/**
 * The GEM strategy read model: one call assembles the whole report page --
 * current signal, why it says what it says, how the real portfolio compares, and
 * the single operation to carry out.
 *
 * Every figure comes from either stored evaluations (`gem_strategy_signals`) or
 * prices; nothing is recomputed on the client. The strategy rules themselves
 * live in `gem-momentum.util`, the position arithmetic in `gem-position.util`.
 */
@Injectable()
export class GemStrategyService {
  constructor(
    private dataSource: DataSource,
    private signalService: GemSignalService,
    private positionService: GemPositionService,
    private performanceService: GemPerformanceService,
    private priceService: GemPriceService,
    private backfillService: GemBackfillService,
    private backtestService: GemBacktestService,
  ) {}

  /**
   * Config, role assignments and the accounts the strategy is run in, or null
   * when the user has no GEM strategy yet.
   */
  private async loadStrategy(
    userId: string,
    strategyId?: string,
  ): Promise<{
    strategy: GemStrategy;
    assets: GemStrategyAsset[];
    accounts: GemAccountRef[];
  } | null> {
    return withScopedDb(this.dataSource, async (manager) => {
      // A named scenario, or the oldest one -- which is the only one for a user
      // who never created a second, so the default report is unchanged.
      const strategy = await manager.getRepository(GemStrategy).findOne({
        where: strategyId ? { id: strategyId, userId } : { userId },
        order: { createdAt: "ASC" },
      });
      if (!strategy) return null;
      const assets = await manager.getRepository(GemStrategyAsset).find({
        where: { strategyId: strategy.id },
        relations: ["security"],
      });
      const links = await manager.getRepository(GemStrategyAccount).find({
        where: { strategyId: strategy.id },
        relations: ["account"],
      });
      const accounts = links
        .filter((link) => link.account)
        .map((link) => ({ id: link.account.id, name: link.account.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { strategy, assets, accounts };
    });
  }

  /** Every saved scenario, oldest first, for the report's switcher. */
  async listStrategies(userId: string): Promise<GemStrategyRef[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const rows = await manager.getRepository(GemStrategy).find({
        where: { userId },
        order: { createdAt: "ASC" },
        select: { id: true, name: true },
      });
      return rows.map((row) => ({ id: row.id, name: row.name }));
    });
  }

  private async defaultCurrency(userId: string): Promise<string> {
    const preference = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    return preferredCurrency(preference);
  }

  /** Every role, mapped or not, so the client can name what is missing. */
  private buildAssetRefs(
    assets: GemStrategyAsset[],
  ): Map<GemAssetRole, GemAssetRef> {
    const byRole = new Map(assets.map((asset) => [asset.role, asset]));
    const refs = new Map<GemAssetRole, GemAssetRef>();
    for (const role of GEM_ASSET_ROLES) {
      const asset = byRole.get(role);
      refs.set(role, {
        role,
        securityId: asset?.securityId ?? null,
        symbol: asset?.security?.symbol ?? null,
        name: asset?.security?.name ?? null,
      });
    }
    return refs;
  }

  private momentumOf(
    refs: Map<GemAssetRole, GemAssetRef>,
    role: GemAssetRole,
    momentum: Partial<Record<GemAssetRole, number | null>>,
    rank: number | null,
  ): GemAssetMomentum {
    return {
      ...(refs.get(role) as GemAssetRef),
      momentumPercent: momentum[role] ?? null,
      rank,
    };
  }

  /** Expand a stored signal into the two decision steps the report explains. */
  private toSignalView(
    signal: GemStrategySignal,
    refs: Map<GemAssetRole, GemAssetRef>,
  ): GemSignalView {
    const mappedEquities = GEM_EQUITY_ROLES.filter(
      (role) => refs.get(role)?.securityId,
    );
    const ranked = rankEquities(signal.momentum, mappedEquities);
    const rankByRole = new Map(
      ranked.map((entry, index) => [entry.role, index + 1]),
    );

    return {
      id: signal.id,
      state: signal.state,
      target: signal.targetRole ? (refs.get(signal.targetRole) ?? null) : null,
      targetWeightPercent: Number(signal.targetWeightPercent),
      effectiveFrom: signal.effectiveFrom,
      evaluatedOn: signal.evaluatedOn,
      absolute: {
        equity: this.momentumOf(
          refs,
          "US_EQUITY",
          signal.momentum,
          rankByRole.get("US_EQUITY") ?? null,
        ),
        // Pre-split evaluations carry no benchmark role; they were all taken
        // against the safe asset, which is what NULL reads as.
        benchmark: this.momentumOf(
          refs,
          signal.benchmarkRole ?? "SAFE",
          signal.momentum,
          null,
        ),
        spreadPp: signal.spreadPp,
        result: signal.state,
      },
      relative: {
        ranking: ranked.map((entry, index) =>
          this.momentumOf(refs, entry.role, signal.momentum, index + 1),
        ),
        winner: ranked[0] ? (refs.get(ranked[0].role) ?? null) : null,
        leadPp: signal.leadPp,
        // While RISK-OFF the ranking is computed but does not drive allocation.
        applied: signal.state === "RISK_ON",
      },
    };
  }

  /**
   * The instrument a past decision actually named.
   *
   * History resolved every role through the *current* mapping, so replacing the
   * ETF in a role rewrote the past: an entry from March claimed to have bought
   * the fund the user assigned in August. The signal stores the security it
   * chose, so that is what the row shows; the current mapping is only the
   * fallback for a role whose security has since been deleted.
   */
  private storedRef(
    role: GemAssetRole | null,
    securityId: string | null,
    securities: Map<string, { symbol: string | null; name: string | null }>,
  ): GemAssetRef | null {
    if (!role) return null;
    const stored = securityId ? securities.get(securityId) : undefined;
    if (stored) {
      return {
        role,
        securityId,
        symbol: stored.symbol,
        name: stored.name,
      };
    }
    // The instrument this decision actually named is gone, and today's
    // assignment for the role is not a stand-in for it.
    //
    // A March signal that selected EEM, after EEM is deleted and the role
    // reassigned to EMIM, rendered as "March selected EMIM" -- a historical
    // falsehood, and one nothing on the page marked as a guess. The role is
    // what the row records and is kept; the instrument is unknown and says so.
    // `buildAssetRefs` stays the source for the *current* signal, where the
    // assignment is the answer rather than a substitute for one.
    return { role, securityId: null, symbol: null, name: null };
  }

  private toHistoryEntry(
    signal: GemStrategySignal,
    refs: Map<GemAssetRole, GemAssetRef>,
    securities: Map<string, { symbol: string | null; name: string | null }>,
    /** The evaluation immediately before this one, which is what it switched out of. */
    previous: GemStrategySignal | null,
  ): GemHistoryEntryView {
    const action = historyAction(signal.targetRole, signal.previousRole);
    const winner = this.storedRef(
      signal.targetRole,
      signal.targetSecurityId,
      securities,
    );
    return {
      id: signal.id,
      evaluatedOn: signal.evaluatedOn,
      effectiveFrom: signal.effectiveFrom,
      winner,
      state: signal.state,
      action,
      momentum: signal.momentum,
      change:
        action === "SWITCH"
          ? {
              // What it moved out of is the previous period's own target,
              // not whatever that role points at today -- and role and
              // instrument must come from the same place. This row's
              // `previousRole` and the predecessor row's target can disagree
              // (a period materialized out of order after a backfill leaves
              // one of them behind), and pairing them produced a ref naming
              // one role with another role's security: "switched from SPY to
              // SPY". Where they disagree the instrument is unknown, not
              // guessed.
              from: this.storedRef(
                signal.previousRole,
                previous && previous.targetRole === signal.previousRole
                  ? previous.targetSecurityId
                  : null,
                securities,
              ),
              to: winner,
            }
          : null,
      // A HOLD asked for nothing, so "executed" does not apply to it.
      executed: action === "HOLD" ? null : signal.executed,
    };
  }

  /**
   * How current the report's inputs are, judged per role.
   *
   * `pricesAsOf` is the **oldest** required instrument's last close, not the
   * newest: a signal is only as current as the stalest number behind it, and
   * taking the maximum let a US quote refreshed this morning stand in for an
   * ex-US instrument last priced three weeks ago. An assigned instrument with
   * no price at all makes the date unknown rather than letting the others
   * answer for it.
   *
   * `staleRoles` names the offenders, so the warning says which instrument to
   * go and refresh instead of leaving the user to find it.
   */
  private async priceFreshness(
    securityByRole: Map<GemAssetRole, string>,
    asOf: string,
  ): Promise<{ pricesAsOf: string | null; staleRoles: GemAssetRole[] }> {
    const required = [...securityByRole.entries()];
    if (required.length === 0) return { pricesAsOf: null, staleRoles: [] };

    const latest = await this.priceService.latestPriceDates(
      required.map(([, securityId]) => securityId),
    );
    const cutoff = parseYmd(asOf).getTime() - STALE_PRICE_DAYS * 86_400_000;
    const staleRoles: GemAssetRole[] = [];
    let oldest: string | null = null;
    let anyMissing = false;

    for (const [role, securityId] of required) {
      const date = latest.get(securityId);
      if (!date) {
        // Never priced: it cannot be stale, it is absent, and the report must
        // not imply the others speak for it.
        anyMissing = true;
        staleRoles.push(role);
        continue;
      }
      if (parseYmd(date).getTime() < cutoff) staleRoles.push(role);
      if (oldest === null || date < oldest) oldest = date;
    }

    return { pricesAsOf: anyMissing ? null : oldest, staleRoles };
  }

  /** Symbol and name for every instrument the stored signals name. */
  private async loadSignalSecurities(
    userId: string,
    signals: GemStrategySignal[],
  ): Promise<Map<string, { symbol: string | null; name: string | null }>> {
    const ids = [
      ...new Set(
        signals
          .map((signal) => signal.targetSecurityId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) return new Map();
    const rows = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(Security).find({
        where: { id: In(ids), userId },
        select: { id: true, symbol: true, name: true },
      }),
    );
    return new Map(
      rows.map((row) => [row.id, { symbol: row.symbol, name: row.name }]),
    );
  }

  /**
   * When the next evaluation falls: the price date the following period will be
   * decided on, i.e. the last day before it starts.
   */
  private nextEvaluation(
    strategy: GemStrategy,
    asOf: string,
  ): { on: string; days: number } {
    const current = periodFor(asOf, strategy.cadence);
    const nextStart = addMonthsUtc(
      parseYmd(current.effectiveFrom),
      cadenceMonths(strategy.cadence),
    );
    const evaluatedOn = new Date(nextStart);
    evaluatedOn.setUTCDate(0);
    const days = Math.max(
      0,
      Math.round(
        (evaluatedOn.getTime() - parseYmd(asOf).getTime()) / 86_400_000,
      ),
    );
    return { on: evaluatedOn.toISOString().slice(0, 10), days };
  }

  /**
   * The empty report, carrying whatever scenarios the user does have.
   *
   * `emptyReport` describes one strategy that is not there; it says nothing
   * about the others, and hardcoding `strategies: []` claimed there were none.
   * That is a claim about a second thing, it was wrong whenever this was
   * reached with a stale id, and it removed the switcher -- the only control
   * that could have got the user back to a scenario that does exist.
   */
  private async unconfiguredReport(
    userId: string,
  ): Promise<GemStrategyReportView> {
    return {
      ...this.emptyReport(this.buildAssetRefs([]), DEFAULT_STRATEGY_NAME),
      strategies: await this.listStrategies(userId),
    };
  }

  /** The report a user with no configured strategy gets: shape, no invented data. */
  private emptyReport(
    refs: Map<GemAssetRole, GemAssetRef>,
    name: string,
  ): GemStrategyReportView {
    const meta: GemStrategyMetaView = {
      id: null,
      name,
      cadence: "MONTHLY",
      lookbackMonths: DEFAULT_LOOKBACK_MONTHS,
      taxRatePercent: null,
      commissionAmount: null,
      nextEvaluationOn: null,
      daysUntilNextEvaluation: null,
      pricesAsOf: null,
      rulesSourceUrl: null,
      rulesSourceLabel: null,
      accounts: [],
    };
    return {
      strategy: meta,
      strategies: [],
      assets: [...refs.values()],
      signal: null,
      position: null,
      action: null,
      performance: null,
      history: [],
      backtest: null,
      warnings: [
        { code: "FIRST_RUN" },
        {
          code: "UNMAPPED_ROLE",
          roles: GEM_ASSET_ROLES.filter(
            (role) => !GEM_OPTIONAL_ROLES.includes(role),
          ),
        },
        { code: "NO_ACCOUNT" },
      ],
    };
  }

  /**
   * The report, assembled from one configuration.
   *
   * `attempt` guards the one race that can split it in two. Everything below --
   * the role references, the position, the safe asset, the cost assumptions,
   * the metadata handed back to the client -- is built from the strategy this
   * method loads, while `materialize` deliberately reloads the stored
   * configuration under a lock before it writes. If the user saved in between,
   * those two are different configurations and pasting their halves together
   * produces a report of neither: signals filtered against a fingerprint the
   * metadata does not describe, a backtest replaying one configuration's
   * decisions with another's safe asset and costs, a current signal that comes
   * back null although materialization just produced it.
   *
   * So the report is built again from the top, which re-reads everything --
   * accounts included. `GEM_REPORT_ATTEMPTS` bounds that: a user saving faster
   * than the report can be built twice is not a state worth spinning on, and
   * carrying on regardless is worse than refusing -- the second mismatch used
   * to be ignored, which is exactly how B's costs and safe asset ended up
   * describing C's history. Past the budget the request fails with a conflict
   * the client can retry, rather than returning a report of neither
   * configuration.
   */
  async getReport(
    userId: string,
    range: GemRange = "1Y",
    strategyId?: string,
    attempt = 0,
  ): Promise<GemStrategyReportView> {
    const asOf = todayYMD();
    const loaded = await this.loadStrategy(userId, strategyId);
    if (!loaded) {
      // A named scenario that does not resolve is not the same thing as having
      // no scenarios. It is a stale id -- a bookmark, another tab that deleted
      // it -- and the user's remaining scenarios are untouched. Answering with
      // the unconfigured page hid every one of them and took the switcher away
      // with them, so the only route back was to reload the page.
      //
      // So: drop the id and report on the default scenario, which is what an
      // unset id has always meant. Only when *that* finds nothing is the
      // account genuinely unconfigured.
      if (strategyId && attempt + 1 < GEM_REPORT_ATTEMPTS) {
        return this.getReport(userId, range, undefined, attempt + 1);
      }
      return this.unconfiguredReport(userId);
    }

    const { strategy, assets, accounts } = loaded;
    const refs = this.buildAssetRefs(assets);
    const securityByRole = new Map<GemAssetRole, string>();
    for (const [role, ref] of refs) {
      if (ref.securityId) securityByRole.set(role, ref.securityId);
    }
    // An unassigned optional role is not a gap: the strategy runs without it.
    const unmappedRoles = GEM_ASSET_ROLES.filter(
      (role) => !securityByRole.has(role) && !GEM_OPTIONAL_ROLES.includes(role),
    );

    const { signals, legacyPeriods, configChanged, strategyMissing } =
      await this.signalService.materialize(userId, strategy, assets, asOf);
    // Deleted underneath us. Rebuilding once picks up whatever the user is
    // actually looking at now -- another scenario, or none -- and if that is
    // gone too there is nothing to report but the unconfigured page.
    if (strategyMissing) {
      // Rebuilt without the id. Recursing with it re-asks for the scenario
      // that has just been established as gone: `loadStrategy` cannot find it,
      // so every attempt takes the same path and the retry could never do what
      // this comment says it does. Unset is what picks up "whatever the user
      // is actually looking at now".
      return attempt + 1 < GEM_REPORT_ATTEMPTS
        ? this.getReport(userId, range, undefined, attempt + 1)
        : this.unconfiguredReport(userId);
    }
    if (configChanged) {
      if (attempt + 1 < GEM_REPORT_ATTEMPTS) {
        return this.getReport(userId, range, strategyId, attempt + 1);
      }
      // Out of attempts, and everything below would be built from the halves
      // of two configurations: this strategy's costs and safe asset against
      // signals materialized under the newer one. Refusing is the only honest
      // answer left -- the client retries and gets a whole report.
      throw new ConflictException(
        tr(
          "errors.strategies.configurationChanging",
          "The strategy settings changed while the report was being built. Please try again.",
        ),
      );
    }
    // Money is reported in the user's default currency: several accounts can be
    // in the strategy, in different currencies, and the totals have to add up.
    const currencyCode = await this.defaultCurrency(userId);
    const current = this.signalService.currentSignal(
      signals,
      strategy,
      assets,
      currencyCode,
      asOf,
    );
    const { position, action, noPosition, tradingAccountCount } =
      await this.positionService.build({
        userId,
        strategy,
        accounts,
        assetRefs: refs,
        targetRole: current?.targetRole ?? null,
        executed: current?.executed ?? false,
        currencyCode,
      });

    const heldForSimulation = position?.holdings ?? [];
    let performance = await this.performanceService.build({
      userId,
      range,
      securityByRole,
      // Today's holdings, for the "what my current mix would have done" line.
      // They come from the position above, so the chart and the portfolio tab
      // are describing the same accounts at the same moment.
      holdings: heldForSimulation,
      asOf,
    });

    /**
     * The simulated line needs history for instruments the strategy does not
     * assign, and nothing else fetches it.
     *
     * `ensureHistory` runs on a configuration save, over the *assigned*
     * securities, because those are what the signal depends on. A fund the user
     * merely holds is never in that list, so the one thing it is drawn into --
     * "Today's portfolio" -- had whatever prices happened to exist. Refreshing a
     * quote stores today's close, which is a single point: the simulation then
     * had nothing to draw, and the user was told the history was unusable with
     * no way to act on it.
     *
     * Only when the simulation actually failed for want of prices, so the happy
     * path costs nothing, and only once: `ensureHistory` skips a security that
     * already covers the window and honours its own provider cooldown, and it
     * reports which securities it fetched for. Rebuilding when that list is
     * empty would be a retry with unchanged inputs.
     */
    if (
      performance?.currentPortfolio?.unavailableReason ===
      "MISSING_PRICE_HISTORY"
    ) {
      const heldIds = [
        ...new Set(
          heldForSimulation
            .filter((holding) => !holding.isCash && holding.securityId)
            .map((holding) => holding.securityId as string),
        ),
      ];
      const fetched = await this.backfillService.ensureHistory(
        userId,
        heldIds,
        strategy.lookbackMonths,
        strategy.cadence,
      );
      if (fetched.length > 0) {
        performance = await this.performanceService.build({
          userId,
          range,
          securityByRole,
          holdings: heldForSimulation,
          asOf,
        });
      }
    }

    const { pricesAsOf, staleRoles } = await this.priceFreshness(
      securityByRole,
      asOf,
    );
    const signalSecurities = await this.loadSignalSecurities(userId, signals);

    // The simulation charges the configured per-trade commission against the
    // capital the strategy actually runs, so it needs the portfolio's value.
    // Whether anything preceded the oldest signal in hand decides whether the
    // simulation may open with a real purchase, and the 24 periods it holds
    // cannot answer that for a strategy older than they are.
    const oldestEvaluatedOn = signals[signals.length - 1]?.evaluatedOn ?? null;
    const hasEarlierSignals =
      strategy.id && oldestEvaluatedOn
        ? await this.signalService.hasSignalsBefore(
            userId,
            strategy.id,
            oldestEvaluatedOn,
          )
        : false;
    const backtest = await this.backtestService.build({
      strategy,
      signals,
      safeSecurityId: securityByRole.get("SAFE") ?? null,
      notional: position?.totalMarketValue ?? null,
      // Accounts that can actually place an order, not every account the
      // scenario names. An empty one trades nothing, and charging it a
      // commission per leg doubled the modelled cost of a strategy set up
      // across a funded account and an empty one. Floored at one so a run
      // with a notional but nothing currently held still models the single
      // order it would take -- `runBacktest` applies the same floor.
      accountCount: Math.max(1, tradingAccountCount),
      hasEarlierSignals,
      asOf,
    });
    const next = this.nextEvaluation(strategy, asOf);

    // When there is no current signal, work out whether a required leg's price
    // history is simply too short to reach the momentum window's start -- the
    // one cause of a missing signal we can name a security and a date for, and
    // the one the user can fix themselves by fetching more history. The absolute
    // test needs the US equity leg and the benchmark; a RISK-ON result needs
    // every assigned equity market too, so any of those coming up short leaves
    // the period unevaluated. Only computed on the no-signal path so the happy
    // path pays for no extra query.
    let shortRoles: GemAssetRole[] = [];
    let shortHistoryFrom: string | null = null;
    if (!current) {
      shortHistoryFrom = addMonthsUtc(
        parseYmd(periodFor(asOf, strategy.cadence).evaluatedOn),
        -strategy.lookbackMonths,
      )
        .toISOString()
        .slice(0, 10);
      const requiredRoles = [
        ...GEM_EQUITY_ROLES.filter((role) => securityByRole.has(role)),
        benchmarkRoleFor([...securityByRole.keys()]),
      ];
      const requiredIds = [
        ...new Set(
          requiredRoles
            .map((role) => securityByRole.get(role))
            .filter((id): id is string => !!id),
        ),
      ];
      const earliestBySecurity =
        await this.priceService.earliestPriceDates(requiredIds);
      shortRoles = requiredRoles.filter((role) => {
        const id = securityByRole.get(role);
        if (!id) return false;
        const earliest = earliestBySecurity.get(id);
        // No price at or before the window start (a string date compare is a
        // valid ISO ordering): the trailing return has no base to measure from.
        return !earliest || earliest > (shortHistoryFrom as string);
      });
    }

    const warnings: GemWarning[] = [];
    if (unmappedRoles.length > 0) {
      warnings.push({ code: "UNMAPPED_ROLE", roles: unmappedRoles });
    }
    if (!current && shortRoles.length > 0) {
      // A named, fixable cause for the missing signal: these legs need prices
      // back to `shortHistoryFrom`. Preferred over the generic warnings below,
      // which stay for a missing signal we cannot pin to an instrument.
      warnings.push({
        code: "SHORT_HISTORY",
        roles: shortRoles,
        requiredFrom: shortHistoryFrom ?? undefined,
      });
    } else if (signals.length === 0 && legacyPeriods === 0) {
      warnings.push({ code: "FIRST_RUN" });
    } else if (!current) {
      // History exists but the period governing today could not be evaluated --
      // missing prices for the absolute test, so there is no signal to act on.
      warnings.push({ code: "CALCULATION_FAILED" });
    }
    if (
      current &&
      Object.values(current.momentum).some((value) => value === null)
    ) {
      warnings.push({ code: "INCOMPLETE_HISTORY" });
    } else if (performance?.incomplete) {
      warnings.push({ code: "INCOMPLETE_HISTORY" });
    }
    if (accounts.length === 0 || !position) {
      warnings.push({ code: "NO_ACCOUNT" });
    } else if (noPosition) {
      warnings.push({ code: "NO_POSITION" });
    }
    if (staleRoles.length > 0) {
      warnings.push({ code: "STALE_PRICES", roles: staleRoles });
    }
    // The history and the backtest carry one configuration's decisions only.
    // When that left periods out, the report says how many rather than letting
    // the table quietly come up short.
    if (legacyPeriods > 0) {
      warnings.push({ code: "LEGACY_PERIODS", count: legacyPeriods });
    }

    return {
      strategy: {
        id: strategy.id,
        name: strategy.name,
        cadence: strategy.cadence,
        lookbackMonths: strategy.lookbackMonths,
        taxRatePercent: strategy.taxRatePercent,
        commissionAmount: strategy.commissionAmount,
        nextEvaluationOn: next.on,
        daysUntilNextEvaluation: next.days,
        pricesAsOf,
        rulesSourceUrl: strategy.rulesSourceUrl,
        rulesSourceLabel: strategy.rulesSourceLabel,
        accounts,
      },
      strategies: await this.listStrategies(userId),
      assets: [...refs.values()],
      signal: current ? this.toSignalView(current, refs) : null,
      position,
      action,
      performance,
      // `signals` is newest first, so the entry after each one is what it
      // switched out of.
      history: signals.map((signal, index) =>
        this.toHistoryEntry(
          signal,
          refs,
          signalSecurities,
          signals[index + 1] ?? null,
        ),
      ),
      backtest,
      warnings,
    };
  }

  /**
   * Create or update the user's GEM configuration, then return the refreshed
   * report. Roles are replaced wholesale when `assets` is supplied so a role can
   * be cleared by sending a null security.
   */
  async updateConfig(
    userId: string,
    dto: UpdateGemStrategyDto,
    range: GemRange = "1Y",
    strategyId?: string,
  ): Promise<GemStrategyReportView> {
    const configured = await withScopedDb(this.dataSource, async (manager) => {
      // Whatever this save changes, a materialization already in flight is
      // writing signals against the settings it read. Take its lock first so
      // the two cannot interleave: without it a save committing between that
      // reload and its first insert leaves rows answering a configuration the
      // database no longer holds, and nothing repairs them until some later
      // read happens to run.
      //
      // The id is known only for a named scenario; a save that has to look the
      // strategy up locks below, once it knows which one it is editing.
      if (strategyId) await lockGemStrategy(manager, strategyId);
      // The unnamed save has no id to lock on yet, and two of them racing on a
      // user with no scenario each find nothing and each create one -- two
      // defaults where the model allows the user only to have made one. The
      // same lock function keyed by the user serializes that, and serializes
      // the lookup below with any other unnamed save. Nothing else locks on a
      // user id, so there is no second order in which these can be taken.
      if (!strategyId) await lockGemStrategy(manager, `user:${userId}`);
      if (dto.accountIds && dto.accountIds.length > 0) {
        const wanted = [...new Set(dto.accountIds)];
        const owned = await manager.getRepository(Account).find({
          where: { id: In(wanted), userId },
          select: { id: true, accountType: true, accountSubType: true },
        });
        if (owned.length !== wanted.length) {
          throw new NotFoundException(
            tr("errors.strategies.accountNotFound", "Account not found"),
          );
        }
        // Ownership is not eligibility. The picker offers only brokerage and
        // standalone investment accounts, but the API takes any id the user
        // owns, and the rest of the report then quietly disagrees with itself:
        // holdings finds nothing for a chequing account, the cash read filters
        // to investment accounts and skips it, and the metadata still names it
        // as one of the strategy's accounts. A linked cash sleeve is rejected
        // for the opposite reason -- it is half of an account, and its
        // brokerage side is the thing a strategy runs in.
        const ineligible = owned.filter(
          (account) =>
            account.accountType !== AccountType.INVESTMENT ||
            account.accountSubType === AccountSubType.INVESTMENT_CASH,
        );
        if (ineligible.length > 0) {
          throw new BadRequestException(
            tr(
              "errors.strategies.accountNotInvestment",
              "A GEM strategy can only run in investment accounts.",
            ),
          );
        }
      }

      const securityIds = (dto.assets ?? [])
        .map((asset) => asset.securityId)
        .filter((id): id is string => !!id);
      if (securityIds.length > 0) {
        const owned = await manager.getRepository(Security).find({
          where: { id: In(securityIds), userId },
          select: { id: true },
        });
        if (owned.length !== new Set(securityIds).size) {
          throw new NotFoundException(
            tr("errors.strategies.securityNotFound", "Security not found"),
          );
        }
      }

      const strategyRepo = manager.getRepository(GemStrategy);
      // Naming a scenario edits that one; omitting the id edits the first,
      // which is the only one for a user who never created a second.
      let existing = await strategyRepo.findOne({
        where: strategyId ? { id: strategyId, userId } : { userId },
        order: { createdAt: "ASC" },
      });
      // The unnamed case: the read above happened *before* any lock, so the
      // entity it produced is a snapshot, and the partial DTO is about to be
      // applied on top of it. Two concurrent saves -- one setting the cadence,
      // one the tax rate -- both loaded the same snapshot, and the second to
      // reach the lock wrote its own field plus the first one's stale values,
      // silently undoing that change. The comment here promised a re-read and
      // did not perform one; taking the lock and reading again under it is
      // what makes the write a read-modify-write of the authoritative row.
      if (!strategyId && existing) {
        await lockGemStrategy(manager, existing.id);
        existing = await strategyRepo.findOne({
          where: { id: existing.id, userId },
        });
      }
      if (strategyId && !existing) {
        throw new NotFoundException(
          tr("errors.strategies.strategyNotFound", "Strategy not found"),
        );
      }
      const strategy =
        existing ??
        strategyRepo.create({ userId, name: DEFAULT_STRATEGY_NAME });

      if (dto.name !== undefined) {
        const trimmed = dto.name.trim();
        if (trimmed.length > 0) strategy.name = trimmed;
      }
      if (dto.cadence !== undefined) strategy.cadence = dto.cadence;
      if (dto.lookbackMonths !== undefined) {
        strategy.lookbackMonths = dto.lookbackMonths;
      }
      if (dto.taxRatePercent !== undefined) {
        strategy.taxRatePercent = dto.taxRatePercent;
      }
      if (dto.commissionAmount !== undefined) {
        strategy.commissionAmount = dto.commissionAmount;
      }
      if (dto.rulesSourceUrl !== undefined) {
        // The same normalisation payees, securities and institutions apply: a
        // blank field clears the column instead of storing `""`, and a
        // schemeless host gets `https://` so the stored value is a URL anyone
        // can follow. The report's own link defends itself, but an API consumer
        // reading this column sees whatever was stored.
        strategy.rulesSourceUrl = normalizeWebsite(dto.rulesSourceUrl) ?? null;
      }
      if (dto.rulesSourceLabel !== undefined) {
        strategy.rulesSourceLabel = dto.rulesSourceLabel;
      }
      const saved = await strategyRepo.save(strategy);

      // Accounts are replaced wholesale: the form always sends the full set, so
      // an account left out of it is one the user removed from the strategy.
      if (dto.accountIds) {
        const accountRepo = manager.getRepository(GemStrategyAccount);
        const wanted = [...new Set(dto.accountIds)];
        const existingLinks = await accountRepo.find({
          where: { strategyId: saved.id },
        });
        const removed = existingLinks.filter(
          (link) => !wanted.includes(link.accountId),
        );
        if (removed.length > 0) await accountRepo.remove(removed);
        const kept = new Set(existingLinks.map((link) => link.accountId));
        const added = wanted
          .filter((accountId) => !kept.has(accountId))
          .map((accountId) =>
            accountRepo.create({ userId, strategyId: saved.id, accountId }),
          );
        if (added.length > 0) await accountRepo.save(added);
      }

      if (dto.assets) {
        const assetRepo = manager.getRepository(GemStrategyAsset);
        const stored = await assetRepo.find({
          where: { strategyId: saved.id },
        });
        const byRole = new Map(stored.map((asset) => [asset.role, asset]));
        // A role appears at most once. Sending it twice would insert a second
        // row and hit the (strategy_id, role) unique index; the last value the
        // caller sent is the one they meant.
        const incomingByRole = new Map(
          dto.assets.map((asset) => [asset.role, asset]),
        );
        for (const incoming of incomingByRole.values()) {
          const asset =
            byRole.get(incoming.role) ??
            assetRepo.create({
              userId,
              strategyId: saved.id,
              role: incoming.role,
            });
          asset.securityId = incoming.securityId ?? null;
          await assetRepo.save(asset);
        }
      }

      const assigned = await manager.getRepository(GemStrategyAsset).find({
        where: { strategyId: saved.id },
        select: { securityId: true },
      });
      return {
        id: saved.id,
        lookbackMonths: saved.lookbackMonths,
        cadence: saved.cadence,
        securityIds: assigned
          .map((asset) => asset.securityId)
          .filter((id): id is string => !!id),
      };
    });

    // Assigning the last role is the moment the strategy can produce a signal,
    // so fetch any history the instruments are missing before evaluating --
    // otherwise a just-created security leaves the first signal waiting on a
    // background job the user cannot see. Outside the transaction: this talks
    // to the quote provider.
    await this.backfillService.ensureHistory(
      userId,
      configured.securityIds,
      configured.lookbackMonths,
      configured.cadence,
    );

    return this.getReport(userId, range, configured.id);
  }

  /**
   * Start a new scenario. Nothing is copied from an existing one: a scenario
   * exists to differ, and the settings form is where it is made to.
   */
  async createStrategy(
    userId: string,
    name: string | undefined,
    range: GemRange = "1Y",
  ): Promise<GemStrategyReportView> {
    const created = await withScopedDb(this.dataSource, async (manager) => {
      const repo = manager.getRepository(GemStrategy);
      const trimmed = name?.trim();
      return repo.save(
        repo.create({
          userId,
          name: trimmed && trimmed.length > 0 ? trimmed : DEFAULT_STRATEGY_NAME,
        }),
      );
    });
    return this.getReport(userId, range, created.id);
  }

  /**
   * Delete a scenario, with its role assignments, account links and evaluation
   * history -- all of which cascade from the row. Returns the report for
   * whatever scenario is left, or the unconfigured one when none is.
   */
  async removeStrategy(
    userId: string,
    strategyId: string,
    range: GemRange = "1Y",
  ): Promise<GemStrategyReportView> {
    await withScopedDb(this.dataSource, async (manager) => {
      // Same lock, same ordering as materialization and the settings save.
      //
      // Without it a delete could commit in the window between a materializer
      // reloading the strategy and its first insert: the insert then hits a
      // foreign key that is gone, the whole report transaction aborts, and the
      // user refreshing one tab while deleting a scenario in another gets a
      // 500. Taking it before the existence check also means the check is made
      // against a settled world rather than a snapshot.
      await lockGemStrategy(manager, strategyId);
      const repo = manager.getRepository(GemStrategy);
      const strategy = await repo.findOne({
        where: { id: strategyId, userId },
      });
      if (!strategy) {
        throw new NotFoundException(
          tr("errors.strategies.strategyNotFound", "Strategy not found"),
        );
      }
      await repo.remove(strategy);
    });
    return this.getReport(userId, range);
  }

  /** Record that the current operation was carried out, then re-read the report. */
  async markExecuted(
    userId: string,
    signalId: string,
    range: GemRange = "1Y",
    strategyId?: string,
  ): Promise<GemStrategyReportView> {
    // The expectation goes *in*, so the mismatch is decided inside the
    // transaction and before the write. Checking the returned id here left the
    // row already marked by the time the conflict was raised: the client saw a
    // failure and the database recorded a completed operation.
    const owningStrategyId = await this.signalService.markExecuted(
      userId,
      signalId,
      strategyId,
    );
    if (owningStrategyId === GEM_SIGNAL_STRATEGY_MISMATCH) {
      // The client named a scenario and the signal belongs to another one: its
      // report and its selection have drifted apart, so neither answer is
      // safe. Nothing was written.
      throw new ConflictException(
        tr(
          "errors.strategies.signalStrategyMismatch",
          "That signal belongs to a different strategy.",
        ),
      );
    }
    if (!owningStrategyId) {
      throw new NotFoundException(
        tr("errors.strategies.signalNotFound", "Strategy signal not found"),
      );
    }
    // The signal's own strategy, never the requested one: the report that comes
    // back is always the report of what was just marked.
    return this.getReport(userId, range, owningStrategyId);
  }
}
