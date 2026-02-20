import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AiService } from "../ai.service";
import { AiUsageService } from "../ai-usage.service";
import { AiUsageLog } from "../entities/ai-usage-log.entity";
import {
  ForecastAggregatorService,
  ForecastAggregates,
} from "./forecast-aggregator.service";
import { FORECAST_SYSTEM_PROMPT } from "../context/prompt-templates";
import { sanitizePromptValue } from "../context/prompt-sanitize";
import { UserPreference } from "../../users/entities/user-preference.entity";
import {
  ForecastResponse,
  ForecastMonthProjection,
  ForecastRiskFlag,
  ForecastKeyExpense,
} from "./dto/ai-forecast.dto";

const MIN_FORECAST_INTERVAL_HOURS = 6;
const DEFAULT_FORECAST_MONTHS = 3;

const VALID_SEVERITIES = new Set(["info", "warning", "alert"]);
const MAX_NARRATIVE_LENGTH = 5000;
const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_EXPENSE_DESCRIPTION_LENGTH = 255;

@Injectable()
export class AiForecastService {
  private readonly logger = new Logger(AiForecastService.name);

  constructor(
    @InjectRepository(UserPreference)
    private readonly prefRepo: Repository<UserPreference>,
    @InjectRepository(AiUsageLog)
    private readonly usageLogRepo: Repository<AiUsageLog>,
    private readonly aiService: AiService,
    private readonly usageService: AiUsageService,
    private readonly aggregatorService: ForecastAggregatorService,
  ) {}

