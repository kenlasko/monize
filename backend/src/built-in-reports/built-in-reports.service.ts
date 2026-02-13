import { Injectable } from "@nestjs/common";
import { SpendingReportsService } from "./spending-reports.service";
import { IncomeReportsService } from "./income-reports.service";
import { ComparisonReportsService } from "./comparison-reports.service";
import { AnomalyReportsService } from "./anomaly-reports.service";
import { TaxRecurringReportsService } from "./tax-recurring-reports.service";
import { DataQualityReportsService } from "./data-quality-reports.service";
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
  ) {}

  getSpendingByCategory(
    userId: string,
    startDate: string | undefined,
    endDate: string,
  ): Promise<SpendingByCategoryResponse> {
    return this.spendingReports.getSpendingByCategory(
      userId,
      startDate,
      endDate,
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
  ): Promise<IncomeBySourceResponse> {
    return this.incomeReports.getIncomeBySource(userId, startDate, endDate);
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
  ): Promise<IncomeVsExpensesResponse> {
    return this.incomeReports.getIncomeVsExpenses(userId, startDate, endDate);
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
    threshold: number = 2,
  ): Promise<SpendingAnomaliesResponse> {
    return this.anomalyReports.getSpendingAnomalies(userId, threshold);
  }

  getTaxSummary(userId: string, year: number): Promise<TaxSummaryResponse> {
    return this.taxRecurringReports.getTaxSummary(userId, year);
  }

  getRecurringExpenses(
    userId: string,
    minOccurrences: number = 3,
  ): Promise<RecurringExpensesResponse> {
    return this.taxRecurringReports.getRecurringExpenses(
      userId,
      minOccurrences,
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
}
