import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { MonteCarloCashFlow } from "./entities/monte-carlo-cash-flow.entity";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import { UpdateScenarioDto } from "./dto/update-scenario.dto";
import { RunScenarioDto } from "./dto/run-scenario.dto";
import { CashFlowDto } from "./dto/cash-flow.dto";
import {
  CashFlowSpec,
  MonteCarloSimulationService,
} from "./monte-carlo-simulation.service";
import { SimulationResult } from "./dto/simulation-result.dto";
import { PortfolioService } from "../securities/portfolio.service";
import { SecurityPriceService } from "../securities/security-price.service";
import { Holding } from "../securities/entities/holding.entity";
import { Security } from "../securities/entities/security.entity";
import { SecurityPrice } from "../securities/entities/security-price.entity";
import { Account } from "../accounts/entities/account.entity";

export interface HistoricalStats {
  /** Number of full calendar years of data used to compute the stats. */
  yearsObserved: number;
  /** Annualized arithmetic mean return, decimal (0.07 = 7%). null if not enough data. */
  meanReturn: number | null;
  /** Sample standard deviation of annual returns. null if not enough data. */
  volatility: number | null;
  /** Aggregate current market value of the selected accounts in the user's default currency. */
  currentBalance: number;
}

export interface HoldingStat {
  symbol: string;
  name: string;
  currencyCode: string;
  quantity: number;
  marketValue: number;
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
    @InjectRepository(MonteCarloScenario)
    private scenariosRepository: Repository<MonteCarloScenario>,
    @InjectRepository(MonteCarloCashFlow)
    private cashFlowsRepository: Repository<MonteCarloCashFlow>,
    @InjectRepository(Holding)
    private holdingsRepository: Repository<Holding>,
    @InjectRepository(SecurityPrice)
    private securityPriceRepository: Repository<SecurityPrice>,
    @InjectRepository(Account)
    private accountsRepository: Repository<Account>,
    @InjectRepository(Security)
    private securitiesRepository: Repository<Security>,
    private simulationService: MonteCarloSimulationService,
    private portfolioService: PortfolioService,
    private securityPriceService: SecurityPriceService,
  ) {}

  async create(
    userId: string,
    dto: CreateScenarioDto,
  ): Promise<MonteCarloScenario> {
    const scenario = this.scenariosRepository.create({
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
    const saved = await this.scenariosRepository.save(scenario);
    await this.replaceCashFlows(saved.id, dto.cashFlows);
    return this.findOne(userId, saved.id);
  }

  async findAll(userId: string): Promise<MonteCarloScenario[]> {
    return this.scenariosRepository.find({
      where: { userId },
      order: { isFavourite: "DESC", updatedAt: "DESC" },
    });
  }

  async findOne(userId: string, id: string): Promise<MonteCarloScenario> {
    const scenario = await this.scenariosRepository.findOne({
      where: { id, userId },
      relations: ["cashFlows"],
    });
    if (!scenario) {
      throw new NotFoundException(`Scenario ${id} not found`);
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
    await this.cashFlowsRepository.delete({ scenarioId });
    if (flows.length === 0) return;
    const rows = flows.map((cf, idx) =>
      this.cashFlowsRepository.create({
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
    await this.cashFlowsRepository.save(rows);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateScenarioDto,
  ): Promise<MonteCarloScenario> {
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

    const saved = await this.scenariosRepository.save(scenario);
    await this.replaceCashFlows(saved.id, dto.cashFlows);
    return this.findOne(userId, saved.id);
  }

  async remove(userId: string, id: string): Promise<void> {
    const scenario = await this.findOne(userId, id);
    await this.scenariosRepository.remove(scenario);
  }

  async runSaved(userId: string, id: string): Promise<SimulationResult> {
    const scenario = await this.findOne(userId, id);

    const startingValue =
      scenario.useCurrentBalance && scenario.accountIds.length > 0
        ? await this.computeCurrentValue(userId, scenario.accountIds)
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
    await this.scenariosRepository.save(scenario);

    return result;
  }

  async runAdHoc(
    userId: string,
    dto: RunScenarioDto,
  ): Promise<SimulationResult> {
    const startingValue =
      dto.useCurrentBalance && dto.accountIds.length > 0
        ? await this.computeCurrentValue(userId, dto.accountIds)
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
   * If `useHistorical` is true and the selected accounts have enough history,
   * substitute computed mean/volatility for the supplied values. Falls back
   * silently to the supplied values when historical data is insufficient.
   */
  private async resolveReturns(
    userId: string,
    accountIds: string[],
    useHistorical: boolean,
    fallbackReturn: number,
    fallbackVolatility: number,
  ): Promise<{ expectedReturn: number; volatility: number }> {
    if (!useHistorical || accountIds.length === 0) {
      return { expectedReturn: fallbackReturn, volatility: fallbackVolatility };
    }
    const stats = await this.getHistoricalStats(userId, accountIds);
    return {
      expectedReturn: stats.meanReturn ?? fallbackReturn,
      volatility: stats.volatility ?? fallbackVolatility,
    };
  }

  /** Brokerage and standalone investment accounts only — what UIs that drive
   * holdings-based simulations should show in their account picker. */
  async getBrokerageAccounts(userId: string) {
    return this.portfolioService.getBrokerageAccounts(userId);
  }

  /**
   * Computes annualized mean return and stdev from the user's investment
   * transaction history for the selected accounts. The user's "Use historical"
   * button calls this to prefill the form.
   *
   * Methodology: build a per-year value series from the running portfolio
   * value at each year-end, factoring out external cash flows (contributions
   * and withdrawals) so the return reflects asset performance, not deposits.
   * Money-weighted return per year:
   *
   *   r_t = (V_t - V_{t-1} - netFlow_t) / max(V_{t-1} + netFlow_t, eps)
   *
   * Returns null mean/volatility when there are fewer than 2 full years.
   */
  async getHistoricalStats(
    userId: string,
    accountIds: string[],
  ): Promise<HistoricalStats> {
    if (accountIds.length === 0) {
      throw new BadRequestException("At least one accountId is required");
    }

    const currentBalance = await this.computeCurrentValue(userId, accountIds);

    // Build a value-weighted series of yearly returns from the price history
    // of currently held securities. This answers "what would my current mix
    // have returned year-over-year", which is what users expect when they
    // pick 'Use historical' on this report.
    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(accountIds) },
      relations: ["security"],
    });
    const active = holdings.filter(
      (h) => Math.abs(Number(h.quantity)) > 0.0001,
    );
    if (active.length === 0) {
      return {
        yearsObserved: 0,
        meanReturn: null,
        volatility: null,
        currentBalance,
      };
    }

    const securityIds = [...new Set(active.map((h) => h.securityId))];
    const yearlyReturns = await this.fetchYearlyReturnsBySecurity(securityIds);

    // Weight each security by its current market value (sum across accounts).
    const currentPrices =
      await this.portfolioService.getLatestPrices(securityIds);
    const weightBySec = new Map<string, number>();
    for (const h of active) {
      const price = currentPrices.get(h.securityId);
      if (price == null) continue;
      const value = Number(h.quantity) * price;
      weightBySec.set(
        h.securityId,
        (weightBySec.get(h.securityId) ?? 0) + value,
      );
    }

    // Compute portfolio yearly returns by combining per-security returns
    // weighted by current value. Years where no securities have data are
    // skipped.
    const allYears = new Set<number>();
    for (const r of yearlyReturns.values())
      for (const y of r.keys()) allYears.add(y);

    const portfolioReturns: number[] = [];
    for (const year of [...allYears].sort()) {
      let weightedReturn = 0;
      let totalWeight = 0;
      for (const [secId, returns] of yearlyReturns) {
        const r = returns.get(year);
        const w = weightBySec.get(secId);
        if (r === undefined || w === undefined || w <= 0) continue;
        weightedReturn += r * w;
        totalWeight += w;
      }
      if (totalWeight > 0) portfolioReturns.push(weightedReturn / totalWeight);
    }

    if (portfolioReturns.length < 2) {
      return {
        yearsObserved: portfolioReturns.length,
        meanReturn: null,
        volatility: null,
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
      throw new BadRequestException("At least one accountId is required");
    }

    // Verify the requested accounts belong to the user before running queries
    // that don't carry their own userId clause.
    const accounts = await this.accountsRepository.find({
      where: { id: In(accountIds), userId },
    });
    if (accounts.length === 0) return [];

    const holdings = await this.holdingsRepository.find({
      where: { accountId: In(accounts.map((a) => a.id)) },
      relations: ["security"],
    });
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
    const yearlyReturns = await this.fetchYearlyReturnsBySecurity(securityIds);
    const currentPrices =
      await this.portfolioService.getLatestPrices(securityIds);

    const grouped = new Map<string, HoldingStat[]>();
    for (const a of accounts) grouped.set(a.id, []);

    for (const h of active) {
      if (!grouped.has(h.accountId)) continue;
      const returns = yearlyReturns.get(h.securityId);
      const series = returns ? [...returns.values()] : [];
      const stats = computeMeanStdev(series);
      const price = currentPrices.get(h.securityId);
      grouped.get(h.accountId)!.push({
        symbol: h.security?.symbol ?? "?",
        name: h.security?.name ?? "Unknown",
        currencyCode: h.security?.currencyCode ?? "USD",
        quantity: Number(h.quantity),
        marketValue:
          price == null
            ? 0
            : Math.round(Number(h.quantity) * price * 100) / 100,
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
        (x, y) => y.marketValue - x.marketValue,
      ),
    }));
  }

  /**
   * Fetch year-end closing prices for the given securities and convert to
   * per-year returns. Returned map: securityId → Map<year, return>.
   */
  private async fetchYearlyReturnsBySecurity(
    securityIds: string[],
  ): Promise<Map<string, Map<number, number>>> {
    if (securityIds.length === 0) return new Map();

    let yearlyReturns = await this.queryYearlyReturns(securityIds);

    // For securities with fewer than 10 yearly returns we backfill from the
    // provider — typically newer holdings whose local price history doesn't
    // yet span the full window we want for stable mean/volatility estimates.
    const sparseIds = securityIds.filter(
      (id) => (yearlyReturns.get(id)?.size ?? 0) < 10,
    );
    if (sparseIds.length > 0) {
      const securities = await this.securitiesRepository.find({
        where: { id: In(sparseIds) },
      });
      await Promise.all(
        securities.map((s) =>
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
      yearlyReturns = await this.queryYearlyReturns(securityIds);
    }

    return yearlyReturns;
  }

  private async queryYearlyReturns(
    securityIds: string[],
  ): Promise<Map<string, Map<number, number>>> {
    const yearEndRows: Array<{
      security_id: string;
      year: string;
      close_price: string;
    }> = await this.securityPriceRepository.query(
      `SELECT DISTINCT ON (security_id, EXTRACT(YEAR FROM price_date))
         security_id,
         EXTRACT(YEAR FROM price_date)::text AS year,
         close_price
       FROM security_prices
       WHERE security_id = ANY($1)
       ORDER BY security_id, EXTRACT(YEAR FROM price_date), price_date DESC`,
      [securityIds],
    );

    const pricesBySecurity = new Map<
      string,
      Array<{ year: number; price: number }>
    >();
    for (const row of yearEndRows) {
      const arr = pricesBySecurity.get(row.security_id) ?? [];
      arr.push({ year: Number(row.year), price: Number(row.close_price) });
      pricesBySecurity.set(row.security_id, arr);
    }

    const yearlyReturns = new Map<string, Map<number, number>>();
    for (const [secId, prices] of pricesBySecurity) {
      prices.sort((a, b) => a.year - b.year);
      const returns = new Map<number, number>();
      for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1].price;
        const curr = prices[i].price;
        if (prev > 0) returns.set(prices[i].year, (curr - prev) / prev);
      }
      yearlyReturns.set(secId, returns);
    }
    return yearlyReturns;
  }

  private async computeCurrentValue(
    userId: string,
    accountIds: string[],
  ): Promise<number> {
    try {
      const summary = await this.portfolioService.getPortfolioSummary(
        userId,
        accountIds,
      );
      const value = summary.totalPortfolioValue;
      // NaN serializes to JSON null and would break the frontend form. Floats
      // with more than 4 decimals fail the DTO's @IsNumber maxDecimalPlaces
      // check. Clamp non-finite values to 0 and round to 4 decimal places.
      if (!Number.isFinite(value)) return 0;
      return Math.round(value * 10000) / 10000;
    } catch (err) {
      this.logger.warn(
        `Failed to compute current portfolio value for accounts ${accountIds.join(",")}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return 0;
    }
  }
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
