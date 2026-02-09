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
import { AccountsService } from "./accounts.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { LoanPreviewDto } from "./dto/loan-preview.dto";
import {
  MortgagePreviewDto,
  MortgagePreviewResponseDto,
} from "./dto/mortgage-preview.dto";
import {
  UpdateMortgageRateDto,
  UpdateMortgageRateResponseDto,
} from "./dto/update-mortgage-rate.dto";
import { PaymentFrequency } from "./loan-amortization.util";
import { MortgagePaymentFrequency } from "./mortgage-amortization.util";

@ApiTags("Accounts")
@Controller("accounts")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

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
      endDate: result.endDate.toISOString().split("T")[0],
    };
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
