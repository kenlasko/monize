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
  config: ReportConfig,
): ReportConfig {
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
