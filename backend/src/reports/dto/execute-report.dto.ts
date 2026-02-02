import { IsOptional, IsDateString, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TimeframeType, TableColumn } from '../entities/custom-report.entity';

export class ExecuteReportDto {
  @ApiPropertyOptional({ description: 'Override timeframe type', enum: TimeframeType })
  @IsOptional()
  @IsEnum(TimeframeType)
  timeframeType?: TimeframeType;

  @ApiPropertyOptional({ description: 'Override start date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Override end date (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

// Response interfaces
export interface AggregatedDataPoint {
  label: string;
  value: number;
  id?: string;
  color?: string;
  percentage?: number;
  count?: number;
  // Transaction-specific fields (for no-aggregation mode)
  date?: string;
  payee?: string;
  description?: string;
  memo?: string;
  category?: string;
  account?: string;
}

export interface ReportTimeframe {
  startDate: string;
  endDate: string;
  label: string;
}

export interface ReportSummary {
  total: number;
  count: number;
  average: number;
}

export interface ReportResult {
  reportId: string;
  name: string;
  viewType: string;
  groupBy: string;
  timeframe: ReportTimeframe;
  data: AggregatedDataPoint[];
  summary: ReportSummary;
  tableColumns?: TableColumn[];
}
