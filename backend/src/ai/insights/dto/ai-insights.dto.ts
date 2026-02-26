import { IsOptional, IsString, IsIn, IsBoolean } from "class-validator";
import { Transform } from "class-transformer";
import {
  INSIGHT_TYPES,
  INSIGHT_SEVERITIES,
  InsightType,
  InsightSeverity,
} from "../../../ai/entities/ai-insight.entity";

export class GetInsightsQueryDto {
  @IsOptional()
  @IsString()
  @IsIn([...INSIGHT_TYPES])
  type?: InsightType;

  @IsOptional()
  @IsString()
  @IsIn([...INSIGHT_SEVERITIES])
  severity?: InsightSeverity;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === "true" || value === true)
  includeDismissed?: boolean;
}

export interface AiInsightResponse {
  id: string;
  type: InsightType;
  title: string;
  description: string;
  severity: InsightSeverity;
  data: Record<string, unknown>;
  isDismissed: boolean;
  generatedAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface InsightsListResponse {
  insights: AiInsightResponse[];
  total: number;
  lastGeneratedAt: string | null;
  isGenerating: boolean;
}
