import type { ReportingBasis } from "../accruals/reporting-basis";
export const REPORT_TOOL_TYPES = [
  "spending_by_category",
  "spending_by_payee",
  "income_vs_expenses",
  "monthly_trend",
  "income_by_source",
  "spending_anomalies",
  "month_comparison",
  "net_worth_history",
] as const;
export interface BuiltInReportRequest {
  type: (typeof REPORT_TOOL_TYPES)[number];
  basis?: ReportingBasis;
  startDate?: string;
  endDate?: string;
  months?: number;
  month?: string;
}
