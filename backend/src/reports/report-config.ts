import {
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportCategoryType,
  ReportConfig,
} from "./entities/custom-report.entity";

/** Resolve the stored population before changes to the layout can reinterpret it. */
export function resolveReportConfig(
  groupBy: GroupByType,
  input?: Partial<ReportConfig> | null,
): ReportConfig {
  const stored = input ?? {};
  const config: ReportConfig = {
    ...stored,
    metric: stored.metric ?? MetricType.TOTAL_AMOUNT,
    includeTransfers: stored.includeTransfers ?? false,
    direction:
      stored.direction ??
      (stored.categoryType
        ? DirectionFilter.BOTH
        : DirectionFilter.EXPENSES_ONLY),
  };
  const income = config.direction === DirectionFilter.INCOME_ONLY;
  if (!income && config.direction !== DirectionFilter.EXPENSES_ONLY) {
    return {
      ...config,
      categoryType: config.categoryType ?? ReportCategoryType.ALL,
    };
  }
  if (groupBy === GroupByType.NONE && config.metric === MetricType.NONE) {
    return {
      ...config,
      direction: income ? DirectionFilter.INCOMING : DirectionFilter.OUTGOING,
      categoryType: ReportCategoryType.ALL,
    };
  }
  return {
    ...config,
    direction: DirectionFilter.BOTH,
    categoryType: income
      ? ReportCategoryType.INCOME
      : ReportCategoryType.EXPENSE,
  };
}
