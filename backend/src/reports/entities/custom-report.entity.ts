import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from "typeorm";

// Enum definitions
export enum ReportViewType {
  TABLE = "TABLE",
  LINE_CHART = "LINE_CHART",
  BAR_CHART = "BAR_CHART",
  PIE_CHART = "PIE_CHART",
}

export enum TimeframeType {
  LAST_7_DAYS = "LAST_7_DAYS",
  LAST_30_DAYS = "LAST_30_DAYS",
  LAST_MONTH = "LAST_MONTH",
  LAST_3_MONTHS = "LAST_3_MONTHS",
  LAST_6_MONTHS = "LAST_6_MONTHS",
  LAST_12_MONTHS = "LAST_12_MONTHS",
  LAST_YEAR = "LAST_YEAR",
  YEAR_TO_DATE = "YEAR_TO_DATE",
  CUSTOM = "CUSTOM",
}

export enum GroupByType {
  NONE = "NONE",
  CATEGORY = "CATEGORY",
  PAYEE = "PAYEE",
  YEAR = "YEAR",
  MONTH = "MONTH",
  WEEK = "WEEK",
  DAY = "DAY",
}

export enum MetricType {
  NONE = "NONE",
  TOTAL_AMOUNT = "TOTAL_AMOUNT",
  COUNT = "COUNT",
  AVERAGE = "AVERAGE",
}

export enum DirectionFilter {
  INCOME_ONLY = "INCOME_ONLY",
  EXPENSES_ONLY = "EXPENSES_ONLY",
  BOTH = "BOTH",
}

// Table column options - aggregation columns
export enum TableColumn {
  LABEL = "LABEL",
  VALUE = "VALUE",
  COUNT = "COUNT",
  PERCENTAGE = "PERCENTAGE",
  // Transaction-specific columns (for no-aggregation mode)
  DATE = "DATE",
  PAYEE = "PAYEE",
  DESCRIPTION = "DESCRIPTION",
  MEMO = "MEMO",
  CATEGORY = "CATEGORY",
  ACCOUNT = "ACCOUNT",
}

// Sort direction
export enum SortDirection {
  ASC = "ASC",
  DESC = "DESC",
}

// Filter group types
export type FilterField = "account" | "category" | "payee" | "text";

export interface FilterCondition {
  field: FilterField;
  value: string;
}

export interface FilterGroup {
  conditions: FilterCondition[];
}

// JSON column interfaces
export interface ReportFilters {
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  searchText?: string;
  filterGroups?: FilterGroup[];
}

export interface ReportConfig {
  metric: MetricType;
  includeTransfers: boolean;
  direction: DirectionFilter;
  customStartDate?: string;
  customEndDate?: string;
  tableColumns?: TableColumn[];
  sortBy?: TableColumn;
  sortDirection?: SortDirection;
}

@Entity("custom_reports")
export class CustomReport {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  @Column({ type: "varchar", length: 255 })
  name: string;

  @Column({ type: "text", nullable: true })
  description: string | null;

  @Column({ type: "varchar", length: 50, nullable: true })
  icon: string | null;

  @Column({
    type: "varchar",
    name: "background_color",
    length: 7,
    nullable: true,
  })
  backgroundColor: string | null;

  @Column({
    type: "varchar",
    length: 20,
    name: "view_type",
    default: ReportViewType.BAR_CHART,
  })
  viewType: ReportViewType;

  @Column({
    type: "varchar",
    length: 30,
    name: "timeframe_type",
    default: TimeframeType.LAST_3_MONTHS,
  })
  timeframeType: TimeframeType;

  @Column({
    type: "varchar",
    length: 20,
    name: "group_by",
    default: GroupByType.NONE,
  })
  groupBy: GroupByType;

  @Column({ type: "jsonb", default: "{}" })
  filters: ReportFilters;

  @Column({ type: "jsonb", default: "{}" })
  config: ReportConfig;

  @Column({ name: "is_favourite", default: false })
  isFavourite: boolean;

  @Column({ name: "sort_order", type: "int", default: 0 })
  sortOrder: number;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
