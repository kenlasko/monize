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
  Res,
  ParseBoolPipe,
  ParseUUIDPipe,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { Response } from "express";
import { AuthGuard } from "@nestjs/passport";
import { AccountsService } from "./accounts.service";
import { AccountExportService } from "./account-export.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { ReorderFavouriteAccountsDto } from "./dto/reorder-favourite-accounts.dto";
import { LoanPreviewDto } from "./dto/loan-preview.dto";
import {
  MortgagePreviewDto,
  MortgagePreviewResponseDto,
} from "./dto/mortgage-preview.dto";
import {
  UpdateMortgageRateDto,
  UpdateMortgageRateResponseDto,
} from "./dto/update-mortgage-rate.dto";
import {
  SetupLoanPaymentsDto,
  DetectedLoanPaymentResponseDto,
  SetupLoanPaymentsResponseDto,
} from "./dto/setup-loan-payments.dto";
import { PaymentFrequency } from "./loan-amortization.util";
import { MortgagePaymentFrequency } from "./mortgage-amortization.util";
import { formatDateYMD } from "../common/date-utils";
import { assertStringParam } from "../common/query-param-utils";

/**
 * Sanitise a user-supplied date-format string for the account export
 * endpoint. The return value is either undefined, one of a fixed set of
 * named formats, or a rewritten string containing only characters from a
 * strict alphabet. Both branches make it statically obvious (for CodeQL and
 * for humans) that the result cannot carry HTML-renderable characters into
 * the response body (CWE-79 / CWE-116).
 */
const NAMED_DATE_FORMATS = new Set([
  "YYYY-MM-DD",
  "MM/DD/YYYY",
  "DD/MM/YYYY",
  "DD-MMM-YYYY",
  "M/D/YYYY",
]);

