import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
  Query,
  ParseBoolPipe,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { BudgetsService } from "./budgets.service";
import { BudgetPeriodService } from "./budget-period.service";
import { BudgetGeneratorService } from "./budget-generator.service";
import { BudgetReportsService } from "./budget-reports.service";
import { CreateBudgetDto } from "./dto/create-budget.dto";
import { UpdateBudgetDto } from "./dto/update-budget.dto";
import { CreateBudgetCategoryDto } from "./dto/create-budget-category.dto";
import { UpdateBudgetCategoryDto } from "./dto/update-budget-category.dto";
import { BulkUpdateBudgetCategoriesDto } from "./dto/bulk-update-budget-categories.dto";
import { GenerateBudgetDto } from "./dto/generate-budget.dto";
import { ApplyGeneratedBudgetDto } from "./dto/apply-generated-budget.dto";
import { BudgetReportQueryDto } from "./dto/budget-report-query.dto";
import { CategoryBudgetStatusDto } from "./dto/category-budget-status.dto";

@ApiTags("Budgets")
@Controller("budgets")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BudgetsController {
  constructor(
    private readonly budgetsService: BudgetsService,
    private readonly budgetPeriodService: BudgetPeriodService,
    private readonly budgetGeneratorService: BudgetGeneratorService,
    private readonly budgetReportsService: BudgetReportsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new budget" })
  @ApiResponse({ status: 201, description: "Budget created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  create(@Request() req, @Body() createBudgetDto: CreateBudgetDto) {
    return this.budgetsService.create(req.user.id, createBudgetDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all budgets for the authenticated user" })
  @ApiResponse({ status: 200, description: "List of budgets retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findAll(@Request() req) {
    return this.budgetsService.findAll(req.user.id);
  }

  @Get("dashboard-summary")
  @ApiOperation({
    summary: "Get budget summary for dashboard widget",
  })
  @ApiResponse({
    status: 200,
    description:
      "Dashboard budget summary retrieved (null if no active budget)",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getDashboardSummary(@Request() req) {
    return this.budgetsService.getDashboardSummary(req.user.id);
  }

  @Post("category-budget-status")
  @ApiOperation({
    summary:
      "Get budget status for specific categories (for transaction list context)",
  })
  @ApiResponse({ status: 200, description: "Category budget status retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getCategoryBudgetStatus(
    @Request() req,
    @Body() dto: CategoryBudgetStatusDto,
  ) {
    const statusMap = await this.budgetsService.getCategoryBudgetStatus(
      req.user.id,
      dto.categoryIds,
    );

    return Object.fromEntries(statusMap);
  }

  @Post("generate")
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: "Analyze spending and suggest budget amounts",
  })
  @ApiResponse({
    status: 201,
    description: "Budget suggestions generated",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  generate(@Request() req, @Body() dto: GenerateBudgetDto) {
    return this.budgetGeneratorService.generate(req.user.id, dto);
  }

  @Post("generate/apply")
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: "Create a budget from generated suggestions",
  })
  @ApiResponse({
    status: 201,
    description: "Budget created from suggestions",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  applyGenerated(@Request() req, @Body() dto: ApplyGeneratedBudgetDto) {
    return this.budgetGeneratorService.apply(req.user.id, dto);
  }

  @Get("alerts")
  @ApiOperation({ summary: "Get budget alerts" })
  @ApiQuery({
    name: "unreadOnly",
    required: false,
    type: Boolean,
    description: "Only return unread alerts",
  })
  @ApiResponse({ status: 200, description: "Alerts retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getAlerts(
    @Request() req,
    @Query("unreadOnly", new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ) {
    return this.budgetsService.getAlerts(req.user.id, unreadOnly || false);
  }

  @Patch("alerts/:id/read")
  @ApiOperation({ summary: "Mark an alert as read" })
  @ApiParam({ name: "id", description: "Alert UUID" })
  @ApiResponse({ status: 200, description: "Alert marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Alert not found" })
  markAlertRead(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetsService.markAlertRead(req.user.id, id);
  }

  @Patch("alerts/read-all")
  @ApiOperation({ summary: "Mark all alerts as read" })
  @ApiResponse({ status: 200, description: "All alerts marked as read" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  markAllAlertsRead(@Request() req) {
    return this.budgetsService.markAllAlertsRead(req.user.id);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific budget with categories" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Budget retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetsService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a budget" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Budget updated" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateBudgetDto: UpdateBudgetDto,
  ) {
    return this.budgetsService.update(req.user.id, id, updateBudgetDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a budget" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Budget deleted" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 403, description: "Forbidden" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetsService.remove(req.user.id, id);
  }

  @Post(":id/categories")
  @ApiOperation({ summary: "Add a category to a budget" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 201, description: "Category added to budget" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget or category not found" })
  addCategory(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: CreateBudgetCategoryDto,
  ) {
    return this.budgetsService.addCategory(req.user.id, id, dto);
  }

  @Patch(":id/categories/:categoryId")
  @ApiOperation({ summary: "Update a budget category allocation" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiParam({ name: "categoryId", description: "Budget category UUID" })
  @ApiResponse({ status: 200, description: "Budget category updated" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget category not found" })
  updateCategory(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("categoryId", ParseUUIDPipe) categoryId: string,
    @Body() dto: UpdateBudgetCategoryDto,
  ) {
    return this.budgetsService.updateCategory(req.user.id, id, categoryId, dto);
  }

  @Delete(":id/categories/:categoryId")
  @ApiOperation({ summary: "Remove a category from a budget" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiParam({ name: "categoryId", description: "Budget category UUID" })
  @ApiResponse({ status: 200, description: "Budget category removed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget category not found" })
  removeCategory(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("categoryId", ParseUUIDPipe) categoryId: string,
  ) {
    return this.budgetsService.removeCategory(req.user.id, id, categoryId);
  }

  @Post(":id/categories/bulk")
  @ApiOperation({ summary: "Bulk update budget category amounts" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Budget categories updated" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget or category not found" })
  bulkUpdateCategories(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: BulkUpdateBudgetCategoriesDto,
  ) {
    return this.budgetsService.bulkUpdateCategories(
      req.user.id,
      id,
      dto.categories,
    );
  }

  @Get(":id/summary")
  @ApiOperation({ summary: "Get current period budget summary" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Budget summary retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getSummary(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetsService.getSummary(req.user.id, id);
  }

  @Get(":id/velocity")
  @ApiOperation({ summary: "Get spending velocity and projections" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Velocity data retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getVelocity(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetsService.getVelocity(req.user.id, id);
  }

  @Get(":id/periods")
  @ApiOperation({ summary: "List historical budget periods" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Periods retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getPeriods(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetPeriodService.findAll(req.user.id, id);
  }

  @Get(":id/periods/:periodId")
  @ApiOperation({ summary: "Get period detail with category breakdowns" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiParam({ name: "periodId", description: "Budget period UUID" })
  @ApiResponse({ status: 200, description: "Period detail retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Period not found" })
  getPeriodDetail(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("periodId", ParseUUIDPipe) periodId: string,
  ) {
    return this.budgetPeriodService.findOne(req.user.id, id, periodId);
  }

  @Post(":id/periods/close")
  @ApiOperation({ summary: "Close current period and create next" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 201, description: "Period closed successfully" })
  @ApiResponse({ status: 400, description: "No open period to close" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  closePeriod(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetPeriodService.closePeriod(req.user.id, id);
  }

  // --- Budget Reports ---

  @Get(":id/reports/trend")
  @ApiOperation({ summary: "Get budget vs actual trend over N months" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiQuery({
    name: "months",
    required: false,
    type: Number,
    description: "Number of months (default 6)",
  })
  @ApiResponse({ status: 200, description: "Trend data retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getTrend(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: BudgetReportQueryDto,
  ) {
    return this.budgetReportsService.getTrend(
      req.user.id,
      id,
      query.months || 6,
    );
  }

  @Get(":id/reports/category-trend")
  @ApiOperation({ summary: "Get per-category trend over time" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiQuery({
    name: "months",
    required: false,
    type: Number,
    description: "Number of months (default 6)",
  })
  @ApiQuery({
    name: "categoryIds",
    required: false,
    type: [String],
    description: "Filter to specific category IDs",
  })
  @ApiResponse({ status: 200, description: "Category trend data retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getCategoryTrend(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: BudgetReportQueryDto,
  ) {
    return this.budgetReportsService.getCategoryTrend(
      req.user.id,
      id,
      query.months || 6,
      query.categoryIds,
    );
  }

  @Get(":id/reports/health-score")
  @ApiOperation({ summary: "Get budget health score (0-100)" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Health score calculated" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getHealthScore(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetReportsService.getHealthScore(req.user.id, id);
  }

  @Get(":id/reports/seasonal")
  @ApiOperation({ summary: "Get seasonal spending patterns" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Seasonal patterns retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getSeasonalPatterns(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetReportsService.getSeasonalPatterns(req.user.id, id);
  }

  @Get(":id/reports/flex-groups")
  @ApiOperation({ summary: "Get flex group aggregation status" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Flex group status retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getFlexGroupStatus(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetReportsService.getFlexGroupStatus(req.user.id, id);
  }

  @Get(":id/reports/daily-spending")
  @ApiOperation({ summary: "Get daily spending for current period (heatmap)" })
  @ApiParam({ name: "id", description: "Budget UUID" })
  @ApiResponse({ status: 200, description: "Daily spending data retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Budget not found" })
  getDailySpending(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.budgetReportsService.getDailySpending(req.user.id, id);
  }
}