  async generateForecast(
    userId: string,
    months?: number,
  ): Promise<ForecastResponse> {
    await this.checkRateLimit(userId);

    const preferences = await this.prefRepo.findOne({
      where: { userId },
    });
    const currency = preferences?.defaultCurrency || "USD";

    let aggregates: ForecastAggregates;
    try {
      aggregates = await this.aggregatorService.computeAggregates(
        userId,
        currency,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Failed to compute forecast aggregates for user ${userId}: ${message}`,
      );
      throw new BadRequestException(
        "Failed to gather financial data for forecasting. Please try again.",
      );
    }

    if (aggregates.monthlyHistory.length < 2) {
      throw new BadRequestException(
        "Insufficient transaction history for forecasting. At least 2 months of data are required.",
      );
    }

    const forecastMonths = months ?? DEFAULT_FORECAST_MONTHS;
    const prompt = this.buildForecastPrompt(aggregates, forecastMonths);

    try {
      const response = await this.aiService.complete(
        userId,
        {
          systemPrompt: FORECAST_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
          maxTokens: 4096,
          temperature: 0.3,
          responseFormat: "json",
        },
        "forecast",
      );

      return this.parseForecastResponse(
        response.content,
        aggregates,
        forecastMonths,
        currency,
      );
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(
        `Failed to generate AI forecast for user ${userId}: ${message}`,
      );
      throw new BadRequestException(
        "Failed to generate forecast. Please try again.",
      );
    }
  }

  private async checkRateLimit(userId: string): Promise<void> {
    const cutoff = new Date(
      Date.now() - MIN_FORECAST_INTERVAL_HOURS * 60 * 60 * 1000,
    );

    const recentLog = await this.usageLogRepo
      .createQueryBuilder("log")
      .where("log.userId = :userId", { userId })
      .andWhere("log.feature = :feature", { feature: "forecast" })
      .andWhere("log.error IS NULL")
      .andWhere("log.createdAt > :cutoff", { cutoff })
      .getOne();

    if (recentLog) {
      throw new BadRequestException(
        "A forecast was recently generated. Please try again later.",
      );
    }
  }

  private buildForecastPrompt(
    aggregates: ForecastAggregates,
    forecastMonths: number,
  ): string {
    const sections: string[] = [];

    sections.push(
      `Currency: ${aggregates.currency}`,
      `Today: ${aggregates.today}`,
      `Forecast period: ${forecastMonths} months forward`,
    );

    sections.push("\n--- CURRENT ACCOUNT BALANCES ---");
    sections.push(
      `Total balance: ${aggregates.accountBalances.totalBalance.toFixed(2)}`,
    );
    for (const acct of aggregates.accountBalances.accounts) {
      sections.push(
        `${sanitizePromptValue(acct.name)} (${acct.accountType}): ${acct.balance.toFixed(2)} ${acct.currencyCode}`,
      );
    }

    sections.push("\n--- MONTHLY TRANSACTION HISTORY (12 months) ---");
    for (const month of aggregates.monthlyHistory) {
      const topExpenses = month.categoryBreakdown
        .filter((c) => !c.isIncome)
        .slice(0, 5)
        .map((c) => `${sanitizePromptValue(c.categoryName)}=${c.total.toFixed(2)}`)
        .join(", ");
      sections.push(
        `${month.month}: income=${month.totalIncome.toFixed(2)}, expenses=${month.totalExpenses.toFixed(2)}, net=${month.netCashFlow.toFixed(2)} (top expenses: ${topExpenses})`,
      );
    }

    sections.push("\n--- INCOME PATTERNS ---");
    sections.push(
      `Average monthly income: ${aggregates.incomePatterns.averageMonthlyIncome.toFixed(2)}`,
      `Income variability (CV): ${aggregates.incomePatterns.incomeVariability.toFixed(2)}`,
    );
    if (aggregates.incomePatterns.incomeVariability > 0.3) {
      sections.push(
        "NOTE: High income variability detected (freelancer/contractor pattern)",
      );
    }

    sections.push("\n--- SCHEDULED/RECURRING FUTURE TRANSACTIONS ---");
    for (const st of aggregates.scheduledTransactions.slice(0, 20)) {
      const type = st.isIncome ? "INCOME" : "EXPENSE";
      if (!st.isTransfer) {
        sections.push(
          `${sanitizePromptValue(st.name)}: ${st.amount.toFixed(2)} (${st.frequency}, next: ${st.nextDueDate}, ${type}, category: ${sanitizePromptValue(st.categoryName || "unknown")})`,
        );
      }
    }

    if (aggregates.recurringCharges.length > 0) {
      sections.push("\n--- DETECTED RECURRING CHARGES ---");
      for (const charge of aggregates.recurringCharges.slice(0, 15)) {
        sections.push(
          `${sanitizePromptValue(charge.payeeName)} (${charge.frequency}): latest=${charge.currentAmount.toFixed(2)}, category=${sanitizePromptValue(charge.categoryName || "unknown")}`,
        );
      }
    }

    return sections.join("\n");
  }

  private parseForecastResponse(
    content: string,
    aggregates: ForecastAggregates,
    forecastMonths: number,
    currency: string,
  ): ForecastResponse {
    const trimmed = content.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn("AI forecast response did not contain a JSON object");
      throw new BadRequestException(
        "Failed to generate forecast. Please try again.",
      );
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);

      return {
        generatedAt: new Date().toISOString(),
        currency,
        currentBalance: aggregates.accountBalances.totalBalance,
        forecastMonths,
        monthlyProjections: this.validateProjections(parsed.monthlyProjections),
        riskFlags: this.validateRiskFlags(parsed.riskFlags || []),
        narrativeSummary: this.sanitizeNarrative(parsed.narrativeSummary || ""),
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.warn(`Failed to parse AI forecast response: ${message}`);
      throw new BadRequestException(
        "Failed to generate forecast. Please try again.",
      );
    }
  }

  private validateProjections(raw: unknown): ForecastMonthProjection[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const obj = item as Record<string, unknown>;
        return (
          typeof obj.month === "string" &&
          /^\d{4}-\d{2}$/.test(obj.month) &&
          typeof obj.projectedIncome === "number" &&
          typeof obj.projectedExpenses === "number"
        );
      })
      .map((item: Record<string, unknown>) => ({
        month: item.month as string,
        projectedIncome: Number(item.projectedIncome) || 0,
        projectedExpenses: Number(item.projectedExpenses) || 0,
        projectedNetCashFlow: Number(item.projectedNetCashFlow) || 0,
        projectedEndingBalance: Number(item.projectedEndingBalance) || 0,
        confidenceLow: Number(item.confidenceLow) || 0,
        confidenceHigh: Number(item.confidenceHigh) || 0,
        keyExpenses: this.validateKeyExpenses(item.keyExpenses),
      }));
  }

  private validateKeyExpenses(raw: unknown): ForecastKeyExpense[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const obj = item as Record<string, unknown>;
        return (
          typeof obj.description === "string" && typeof obj.amount === "number"
        );
      })
      .slice(0, 10)
      .map((item: Record<string, unknown>) => ({
        description: String(item.description).substring(
          0,
          MAX_EXPENSE_DESCRIPTION_LENGTH,
        ),
        amount: Number(item.amount) || 0,
        category:
          item.category != null
            ? String(item.category).substring(0, 255)
            : null,
        isRecurring: item.isRecurring === true,
        isIrregular: item.isIrregular === true,
      }));
  }

  private validateRiskFlags(raw: unknown): ForecastRiskFlag[] {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const obj = item as Record<string, unknown>;
        return (
          typeof obj.month === "string" &&
          typeof obj.severity === "string" &&
          VALID_SEVERITIES.has(obj.severity) &&
          typeof obj.title === "string" &&
          typeof obj.description === "string"
        );
      })
      .map((item: Record<string, unknown>) => ({
        month: item.month as string,
        severity: item.severity as "info" | "warning" | "alert",
        title: String(item.title).substring(0, MAX_TITLE_LENGTH),
        description: String(item.description).substring(
          0,
          MAX_DESCRIPTION_LENGTH,
        ),
      }));
  }

  private sanitizeNarrative(raw: string): string {
    if (typeof raw !== "string") return "";
    return raw.substring(0, MAX_NARRATIVE_LENGTH);
  }
}
