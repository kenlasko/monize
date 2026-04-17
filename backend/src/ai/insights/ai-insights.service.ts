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
import { sanitizePromptValue } from "../../common/sanitization.util";
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
      this.logger.log(
        `Insights generation already in progress user=${userId}; returning current list`,
      );
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
      this.logger.log(
        `Insights generation skipped user=${userId}: last run within ${MIN_GENERATION_INTERVAL_HOURS}h cooldown`,
      );
      return this.getInsights(userId);
    }

    this.generatingUsers.add(userId);
    const startTime = Date.now();
    this.logger.log(`Insights generation start user=${userId}`);

    try {
      const preferences = await this.prefRepo.findOne({
        where: { userId },
      });
      const currency = preferences?.defaultCurrency || "USD";

      let aggregates: SpendingAggregates;
      const aggregateStart = Date.now();
      try {
        aggregates = await this.aggregatorService.computeAggregates(
          userId,
          currency,
        );
        this.logger.log(
          `Insights aggregates built user=${userId} currency=${currency} ` +
            `categories=${aggregates.categorySpending.length} ` +
            `months=${aggregates.monthlySpending.length} ` +
            `recurring=${aggregates.recurringCharges.length} ` +
            `in ${Date.now() - aggregateStart}ms`,
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
        this.logger.log(
          `Insights generation skipped user=${userId}: no spending data to analyze`,
        );
        return this.getInsights(userId);
      }

      const prompt = this.buildInsightsPrompt(aggregates);

      try {
        const providerCallStart = Date.now();
        this.logger.log(
          `Insights provider call start user=${userId} promptChars=${prompt.length}`,
        );
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
        const providerCallMs = Date.now() - providerCallStart;
        this.logger.log(
          `Insights provider call done user=${userId} ` +
            `model=${response.model} ms=${providerCallMs} ` +
            `inputTokens=${response.usage.inputTokens} ` +
            `outputTokens=${response.usage.outputTokens} ` +
            `contentChars=${response.content.length}`,
        );

        const rawInsights = this.parseInsightsResponse(
          response.content,
          userId,
        );
        await this.saveInsights(userId, rawInsights);
        this.logger.log(
          `Insights generation complete user=${userId} ` +
            `totalMs=${Date.now() - startTime} ` +
            `parsed=${rawInsights.length} ` +
            `inputTokens=${response.usage.inputTokens} ` +
            `outputTokens=${response.usage.outputTokens}`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        this.logger.warn(
          `Failed to generate AI insights for user ${userId} ` +
            `after ${Date.now() - startTime}ms: ${message}`,
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

    for (let offset = 0; offset < userIds.length; offset += CRON_BATCH_SIZE) {
      const batch = userIds.slice(offset, offset + CRON_BATCH_SIZE);

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
    }

    this.logger.log(
      `Daily insight generation complete for ${userIds.length} users`,
    );
  }

  private async cleanupExpiredInsights(): Promise<void> {
    const result = await this.insightRepo.delete({
      expiresAt: LessThan(new Date()),
    });

    if (result.affected && result.affected > 0) {
      this.logger.log(`Cleaned up ${result.affected} expired insights`);
    }

    // Purge dismissed insights older than 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const dismissedResult = await this.insightRepo.delete({
      isDismissed: true,
      createdAt: LessThan(cutoff),
    });

    if (dismissedResult.affected && dismissedResult.affected > 0) {
      this.logger.log(
        `Purged ${dismissedResult.affected} old dismissed insights`,
      );
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

  private formatPctWithDirection(pct: number): string {
    if (Math.abs(pct) < 0.05) return "0.0% (UNCHANGED)";
    if (pct > 0) return `+${pct.toFixed(1)}% (ABOVE)`;
    return `${pct.toFixed(1)}% (BELOW)`;
  }

  private buildInsightsPrompt(aggregates: SpendingAggregates): string {
    const sections: string[] = [];

    const monthProgress =
      aggregates.daysElapsedInMonth / aggregates.daysInMonth;
    const hasEnoughDaysForProjection = aggregates.daysElapsedInMonth >= 10;

    let projectedMonthlySpending: number | null = null;
    let projectedVsAvgPct: number | null = null;

    if (hasEnoughDaysForProjection && aggregates.daysElapsedInMonth > 0) {
      projectedMonthlySpending =
        (aggregates.totalSpendingCurrentMonth / aggregates.daysElapsedInMonth) *
        aggregates.daysInMonth;
      projectedVsAvgPct =
        aggregates.averageMonthlySpending > 0
          ? ((projectedMonthlySpending - aggregates.averageMonthlySpending) /
              aggregates.averageMonthlySpending) *
            100
          : 0;
    }

    sections.push(
      `Currency: ${aggregates.currency}`,
      `Days elapsed in current month: ${aggregates.daysElapsedInMonth}/${aggregates.daysInMonth} (${(monthProgress * 100).toFixed(0)}% through month)`,
      `Total spending current month (so far): ${aggregates.totalSpendingCurrentMonth.toFixed(2)}`,
    );

    if (projectedMonthlySpending !== null && projectedVsAvgPct !== null) {
      sections.push(
        `Projected full-month spending: ${projectedMonthlySpending.toFixed(2)}`,
        `Projected vs average: ${this.formatPctWithDirection(projectedVsAvgPct)}`,
      );
    } else {
      sections.push(
        `Projected full-month spending: NOT AVAILABLE (only ${aggregates.daysElapsedInMonth} days elapsed, need at least 10 for reliable projection)`,
      );
    }

    sections.push(
      `Total spending previous month: ${aggregates.totalSpendingPreviousMonth.toFixed(2)}`,
      `Average monthly spending (6-month): ${aggregates.averageMonthlySpending.toFixed(2)}`,
    );

    // Filter to categories with actual current-month spending
    const activeCategories = aggregates.categorySpending.filter(
      (cat) => cat.currentMonthTotal > 0,
    );

    if (activeCategories.length > 0) {
      sections.push("\n--- CATEGORY SPENDING (current month > $0 only) ---");
      for (const cat of activeCategories.slice(0, 15)) {
        const vsAvgPct =
          cat.averageMonthlyTotal > 0
            ? ((cat.currentMonthTotal - cat.averageMonthlyTotal) /
                cat.averageMonthlyTotal) *
              100
            : 0;
        const vsPrevPct =
          cat.previousMonthTotal > 0
            ? ((cat.currentMonthTotal - cat.previousMonthTotal) /
                cat.previousMonthTotal) *
              100
            : 0;

        const vsAvgLabel =
          cat.averageMonthlyTotal > 0
            ? cat.currentMonthTotal > cat.averageMonthlyTotal
              ? `${Math.abs(vsAvgPct).toFixed(1)}% ABOVE average`
              : cat.currentMonthTotal < cat.averageMonthlyTotal
                ? `${Math.abs(vsAvgPct).toFixed(1)}% BELOW average`
                : "EQUAL to average"
            : "no historical average";
        const vsPrevLabel =
          cat.previousMonthTotal > 0
            ? cat.currentMonthTotal > cat.previousMonthTotal
              ? `${Math.abs(vsPrevPct).toFixed(1)}% ABOVE previous month`
              : cat.currentMonthTotal < cat.previousMonthTotal
                ? `${Math.abs(vsPrevPct).toFixed(1)}% BELOW previous month`
                : "EQUAL to previous month"
            : "no previous month data";

        sections.push(
          `${sanitizePromptValue(cat.categoryName)}: current=${cat.currentMonthTotal.toFixed(2)}, prev=${cat.previousMonthTotal.toFixed(2)}, avg=${cat.averageMonthlyTotal.toFixed(2)}, vs avg: ${vsAvgLabel}, vs prev: ${vsPrevLabel}, months=${cat.monthCount}, txns=${cat.transactionCount}`,
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

  private parseInsightsResponse(content: string, userId: string): RawInsight[] {
    const MAX_JSON_SIZE = 100 * 1024; // 100KB
    const trimmed = content.trim();
    const preview = trimmed.slice(0, 500).replace(/\s+/g, " ");

    // Some providers (notably OpenAI-compatible endpoints like Cloudflare)
    // wrap JSON output in markdown code fences even when asked not to.
    // Strip them before attempting JSON extraction.
    const stripped = this.stripMarkdownFences(trimmed);

    const insightsArray = this.extractInsightsArray(stripped);
    if (!insightsArray) {
      this.logger.warn(
        `AI response did not contain a JSON insights array user=${userId} ` +
          `contentChars=${content.length} preview="${preview}"`,
      );
      return [];
    }

    // Serialized-size guard on the extracted array (defense in depth).
    if (JSON.stringify(insightsArray).length > MAX_JSON_SIZE) {
      this.logger.warn(
        `AI insights JSON too large user=${userId} ` +
          `items=${insightsArray.length} limit=${MAX_JSON_SIZE}`,
      );
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

    const rawCount = insightsArray.length;
    const validated = insightsArray
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
      .map((item) => {
        const obj = item as Record<string, unknown>;
        return {
          type: obj.type as string,
          title: String(obj.title).substring(0, 255),
          description: String(obj.description).substring(0, 5000),
          severity: obj.severity as string,
          data: this.sanitizeData(obj.data),
        };
      });

    if (rawCount !== validated.length) {
      this.logger.warn(
        `Filtered invalid insights user=${userId} ` +
          `raw=${rawCount} valid=${validated.length} ` +
          `dropped=${rawCount - validated.length}`,
      );
    }

    return validated;
  }

  private stripMarkdownFences(text: string): string {
    const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
    if (fenceMatch) {
      return fenceMatch[1].trim();
    }
    return text;
  }

  /**
   * Extract the insights array from the model output. Accepts the
   * strict contract ({"insights": [...]}) as well as legacy/tolerant shapes
   * (a bare array, or an object with the array under a commonly-seen key).
   * Returns null if no insights array can be recovered.
   */
  private extractInsightsArray(text: string): unknown[] | null {
    if (!text) return null;

    // 1. Try to parse the whole thing as JSON first (strict-shape path).
    const direct = this.safeJsonParse(text);
    if (direct !== undefined) {
      const arr = this.findInsightsArrayIn(direct);
      if (arr) return arr;
    }

    // 2. Fall back to regex-extracting the first object blob, for models
    //    that emit preamble/trailing text around the JSON.
    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      const parsed = this.safeJsonParse(objectMatch[0]);
      if (parsed !== undefined) {
        const arr = this.findInsightsArrayIn(parsed);
        if (arr) return arr;
      }
    }

    // 3. Legacy/tolerant: accept a bare array (pre-wrapper contract).
    //    LLM02-F1: non-greedy regex bounds the match size.
    const arrayMatch = text.match(/\[[\s\S]*?\]/);
    if (arrayMatch) {
      const parsed = this.safeJsonParse(arrayMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    }

    return null;
  }

  private safeJsonParse(text: string): unknown | undefined {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  private findInsightsArrayIn(value: unknown): unknown[] | null {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return null;
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.insights)) return obj.insights;
    // Some models emit alternate key names; accept the common ones.
    if (Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj.data)) return obj.data;
    return null;
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
