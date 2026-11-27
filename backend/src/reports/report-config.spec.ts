import { aggregationConfig, resolveReportConfig } from "./report-config";
import {
  DirectionFilter,
  GroupByType,
  MetricType,
  ReportCategoryType,
  TransferMeasure,
} from "./entities/custom-report.entity";

describe("resolveReportConfig and the transfer measure", () => {
  it("drops a cleared measure, so the report stores as before", () => {
    const config = resolveReportConfig(GroupByType.CATEGORY, {
      metric: MetricType.TOTAL_AMOUNT,
      transferMeasure: null,
    });
    expect("transferMeasure" in config).toBe(false);
  });

  it("keeps a measure it is given", () => {
    expect(
      resolveReportConfig(GroupByType.CATEGORY, {
        transferMeasure: TransferMeasure.NET,
      }).transferMeasure,
    ).toBe(TransferMeasure.NET);
  });
});

// docs/specs/transfer-categories.md section 8.2.
describe("aggregationConfig", () => {
  const base = resolveReportConfig(GroupByType.CATEGORY, {
    metric: MetricType.TOTAL_AMOUNT,
    direction: DirectionFilter.EXPENSES_ONLY,
  });

  it("returns a report without a measure unchanged", () => {
    expect(aggregationConfig(GroupByType.CATEGORY, base)).toBe(base);
  });

  it.each([
    [TransferMeasure.OUTGOING, DirectionFilter.EXPENSES_ONLY],
    [TransferMeasure.INCOMING, DirectionFilter.INCOME_ONLY],
    [TransferMeasure.NET, DirectionFilter.BOTH],
  ])("settles %s cells as %s, transfers in, any category", (measure, dir) => {
    const config = aggregationConfig(GroupByType.CATEGORY, {
      ...base,
      transferMeasure: measure,
    });
    expect(config).toMatchObject({
      direction: dir,
      includeTransfers: true,
      categoryType: ReportCategoryType.ALL,
      transferMeasure: measure,
    });
  });

  it.each([
    [TransferMeasure.OUTGOING, DirectionFilter.OUTGOING],
    [TransferMeasure.INCOMING, DirectionFilter.INCOMING],
    [TransferMeasure.NET, DirectionFilter.BOTH],
  ])("lists %s legs with their own sign", (measure, dir) => {
    const config = aggregationConfig(GroupByType.NONE, {
      ...base,
      metric: MetricType.NONE,
      transferMeasure: measure,
    });
    expect(config.direction).toBe(dir);
  });
});
