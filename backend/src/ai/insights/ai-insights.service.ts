import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { Repository, LessThan } from "typeorm";
import { Cron, CronExpression } from "@nestjs/schedule";
import {
  AiInsight,
  InsightType,
  InsightSeverity,
} from "../entities/ai-insight.entity";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import {
  InsightsAggregatorService,
  SpendingAggregates,
} from "./insights-aggregator.service";
import { INSIGHT_SYSTEM_PROMPT } from "../context/prompt-templates";
import { sanitizePromptValue } from "../context/prompt-sanitize";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { AiInsightResponse, InsightsListResponse } from "./dto/ai-insights.dto";

const INSIGHT_EXPIRY_DAYS = 7;
const MAX_INSIGHTS_PER_USER = 50;
const MIN_GENERATION_INTERVAL_HOURS = 12;
const CRON_BATCH_SIZE = 50;

interface RawInsight {
  type: string;
  title: string;
  description: string;
  severity: string;
  data: Record<string, unknown>;
}

@Injectable()
export class AiInsightsService {
  private readonly logger = new Logger(AiInsightsService.name);
  private readonly generatingUsers = new Set<string>();

  constructor(
    @InjectRepository(AiInsight)
    private readonly insightRepo: Repository<AiInsight>,
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
    private readonly aiService: AiService,
    private readonly usageService: AiUsageService,
    private readonly aggregatorService: InsightsAggregatorService,
    private readonly configService: ConfigService,
  ) {}

  async getInsights(
    userId: string,
    type?: InsightType,
    severity?: InsightSeverity,
    includeDismissed = false,
  ): Promise<InsightsListResponse> {
    const qb = this.insightRepo
      .createQueryBuilder("i")
      .where("i.userId = :userId", { userId })
      .andWhere("i.expiresAt > :now", { now: new Date() });

    if (!includeDismissed) {
      qb.andWhere("i.isDismissed = false");
    }

    if (type) {
      qb.andWhere("i.type = :type", { type });
    }

    if (severity) {
      qb.andWhere("i.severity = :severity", { severity });
    }

    qb.orderBy("i.severity", "ASC")
      .addOrderBy("i.generatedAt", "DESC")
      .take(MAX_INSIGHTS_PER_USER);

    const insights = await qb.getMany();

    const lastGenerated = await this.insightRepo
      .createQueryBuilder("i")
      .select("MAX(i.generatedAt)", "lastGenerated")
      .where("i.userId = :userId", { userId })
      .getRawOne();

    return {
      insights: insights.map((i) => this.toResponse(i)),
      total: insights.length,
      lastGeneratedAt: lastGenerated?.lastGenerated
        ? new Date(lastGenerated.lastGenerated).toISOString()
        : null,
      isGenerating: this.generatingUsers.has(userId),
    };
  }

  isGenerating(userId: string): boolean {
    return this.generatingUsers.has(userId);
  }

  async dismissInsight(userId: string, insightId: string): Promise<void> {
    const insight = await this.insightRepo.findOne({
      where: { id: insightId, userId },
    });

    if (!insight) {
      throw new NotFoundException("Insight not found");
    }

    await this.insightRepo.update({ id: insightId }, { isDismissed: true });
  }

