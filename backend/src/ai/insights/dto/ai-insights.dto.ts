import { IsOptional, IsString, IsIn } from "class-validator";
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
  @IsString()
  @IsIn(["true", "false"])
  includeDismissed?: string;
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
