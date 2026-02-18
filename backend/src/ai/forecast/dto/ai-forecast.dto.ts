import { IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class ForecastRequestDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  @Type(() => Number)
  months?: number;
}

export interface ForecastKeyExpense {
  description: string;
  amount: number;
  category: string | null;
  isRecurring: boolean;
  isIrregular: boolean;
}

export interface ForecastMonthProjection {
  month: string;
  projectedIncome: number;
  projectedExpenses: number;
  projectedNetCashFlow: number;
  projectedEndingBalance: number;
  confidenceLow: number;
  confidenceHigh: number;
  keyExpenses: ForecastKeyExpense[];
}

export interface ForecastRiskFlag {
  month: string;
  severity: "info" | "warning" | "alert";
  title: string;
  description: string;
}

export interface ForecastResponse {
  generatedAt: string;
  currency: string;
  currentBalance: number;
  forecastMonths: number;
  monthlyProjections: ForecastMonthProjection[];
  riskFlags: ForecastRiskFlag[];
  narrativeSummary: string;
}
