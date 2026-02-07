import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsArray,
  IsUUID,
  IsObject,
  IsIn,
  MaxLength,
  ValidateNested,
  IsDateString,
  IsNumber,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ReportViewType,
  TimeframeType,
  GroupByType,
  MetricType,
  DirectionFilter,
  TableColumn,
  SortDirection,
} from '../entities/custom-report.entity';

export class FilterConditionDto {
  @ApiProperty({ description: 'Field to filter on', enum: ['account', 'category', 'payee', 'text'] })
  @IsIn(['account', 'category', 'payee', 'text'])
  field: 'account' | 'category' | 'payee' | 'text';

  @ApiProperty({ description: 'Value to match (UUID for entity fields, search string for text)' })
  @IsString()
  value: string;
}

export class FilterGroupDto {
  @ApiProperty({ description: 'Conditions combined with OR', type: [FilterConditionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterConditionDto)
  conditions: FilterConditionDto[];
}

export class ReportFiltersDto {
  @ApiPropertyOptional({ description: 'Account IDs to filter by (legacy)' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  accountIds?: string[];

  @ApiPropertyOptional({ description: 'Category IDs to filter by (legacy)' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ description: 'Payee IDs to filter by (legacy)' })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  payeeIds?: string[];

  @ApiPropertyOptional({ description: 'Text to search in payee, description, or memo (legacy)' })
  @IsOptional()
  @IsString()
  searchText?: string;

  @ApiPropertyOptional({ description: 'Advanced filter groups (AND between groups, OR within)', type: [FilterGroupDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterGroupDto)
  filterGroups?: FilterGroupDto[];
}

export class ReportConfigDto {
  @ApiPropertyOptional({ description: 'Metric to calculate', enum: MetricType })
  @IsOptional()
  @IsEnum(MetricType)
  metric?: MetricType;

  @ApiPropertyOptional({ description: 'Include transfers in calculations' })
  @IsOptional()
  @IsBoolean()
  includeTransfers?: boolean;

  @ApiPropertyOptional({ description: 'Filter direction', enum: DirectionFilter })
  @IsOptional()
  @IsEnum(DirectionFilter)
  direction?: DirectionFilter;

  @ApiPropertyOptional({ description: 'Custom start date for CUSTOM timeframe (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  customStartDate?: string;

  @ApiPropertyOptional({ description: 'Custom end date for CUSTOM timeframe (YYYY-MM-DD)' })
  @IsOptional()
  @IsDateString()
  customEndDate?: string;

  @ApiPropertyOptional({ description: 'Columns to display in table view', enum: TableColumn, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(TableColumn, { each: true })
  tableColumns?: TableColumn[];

  @ApiPropertyOptional({ description: 'Column to sort by', enum: TableColumn })
  @IsOptional()
  @IsEnum(TableColumn)
  sortBy?: TableColumn;

  @ApiPropertyOptional({ description: 'Sort direction', enum: SortDirection })
  @IsOptional()
  @IsEnum(SortDirection)
  sortDirection?: SortDirection;
}

export class CreateCustomReportDto {
  @ApiProperty({ description: 'Report name' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: 'Report description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Icon identifier (emoji or icon name)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @ApiPropertyOptional({ description: 'Background color as hex code (e.g., #3b82f6)' })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, { message: 'Background color must be in hex format (e.g., #3b82f6)' })
  backgroundColor?: string;

  @ApiPropertyOptional({ description: 'View type for the report', enum: ReportViewType })
  @IsOptional()
  @IsEnum(ReportViewType)
  viewType?: ReportViewType;

  @ApiPropertyOptional({ description: 'Timeframe type', enum: TimeframeType })
  @IsOptional()
  @IsEnum(TimeframeType)
  timeframeType?: TimeframeType;

  @ApiPropertyOptional({ description: 'How to group/aggregate data', enum: GroupByType })
  @IsOptional()
  @IsEnum(GroupByType)
  groupBy?: GroupByType;

  @ApiPropertyOptional({ description: 'Filters to apply', type: ReportFiltersDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReportFiltersDto)
  filters?: ReportFiltersDto;

  @ApiPropertyOptional({ description: 'Report configuration', type: ReportConfigDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => ReportConfigDto)
  config?: ReportConfigDto;

  @ApiPropertyOptional({ description: 'Mark as favourite' })
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;

  @ApiPropertyOptional({ description: 'Sort order for display' })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;
}