  async generateInsights(userId: string): Promise<InsightsListResponse> {
    if (this.generatingUsers.has(userId)) {
      return this.getInsights(userId);
    }

    const recentInsight = await this.insightRepo
      .createQueryBuilder("i")
      .where("i.userId = :userId", { userId })
      .andWhere("i.generatedAt > :cutoff", {
        cutoff: new Date(
          Date.now() - MIN_GENERATION_INTERVAL_HOURS * 60 * 60 * 1000,
        ),
      })
      .getOne();

    if (recentInsight) {
      return this.getInsights(userId);
    }

    this.generatingUsers.add(userId);

    try {
      const preferences = await this.prefRepo.findOne({
        where: { userId },
      });
      const currency = preferences?.defaultCurrency || "USD";

      let aggregates: SpendingAggregates;
      try {
        aggregates = await this.aggregatorService.computeAggregates(
          userId,
          currency,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.warn(
          `Failed to compute aggregates for user ${userId}: ${message}`,
        );
        return this.getInsights(userId);
      }

      if (
        aggregates.categorySpending.length === 0 &&
        aggregates.monthlySpending.length === 0
      ) {
        return this.getInsights(userId);
      }

      const prompt = this.buildInsightsPrompt(aggregates);

      try {
        const response = await this.aiService.complete(
          userId,
          {
            systemPrompt: INSIGHT_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
            maxTokens: 4096,
            temperature: 0.3,
            responseFormat: "json",
          },
          "insight",
        );

        const rawInsights = this.parseInsightsResponse(response.content);
        await this.saveInsights(userId, rawInsights);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.warn(
          `Failed to generate AI insights for user ${userId}: ${message}`,
        );
      }

      return this.getInsights(userId);
    } finally {
      this.generatingUsers.delete(userId);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async handleDailyInsightGeneration(): Promise<void> {
    this.logger.log("Starting daily insight generation");

    try {
      await this.cleanupExpiredInsights();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Failed to cleanup expired insights: ${message}`);
    }

    const userIds = await this.getActiveUserIds();
    const batch = userIds.slice(0, CRON_BATCH_SIZE);

    for (const userId of batch) {
      try {
        await this.generateInsights(userId);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.warn(
          `Failed to generate insights for user ${userId}: ${message}`,
        );
      }
    }

    this.logger.log(
      `Daily insight generation complete for ${batch.length} of ${userIds.length} users`,
    );
  }

  private async cleanupExpiredInsights(): Promise<void> {
    const result = await this.insightRepo.delete({
      expiresAt: LessThan(new Date()),
    });

    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired insights`);
    }
  }

  private async getActiveUserIds(): Promise<string[]> {
    const userIdsWithConfig = await this.insightRepo.manager
      .createQueryBuilder()
      .select("DISTINCT apc.user_id", "userId")
      .from("ai_provider_configs", "apc")
      .where("apc.is_active = true")
      .getRawMany();

    const ids = new Set(userIdsWithConfig.map((r: any) => r.userId as string));

    const hasServerDefault = !!this.configService.get<string>(
      "AI_DEFAULT_PROVIDER",
    );

    if (hasServerDefault) {
      const allActiveUsers = await this.insightRepo.manager
        .createQueryBuilder()
        .select("u.id", "userId")
        .from("users", "u")
        .where("u.is_active = true")
        .getRawMany();

      for (const row of allActiveUsers) {
        ids.add(row.userId as string);
      }
    }

    return [...ids] as string[];
  }

  private buildInsightsPrompt(aggregates: SpendingAggregates): string {
    const sections: string[] = [];

    sections.push(
      `Currency: ${aggregates.currency}`,
      `Days elapsed in current month: ${aggregates.daysElapsedInMonth}/${aggregates.daysInMonth}`,
      `Total spending current month: ${aggregates.totalSpendingCurrentMonth.toFixed(2)}`,
      `Total spending previous month: ${aggregates.totalSpendingPreviousMonth.toFixed(2)}`,
      `Average monthly spending (6-month): ${aggregates.averageMonthlySpending.toFixed(2)}`,
    );

    if (aggregates.categorySpending.length > 0) {
      sections.push("\n--- CATEGORY SPENDING ---");
      for (const cat of aggregates.categorySpending.slice(0, 15)) {
        sections.push(
          `${sanitizePromptValue(cat.categoryName)}: current month=${cat.currentMonthTotal.toFixed(2)}, previous month=${cat.previousMonthTotal.toFixed(2)}, 6-month avg=${cat.averageMonthlyTotal.toFixed(2)}, months with data=${cat.monthCount}, transactions=${cat.transactionCount}`,
        );
      }
    }

    if (aggregates.monthlySpending.length > 0) {
      sections.push("\n--- MONTHLY SPENDING TRENDS ---");
      for (const month of aggregates.monthlySpending) {
        const top3 = month.categoryBreakdown
          .slice(0, 3)
          .map(
            (c) =>
              `${sanitizePromptValue(c.categoryName)}=${c.total.toFixed(2)}`,
          )
          .join(", ");
        sections.push(
          `${month.month}: total=${month.total.toFixed(2)} (top: ${top3})`,
        );
      }
    }

    if (aggregates.recurringCharges.length > 0) {
      sections.push("\n--- RECURRING CHARGES ---");
      for (const charge of aggregates.recurringCharges.slice(0, 15)) {
        const amountChange =
          charge.previousAmount > 0
            ? (
                ((charge.currentAmount - charge.previousAmount) /
                  charge.previousAmount) *
                100
              ).toFixed(1)
            : "N/A";
        sections.push(
          `${sanitizePromptValue(charge.payeeName)} (${charge.frequency}): current=${charge.currentAmount.toFixed(2)}, previous=${charge.previousAmount.toFixed(2)}, change=${amountChange}%, category=${sanitizePromptValue(charge.categoryName || "unknown")}, occurrences=${charge.amounts.length}`,
        );
      }
    }

    return sections.join("\n");
  }

  private parseInsightsResponse(content: string): RawInsight[] {
    const trimmed = content.trim();
    const jsonMatch = trimmed.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      this.logger.warn("AI response did not contain a JSON array");
      return [];
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        this.logger.warn("Parsed AI response is not an array");
        return [];
      }

      const validTypes = new Set([
        "anomaly",
        "trend",
        "subscription",
        "budget_pace",
        "seasonal",
        "new_recurring",
      ]);
      const validSeverities = new Set(["info", "warning", "alert"]);

      return parsed
        .filter((item: unknown) => {
          if (!item || typeof item !== "object") return false;
          const obj = item as Record<string, unknown>;
          return (
            typeof obj.type === "string" &&
            validTypes.has(obj.type) &&
            typeof obj.title === "string" &&
            typeof obj.description === "string" &&
            typeof obj.severity === "string" &&
            validSeverities.has(obj.severity)
          );
        })
        .map((item: Record<string, unknown>) => ({
          type: item.type as string,
          title: String(item.title).substring(0, 255),
          description: String(item.description).substring(0, 5000),
          severity: item.severity as string,
          data: this.sanitizeData(item.data),
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Failed to parse AI insights response: ${message}`);
      return [];
    }
  }

  private async saveInsights(
    userId: string,
    rawInsights: RawInsight[],
  ): Promise<void> {
    if (rawInsights.length === 0) return;

    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + INSIGHT_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    );

    const insights = rawInsights.map((raw) => {
      const insight = this.insightRepo.create({
        userId,
        type: raw.type as InsightType,
        title: raw.title,
        description: raw.description,
        severity: raw.severity as InsightSeverity,
        data: raw.data,
        isDismissed: false,
        generatedAt: now,
        expiresAt,
      });
      return insight;
    });

    await this.insightRepo.save(insights);

    // Enforce max insights per user by removing oldest
    const count = await this.insightRepo.count({ where: { userId } });
    if (count > MAX_INSIGHTS_PER_USER) {
      const toRemove = await this.insightRepo.find({
        where: { userId },
        order: { generatedAt: "ASC" },
        take: count - MAX_INSIGHTS_PER_USER,
      });
      if (toRemove.length > 0) {
        await this.insightRepo.remove(toRemove);
      }
    }
  }

  private sanitizeData(data: unknown): Record<string, unknown> {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return {};
    }

    const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
    const MAX_KEYS = 20;
    const MAX_STRING_LENGTH = 1000;

    const result: Record<string, unknown> = {};
    let keyCount = 0;

    for (const key of Object.keys(data)) {
      if (keyCount >= MAX_KEYS) break;
      if (DANGEROUS_KEYS.has(key)) continue;

      const value = (data as Record<string, unknown>)[key];

      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        value === null
      ) {
        result[key] =
          typeof value === "string"
            ? value.substring(0, MAX_STRING_LENGTH)
            : value;
        keyCount++;
      }
    }

    return result;
  }

  private toResponse(insight: AiInsight): AiInsightResponse {
    return {
      id: insight.id,
      type: insight.type,
      title: insight.title,
      description: insight.description,
      severity: insight.severity,
      data: insight.data,
      isDismissed: insight.isDismissed,
      generatedAt: insight.generatedAt.toISOString(),
      expiresAt: insight.expiresAt.toISOString(),
      createdAt: insight.createdAt.toISOString(),
    };
  }
}
