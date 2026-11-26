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
  TAG = 'TAG',
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
  ACCOUNT_AMOUNT = 'ACCOUNT_AMOUNT',
  ORIGINAL_AMOUNT = 'ORIGINAL_AMOUNT',
  TAG = 'TAG',
}

export enum SortDirection {
  ASC = 'ASC',
  DESC = 'DESC',
}

export type FilterField = 'account' | 'category' | 'payee' | 'tag' | 'text';

export interface FilterCondition {
  field: FilterField;
  value: string | string[]; // string[] of UUIDs for entity fields, string for text
}

export interface FilterGroup {
  conditions: FilterCondition[]; // Combined with OR
}

export interface ReportFilters {
  // Legacy (kept for backward compat, ignored when filterGroups present)
  accountIds?: string[];
  categoryIds?: string[];
  payeeIds?: string[];
  tagIds?: string[];
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
  /**
   * The figure in the report's currency. `null` only on a listed transaction
   * with no rate into it on its date: the row stays listed under its own
   * `accountAmount` so it can be matched against a statement, and is in no
   * total (`excludedCount` counts it).
   */
  value: number | null;
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
  /** The row's own tags (and, for a split line, its own plus the parent's), joined for display. */
  tags?: string;
  /**
   * The row's own amount in its account's currency, unconverted and signed as
   * `value` is; `accountCurrency` names its currency. A column of these mixes
   * currencies, so it has no total.
   */
  accountAmount?: number;
  accountCurrency?: string;
  /**
   * What a row entered in a foreign currency was entered as, unconverted and
   * signed as `value` is; `originalCurrency` names its currency. Absent on an
   * ordinary row and on a split line. A column of these has no total.
   */
  originalAmount?: number;
  originalCurrency?: string;
  // Budget variance fields (for BUDGET_VARIANCE metric)
  budgeted?: number;
  actual?: number;
}

export interface ReportTimeframe {
  startDate: string;
  endDate: string;
  label: string;
}

export interface ReportSummary {
  /**
   * A truncated read or a missing exchange rate withholds the full amount.
   * Counts require no rate and are withheld only for a truncated read.
   */
  total: number | null;
  /** The same metric over the known population, rounded once. Show it as a subtotal when total is null. */
  knownTotal: number;
  /**
   * Signed totals count a posting once across overlapping tags. An unconverted
   * posting is excluded from a monetary aggregate but remains on a transaction list.
   */
  count: number;
  /** `null` with `total`. */
  average: number | null;
  /**
   * Provisional transfer amounts (an imported estimate awaiting the other
   * account's file or the reader's confirmation) inside `total` /
   * `knownTotal`. The figures include them; absent means no information.
   */
  provisionalCount?: number;
}

export interface ReportResult {
  reportId: string;
  name: string;
  viewType: ReportViewType;
  groupBy: GroupByType;
  timeframe: ReportTimeframe;
  data: AggregatedDataPoint[];
  summary: ReportSummary;
  /** Present when Both / Total Amount used signed postings. Older servers return unsigned totals. */
  signedTotal?: true;
  /** Reporting currency every money figure is expressed in. */
  currency: string;
  /** Source currencies with no rate into `currency`; their rows are in no figure. */
  missingCurrencies: string[];
  /** Rows (or split lines) left out of every figure for want of a rate. */
  excludedCount: number;
  /** {@link ReportSummary.provisionalCount}, beside the other completeness fields. */
  provisionalCount?: number;
  /** The row limit cut the read short (newest rows dropped): every figure is a subtotal. */
  truncated?: boolean;
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
  [GroupByType.TAG]: 'Tag',
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
  [TableColumn.ACCOUNT_AMOUNT]: 'Amount (account currency)',
  [TableColumn.ORIGINAL_AMOUNT]: 'Amount (original currency)',
  [TableColumn.TAG]: 'Tag',
};

export const SORT_DIRECTION_LABELS: Record<SortDirection, string> = {
  [SortDirection.ASC]: 'Ascending',
  [SortDirection.DESC]: 'Descending',
};
