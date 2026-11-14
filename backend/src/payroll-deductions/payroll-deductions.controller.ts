import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { tr } from "../i18n/translate";
import {
  CreatePayrollDeductionRuleDto,
  CreatePayrollDeductionRulesDto,
  UpdatePayrollDeductionRuleDto,
} from "./dto/create-payroll-deduction-rule.dto";
import { PayrollDeductionReportQueryDto } from "./dto/payroll-deduction-report-query.dto";
import { PayrollDeductionReport } from "./payroll-deduction-report";
import {
  ExpectedAmountSuggestion,
  PayrollDeductionHistoryView,
  PayrollDeductionRuleView,
  PayrollDeductionsService,
} from "./payroll-deductions.service";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * Payroll deduction rules (docs/specs/payroll-deductions.md section 5.2).
 * Owner-only on every route by the global delegate guard's default (decision
 * 9); `userId` comes from the JWT and never from the request.
 */
@ApiTags("Payroll deductions")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("payroll-deductions")
export class PayrollDeductionsController {
  constructor(private readonly service: PayrollDeductionsService) {}

  @Get()
  @ApiOperation({ summary: "List the rules with their year-to-date figures" })
  @ApiResponse({ status: 200, description: "The rules" })
  findAll(@Request() req): Promise<PayrollDeductionRuleView[]> {
    return this.service.findAll(req.user.id);
  }

  @Get("history")
  @ApiOperation({
    summary: "What each ruled category collected in past periods",
  })
  @ApiResponse({ status: 200, description: "One entry per category" })
  history(@Request() req): Promise<PayrollDeductionHistoryView[]> {
    return this.service.history(req.user.id);
  }

  @Get("report")
  @ApiOperation({
    summary:
      "The payroll deductions report: a year's summary and paycheques, and every period's total",
  })
  @ApiResponse({ status: 200, description: "The report" })
  report(
    @Request() req,
    @Query() query: PayrollDeductionReportQueryDto,
  ): Promise<PayrollDeductionReport> {
    return this.service.report(req.user.id, query.year);
  }

  @Get("suggest")
  @ApiOperation({ summary: "The expected amount a bill and category suggest" })
  @ApiResponse({ status: 200, description: "The suggestion, or null" })
  suggest(
    @Request() req,
    @Query("scheduledTransactionId", ParseUUIDPipe)
    scheduledTransactionId: string,
    @Query("categoryId", ParseUUIDPipe) categoryId: string,
    @Query("resetDate") resetDate?: string,
  ): Promise<ExpectedAmountSuggestion> {
    // Optional, so no pipe: a value that is present must still be a real date.
    if (resetDate !== undefined && !isCalendarDate(resetDate)) {
      throw new BadRequestException(
        tr(
          "errors.validation.invalidDateParam",
          "resetDate must be a valid date in YYYY-MM-DD format",
          { paramName: "resetDate" },
        ),
      );
    }
    return this.service.suggestExpected(
      req.user.id,
      scheduledTransactionId,
      categoryId,
      resetDate,
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a rule" })
  @ApiResponse({ status: 201, description: "The created rule" })
  @ApiResponse({ status: 400, description: "Missing expected amount" })
  @ApiResponse({
    status: 409,
    description: "The bill already has that category",
  })
  create(
    @Request() req,
    @Body() dto: CreatePayrollDeductionRuleDto,
  ): Promise<PayrollDeductionRuleView> {
    return this.service.create(req.user.id, dto);
  }

  @Post("batch")
  @ApiOperation({
    summary: "Create one rule per category of a bill, atomically",
  })
  @ApiResponse({ status: 201, description: "The created rules, in order" })
  @ApiResponse({ status: 400, description: "A line lacks its expected amount" })
  @ApiResponse({
    status: 409,
    description: "A category repeats, or the bill already has it",
  })
  createMany(
    @Request() req,
    @Body() dto: CreatePayrollDeductionRulesDto,
  ): Promise<PayrollDeductionRuleView[]> {
    return this.service.createMany(req.user.id, dto);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a rule" })
  @ApiResponse({ status: 200, description: "The updated rule" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayrollDeductionRuleDto,
  ): Promise<PayrollDeductionRuleView> {
    return this.service.update(req.user.id, id, dto);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({ summary: "Delete a rule" })
  @ApiResponse({ status: 204, description: "Deleted" })
  @ApiResponse({ status: 404, description: "Rule not found" })
  async remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.service.remove(req.user.id, id);
  }
}
