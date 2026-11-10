import { Injectable, Logger } from "@nestjs/common";
import { DataSource, LessThan, Repository } from "typeorm";
import { Cron } from "@nestjs/schedule";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiProviderConfig } from "./entities/ai-provider-config.entity";
import { AiUsageSummary, EstimatedCostByCurrency } from "./dto/ai-response.dto";
import { roundMoney } from "../common/round.util";
import { withSystemContext } from "../common/db/with-context";
import { withScopedDb } from "../common/db/scoped-db";
import { preferredCurrency } from "../common/default-currency.util";
import { formatDateYMDLocal } from "../common/date-utils";
import {
  buildRateIndex,
  convertAtDate,
  RateIndex,
} from "../common/time-series/rate-index.util";
import { UserPreference } from "../users/entities/user-preference.entity";

interface CostRate {
  inputCostPer1M: number | null;
  outputCostPer1M: number | null;
  currency: string;
}

const TOKENS_PER_UNIT = 1_000_000;

function rateKey(provider: string, model: string | null): string {
  return `${provider}::${model ?? ""}`;
}

function computeCost(
  inputTokens: number,
  outputTokens: number,
  rate: CostRate | undefined,
): number | null {
  if (!rate) return null;
  if (rate.inputCostPer1M === null && rate.outputCostPer1M === null) {
    return null;
  }
  const inputCost =
    rate.inputCostPer1M !== null
      ? (inputTokens / TOKENS_PER_UNIT) * rate.inputCostPer1M
      : 0;
  const outputCost =
    rate.outputCostPer1M !== null
      ? (outputTokens / TOKENS_PER_UNIT) * rate.outputCostPer1M
      : 0;
  // Unrounded: the aggregates are per day, and rounding each day before they
  // are summed would drift a cheap model's cost; the figures are rounded once,
  // where they leave the service.
  return inputCost + outputCost;
}

/**
 * The day a usage row was logged, for its rate. `created_at` is a TIMESTAMP
 * without a time zone, so its own calendar date is the day; `usageDayOf` reads
 * the same date off an entity, whose driver builds the Date in local time.
 */
const USAGE_DAY_SQL = "TO_CHAR(log.created_at, 'YYYY-MM-DD')";
const usageDayOf = (createdAt: Date): string => formatDateYMDLocal(createdAt);

/** A sum with an unknown part is unknown. */
function addUnknown(sum: number | null, part: number | null): number | null {
  return sum === null || part === null ? null : sum + part;
}

/** A bucket's sums, each rounded once. */
function roundBucket(bucket: EstimatedCostByCurrency): EstimatedCostByCurrency {
  return Object.fromEntries(
    Object.entries(bucket).map(([currency, amount]) => [
      currency,
      roundMoney(amount),
    ]),
  );
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : roundMoney(value);
}

function addCostToBucket(
  bucket: EstimatedCostByCurrency,
  currency: string,
  cost: number,
): void {
  bucket[currency] = (bucket[currency] ?? 0) + cost;
}

interface LogUsageParams {
  userId: string;
  provider: string;
  model: string;
  feature: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error?: string;
}

