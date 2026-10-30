import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import { DataSource, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { MonteCarloCashFlow } from "./entities/monte-carlo-cash-flow.entity";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import { UpdateScenarioDto } from "./dto/update-scenario.dto";
import { RunScenarioDto } from "./dto/run-scenario.dto";
import { CashFlowDto, MAX_SCENARIO_CASH_FLOWS } from "./dto/cash-flow.dto";
import {
  CashFlowSpec,
  MonteCarloSimulationService,
} from "./monte-carlo-simulation.service";
import { SimulationResult } from "./dto/simulation-result.dto";
import { PortfolioService } from "../securities/portfolio.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import { Account } from "../accounts/entities/account.entity";
import { todayYMD } from "../common/date-utils";
import { roundMoney } from "../common/round.util";
import { resolveUserDefaultCurrency } from "../common/default-currency.util";
import { loadPriceSeries } from "../common/time-series/price-series.util";
import {
  buildRateIndex,
  convertAtDate,
} from "../common/time-series/rate-index.util";
import {
  BOUNDARY_LAG_DAYS,
  daysBetween,
} from "../common/time-series/price-boundary.util";

export interface HistoricalStats {
  /** Number of full calendar years of data used to compute the stats. */
  yearsObserved: number;
  /** Annualized arithmetic mean return, decimal (0.07 = 7%). null if not enough data. */
  meanReturn: number | null;
  /** Sample standard deviation of annual returns. null if not enough data. */
  volatility: number | null;
  /**
   * False when the historical mean/volatility could not be computed over the
   * whole selected portfolio -- a held security had no current price, or its
   * value could not be converted into one common currency for weighting.
   *
   * When false, `meanReturn` and `volatility` are `null`: a return computed over
   * the priced, convertible subset is not the selected portfolio's return, and
   * the review's mixed-currency example turned a balanced 0% mix into -20%
   * (recheck RR5-003).
   */
  returnsComplete: boolean;
  /** `"JPY->USD"` for each holding value that could not be converted for weighting. */
  missingRatePairs: string[];
  /** Securities held with no current price, so they could not be weighted. */
  unpricedSecurityIds: string[];
  /**
   * Securities held but excluded from weighting for a reason other than a
   * missing price or rate: a net short position (a long-only value weighting
   * cannot represent a negative weight) or a security whose currency is
   * unknown. Either one makes the statistic incomplete (review #1132).
   */
  unweightableSecurityIds: string[];
  /**
   * True when the current portfolio value itself could not be determined (the
   * summary failed or was incomplete), so the idle-cash weight is unknown and
   * the statistics are withheld for that reason. Any missing currency pair the
   * summary named is in `missingRatePairs`.
   */
  portfolioValueUnknown: boolean;
  /**
   * Aggregate current market value of the selected accounts in the user's
   * default currency, or `null` when it could not be determined.
   *
   * `null` and `0` are different answers: zero means the accounts hold nothing,
   * `null` means the valuation failed (a price or exchange rate was missing, or
   * the portfolio summary threw). This used to be a non-null number with a
   * hard-coded 0 on failure, so a form could offer to start a simulation from a
   * fabricated empty portfolio (audit P5-010).
   */
  currentBalance: number | null;
}

export interface HoldingStat {
  symbol: string;
  name: string;
  /** `null` when the security carries no currency: unknown, not a default. */
  currencyCode: string | null;
  quantity: number;
  /**
   * Current market value, or `null` when the security has no current price.
   *
   * `null` and `0` are different answers, and this was `0`: the same report that
   * correctly refuses an incomplete starting value simultaneously told the user an
   * unpriced 10-share holding was worth nothing (recheck RR4-004). A held position
   * with no quote is unknown.
   */
  marketValue: number | null;
  yearsObserved: number;
  meanReturn: number | null;
  volatility: number | null;
}

export interface AccountHoldingStats {
  accountId: string;
  accountName: string;
  currencyCode: string;
  holdings: HoldingStat[];
}

@Injectable()
export class MonteCarloService {
  private readonly logger = new Logger(MonteCarloService.name);

  constructor(
    private simulationService: MonteCarloSimulationService,
    private portfolioService: PortfolioService,
    private securityPriceService: SecurityPriceService,
    private exchangeRateService: ExchangeRateService,
    private dataSource: DataSource,
  ) {}

  async create(
    userId: string,
    dto: CreateScenarioDto,
  ): Promise<MonteCarloScenario> {
    assertCashFlowCount(dto.cashFlows);
    const saved = await withScopedDb(this.dataSource, (m) => {
      const repo = m.getRepository(MonteCarloScenario);
      const scenario = repo.create({
        userId,
        name: dto.name,
        description: dto.description ?? null,
        accountIds: dto.accountIds,
        startingValue: dto.startingValue,
        useCurrentBalance: dto.useCurrentBalance,
        yearsToRetirement: dto.yearsToRetirement,
        annualContribution: dto.annualContribution,
        contributionGrowthRate: dto.contributionGrowthRate,
        yearsInRetirement: dto.yearsInRetirement,
        annualWithdrawal: dto.annualWithdrawal,
        expectedReturn: dto.expectedReturn,
        volatility: dto.volatility,
        inflationRate: dto.inflationRate,
        showRealValues: dto.showRealValues,
        useHistoricalReturns: dto.useHistoricalReturns,
        simulationCount: dto.simulationCount,
        targetValue: dto.targetValue ?? null,
        randomSeed: dto.randomSeed ?? null,
      });
      return repo.save(scenario);
    });
    await this.replaceCashFlows(saved.id, dto.cashFlows);
    return this.findOne(userId, saved.id);
  }

  async findAll(userId: string): Promise<MonteCarloScenario[]> {
    const scenarios = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonteCarloScenario).find({
        where: { userId },
        relations: ["cashFlows"],
        order: { isFavourite: "DESC", sortOrder: "ASC", updatedAt: "DESC" },
      }),
    );
    for (const s of scenarios) {
      if (s.cashFlows) {
        s.cashFlows.sort((a, b) => a.sortOrder - b.sortOrder);
      }
    }
    return scenarios;
  }

  async findOne(userId: string, id: string): Promise<MonteCarloScenario> {
    const scenario = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonteCarloScenario).findOne({
        where: { id, userId },
        relations: ["cashFlows"],
      }),
    );
    if (!scenario) {
      throw new NotFoundException(
        tr("errors.monteCarlo.scenarioNotFound", `Scenario ${id} not found`, {
          id,
        }),
      );
    }
    if (scenario.cashFlows) {
      scenario.cashFlows.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    return scenario;
  }

  /**
   * Replace the cash-flow list on a scenario (delete-all + insert pattern,
   * since clients send the full list each time). Skipped when `flows` is
   * undefined so partial PATCH calls don't wipe the list accidentally.
   */
  private async replaceCashFlows(
    scenarioId: string,
    flows: CashFlowDto[] | undefined,
  ): Promise<void> {
    if (flows === undefined) return;
    await withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(MonteCarloCashFlow);
      await repo.delete({ scenarioId });
      if (flows.length === 0) return;
      const rows = flows.map((cf, idx) =>
        repo.create({
          scenarioId,
          name: cf.name,
          amount: cf.amount,
          flowType: cf.flowType,
          startYear: cf.startYear,
          endYear: cf.endYear ?? null,
          inflationAdjust: cf.inflationAdjust,
          sortOrder: idx,
        }),
      );
      await repo.save(rows);
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateScenarioDto,
  ): Promise<MonteCarloScenario> {
    assertCashFlowCount(dto.cashFlows);
    const scenario = await this.findOne(userId, id);

    // Explicit property mapping (no Object.assign — prevents mass assignment).
    if (dto.name !== undefined) scenario.name = dto.name;
    if (dto.description !== undefined)
      scenario.description = dto.description ?? null;
    if (dto.accountIds !== undefined) scenario.accountIds = dto.accountIds;
    if (dto.startingValue !== undefined)
      scenario.startingValue = dto.startingValue;
    if (dto.useCurrentBalance !== undefined)
      scenario.useCurrentBalance = dto.useCurrentBalance;
    if (dto.yearsToRetirement !== undefined)
      scenario.yearsToRetirement = dto.yearsToRetirement;
    if (dto.annualContribution !== undefined)
      scenario.annualContribution = dto.annualContribution;
    if (dto.contributionGrowthRate !== undefined)
      scenario.contributionGrowthRate = dto.contributionGrowthRate;
    if (dto.yearsInRetirement !== undefined)
      scenario.yearsInRetirement = dto.yearsInRetirement;
    if (dto.annualWithdrawal !== undefined)
      scenario.annualWithdrawal = dto.annualWithdrawal;
    if (dto.expectedReturn !== undefined)
      scenario.expectedReturn = dto.expectedReturn;
    if (dto.volatility !== undefined) scenario.volatility = dto.volatility;
    if (dto.inflationRate !== undefined)
      scenario.inflationRate = dto.inflationRate;
    if (dto.showRealValues !== undefined)
      scenario.showRealValues = dto.showRealValues;
    if (dto.useHistoricalReturns !== undefined)
      scenario.useHistoricalReturns = dto.useHistoricalReturns;
    if (dto.simulationCount !== undefined)
      scenario.simulationCount = dto.simulationCount;
    if (dto.targetValue !== undefined)
      scenario.targetValue = dto.targetValue ?? null;
    if (dto.randomSeed !== undefined)
      scenario.randomSeed = dto.randomSeed ?? null;
    if (dto.isFavourite !== undefined) scenario.isFavourite = dto.isFavourite;

    const saved = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonteCarloScenario).save(scenario),
    );
    await this.replaceCashFlows(saved.id, dto.cashFlows);
    return this.findOne(userId, saved.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const scenario = await this.findOne(userId, id);
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonteCarloScenario).remove(scenario),
    );
  }

  async reorder(userId: string, scenarioIds: string[]): Promise<void> {
    // Defensive: reject anything that isn't a proper array. The DTO validates
    // this via @IsArray + @ArrayMaxSize, but we re-check here so the invariant
    // holds for any caller (mirrors AccountsService.reorderFavourites).
    if (!Array.isArray(scenarioIds)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeArray",
          'The value of "scenarioIds" must be an array',
          { param: "scenarioIds" },
        ),
      );
    }
    await withScopedDb(this.dataSource, async (m) => {
      // for...of over .entries(), never `i < scenarioIds.length`: a request
      // value's .length must not bound a loop inside this closure (CWE-834,
      // CodeQL js/loop-bound-injection cannot see the isArray guard above
      // through the withScopedDb callback).
      for (const [i, scenarioId] of scenarioIds.entries()) {
        await m.update(
          MonteCarloScenario,
          { id: scenarioId, userId },
          { sortOrder: i },
        );
      }
    });
  }

  async runSaved(userId: string, id: string): Promise<SimulationResult> {
    const scenario = await this.findOne(userId, id);
    // A stored list is not bounded by the DTO: rows written before the cap,
    // or restored from a backup, can exceed it. Refuse before any work.
    assertCashFlowCount(scenario.cashFlows);

    const startingValue =
      scenario.useCurrentBalance && scenario.accountIds.length > 0
        ? this.requireCurrentValue(
            await this.computeCurrentValue(userId, scenario.accountIds),
          )
        : scenario.startingValue;

    const { expectedReturn, volatility } = await this.resolveReturns(
      userId,
      scenario.accountIds,
      scenario.useHistoricalReturns,
      scenario.expectedReturn,
      scenario.volatility,
    );

    const result = this.simulationService.run({
      startingValue,
      yearsToRetirement: scenario.yearsToRetirement,
      annualContribution: scenario.annualContribution,
      contributionGrowthRate: scenario.contributionGrowthRate,
      yearsInRetirement: scenario.yearsInRetirement,
      annualWithdrawal: scenario.annualWithdrawal,
      expectedReturn,
      volatility,
      inflationRate: scenario.inflationRate,
      showRealValues: scenario.showRealValues,
      simulationCount: scenario.simulationCount,
      targetValue: scenario.targetValue,
      randomSeed: scenario.randomSeed,
      cashFlows: (scenario.cashFlows ?? []).map(toCashFlowSpec),
    });

    scenario.lastRunAt = new Date();
    await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonteCarloScenario).save(scenario),
    );

    return result;
  }

  async runAdHoc(
    userId: string,
    dto: RunScenarioDto,
  ): Promise<SimulationResult> {
    assertCashFlowCount(dto.cashFlows);
    const startingValue =
      dto.useCurrentBalance && dto.accountIds.length > 0
        ? this.requireCurrentValue(
            await this.computeCurrentValue(userId, dto.accountIds),
          )
        : dto.startingValue;

    const { expectedReturn, volatility } = await this.resolveReturns(
      userId,
      dto.accountIds,
      dto.useHistoricalReturns,
      dto.expectedReturn,
      dto.volatility,
    );

    return this.simulationService.run({
      startingValue,
      yearsToRetirement: dto.yearsToRetirement,
      annualContribution: dto.annualContribution,
      contributionGrowthRate: dto.contributionGrowthRate,
      yearsInRetirement: dto.yearsInRetirement,
      annualWithdrawal: dto.annualWithdrawal,
      expectedReturn,
      volatility,
      inflationRate: dto.inflationRate,
      showRealValues: dto.showRealValues,
      simulationCount: dto.simulationCount,
      targetValue: dto.targetValue,
      randomSeed: dto.randomSeed,
      cashFlows: (dto.cashFlows ?? []).map(toCashFlowSpec),
    });
  }

  /**
   * If `useHistorical` is true, substitute the computed mean/volatility for
   * the supplied values -- or refuse the run when they cannot be computed.
   *
   * Refuse, never substitute: this used to fall back silently to the manually
   * entered figures, so a run the user configured as "use historical returns"
   * proceeded on a stale form default with nothing in the result saying so
   * (review #1132). The starting value already refuses this way
   * (`requireCurrentValue`); the return assumptions the same run consumes get
   * the same treatment.
   */
  private async resolveReturns(
    userId: string,
    accountIds: string[],
    useHistorical: boolean,
    manualReturn: number,
    manualVolatility: number,
  ): Promise<{ expectedReturn: number; volatility: number }> {
    if (!useHistorical || accountIds.length === 0) {
      return { expectedReturn: manualReturn, volatility: manualVolatility };
    }
    const stats = await this.getHistoricalStats(userId, accountIds);
    if (stats.meanReturn === null || stats.volatility === null) {
      throw new BadRequestException(
        tr(
          "errors.monteCarlo.historicalReturnsUnavailable",
          "Historical returns for the selected accounts could not be computed, so a simulation cannot use them. Enter an expected return and volatility manually, or retry once prices and exchange rates are available.",
        ),
      );
    }
    return {
      expectedReturn: stats.meanReturn,
      volatility: stats.volatility,
    };
  }

  /** Brokerage and standalone investment accounts only — what UIs that drive
   * holdings-based simulations should show in their account picker. */
  async getBrokerageAccounts(userId: string) {
    return this.portfolioService.getBrokerageAccounts(userId);
  }

  /**
   * Annualized mean return and stdev for the selected accounts' *current mix*,
   * to prefill the "Use historical" form.
   *
   * Methodology (the comment used to describe a money-weighted transaction-history
   * backtest this method never implemented -- recheck DOC5-01): take each
   * currently held security's per-year return from its year-end price series, and
   * combine them each year weighted by the security's current market value. The
   * weights are converted into one common currency first (recheck RR5-003), and
   * the whole thing is refused -- null mean/volatility -- when any held security
   * cannot be priced or converted, because a return over a subset of the holdings
   * is not the portfolio's return.
   *
   * Returns null mean/volatility when there are fewer than 2 full years, or when
   * the weighting set is incomplete.
   */
  async getHistoricalStats(
    userId: string,
    accountIds: string[],
  ): Promise<HistoricalStats> {
    if (accountIds.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.monteCarlo.atLeastOneAccountRequired",
          "At least one accountId is required",
        ),
      );
    }

    // Verify the requested accounts belong to the user before running queries
    // that don't carry their own userId clause -- the Holding query below
    // filters on accountId alone, so without this a caller could read another
    // user's return statistics by supplying their account ids (review #1132;
    // getHoldingStats has carried the same guard from the start).
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(accountIds), userId },
      }),
    );
    const ownedIds = accounts.map((a) => a.id);
    if (ownedIds.length === 0) {
      // None of the requested accounts exist for this user, so their selection
      // holds nothing of theirs: a known-empty answer, not a failed valuation.
      return {
        yearsObserved: 0,
        meanReturn: null,
        volatility: null,
        returnsComplete: true,
        missingRatePairs: [],
        unpricedSecurityIds: [],
        unweightableSecurityIds: [],
        portfolioValueUnknown: false,
        currentBalance: 0,
      };
    }

    const current = await this.computeCurrentSummary(userId, ownedIds);
    const currentBalance = current.value;

    // Build a value-weighted series of yearly returns from the price history
    // of currently held securities. This answers "what would my current mix
    // have returned year-over-year", which is what users expect when they
    // pick 'Use historical' on this report.
    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(ownedIds) },
        relations: ["security"],
      }),
    );
    const active = holdings.filter(
      (h) => Math.abs(Number(h.quantity)) > 0.0001,
    );
    if (active.length === 0) {
      return {
        yearsObserved: 0,
        meanReturn: null,
        volatility: null,
        returnsComplete: true,
        missingRatePairs: [],
        unpricedSecurityIds: [],
        unweightableSecurityIds: [],
        portfolioValueUnknown: false,
        currentBalance,
      };
    }

    const securityIds = [...new Set(active.map((h) => h.securityId))];
    const closesBySecurity =
      await this.fetchYearEndClosesBySecurity(securityIds);

    // Weight each security by its current market value in ONE common currency.
    // Weighting by raw native price summed USD, JPY and EUR amounts as though the
    // units matched, and dropped an unpriced holding without recording it -- both
    // silently changed the expected return the simulation ran on (recheck
    // RR5-003). Value each holding here (an unpriced one is unknown, not zero),
    // then convert every value into one currency through the shared resolver.
    const currentPrices =
      await this.portfolioService.getLatestPrices(securityIds);
    const nativeValues: Array<{
      securityId: string;
      currencyCode: string;
      nativeValue: number;
    }> = [];
    const unpricedSecurityIds = new Set<string>();
    const unweightableSecurityIds = new Set<string>();
    const currencyBySecurity = new Map<string, string>();
    for (const h of active) {
      const price = currentPrices.get(h.securityId);
      if (price == null) {
        unpricedSecurityIds.add(h.securityId);
        continue;
      }
      // A holding whose security relation carries no currency cannot be
      // converted for weighting. Fabricating "USD" here converted a JPY value
      // at the USD rate -- a silent FX fallback in the exact path this
      // refusal exists for (review #1132). An unknown currency joins the
      // refusal like an unknown price does.
      const currencyCode = h.security?.currencyCode;
      if (!currencyCode) {
        unweightableSecurityIds.add(h.securityId);
        continue;
      }
      currencyBySecurity.set(h.securityId, currencyCode);
      nativeValues.push({
        securityId: h.securityId,
        currencyCode,
        nativeValue: Number(h.quantity) * price,
      });
    }

    const converted =
      await this.portfolioService.convertSecurityValuesToDefault(
        userId,
        nativeValues,
      );
    const weightBySec = converted.valueBySecurity;

    // A net short position has a negative current value, which a long-only
    // value weighting cannot represent -- dropping it silently would make the
    // long subset stand in for the portfolio (review #1132). Refuse instead.
    // A net-zero position genuinely holds nothing and is excluded from the
    // weights below without making the statistic incomplete.
    for (const [secId, w] of weightBySec) {
      if (w < 0) {
        unweightableSecurityIds.add(secId);
      }
    }

    const weightedSecIds = [...weightBySec.entries()]
      .filter(([, w]) => w > 0)
      .map(([id]) => id);

    // Each year-end close is converted at the rate of its own date, so a
    // return is the one a holder in the default currency earned; a native
    // return weighted by default-currency values is neither.
    const defaultCurrency = await resolveUserDefaultCurrency(
      this.dataSource,
      userId,
    );
    const missingFxPairs = new Set<string>();
    // Every pair's rates load once, then each close resolves in memory.
    const foreignCurrencies = new Set<string>();
    let earliestClose: string | null = null;
    for (const secId of weightedSecIds) {
      const currency = currencyBySecurity.get(secId);
      if (!currency || currency === defaultCurrency) continue;
      for (const c of closesBySecurity.get(secId) ?? []) {
        foreignCurrencies.add(currency);
        if (earliestClose === null || c.date < earliestClose) {
          earliestClose = c.date;
        }
      }
    }
    const loadRateIndex = () =>
      withScopedDb(this.dataSource, (m) =>
        buildRateIndex(
          (sql, params) => m.query(sql, params),
          foreignCurrencies,
          defaultCurrency,
          earliestClose ?? todayYMD(),
          todayYMD(),
        ),
      );
    // A close that cannot convert is a gap for that security alone: it is
    // dropped, and `toYearlyReturns` skips the two returns that touch it.
    const convertAll = (
      rateIndex: Awaited<ReturnType<typeof loadRateIndex>>,
    ) => {
      const returns = new Map<string, Map<number, number>>();
      const gaps: Array<{ secId: string; pair: string; date: string }> = [];
      for (const secId of weightedSecIds) {
        const currency = currencyBySecurity.get(secId);
        if (!currency) continue;
        const closes: YearEndClose[] = [];
        for (const c of closesBySecurity.get(secId) ?? []) {
          const price =
            currency === defaultCurrency
              ? c.price
              : convertAtDate(
                  c.price,
                  currency,
                  defaultCurrency,
                  c.date,
                  rateIndex,
                  this.logger,
                );
          if (price === null) {
            gaps.push({
              secId,
              pair: `${currency}->${defaultCurrency}`,
              date: c.date,
            });
            continue;
          }
          closes.push({ ...c, price });
        }
        returns.set(secId, toYearlyReturns(closes));
      }
      return { returns, gaps };
    };
    let { returns: yearlyReturns, gaps } = convertAll(await loadRateIndex());
    if (gaps.length > 0) {
      // Fetch first, as the other read paths do: ask the history backfill for
      // each missing pair's month, then convert again from what is stored.
      const datesByPair = new Map<string, Set<string>>();
      for (const g of gaps) {
        const dates = datesByPair.get(g.pair) ?? new Set<string>();
        dates.add(g.date);
        datesByPair.set(g.pair, dates);
      }
      let loaded = 0;
      for (const [pair, dates] of datesByPair) {
        const [from, to] = pair.split("->");
        for (const date of dates) {
          try {
            loaded += await this.exchangeRateService.ensureRatesForDate(
              [{ from, to }],
              date,
            );
          } catch (error) {
            this.logger.warn(
              `Historical rate fetch ${pair} for ${date} failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      if (loaded > 0) {
        ({ returns: yearlyReturns, gaps } = convertAll(await loadRateIndex()));
      }
    }
    // The stats are withheld only when a gap leaves a security with fewer
    // yearly returns than the statistic needs; a smaller gap is a warning.
    const gapPairsBySecurity = new Map<string, Set<string>>();
    for (const g of gaps) {
      const pairs = gapPairsBySecurity.get(g.secId) ?? new Set<string>();
      pairs.add(g.pair);
      gapPairsBySecurity.set(g.secId, pairs);
    }
    for (const [secId, pairs] of gapPairsBySecurity) {
      if ((yearlyReturns.get(secId)?.size ?? 0) < MIN_YEARLY_RETURNS) {
        for (const pair of pairs) missingFxPairs.add(pair);
      } else {
        this.logger.warn(
          `Historical stats skip year-end closes of ${secId} with no ${[...pairs].join(", ")} rate`,
        );
      }
    }
    // A failed or incomplete summary leaves the cash weight unknown; name the
    // pairs it could not convert (a cash balance in a currency with no rate)
    // and flag the failure itself, so the withheld statistics have a reason.
    const portfolioValueUnknown = current.value === null;
    const missingRatePairs = [
      ...new Set([
        ...converted.missingRatePairs,
        ...missingFxPairs,
        ...current.missingRatePairs,
      ]),
    ].sort();

    // Idle cash is part of the starting value and earns nothing: it joins the
    // weights at a 0% return. An unknown cash balance is not zero cash.
    const cashWeight =
      current.cash !== null && Number.isFinite(current.cash)
        ? Math.max(0, current.cash)
        : null;

    // A return over the priced, convertible subset is not the selected
    // portfolio's return. If any active holding could not be weighted, the
    // mean/volatility are unknown, not the subset's.
    if (
      unpricedSecurityIds.size > 0 ||
      missingRatePairs.length > 0 ||
      unweightableSecurityIds.size > 0 ||
      cashWeight === null
    ) {
      this.logger.warn(
        `Historical stats for accounts ${ownedIds.join(",")} omit holdings that could not be weighted (${[
          ...missingRatePairs,
          ...[...unpricedSecurityIds].map((id) => `unpriced:${id}`),
          ...[...unweightableSecurityIds].map(
            (id) => `unweightable:${id} (short or unknown currency)`,
          ),
        ].join(", ")}); reporting mean/volatility as unavailable`,
      );
      return {
        yearsObserved: 0,
        meanReturn: null,
        volatility: null,
        returnsComplete: false,
        missingRatePairs,
        unpricedSecurityIds: [...unpricedSecurityIds].sort(),
        unweightableSecurityIds: [...unweightableSecurityIds].sort(),
        portfolioValueUnknown,
        currentBalance,
      };
    }

    // Compute portfolio yearly returns by combining per-security returns
    // weighted by current value.
    //
    // Only years where EVERY weighted security has a return are used. The old
    // shape renormalized each year over whichever securities had data for it,
    // so a year missing one holding's prices was reported as the return of the
    // rest -- a subset statistic under `returnsComplete: true` (review #1132).
    // A year with partial coverage is not the portfolio's year; skipping it
    // shrinks `yearsObserved` honestly, and the provider backfill above keeps
    // the window from shrinking for securities that merely lacked local rows.
    const allYears = new Set<number>();
    for (const id of weightedSecIds) {
      for (const y of yearlyReturns.get(id)?.keys() ?? []) allYears.add(y);
    }

    const portfolioReturns: number[] = [];
    for (const year of [...allYears].sort()) {
      let weightedReturn = 0;
      let totalWeight = cashWeight;
      let complete = true;
      for (const secId of weightedSecIds) {
        const r = yearlyReturns.get(secId)?.get(year);
        if (r === undefined) {
          complete = false;
          break;
        }
        const w = weightBySec.get(secId)!;
        weightedReturn += r * w;
        totalWeight += w;
      }
      if (complete && totalWeight > 0) {
        portfolioReturns.push(weightedReturn / totalWeight);
      }
    }

    if (portfolioReturns.length < MIN_YEARLY_RETURNS) {
      return {
        yearsObserved: portfolioReturns.length,
        meanReturn: null,
        volatility: null,
        // The weighting set was complete; there simply is not enough history.
        returnsComplete: true,
        missingRatePairs: [],
        unpricedSecurityIds: [],
        unweightableSecurityIds: [],
        portfolioValueUnknown: false,
        currentBalance,
      };
    }

    const mean =
      portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
    const variance =
      portfolioReturns.reduce((a, r) => a + (r - mean) ** 2, 0) /
      (portfolioReturns.length - 1);
    const stdev = Math.sqrt(variance);

    return {
      yearsObserved: portfolioReturns.length,
      meanReturn: Math.round(mean * 1_000_000) / 1_000_000,
      volatility: Math.round(stdev * 1_000_000) / 1_000_000,
      returnsComplete: true,
      missingRatePairs: [],
      unpricedSecurityIds: [],
      unweightableSecurityIds: [],
      portfolioValueUnknown: false,
      currentBalance,
    };
  }

  /**
   * Per-holding stats grouped by account. Used to show users what historical
   * returns/volatility they're picking up when "Use historical returns" is on.
   */
  async getHoldingStats(
    userId: string,
    accountIds: string[],
  ): Promise<AccountHoldingStats[]> {
    if (accountIds.length === 0) {
      throw new BadRequestException(
        tr(
          "errors.monteCarlo.atLeastOneAccountRequired",
          "At least one accountId is required",
        ),
      );
    }

    // Verify the requested accounts belong to the user before running queries
    // that don't carry their own userId clause.
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { id: In(accountIds), userId },
      }),
    );
    if (accounts.length === 0) return [];

    const holdings = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Holding).find({
        where: { accountId: In(accounts.map((a) => a.id)) },
        relations: ["security"],
      }),
    );
    const active = holdings.filter(
      (h) => Math.abs(Number(h.quantity)) > 0.0001,
    );
    if (active.length === 0) {
      return accounts.map((a) => ({
        accountId: a.id,
        accountName: a.name,
        currencyCode: a.currencyCode,
        holdings: [],
      }));
    }

    const securityIds = [...new Set(active.map((h) => h.securityId))];
    const closesBySecurity =
      await this.fetchYearEndClosesBySecurity(securityIds);
    const currentPrices =
      await this.portfolioService.getLatestPrices(securityIds);

    const grouped = new Map<string, HoldingStat[]>();
    for (const a of accounts) grouped.set(a.id, []);

    for (const h of active) {
      if (!grouped.has(h.accountId)) continue;
      const series = [
        ...toYearlyReturns(closesBySecurity.get(h.securityId) ?? []).values(),
      ];
      const stats = computeMeanStdev(series);
      const price = currentPrices.get(h.securityId);
      grouped.get(h.accountId)!.push({
        symbol: h.security?.symbol ?? "?",
        name: h.security?.name ?? "Unknown",
        currencyCode: h.security?.currencyCode || null,
        quantity: Number(h.quantity),
        marketValue:
          price == null ? null : roundMoney(Number(h.quantity) * price),
        yearsObserved: series.length,
        meanReturn: stats.mean,
        volatility: stats.stdev,
      });
    }

    return accounts.map((a) => ({
      accountId: a.id,
      accountName: a.name,
      currencyCode: a.currencyCode,
      holdings: (grouped.get(a.id) ?? []).sort(
        // Unpriced holdings sort last: an unknown value cannot be compared with a
        // known one, and putting them at 0 would bury them among genuinely empty
        // positions.
        (x, y) => (y.marketValue ?? -Infinity) - (x.marketValue ?? -Infinity),
      ),
    }));
  }

  /**
   * Fetch year-end closing prices for the given securities and convert to
   * per-year returns. Returned map: securityId → Map<year, return>.
   */
  /** Skip provider backfill for any security we've asked about within this
   * window. Prevents the Monte Carlo report from re-hitting Yahoo / MSN on
   * every account-selection change for holdings whose history simply doesn't
   * span the full 10-year window. */
  private static BACKFILL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

  private async fetchYearEndClosesBySecurity(
    securityIds: string[],
  ): Promise<Map<string, YearEndClose[]>> {
    if (securityIds.length === 0) return new Map();

    let closes = await this.queryYearEndCloses(securityIds);

    // For securities with fewer than 10 yearly returns we backfill from the
    // provider — typically newer holdings whose local price history doesn't
    // yet span the full window we want for stable mean/volatility estimates.
    const sparseIds = securityIds.filter(
      (id) => toYearlyReturns(closes.get(id) ?? []).size < 10,
    );
    if (sparseIds.length === 0) return closes;

    const securities = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Security).find({
        where: { id: In(sparseIds) },
      }),
    );
    const now = Date.now();
    const dueForBackfill = securities.filter((s) => {
      const last = s.historicalBackfillAttemptedAt;
      if (!last) return true;
      const lastMs =
        last instanceof Date ? last.getTime() : Date.parse(String(last));
      return (
        !Number.isFinite(lastMs) ||
        now - lastMs > MonteCarloService.BACKFILL_COOLDOWN_MS
      );
    });

    if (dueForBackfill.length === 0) return closes;

    await Promise.all(
      dueForBackfill.map((s) =>
        this.securityPriceService
          .backfillSecurityRange(s, "10y")
          .catch((err) => {
            this.logger.warn(
              `Provider backfill failed for ${s.symbol}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return 0;
          }),
      ),
    );

    // Stamp every security we attempted, regardless of whether the provider
    // actually returned new rows. The cooldown is about not hammering the
    // API, not about whether the data improved.
    await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Security)
        .update(
          { id: In(dueForBackfill.map((s) => s.id)) },
          { historicalBackfillAttemptedAt: new Date() },
        ),
    );

    closes = await this.queryYearEndCloses(securityIds);
    return closes;
  }

  /**
   * Each security's year-end closes, native currency, oldest first. One price
   * basis per series (`loadPriceSeries`); a year counts only when it is
   * complete (not the current one) and its last close is within
   * `BOUNDARY_LAG_DAYS` of 31 December, so a stale close never stands for the
   * year end.
   */
  private async queryYearEndCloses(
    securityIds: string[],
  ): Promise<Map<string, YearEndClose[]>> {
    const series = await withScopedDb(this.dataSource, (m) =>
      loadPriceSeries(m, {
        table: "security_prices",
        ids: securityIds,
        fromDate: "1900-01-01",
        sampling: "month",
      }),
    );

    const currentYear = new Date().getUTCFullYear();
    const result = new Map<string, YearEndClose[]>();
    for (const [secId, { points }] of series) {
      const lastOfYear = new Map<number, { date: string; price: number }>();
      for (const p of points) {
        lastOfYear.set(Number(p.date.slice(0, 4)), {
          date: p.date,
          price: p.close,
        });
      }
      const closes: YearEndClose[] = [];
      for (const [year, last] of [...lastOfYear].sort((a, b) => a[0] - b[0])) {
        if (
          year < currentYear &&
          daysBetween(last.date, `${year}-12-31`) <= BOUNDARY_LAG_DAYS
        ) {
          closes.push({ year, ...last });
        }
      }
      result.set(secId, closes);
    }
    return result;
  }

  /**
   * The current value of the selected accounts, or `null` when it could not be
   * worked out.
   *
   * `null`, not 0: a failed valuation is unknown, and a simulation started from
   * a fabricated zero opening portfolio produces success rates, percentile bands
   * and safe-withdrawal figures that are mathematically valid and financially
   * meaningless. A user with 100,000 invested got a retirement projection built
   * from nothing, with nothing on screen to say so (audit P5-010).
   *
   * Zero is still returned when the accounts genuinely hold nothing -- that is a
   * known answer, and conflating it with "could not compute" is the other half
   * of the same mistake.
   */
  private async computeCurrentValue(
    userId: string,
    accountIds: string[],
  ): Promise<number | null> {
    return (await this.computeCurrentSummary(userId, accountIds)).value;
  }

  /** `computeCurrentValue`, with the idle-cash part of it alongside. */
  private async computeCurrentSummary(
    userId: string,
    accountIds: string[],
  ): Promise<{
    value: number | null;
    cash: number | null;
    /** Pairs the summary could not convert; empty when it failed outright. */
    missingRatePairs: string[];
  }> {
    const unknown = (missingRatePairs: string[] = []) => ({
      value: null,
      cash: null,
      missingRatePairs,
    });
    try {
      const summary = await this.portfolioService.getPortfolioSummary(
        userId,
        accountIds,
      );
      // An incomplete total is a subtotal, and a subtotal is not a starting
      // portfolio value. This used to check only for a thrown error or a
      // non-finite number, so a portfolio with one unresolvable currency pair
      // handed over a perfectly finite figure short by whatever could not be
      // converted, and the simulation ran from it (review finding FR-005).
      if (!summary.valuationComplete) {
        this.logger.warn(
          `Current portfolio value for accounts ${accountIds.join(",")} is incomplete (${[...summary.missingRatePairs, ...summary.unpricedSecurityIds.map((id) => `unpriced:${id}`)].join(", ")}); reporting it as unavailable`,
        );
        return unknown(summary.missingRatePairs);
      }

      const value = summary.totalPortfolioValue;
      // A non-finite aggregate means some component was unusable, which is a
      // failure to value rather than a value of zero.
      if (!Number.isFinite(value)) {
        this.logger.warn(
          `Current portfolio value for accounts ${accountIds.join(",")} is not finite; reporting it as unavailable`,
        );
        return unknown();
      }
      return {
        value: roundMoney(value),
        cash: summary.totalCashValue,
        missingRatePairs: [],
      };
    } catch (err) {
      this.logger.warn(
        `Failed to compute current portfolio value for accounts ${accountIds.join(",")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return unknown();
    }
  }

  /**
   * The starting value for a run that asked to use current balances, refusing
   * rather than substituting a number nobody computed.
   */
  private requireCurrentValue(value: number | null): number {
    if (value === null) {
      throw new BadRequestException(
        tr(
          "errors.monteCarlo.currentValueUnavailable",
          "The current value of the selected accounts could not be determined, so a simulation cannot start from it. Enter a starting value explicitly, or retry once prices and exchange rates are available.",
        ),
      );
    }
    return value;
  }
}

/** Fewest yearly returns a mean and a sample deviation can be read from. */
const MIN_YEARLY_RETURNS = 2;

interface YearEndClose {
  year: number;
  date: string;
  price: number;
}

/**
 * One-year returns between closes of consecutive calendar years. A missing
 * year is a gap, not a two-year return filed under one year.
 */
function toYearlyReturns(closes: YearEndClose[]): Map<number, number> {
  const returns = new Map<number, number>();
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const curr = closes[i];
    if (curr.year === prev.year + 1 && prev.price > 0) {
      returns.set(curr.year, (curr.price - prev.price) / prev.price);
    }
  }
  return returns;
}

function computeMeanStdev(series: number[]): {
  mean: number | null;
  stdev: number | null;
} {
  if (series.length < 2) return { mean: null, stdev: null };
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance =
    series.reduce((a, r) => a + (r - mean) ** 2, 0) / (series.length - 1);
  return {
    mean: Math.round(mean * 1_000_000) / 1_000_000,
    stdev: Math.round(Math.sqrt(variance) * 1_000_000) / 1_000_000,
  };
}

/**
 * Refuse a cash-flow list longer than `MAX_SCENARIO_CASH_FLOWS`. The DTO holds
 * the same bound for requests; this holds it for every caller, including a
 * saved scenario whose rows never passed through the DTO.
 */
function assertCashFlowCount(flows: readonly unknown[] | undefined): void {
  if (Array.isArray(flows) && flows.length > MAX_SCENARIO_CASH_FLOWS) {
    throw new BadRequestException(
      tr(
        "errors.monteCarlo.tooManyCashFlows",
        `A scenario can have at most ${MAX_SCENARIO_CASH_FLOWS} cash flows`,
        { max: MAX_SCENARIO_CASH_FLOWS },
      ),
    );
  }
}

function toCashFlowSpec(cf: {
  amount: number;
  flowType: string;
  startYear: number;
  endYear?: number | null;
  inflationAdjust: boolean;
}): CashFlowSpec {
  return {
    amount: Number(cf.amount),
    flowType: cf.flowType === "ONE_TIME" ? "ONE_TIME" : "RECURRING",
    startYear: cf.startYear,
    endYear: cf.endYear ?? null,
    inflationAdjust: cf.inflationAdjust,
  };
}
