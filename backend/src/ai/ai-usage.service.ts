import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiUsageSummary } from "./dto/ai-response.dto";

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
  constructor(
    @InjectRepository(AiUsageLog)
    private readonly usageLogRepository: Repository<AiUsageLog>,
  ) {}

  async logUsage(params: LogUsageParams): Promise<AiUsageLog> {
    const log = this.usageLogRepository.create({
      userId: params.userId,
      provider: params.provider,
      model: params.model,
      feature: params.feature,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      durationMs: params.durationMs,
      error: params.error || null,
    });
    return this.usageLogRepository.save(log);
  }

  async getUsageSummary(
    userId: string,
    days?: number,
  ): Promise<AiUsageSummary> {
    const qb = this.usageLogRepository
      .createQueryBuilder("log")
      .where("log.user_id = :userId", { userId });

    if (days) {
      qb.andWhere("log.created_at >= NOW() - make_interval(days => :days)", {
        days,
      });
    }

    const [byProvider, byFeature, recentLogs, totals] = await Promise.all([
      this.usageLogRepository
        .createQueryBuilder("log")
        .select("log.provider", "provider")
        .addSelect("COUNT(*)", "requests")
        .addSelect("SUM(log.input_tokens)", "inputTokens")
        .addSelect("SUM(log.output_tokens)", "outputTokens")
        .where("log.user_id = :userId", { userId })
        .andWhere(
          days
            ? "log.created_at >= NOW() - make_interval(days => :days)"
            : "1=1",
          { days },
        )
        .groupBy("log.provider")
        .getRawMany(),

      this.usageLogRepository
        .createQueryBuilder("log")
        .select("log.feature", "feature")
        .addSelect("COUNT(*)", "requests")
        .addSelect("SUM(log.input_tokens)", "inputTokens")
        .addSelect("SUM(log.output_tokens)", "outputTokens")
        .where("log.user_id = :userId", { userId })
        .andWhere(
          days
            ? "log.created_at >= NOW() - make_interval(days => :days)"
            : "1=1",
          { days },
        )
        .groupBy("log.feature")
        .getRawMany(),

      this.usageLogRepository.find({
        where: { userId },
        order: { createdAt: "DESC" },
        take: 20,
      }),

      this.usageLogRepository
        .createQueryBuilder("log")
        .select("COUNT(*)", "totalRequests")
        .addSelect("COALESCE(SUM(log.input_tokens), 0)", "totalInputTokens")
        .addSelect("COALESCE(SUM(log.output_tokens), 0)", "totalOutputTokens")
        .where("log.user_id = :userId", { userId })
        .andWhere(
          days
            ? "log.created_at >= NOW() - make_interval(days => :days)"
            : "1=1",
          { days },
        )
        .getRawOne(),
    ]);

    return {
      totalRequests: parseInt(totals.totalRequests, 10) || 0,
      totalInputTokens: parseInt(totals.totalInputTokens, 10) || 0,
      totalOutputTokens: parseInt(totals.totalOutputTokens, 10) || 0,
      byProvider: byProvider.map((row: Record<string, string>) => ({
        provider: row.provider,
        requests: parseInt(row.requests, 10) || 0,
        inputTokens: parseInt(row.inputTokens, 10) || 0,
        outputTokens: parseInt(row.outputTokens, 10) || 0,
      })),
      byFeature: byFeature.map((row: Record<string, string>) => ({
        feature: row.feature,
        requests: parseInt(row.requests, 10) || 0,
        inputTokens: parseInt(row.inputTokens, 10) || 0,
        outputTokens: parseInt(row.outputTokens, 10) || 0,
      })),
      recentLogs: recentLogs.map((log) => ({
        id: log.id,
        provider: log.provider,
        model: log.model,
        feature: log.feature,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
        durationMs: log.durationMs,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }
}