@Injectable()
export class AiUsageService {
  private readonly logger = new Logger(AiUsageService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron("0 4 * * *")
  async purgeOldUsageLogs(): Promise<void> {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);

      // RLS (task C2): cross-user bulk purge -- runs under a system context.
      const result = await withSystemContext(() =>
        withScopedDb(this.dataSource, (manager) =>
          manager.getRepository(AiUsageLog).delete({
            createdAt: LessThan(cutoff),
          }),
        ),
      );

      if (result.affected && result.affected > 0) {
        this.logger.log(`Purged ${result.affected} old AI usage logs`);
      }
    } catch (error) {
      this.logger.error(
        "Failed to purge old usage logs",
        error instanceof Error ? error.stack : error,
      );
    }
  }

  async logUsage(params: LogUsageParams): Promise<AiUsageLog> {
    return withScopedDb(this.dataSource, (manager) => {
      const repo = manager.getRepository(AiUsageLog);
      const log = repo.create({
        userId: params.userId,
        provider: params.provider,
        model: params.model,
        feature: params.feature,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        durationMs: params.durationMs,
        error: params.error || null,
      });
      return repo.save(log);
    });
  }

  /**
   * Run one AI-usage-log read in its own short scoped transaction. The five
   * reads in getUsageSummary stay independent (as they were when each ran on
   * its own pooled connection) instead of serializing on a shared one.
   */
  private usageLogs<T>(
    fn: (repo: Repository<AiUsageLog>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(AiUsageLog)),
    );
  }

  /**
   * Converts a cost in a provider's currency on a day into the user's
   * reporting currency at the rate for that day, loading the history the
   * rows' currencies and days need once. `null` without an admissible rate.
   */
  private async reportingCurrencyConverter(
    userId: string,
    rows: ReadonlyArray<{
      provider?: string | null;
      model?: string | null;
      day?: string | null;
    }>,
    configs: ReadonlyArray<Pick<AiProviderConfig, "costCurrency">>,
  ): Promise<{
    currency: string;
    convert: (
      cost: number,
      currency: string,
      day: string | null | undefined,
    ) => number | null;
  }> {
    const currency = preferredCurrency(
      await withScopedDb(this.dataSource, (m) =>
        m.getRepository(UserPreference).findOne({ where: { userId } }),
      ),
    );
    const foreign = new Set(
      configs
        .map((cfg) => cfg.costCurrency || "USD")
        .filter((code) => code !== currency),
    );
    const days = rows
      .map((row) => row.day)
      .filter((day): day is string => Boolean(day))
      .sort();
    const index: RateIndex =
      foreign.size === 0 || days.length === 0
        ? new Map()
        : await withScopedDb(this.dataSource, (m) =>
            buildRateIndex(
              (sql, params) => m.query(sql, params),
              foreign,
              currency,
              days[0],
              days[days.length - 1],
            ),
          );
    return {
      currency,
      convert: (cost, from, day) => {
        if (from === currency || cost === 0) return cost;
        if (!day) return null;
        return convertAtDate(cost, from, currency, day, index, this.logger);
      },
    };
  }

  async getUsageSummary(
    userId: string,
    days?: number,
  ): Promise<AiUsageSummary> {
    const [byProviderModel, byFeatureModel, recentLogs, totals, userConfigs] =
      await Promise.all([
        // Group by provider AND model so we can look up per-model cost rates.
        this.usageLogs((repo) =>
          repo
            .createQueryBuilder("log")
            .select("log.provider", "provider")
            .addSelect("log.model", "model")
            .addSelect("COUNT(*)", "requests")
            .addSelect("SUM(log.input_tokens)", "inputTokens")
            .addSelect("SUM(log.output_tokens)", "outputTokens")
            .addSelect(USAGE_DAY_SQL, "day")
            .where("log.user_id = :userId", { userId })
            .andWhere(
              days
                ? "log.created_at >= NOW() - make_interval(days => :days)"
                : "1=1",
              { days },
            )
            .groupBy("log.provider")
            .addGroupBy("log.model")
            .addGroupBy(USAGE_DAY_SQL)
            .getRawMany(),
        ),

        this.usageLogs((repo) =>
          repo
            .createQueryBuilder("log")
            .select("log.feature", "feature")
            .addSelect("log.provider", "provider")
            .addSelect("log.model", "model")
            .addSelect("COUNT(*)", "requests")
            .addSelect("SUM(log.input_tokens)", "inputTokens")
            .addSelect("SUM(log.output_tokens)", "outputTokens")
            .addSelect(USAGE_DAY_SQL, "day")
            .where("log.user_id = :userId", { userId })
            .andWhere(
              days
                ? "log.created_at >= NOW() - make_interval(days => :days)"
                : "1=1",
              { days },
            )
            .groupBy("log.feature")
            .addGroupBy("log.provider")
            .addGroupBy("log.model")
            .addGroupBy(USAGE_DAY_SQL)
            .getRawMany(),
        ),

        this.usageLogs((repo) =>
          repo.find({
            where: { userId },
            order: { createdAt: "DESC" },
            take: 20,
          }),
        ),

        this.usageLogs((repo) =>
          repo
            .createQueryBuilder("log")
            .select("COUNT(*)", "totalRequests")
            .addSelect("COALESCE(SUM(log.input_tokens), 0)", "totalInputTokens")
            .addSelect(
              "COALESCE(SUM(log.output_tokens), 0)",
              "totalOutputTokens",
            )
            .where("log.user_id = :userId", { userId })
            .andWhere(
              days
                ? "log.created_at >= NOW() - make_interval(days => :days)"
                : "1=1",
              { days },
            )
            .getRawOne(),
        ),

        withScopedDb(this.dataSource, (manager) =>
          manager.getRepository(AiProviderConfig).find({
            where: { userId },
            select: [
              "provider",
              "model",
              "inputCostPer1M",
              "outputCostPer1M",
              "costCurrency",
            ] as (keyof AiProviderConfig)[],
          }),
        ),
      ]);

    // Each day's cost in the reader's reporting currency at that day's rate,
    // never a month of usage at today's (issue #2106). A cost with no
    // admissible rate leaves its figure unknown.
    const toReporting = await this.reportingCurrencyConverter(
      userId,
      [
        ...(byProviderModel as Record<string, string | null>[]),
        ...(byFeatureModel as Record<string, string | null>[]),
        ...recentLogs.map((log) => ({
          provider: log.provider,
          model: log.model,
          day: usageDayOf(log.createdAt),
        })),
      ],
      userConfigs,
    );

    // Build (provider, model) -> rate lookup from the user's configured providers.
    const rateMap = new Map<string, CostRate>();
    for (const cfg of userConfigs) {
      rateMap.set(rateKey(cfg.provider, cfg.model), {
        inputCostPer1M: cfg.inputCostPer1M,
        outputCostPer1M: cfg.outputCostPer1M,
        currency: cfg.costCurrency || "USD",
      });
    }

    // Collapse (provider, model) aggregates into byProvider, bucketing costs
    // by each config's cost currency so we can display/convert per-currency.
    const providerAgg = new Map<
      string,
      {
        provider: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costs: EstimatedCostByCurrency;
        reportingCost: number | null;
      }
    >();

    for (const row of byProviderModel as Record<string, string | null>[]) {
      const provider = row.provider as string;
      const model = row.model as string | null;
      const requests = parseInt(row.requests as string, 10) || 0;
      const inputTokens = parseInt(row.inputTokens as string, 10) || 0;
      const outputTokens = parseInt(row.outputTokens as string, 10) || 0;
      const rate = rateMap.get(rateKey(provider, model));
      const cost = computeCost(inputTokens, outputTokens, rate);

      let existing = providerAgg.get(provider);
      if (!existing) {
        existing = {
          provider,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costs: {},
          reportingCost: 0,
        };
        providerAgg.set(provider, existing);
      }
      existing.requests += requests;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      if (cost !== null && rate) {
        addCostToBucket(existing.costs, rate.currency, cost);
        existing.reportingCost = addUnknown(
          existing.reportingCost,
          toReporting.convert(cost, rate.currency, row.day),
        );
      }
    }

    // Same pattern for byFeature.
    const featureAgg = new Map<
      string,
      {
        feature: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        costs: EstimatedCostByCurrency;
        reportingCost: number | null;
      }
    >();

    for (const row of byFeatureModel as Record<string, string | null>[]) {
      const feature = row.feature as string;
      const provider = row.provider as string;
      const model = row.model as string | null;
      const requests = parseInt(row.requests as string, 10) || 0;
      const inputTokens = parseInt(row.inputTokens as string, 10) || 0;
      const outputTokens = parseInt(row.outputTokens as string, 10) || 0;
      const rate = rateMap.get(rateKey(provider, model));
      const cost = computeCost(inputTokens, outputTokens, rate);

      let existing = featureAgg.get(feature);
      if (!existing) {
        existing = {
          feature,
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          costs: {},
          reportingCost: 0,
        };
        featureAgg.set(feature, existing);
      }
      existing.requests += requests;
      existing.inputTokens += inputTokens;
      existing.outputTokens += outputTokens;
      if (cost !== null && rate) {
        addCostToBucket(existing.costs, rate.currency, cost);
        existing.reportingCost = addUnknown(
          existing.reportingCost,
          toReporting.convert(cost, rate.currency, row.day),
        );
      }
    }

    // Sum all provider buckets to produce the totals-by-currency.
    const totalEstimatedCostByCurrency: EstimatedCostByCurrency = {};
    let totalReportingCost: number | null = 0;
    for (const agg of providerAgg.values()) {
      for (const [currency, amount] of Object.entries(agg.costs)) {
        addCostToBucket(totalEstimatedCostByCurrency, currency, amount);
      }
      totalReportingCost = addUnknown(totalReportingCost, agg.reportingCost);
    }

    return {
      totalRequests: parseInt(totals.totalRequests, 10) || 0,
      totalInputTokens: parseInt(totals.totalInputTokens, 10) || 0,
      totalOutputTokens: parseInt(totals.totalOutputTokens, 10) || 0,
      totalEstimatedCostByCurrency: roundBucket(totalEstimatedCostByCurrency),
      reportingCurrency: toReporting.currency,
      totalEstimatedCostInReportingCurrency: roundOrNull(totalReportingCost),
      byProvider: Array.from(providerAgg.values()).map((agg) => ({
        provider: agg.provider,
        requests: agg.requests,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        estimatedCostByCurrency: roundBucket(agg.costs),
        estimatedCostInReportingCurrency: roundOrNull(agg.reportingCost),
      })),
      byFeature: Array.from(featureAgg.values()).map((agg) => ({
        feature: agg.feature,
        requests: agg.requests,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        estimatedCostByCurrency: roundBucket(agg.costs),
        estimatedCostInReportingCurrency: roundOrNull(agg.reportingCost),
      })),
      recentLogs: recentLogs.map((log) => {
        const rate = rateMap.get(rateKey(log.provider, log.model));
        const cost = computeCost(log.inputTokens, log.outputTokens, rate);
        return {
          id: log.id,
          provider: log.provider,
          model: log.model,
          feature: log.feature,
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          durationMs: log.durationMs,
          estimatedCost: cost === null ? null : roundMoney(cost),
          costCurrency: cost !== null && rate ? rate.currency : null,
          estimatedCostInReportingCurrency:
            cost !== null && rate
              ? roundOrNull(
                  toReporting.convert(
                    cost,
                    rate.currency,
                    usageDayOf(log.createdAt),
                  ),
                )
              : null,
          createdAt: log.createdAt.toISOString(),
        };
      }),
    };
  }
}
