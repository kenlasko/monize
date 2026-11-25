import { Injectable } from "@nestjs/common";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ComparisonReportsService } from "./comparison-reports.service";
import {
  AnomalyReportsService,
  SPENDING_ANOMALY_DEFAULT_MONTHS,
  SPENDING_ANOMALY_DEFAULT_THRESHOLD,
} from "./anomaly-reports.service";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { DataQualityReportsService } from "./data-quality-reports.service";
import { MonthlyComparisonService } from "./monthly-comparison.service";
import { MonthlyCategoryBreakdownService } from "./monthly-category-breakdown.service";
import { CashFlowSankeyService } from "./cash-flow-sankey.service";
import type {
  IncomeExpenseBucket,
  WeekStartsOn,
} from "./income-expense-buckets";
import {
  SpendingByCategoryResponse,
  SpendingByPayeeResponse,
  IncomeBySourceResponse,
  MonthlySpendingTrendResponse,
  IncomeVsExpensesResponse,
  YearOverYearResponse,
  WeekendVsWeekdayResponse,
  SpendingAnomaliesResponse,
  TaxSummaryResponse,
  RecurringExpensesResponse,
  BillPaymentHistoryResponse,
  UncategorizedTransactionsResponse,
  DuplicateTransactionsResponse,
  MonthlyComparisonResponse,
  MonthlyCategoryBreakdownResponse,
  CashFlowSankeyResponse,
  SankeyDepth,
  DEFAULT_RECURRING_EXPENSE_RANGE,
  type RecurringExpenseRange,
} from "./dto";

@Injectable()
export class BuiltInReportsService {
  constructor(
    private spendingReports: SpendingReportsService,
    private incomeReports: IncomeReportsService,
    private comparisonReports: ComparisonReportsService,
    private anomalyReports: AnomalyReportsService,
    private taxRecurringReports: TaxRecurringReportsService,
    private dataQualityReports: DataQualityReportsService,
    private monthlyComparison: MonthlyComparisonService,
    private monthlyCategoryBreakdown: MonthlyCategoryBreakdownService,
    private cashFlowSankey: CashFlowSankeyService,
  ) {}

  getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options?: {
      rollupToParent?: boolean;
      accountIds?: string[];
      tagKey?: string;
      tagValue?: string;
    },
  ): Promise<SpendingByCategoryResponse> {
    return this.spendingReports.getSpendingByCategory(
      userId,
      startDate,
      endDate,
      options,
    );
  }

  getSpendingByPayee(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByPayeeResponse> {
    return this.spendingReports.getSpendingByPayee(userId, startDate, endDate);
  }

  getIncomeBySource(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options: { accountIds?: string[] } = {},
  ): Promise<IncomeBySourceResponse> {
    return this.incomeReports.getIncomeBySource(
      userId,
      startDate,
      endDate,
      options,
    );
  }

  getMonthlySpendingTrend(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<MonthlySpendingTrendResponse> {
    return this.spendingReports.getMonthlySpendingTrend(
      userId,
      startDate,
      endDate,
    );
  }

  getIncomeVsExpenses(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options?: {
      accountIds?: string[];
      bucket?: IncomeExpenseBucket;
      weekStartsOn?: WeekStartsOn;
      tagKey?: string;
      transferScopeAccountIds?: string[];
    },
  ): Promise<IncomeVsExpensesResponse> {
    return this.incomeReports.getIncomeVsExpenses(
      userId,
      startDate,
      endDate,
      options,
    );
  }

  getCashFlowSankey(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options?: { accountIds?: string[]; depth?: SankeyDepth },
  ): Promise<CashFlowSankeyResponse> {
    return this.cashFlowSankey.getCashFlowSankey(
      userId,
      startDate,
      endDate,
      options,
    );
  }

  getYearOverYear(
    userId: string,
    yearsToCompare: number,
  ): Promise<YearOverYearResponse> {
    return this.comparisonReports.getYearOverYear(userId, yearsToCompare);
  }

  getWeekendVsWeekday(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<WeekendVsWeekdayResponse> {
    return this.comparisonReports.getWeekendVsWeekday(
      userId,
      startDate,
      endDate,
    );
  }

  getSpendingAnomalies(
    userId: string,
    threshold: number = SPENDING_ANOMALY_DEFAULT_THRESHOLD,
    months: number = SPENDING_ANOMALY_DEFAULT_MONTHS,
  ): Promise<SpendingAnomaliesResponse> {
    return this.anomalyReports.getSpendingAnomalies(userId, threshold, months);
  }

  getTaxSummary(userId: string, year: number): Promise<TaxSummaryResponse> {
    return this.taxRecurringReports.getTaxSummary(userId, year);
  }

  getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
    range: RecurringExpenseRange = DEFAULT_RECURRING_EXPENSE_RANGE,
  ): Promise<RecurringExpensesResponse> {
    return this.taxRecurringReports.getRecurringExpenses(
      userId,
      minOccurrences,
      range,
    );
  }

  getBillPaymentHistory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<BillPaymentHistoryResponse> {
    return this.taxRecurringReports.getBillPaymentHistory(
      userId,
      startDate,
      endDate,
    );
  }

  getUncategorizedTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    limit: number = 500,
  ): Promise<UncategorizedTransactionsResponse> {
    return this.dataQualityReports.getUncategorizedTransactions(
      userId,
      startDate,
      endDate,
      limit,
    );
  }

  getDuplicateTransactions(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    sensitivity: "high" | "medium" | "low" = "medium",
  ): Promise<DuplicateTransactionsResponse> {
    return this.dataQualityReports.getDuplicateTransactions(
      userId,
      startDate,
      endDate,
      sensitivity,
    );
  }

  getMonthlyComparison(
    userId: string,
    month: string,
  ): Promise<MonthlyComparisonResponse> {
    return this.monthlyComparison.getMonthlyComparison(userId, month);
  }

  getMonthlyCategoryBreakdown(
    userId: string,
    startDate: string | undefined,
    endDate: string,
    options?: { accountIds?: string[]; period?: "month" | "year" },
  ): Promise<MonthlyCategoryBreakdownResponse> {
    return this.monthlyCategoryBreakdown.getMonthlyCategoryBreakdown(
      userId,
      startDate,
      endDate,
      options,
    );
  }
}
