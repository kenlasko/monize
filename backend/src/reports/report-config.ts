import {
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportCategoryType,
  ReportConfig,
  TransferMeasure,
} from "./entities/custom-report.entity";

/** Resolve the stored population before changes to the layout can reinterpret it. */
export function resolveReportConfig(
  groupBy: GroupByType,
  input?: Partial<ReportConfig> | null,
): ReportConfig {
  // A cleared measure (null on an update) is no measure: the key is dropped,
  // so a report without one stores and reads exactly as before.
  const { transferMeasure, ...rest } = input ?? {};
  const stored: Partial<ReportConfig> = transferMeasure
    ? { ...rest, transferMeasure }
    : rest;
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

/**
 * The configuration the aggregation reads under a transfer measure
 * (docs/specs/transfer-categories.md section 8.2): legs only, so transfers are
 * in; no category type narrows them; and the measure takes the direction's
 * place. OUTGOING settles each cell as spending does (its net negated, a
 * magnitude), INCOMING as income does, NET signed. A transaction list (metric
 * NONE, no grouping) keeps each leg's own sign, as a one-direction list does.
 * Without a measure the configuration is returned as it is.
 */
export function aggregationConfig(
  groupBy: GroupByType,
  config: ReportConfig,
): ReportConfig {
  const measure = config.transferMeasure;
  if (!measure) return config;
  const list =
    groupBy === GroupByType.NONE && config.metric === MetricType.NONE;
  const direction =
    measure === TransferMeasure.NET
      ? DirectionFilter.BOTH
      : measure === TransferMeasure.OUTGOING
        ? list
          ? DirectionFilter.OUTGOING
          : DirectionFilter.EXPENSES_ONLY
        : list
          ? DirectionFilter.INCOMING
          : DirectionFilter.INCOME_ONLY;
  return {
    ...config,
    direction,
    includeTransfers: true,
    categoryType: ReportCategoryType.ALL,
  };
}
