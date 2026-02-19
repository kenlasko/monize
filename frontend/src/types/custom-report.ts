export enum ReportViewType {
  TABLE = 'TABLE',
  LINE_CHART = 'LINE_CHART',
  BAR_CHART = 'BAR_CHART',
  PIE_CHART = 'PIE_CHART',
}

export enum TimeframeType {
  LAST_7_DAYS = 'LAST_7_DAYS',
  LAST_30_DAYS = 'LAST_30_DAYS',
  LAST_MONTH = 'LAST_MONTH',
  LAST_3_MONTHS = 'LAST_3_MONTHS',
  LAST_6_MONTHS = 'LAST_6_MONTHS',
  LAST_12_MONTHS = 'LAST_12_MONTHS',
  LAST_YEAR = 'LAST_YEAR',
  YEAR_TO_DATE = 'YEAR_TO_DATE',
  CUSTOM = 'CUSTOM',
}

export enum GroupByType {
  NONE = 'NONE',
  CATEGORY = 'CATEGORY',
  PAYEE = 'PAYEE',
  YEAR = 'YEAR',
  MONTH = 'MONTH',
  WEEK = 'WEEK',
  DAY = 'DAY',
}

export enum MetricType {
  NONE = 'NONE',
  TOTAL_AMOUNT = 'TOTAL_AMOUNT',
  COUNT = 'COUNT',
  AVERAGE = 'AVERAGE',
  BUDGET_VARIANCE = 'BUDGET_VARIANCE',
}

export enum DirectionFilter {
  INCOME_ONLY = 'INCOME_ONLY',
  EXPENSES_ONLY = 'EXPENSES_ONLY',
  BOTH = 'BOTH',
}

export enum TableColumn {
  // Aggregation columns
  LABEL = 'LABEL',
  VALUE = 'VALUE',
  COUNT = 'COUNT',
  PERCENTAGE = 'PERCENTAGE',
  // Transaction-specific columns (for no-aggregation mode)
  DATE = 'DATE',
  PAYEE = 'PAYEE',
  DESCRIPTION = 'DESCRIPTION',
  MEMO = 'MEMO',
  CATEGORY = 'CATEGORY',
  ACCOUNT = 'ACCOUNT',
}

export enum SortDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

export type FilterField = 'account' | 'category' | 'payee' | 'text';

export interface FilterCondition {
  field: FilterField;
  value: string; // UUID for entity fields, search string for text
}

export interface FilterGroup {
  conditions: FilterCondition[]; // Combined with OR
}

export interface ReportFilters {
  // Legacy (kept for backward compat, ignored when filterGroups present)
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  searchText?: string;
  // Advanced
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

export interface CustomReport {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  icon: string | null;
  backgroundColor: string | null;
  viewType: ReportViewType;
  timeframeType: TimeframeType;
  groupBy: GroupByType;
  filters: ReportFilters;
  config: ReportConfig;
  isFavourite: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCustomReportData {
  name: string;
  description?: string;
  icon?: string;
  backgroundColor?: string;
  viewType?: ReportViewType;
  timeframeType?: TimeframeType;
  groupBy?: GroupByType;
  filters?: ReportFilters;
  config?: Partial<ReportConfig>;
  isFavourite?: boolean;
  sortOrder?: number;
}

export type UpdateCustomReportData = Partial<CreateCustomReportData>;

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
  viewType: ReportViewType;
  groupBy: GroupByType;
  timeframe: ReportTimeframe;
  data: AggregatedDataPoint[];
  summary: ReportSummary;
  tableColumns?: TableColumn[];
}

// UI Labels for enums
export const VIEW_TYPE_LABELS: Record<ReportViewType, string> = {
  [ReportViewType.TABLE]: 'Table',
  [ReportViewType.LINE_CHART]: 'Line Chart',
  [ReportViewType.BAR_CHART]: 'Bar Chart',
  [ReportViewType.PIE_CHART]: 'Pie Chart',
};

export const TIMEFRAME_LABELS: Record<TimeframeType, string> = {
  [TimeframeType.LAST_7_DAYS]: 'Last 7 Days',
  [TimeframeType.LAST_30_DAYS]: 'Last 30 Days',
  [TimeframeType.LAST_MONTH]: 'Last Month',
  [TimeframeType.LAST_3_MONTHS]: 'Last 3 Months',
  [TimeframeType.LAST_6_MONTHS]: 'Last 6 Months',
  [TimeframeType.LAST_12_MONTHS]: 'Last 12 Months',
  [TimeframeType.LAST_YEAR]: 'Last Year',
  [TimeframeType.YEAR_TO_DATE]: 'Year to Date',
  [TimeframeType.CUSTOM]: 'Custom Range',
};

export const GROUP_BY_LABELS: Record<GroupByType, string> = {
  [GroupByType.NONE]: 'No Grouping',
  [GroupByType.CATEGORY]: 'Category',
  [GroupByType.PAYEE]: 'Payee',
  [GroupByType.YEAR]: 'Year',
  [GroupByType.MONTH]: 'Month',
  [GroupByType.WEEK]: 'Week',
  [GroupByType.DAY]: 'Day',
};

export const METRIC_LABELS: Record<MetricType, string> = {
  [MetricType.NONE]: 'No Aggregation',
  [MetricType.TOTAL_AMOUNT]: 'Total Amount',
  [MetricType.COUNT]: 'Transaction Count',
  [MetricType.AVERAGE]: 'Average Amount',
  [MetricType.BUDGET_VARIANCE]: 'Budget Variance',
};

export const DIRECTION_LABELS: Record<DirectionFilter, string> = {
  [DirectionFilter.INCOME_ONLY]: 'Income Only',
  [DirectionFilter.EXPENSES_ONLY]: 'Expenses Only',
  [DirectionFilter.BOTH]: 'Both',
};

export const TABLE_COLUMN_LABELS: Record<TableColumn, string> = {
  // Aggregation columns
  [TableColumn.LABEL]: 'Label',
  [TableColumn.VALUE]: 'Value',
  [TableColumn.COUNT]: 'Count',
  [TableColumn.PERCENTAGE]: 'Percentage',
  // Transaction columns
  [TableColumn.DATE]: 'Date',
  [TableColumn.PAYEE]: 'Payee',
  [TableColumn.DESCRIPTION]: 'Description',
  [TableColumn.MEMO]: 'Memo',
  [TableColumn.CATEGORY]: 'Category',
  [TableColumn.ACCOUNT]: 'Account',
};

export const SORT_DIRECTION_LABELS: Record<SortDirection, string> = {
  [SortDirection.ASC]: 'Ascending',
  [SortDirection.DESC]: 'Descending',
};
