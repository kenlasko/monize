import { ReportingEndpoint } from "../accruals/reporting-endpoint";
import { Controller, Get, Query, UseGuards, Request } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { BuiltInReportsService } from "./built-in-reports.service";
import type { WeekStartsOn } from "./income-expense-buckets";
import {
  IncomeVsExpensesQueryDto,
  CashFlowQueryDto,
  ReportQueryDto,
  SpendingByCategoryQueryDto,
  SpendingByCategoryResponse,
  SpendingByPayeeResponse,
  IncomeBySourceResponse,
  IncomeBySourceQueryDto,
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
  MonthlyCategoryBreakdownResponse,
  CashFlowSankeyQueryDto,
  CashFlowSankeyResponse,
  DEFAULT_RECURRING_EXPENSE_RANGE,
  isRecurringExpenseRange,
  MonthlyCategoryBreakdownQueryDto,
} from "./dto";

@ApiTags("Built-in Reports")
@Controller("built-in-reports")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BuiltInReportsController {
  constructor(private readonly reportsService: BuiltInReportsService) {}

  @ReportingEndpoint()
  @Get("spending-by-category")
  @ApiOperation({ summary: "Get spending aggregated by category" })
  @ApiResponse({ status: 200, type: SpendingByCategoryResponse })
  getSpendingByCategory(
    @Request() req,
    @Query() query: SpendingByCategoryQueryDto,
  ): Promise<SpendingByCategoryResponse> {
    return this.reportsService.getSpendingByCategory(
      req.user.id,
      query.startDate,
      query.endDate,
      {
        rollupToParent: query.rollupToParent,
        accountIds: query.accountIds,
        tagKey: query.tagKey,
        tagValue: query.tagValue,
      },
    );
  }

  @ReportingEndpoint()
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

  @ReportingEndpoint()
  @Get("income-by-source")
  @ApiOperation({ summary: "Get income aggregated by category" })
  @ApiResponse({ status: 200, type: IncomeBySourceResponse })
  getIncomeBySource(
    @Request() req,
    @Query() query: IncomeBySourceQueryDto,
  ): Promise<IncomeBySourceResponse> {
    return this.reportsService.getIncomeBySource(
      req.user.id,
      query.startDate,
      query.endDate,
      { accountIds: query.accountIds },
    );
  }

  @ReportingEndpoint()
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

  @ReportingEndpoint()
  @Get("income-vs-expenses")
  @ApiOperation({
    summary: "Get income vs expenses, bucketed by month or week",
  })
  @ApiResponse({ status: 200, type: IncomeVsExpensesResponse })
  getIncomeVsExpenses(
    @Request() req,
    @Query() query: IncomeVsExpensesQueryDto,
  ): Promise<IncomeVsExpensesResponse> {
    return this.reportsService.getIncomeVsExpenses(
      req.user.id,
      query.startDate,
      query.endDate,
      {
        accountIds: query.accountIds,
        bucket: query.bucket,
        weekStartsOn: query.weekStartsOn as WeekStartsOn | undefined,
        tagKey: query.tagKey,
        transferScopeAccountIds: query.transferScopeAccountIds,
      },
    );
  }

  @ReportingEndpoint("cash")
  @Get("cash-flow")
  @ApiOperation({ summary: "Get monthly cash flow (income, expenses, net)" })
  @ApiResponse({ status: 200, type: IncomeVsExpensesResponse })
  getCashFlow(
    @Request() req,
    @Query() query: CashFlowQueryDto,
  ): Promise<IncomeVsExpensesResponse> {
    // Cash flow uses the same logic as income vs expenses
    return this.reportsService.getIncomeVsExpenses(
      req.user.id,
      query.startDate,
      query.endDate,
      {
        tagKey: query.tagKey,
        accountIds: query.accountIds,
        transferScopeAccountIds: query.transferScopeAccountIds,
      },
    );
  }

  @ReportingEndpoint("cash")
  @Get("cash-flow-sankey")
  @ApiOperation({
    summary:
      "Get where money came from and went over a window, as Sankey nodes and links",
  })
  @ApiResponse({ status: 200, type: CashFlowSankeyResponse })
  getCashFlowSankey(
    @Request() req,
    @Query() query: CashFlowSankeyQueryDto,
  ): Promise<CashFlowSankeyResponse> {
    return this.reportsService.getCashFlowSankey(
      req.user.id,
      query.startDate,
      query.endDate,
      { accountIds: query.accountIds, depth: query.depth },
    );
  }

  @ReportingEndpoint()
  @Get("year-over-year")
  @ApiOperation({ summary: "Get year-over-year comparison data" })
  @ApiResponse({ status: 200, type: YearOverYearResponse })
  getYearOverYear(
    @Request() req,
    @Query("yearsToCompare") yearsToCompare: string = "2",
  ): Promise<YearOverYearResponse> {
    const years = Math.min(Math.max(parseInt(yearsToCompare, 10) || 2, 1), 10);
    return this.reportsService.getYearOverYear(req.user.id, years);
  }

  @ReportingEndpoint("cash")
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

  @ReportingEndpoint("cash")
  @Get("spending-anomalies")
  @ApiOperation({ summary: "Get spending anomalies" })
  @ApiResponse({ status: 200, type: SpendingAnomaliesResponse })
  getSpendingAnomalies(
    @Request() req,
    @Query("threshold") threshold: string = "2",
  ): Promise<SpendingAnomaliesResponse> {
    const safeThreshold = Math.min(
      Math.max(parseFloat(threshold) || 2, 0.5),
      10,
    );
    return this.reportsService.getSpendingAnomalies(req.user.id, safeThreshold);
  }

  @ReportingEndpoint("cash")
  @Get("tax-summary")
  @ApiOperation({ summary: "Get tax summary for a year" })
  @ApiResponse({ status: 200, type: TaxSummaryResponse })
  getTaxSummary(
    @Request() req,
    @Query("year") year: string,
  ): Promise<TaxSummaryResponse> {
    const safeYear = Math.min(
      Math.max(parseInt(year, 10) || new Date().getFullYear(), 1900),
      2100,
    );
    return this.reportsService.getTaxSummary(req.user.id, safeYear);
  }

  @ReportingEndpoint("cash")
  @Get("recurring-expenses")
  @ApiOperation({ summary: "Get recurring expenses analysis" })
  @ApiResponse({ status: 200, type: RecurringExpensesResponse })
  getRecurringExpenses(
    @Request() req,
    @Query("minOccurrences") minOccurrences: string = "3",
    @Query("range") range?: string,
  ): Promise<RecurringExpensesResponse> {
    const safeMinOccurrences = Math.min(
      Math.max(parseInt(minOccurrences, 10) || 3, 1),
      100,
    );
    // Lenient like minOccurrences: anything but a known preset is the default.
    const safeRange = isRecurringExpenseRange(range)
      ? range
      : DEFAULT_RECURRING_EXPENSE_RANGE;
    return this.reportsService.getRecurringExpenses(
      req.user.id,
      safeMinOccurrences,
      safeRange,
    );
  }

  @ReportingEndpoint("cash")
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

  @ReportingEndpoint("cash")
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

  @ReportingEndpoint("cash")
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

  @ReportingEndpoint()
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

  @ReportingEndpoint()
  @Get("monthly-category-breakdown")
  @ApiOperation({
    summary: "Get expense and income amounts broken down by category and month",
  })
  @ApiResponse({ status: 200, type: MonthlyCategoryBreakdownResponse })
  getMonthlyCategoryBreakdown(
    @Request() req,
    @Query() query: MonthlyCategoryBreakdownQueryDto,
  ): Promise<MonthlyCategoryBreakdownResponse> {
    return this.reportsService.getMonthlyCategoryBreakdown(
      req.user.id,
      query.startDate,
      query.endDate,
      { accountIds: query.accountIds },
    );
  }
}