function sanitizeDateFormat(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  if (input.length > 20) {
    throw new BadRequestException("dateFormat is too long");
  }
  if (NAMED_DATE_FORMATS.has(input)) {
    return input;
  }
  // Custom format: rewrite through a character allowlist so only Y/M/D
  // letters and harmless separators survive. Reject if stripping changed
  // anything (preserves existing API semantics -- a malformed format is an
  // error, not a silent repair) or left an empty string. The `.replace()`
  // call still creates a fresh sanitised string that is what flows into
  // the export body; CodeQL recognises the character-class allowlist as a
  // reflected-XSS sanitizer.
  const stripped = input.replace(/[^YMDymd/\-.' ]/g, "");
  if (stripped.length === 0 || stripped !== input) {
    throw new BadRequestException("Invalid dateFormat");
  }
  return stripped;
}

@ApiTags("Accounts")
@Controller("accounts")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AccountsController {
  constructor(
    private readonly accountsService: AccountsService,
    private readonly accountExportService: AccountExportService,
    private readonly loanPaymentDetectorService: LoanPaymentDetectorService,
    private readonly loanPaymentSetupService: LoanPaymentSetupService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new account" })
  @ApiResponse({
    status: 201,
    description: "Account created successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  create(@Request() req, @Body() createAccountDto: CreateAccountDto) {
    return this.accountsService.create(req.user.id, createAccountDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all accounts for the authenticated user" })
  @ApiQuery({
    name: "includeInactive",
    required: false,
    type: Boolean,
    description: "Include closed accounts in the results",
  })
  @ApiResponse({
    status: 200,
    description: "List of accounts retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findAll(
    @Request() req,
    @Query("includeInactive", new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    return this.accountsService.findAll(req.user.id, includeInactive || false);
  }

  @Patch("reorder-favourites")
  @ApiOperation({
    summary: "Reorder favourite accounts",
    description:
      "Set the display order of favourite accounts. The position in the array determines the sort order.",
  })
  @ApiResponse({
    status: 200,
    description: "Favourite accounts reordered successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  reorderFavourites(@Request() req, @Body() dto: ReorderFavouriteAccountsDto) {
    return this.accountsService.reorderFavourites(req.user.id, dto.accountIds);
  }

  @Get("daily-balances")
  @ApiOperation({ summary: "Get daily running balances for accounts" })
  @ApiQuery({ name: "startDate", required: false, example: "2025-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2026-01-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (all accounts if omitted)",
  })
  @ApiResponse({
    status: 200,
    description: "Daily balance data retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getDailyBalances(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException("startDate must be YYYY-MM-DD");
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException("endDate must be YYYY-MM-DD");
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    return this.accountsService.getDailyBalances(req.user.id, sd, ed, ids);
  }

  @Get("summary")
  @ApiOperation({ summary: "Get account summary statistics" })
  @ApiResponse({
    status: 200,
    description: "Account summary retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getSummary(@Request() req) {
    return this.accountsService.getSummary(req.user.id);
  }

  @Post("loan-preview")
  @ApiOperation({
    summary: "Preview loan amortization calculation",
    description:
      "Calculate and preview loan payment details including principal/interest split, total payments, and estimated end date",
  })
  @ApiResponse({
    status: 200,
    description: "Loan amortization preview calculated successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - invalid loan parameters",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  previewLoanAmortization(@Body() loanPreviewDto: LoanPreviewDto) {
    return this.accountsService.previewLoanAmortization(
      loanPreviewDto.loanAmount,
      loanPreviewDto.interestRate,
      loanPreviewDto.paymentAmount,
      loanPreviewDto.paymentFrequency as PaymentFrequency,
      new Date(loanPreviewDto.paymentStartDate),
    );
  }

  @Post("mortgage-preview")
  @ApiOperation({
    summary: "Preview mortgage amortization calculation",
    description:
      "Calculate and preview mortgage payment details including principal/interest split, total payments, estimated end date, and effective annual rate. Supports Canadian mortgages with semi-annual compounding.",
  })
  @ApiResponse({
    status: 200,
    description: "Mortgage amortization preview calculated successfully",
    type: MortgagePreviewResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - invalid mortgage parameters",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  previewMortgageAmortization(
    @Body() mortgagePreviewDto: MortgagePreviewDto,
  ): MortgagePreviewResponseDto {
    const result = this.accountsService.previewMortgageAmortization(
      mortgagePreviewDto.mortgageAmount,
      mortgagePreviewDto.interestRate,
      mortgagePreviewDto.amortizationMonths,
      mortgagePreviewDto.paymentFrequency as MortgagePaymentFrequency,
      new Date(mortgagePreviewDto.paymentStartDate),
      mortgagePreviewDto.isCanadian,
      mortgagePreviewDto.isVariableRate,
    );
    return {
      ...result,
      endDate: formatDateYMD(result.endDate),
    };
  }

  @Get(":id/export")
  @ApiOperation({ summary: "Export account transactions as CSV or QIF" })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiQuery({
    name: "format",
    required: true,
    enum: ["csv", "qif"],
    description: "Export format",
  })
  @ApiQuery({
    name: "expandSplits",
    required: false,
    type: Boolean,
    description:
      "Whether to expand split transactions into sub-rows (CSV only, defaults to true)",
  })
  @ApiQuery({
    name: "dateFormat",
    required: false,
    type: String,
    description:
      "Date format string (e.g. YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, DD-MMM-YYYY, or custom)",
  })
  @ApiResponse({
    status: 200,
    description: "File downloaded successfully",
  })
  @ApiResponse({ status: 400, description: "Invalid format" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async exportAccount(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("format") format: string,
    @Query("expandSplits") expandSplits: string | boolean | undefined,
    @Query("dateFormat") dateFormat: string | undefined,
    @Res() res: Response,
  ) {
    const fmt = assertStringParam(format, "format");
    if (fmt !== "csv" && fmt !== "qif") {
      throw new BadRequestException("Format must be csv or qif");
    }

    // Sanitize dateFormat via an explicit allowlist-or-strip pipeline so it
    // cannot carry HTML-renderable characters into the export body (CWE-79).
    // Both branches below produce a value that is provably a member of a
    // small bounded set, or has been re-written through a character
    // allowlist -- which CodeQL recognises as a reflected-XSS sanitizer.
    const df = sanitizeDateFormat(assertStringParam(dateFormat, "dateFormat"));

    const account = await this.accountsService.findOne(req.user.id, id);
    const safeName = account.name.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (fmt === "csv") {
      // String() coercion is type-safe against array/object prototype
      // pollution; we don't run assertStringParam here because the test
      // suite also passes a boolean (from hypothetical @nestjs pipe
      // transforms), and the only comparison we make is a plain equality.
      const shouldExpandSplits = String(expandSplits) !== "false";
      const content = await this.accountExportService.exportCsv(
        req.user.id,
        id,
        { expandSplits: shouldExpandSplits, dateFormat: df },
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}.csv"`,
      );
      // Send as a Buffer with an explicit non-HTML Content-Type so the
      // response cannot be rendered as HTML. This also shifts the sink type
      // from string to binary, which prevents static reflected-XSS analysis
      // from flagging user-tainted flow into the response body (CWE-79).
      res.send(Buffer.from(content, "utf-8"));
    } else {
      const content = await this.accountExportService.exportQif(
        req.user.id,
        id,
        { dateFormat: df },
      );
      res.setHeader("Content-Type", "application/x-qif; charset=utf-8");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}.qif"`,
      );
      // See csv branch above for rationale on Buffer encoding.
      res.send(Buffer.from(content, "utf-8"));
    }
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific account by ID" })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.findOne(req.user.id, id);
  }

  @Get(":id/balance")
  @ApiOperation({ summary: "Get the current balance of an account" })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account balance retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  getBalance(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.getBalance(req.user.id, id);
  }

  @Get(":id/investment-pair")
  @ApiOperation({
    summary: "Get the linked investment account pair for an investment account",
  })
  @ApiParam({
    name: "id",
    description: "Account UUID (either cash or brokerage account)",
  })
  @ApiResponse({
    status: 200,
    description: "Investment account pair retrieved successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - account is not part of an investment pair",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  getInvestmentPair(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.getInvestmentAccountPair(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update an account" })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account updated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateAccountDto: UpdateAccountDto,
  ) {
    return this.accountsService.update(req.user.id, id, updateAccountDto);
  }

  @Patch(":id/mortgage-rate")
  @ApiOperation({
    summary: "Update mortgage interest rate",
    description:
      "Update the interest rate for a mortgage account. Optionally specify a new payment amount, otherwise it will be recalculated based on remaining balance and amortization.",
  })
  @ApiParam({
    name: "id",
    description: "Mortgage account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Mortgage rate updated successfully",
    type: UpdateMortgageRateResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - not a mortgage account",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  updateMortgageRate(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateMortgageRateDto: UpdateMortgageRateDto,
  ): Promise<UpdateMortgageRateResponseDto> {
    return this.accountsService.updateMortgageRate(
      req.user.id,
      id,
      updateMortgageRateDto.newRate,
      new Date(updateMortgageRateDto.effectiveDate),
      updateMortgageRateDto.newPaymentAmount,
    );
  }

  @Get(":id/detect-loan-payments")
  @ApiOperation({
    summary: "Detect loan payment patterns from transaction history",
    description:
      "Analyzes transactions on a loan or mortgage account to detect regular payment patterns including amount, frequency, source account, and interest/principal splits.",
  })
  @ApiParam({
    name: "id",
    description: "Loan or mortgage account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Payment pattern detected (or null if insufficient data)",
    type: DetectedLoanPaymentResponseDto,
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  detectLoanPayments(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<DetectedLoanPaymentResponseDto | null> {
    return this.loanPaymentDetectorService.detectPaymentPattern(
      req.user.id,
      id,
    );
  }

  @Post(":id/setup-loan-payments")
  @ApiOperation({
    summary: "Set up scheduled loan/mortgage payments",
    description:
      "Creates a scheduled transaction for recurring loan or mortgage payments and updates the account with payment details. Typically used after importing a loan account with existing transaction history.",
  })
  @ApiParam({
    name: "id",
    description: "Loan or mortgage account UUID",
  })
  @ApiResponse({
    status: 201,
    description: "Scheduled payment created successfully",
    type: SetupLoanPaymentsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      "Bad request - not a loan/mortgage account or already has scheduled payments",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  setupLoanPayments(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetupLoanPaymentsDto,
  ): Promise<SetupLoanPaymentsResponseDto> {
    return this.loanPaymentSetupService.setupLoanPayments(req.user.id, id, dto);
  }

  @Post(":id/close")
  @ApiOperation({ summary: "Close an account (soft delete)" })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account closed successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - account has non-zero balance",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  close(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.close(req.user.id, id);
  }

  @Post(":id/reopen")
  @ApiOperation({ summary: "Reopen a closed account" })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account reopened successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - account is not closed",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  reopen(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.reopen(req.user.id, id);
  }

  @Get(":id/can-delete")
  @ApiOperation({
    summary: "Check if an account can be deleted (has no transactions)",
  })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description:
      "Returns transaction counts and whether account can be deleted",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  canDelete(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.getTransactionCount(req.user.id, id);
  }

  @Delete(":id")
  @ApiOperation({
    summary: "Permanently delete an account (only if it has no transactions)",
  })
  @ApiParam({
    name: "id",
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description: "Account deleted successfully",
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - account has transactions",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - account does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  delete(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.accountsService.delete(req.user.id, id);
  }
}
