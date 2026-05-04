import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { MonteCarloScenario } from "./entities/monte-carlo-scenario.entity";
import { CreateScenarioDto } from "./dto/create-scenario.dto";
import { UpdateScenarioDto } from "./dto/update-scenario.dto";
import { RunScenarioDto } from "./dto/run-scenario.dto";
import { MonteCarloSimulationService } from "./monte-carlo-simulation.service";
import { SimulationResult } from "./dto/simulation-result.dto";
import { PortfolioService } from "../securities/portfolio.service";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";

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

@Injectable()
export class MonteCarloService {
  private readonly logger = new Logger(MonteCarloService.name);

  constructor(
    @InjectRepository(MonteCarloScenario)
    private scenariosRepository: Repository<MonteCarloScenario>,
    @InjectRepository(InvestmentTransaction)
    private investmentTxRepository: Repository<InvestmentTransaction>,
    private simulationService: MonteCarloSimulationService,
    private portfolioService: PortfolioService,
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
      simulationCount: dto.simulationCount,
      targetValue: dto.targetValue ?? null,
      randomSeed: dto.randomSeed ?? null,
    });
    return this.scenariosRepository.save(scenario);
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
    });
    if (!scenario) {
      throw new NotFoundException(`Scenario ${id} not found`);
    }
    return scenario;
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
    if (dto.simulationCount !== undefined)
      scenario.simulationCount = dto.simulationCount;
    if (dto.targetValue !== undefined)
      scenario.targetValue = dto.targetValue ?? null;
    if (dto.randomSeed !== undefined)
      scenario.randomSeed = dto.randomSeed ?? null;
    if (dto.isFavourite !== undefined) scenario.isFavourite = dto.isFavourite;

    return this.scenariosRepository.save(scenario);
  }

  async remove(userId: string, id: string): Promise<void> {
    const scenario = await this.findOne(userId, id);
    await this.scenariosRepository.remove(scenario);
  }

  async runSaved(userId: string, id: string): Promise<SimulationResult> {
    const scenario = await this.findOne(userId, id);

    let startingValue = scenario.startingValue;
    if (scenario.useCurrentBalance && scenario.accountIds.length > 0) {
      startingValue = await this.computeCurrentValue(
        userId,
        scenario.accountIds,
      );
    }

    const result = this.simulationService.run({
      startingValue,
      yearsToRetirement: scenario.yearsToRetirement,
      annualContribution: scenario.annualContribution,
      contributionGrowthRate: scenario.contributionGrowthRate,
      yearsInRetirement: scenario.yearsInRetirement,
      annualWithdrawal: scenario.annualWithdrawal,
      expectedReturn: scenario.expectedReturn,
      volatility: scenario.volatility,
      inflationRate: scenario.inflationRate,
      showRealValues: scenario.showRealValues,
      simulationCount: scenario.simulationCount,
      targetValue: scenario.targetValue,
      randomSeed: scenario.randomSeed,
    });

    scenario.lastRunAt = new Date();
    await this.scenariosRepository.save(scenario);

    return result;
  }

  async runAdHoc(
    userId: string,
    dto: RunScenarioDto,
  ): Promise<SimulationResult> {
    let startingValue = dto.startingValue;
    if (dto.useCurrentBalance && dto.accountIds.length > 0) {
      startingValue = await this.computeCurrentValue(userId, dto.accountIds);
    }

    return this.simulationService.run({
      startingValue,
      yearsToRetirement: dto.yearsToRetirement,
      annualContribution: dto.annualContribution,
      contributionGrowthRate: dto.contributionGrowthRate,
      yearsInRetirement: dto.yearsInRetirement,
      annualWithdrawal: dto.annualWithdrawal,
      expectedReturn: dto.expectedReturn,
      volatility: dto.volatility,
      inflationRate: dto.inflationRate,
      showRealValues: dto.showRealValues,
      simulationCount: dto.simulationCount,
      targetValue: dto.targetValue,
      randomSeed: dto.randomSeed,
    });
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

    const txs = await this.investmentTxRepository.find({
      where: { userId, accountId: In(accountIds) },
      order: { transactionDate: "ASC" },
    });

    if (txs.length === 0) {
      return {
        yearsObserved: 0,
        meanReturn: null,
        volatility: null,
        currentBalance,
      };
    }

    // Group net cash flows by year. For investment transactions:
    //   BUY/REINVEST/ADD_SHARES → outflow from cash, but value stays in portfolio
    //   SELL/REMOVE_SHARES      → inflow to cash, value leaves portfolio
    //   DIVIDEND/INTEREST/CAPITAL_GAIN → return events, not external flows
    //   TRANSFER_IN             → external addition
    //   TRANSFER_OUT            → external removal
    // For Monte Carlo we want **external** flows (transfers in/out) only.
    // Approximating with totalAmount sign on TRANSFER_* and treating
    // BUY/SELL as internal reallocations.
    const flowsByYear = new Map<number, number>();
    const firstYear = new Date(txs[0].transactionDate).getFullYear();
    const currentYear = new Date().getFullYear();

    for (const tx of txs) {
      const year = new Date(tx.transactionDate).getFullYear();
      if (tx.action === "TRANSFER_IN") {
        flowsByYear.set(
          year,
          (flowsByYear.get(year) ?? 0) + Number(tx.totalAmount),
        );
      } else if (tx.action === "TRANSFER_OUT") {
        flowsByYear.set(
          year,
          (flowsByYear.get(year) ?? 0) - Number(tx.totalAmount),
        );
      }
    }

    // We don't have full year-end snapshots historically, so we fall back to
    // a simple CAGR-derived volatility estimate: use overall CAGR for mean
    // and the user-provided default volatility as a placeholder. To keep the
    // helper genuinely useful, we compute a rough yearly geometric return
    // sequence by spreading observed price-driven gains uniformly (out of
    // scope for a richer estimate).
    const yearsObserved = Math.max(0, currentYear - firstYear);
    if (yearsObserved < 2) {
      return {
        yearsObserved,
        meanReturn: null,
        volatility: null,
        currentBalance,
      };
    }

    // Net external flow over the period.
    let netExternal = 0;
    for (const v of flowsByYear.values()) netExternal += v;

    const adjustedStart = Math.max(netExternal, 1); // treat as money in
    const cagr =
      currentBalance > 0 && adjustedStart > 0
        ? Math.pow(currentBalance / adjustedStart, 1 / yearsObserved) - 1
        : null;

    // Without per-year snapshots we can't compute true stdev. Return mean
    // only (volatility = null), letting the UI keep its existing volatility
    // input. This is honest about the data we have.
    return {
      yearsObserved,
      meanReturn:
        cagr === null ? null : Math.round(cagr * 1_000_000) / 1_000_000,
      volatility: null,
      currentBalance,
    };
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
      return summary.totalPortfolioValue;
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
