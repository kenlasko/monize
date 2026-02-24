import { Controller, Get, Query, UseGuards, Request } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { BuiltInReportsService } from "./built-in-reports.service";
import {
  ReportQueryDto,
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
  UncategorizedTransactionsQueryDto,
  DuplicateTransactionsResponse,
  DuplicateTransactionsQueryDto,
  MonthlyComparisonResponse,
  MonthlyComparisonQueryDto,
} from "./dto";

@ApiTags("Built-in Reports")
@Controller("built-in-reports")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BuiltInReportsController {
  constructor(private readonly reportsService: BuiltInReportsService) {}

  @Get("spending-by-category")
  @ApiOperation({ summary: "Get spending aggregated by category" })
  @ApiResponse({ status: 200, type: SpendingByCategoryResponse })
  getSpendingByCategory(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<SpendingByCategoryResponse> {
    return this.reportsService.getSpendingByCategory(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("spending-by-payee")
  @ApiOperation({ summary: "Get spending aggregated by payee" })
  @ApiResponse({ status: 200, type: SpendingByPayeeResponse })
  getSpendingByPayee(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<SpendingByPayeeResponse> {
    return this.reportsService.getSpendingByPayee(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("income-by-source")
  @ApiOperation({ summary: "Get income aggregated by category" })
  @ApiResponse({ status: 200, type: IncomeBySourceResponse })
  getIncomeBySource(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<IncomeBySourceResponse> {
    return this.reportsService.getIncomeBySource(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("monthly-spending-trend")
  @ApiOperation({ summary: "Get monthly spending trend by category" })
  @ApiResponse({ status: 200, type: MonthlySpendingTrendResponse })
  getMonthlySpendingTrend(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<MonthlySpendingTrendResponse> {
    return this.reportsService.getMonthlySpendingTrend(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("income-vs-expenses")
  @ApiOperation({ summary: "Get monthly income vs expenses comparison" })
  @ApiResponse({ status: 200, type: IncomeVsExpensesResponse })
  getIncomeVsExpenses(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<IncomeVsExpensesResponse> {
    return this.reportsService.getIncomeVsExpenses(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("cash-flow")
  @ApiOperation({ summary: "Get monthly cash flow (income, expenses, net)" })
  @ApiResponse({ status: 200, type: IncomeVsExpensesResponse })
  getCashFlow(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<IncomeVsExpensesResponse> {
    // Cash flow uses the same logic as income vs expenses
    return this.reportsService.getIncomeVsExpenses(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("year-over-year")
  @ApiOperation({ summary: "Get year-over-year comparison data" })
  @ApiResponse({ status: 200, type: YearOverYearResponse })
  getYearOverYear(
    @Request() req,
    @Query("yearsToCompare") yearsToCompare: string = "2",
  ): Promise<YearOverYearResponse> {
    return this.reportsService.getYearOverYear(
      req.user.id,
      parseInt(yearsToCompare, 10) || 2,
    );
  }

  @Get("weekend-vs-weekday")
  @ApiOperation({ summary: "Get weekend vs weekday spending analysis" })
  @ApiResponse({ status: 200, type: WeekendVsWeekdayResponse })
  getWeekendVsWeekday(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<WeekendVsWeekdayResponse> {
    return this.reportsService.getWeekendVsWeekday(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("spending-anomalies")
  @ApiOperation({ summary: "Get spending anomalies" })
  @ApiResponse({ status: 200, type: SpendingAnomaliesResponse })
  getSpendingAnomalies(
    @Request() req,
    @Query("threshold") threshold: string = "2",
  ): Promise<SpendingAnomaliesResponse> {
    return this.reportsService.getSpendingAnomalies(
      req.user.id,
      parseFloat(threshold) || 2,
    );
  }

  @Get("tax-summary")
  @ApiOperation({ summary: "Get tax summary for a year" })
  @ApiResponse({ status: 200, type: TaxSummaryResponse })
  getTaxSummary(
    @Request() req,
    @Query("year") year: string,
  ): Promise<TaxSummaryResponse> {
    return this.reportsService.getTaxSummary(
      req.user.id,
      parseInt(year, 10) || new Date().getFullYear(),
    );
  }

  @Get("recurring-expenses")
  @ApiOperation({ summary: "Get recurring expenses analysis" })
  @ApiResponse({ status: 200, type: RecurringExpensesResponse })
  getRecurringExpenses(
    @Request() req,
    @Query("minOccurrences") minOccurrences: string = "3",
  ): Promise<RecurringExpensesResponse> {
    return this.reportsService.getRecurringExpenses(
      req.user.id,
      parseInt(minOccurrences, 10) || 3,
    );
  }

  @Get("bill-payment-history")
  @ApiOperation({ summary: "Get bill payment history" })
  @ApiResponse({ status: 200, type: BillPaymentHistoryResponse })
  getBillPaymentHistory(
    @Request() req,
    @Query() query: ReportQueryDto,
  ): Promise<BillPaymentHistoryResponse> {
    return this.reportsService.getBillPaymentHistory(
      req.user.id,
      query.startDate,
      query.endDate,
    );
  }

  @Get("uncategorized-transactions")
  @ApiOperation({ summary: "Get uncategorized transactions" })
  @ApiResponse({ status: 200, type: UncategorizedTransactionsResponse })
  getUncategorizedTransactions(
    @Request() req,
    @Query() query: UncategorizedTransactionsQueryDto,
  ): Promise<UncategorizedTransactionsResponse> {
    return this.reportsService.getUncategorizedTransactions(
      req.user.id,
      query.startDate,
      query.endDate,
      query.limit || 500,
    );
  }

  @Get("duplicate-transactions")
  @ApiOperation({ summary: "Find potential duplicate transactions" })
  @ApiResponse({ status: 200, type: DuplicateTransactionsResponse })
  getDuplicateTransactions(
    @Request() req,
    @Query() query: DuplicateTransactionsQueryDto,
  ): Promise<DuplicateTransactionsResponse> {
    return this.reportsService.getDuplicateTransactions(
      req.user.id,
      query.startDate,
      query.endDate,
      query.sensitivity || "medium",
    );
  }

  @Get("monthly-comparison")
  @ApiOperation({
    summary: "Get monthly comparison report (month vs previous month)",
  })
  @ApiResponse({ status: 200, type: MonthlyComparisonResponse })
  getMonthlyComparison(
    @Request() req,
    @Query() query: MonthlyComparisonQueryDto,
  ): Promise<MonthlyComparisonResponse> {
    return this.reportsService.getMonthlyComparison(req.user.id, query.month);
  }
}
