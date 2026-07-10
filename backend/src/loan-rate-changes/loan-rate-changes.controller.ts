import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { LoanRateChangesService } from "./loan-rate-changes.service";
import { RateChangeInferenceService } from "./rate-change-inference.service";
import { CreateLoanRateChangeDto } from "./dto/create-loan-rate-change.dto";
import { UpdateLoanRateChangeDto } from "./dto/update-loan-rate-change.dto";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";

@ApiTags("Loan Rate Changes")
@Controller("accounts/:accountId/rate-changes")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class LoanRateChangesController {
  constructor(
    private readonly loanRateChangesService: LoanRateChangesService,
    private readonly rateChangeInferenceService: RateChangeInferenceService,
  ) {}

  @Get()
  @AllowDelegate()
  @ApiOperation({ summary: "Get the rate-change history for a loan account" })
  @ApiResponse({
    status: 200,
    description: "Rate changes retrieved successfully",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  findAll(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ) {
    return this.loanRateChangesService.findAll(req.user.id, accountId);
  }

  @Post()
  @ApiOperation({ summary: "Record an interest-rate change" })
  @ApiResponse({ status: 201, description: "Rate change created successfully" })
  @ApiResponse({ status: 404, description: "Account not found" })
  @ApiResponse({
    status: 409,
    description: "A rate change already exists for that date",
  })
  create(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Body() createDto: CreateLoanRateChangeDto,
  ) {
    return this.loanRateChangesService.create(
      req.user.id,
      accountId,
      createDto,
      { deferScheduledSync: true },
    );
  }

  @Post("apply-scheduled-payment")
  @ApiOperation({
    summary: "Apply the pending scheduled-payment change for a loan account",
    description:
      "Resyncs the account's linked scheduled bill payment to its current rate and payment. Called after the user grants permission from the rate-change confirmation prompt.",
  })
  @ApiResponse({ status: 201, description: "Scheduled payment synced" })
  @ApiResponse({ status: 404, description: "Account not found" })
  applyScheduledPayment(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ) {
    return this.loanRateChangesService.applyScheduledPaymentSync(
      req.user.id,
      accountId,
    );
  }

  @Post("detect")
  @ApiOperation({
    summary: "Detect historical rate changes from payment history",
    description:
      "Analyzes the account's payment history to infer rate changes over time. Replaces previously inferred entries; manually entered ones are preserved.",
  })
  @ApiResponse({ status: 201, description: "Detection completed" })
  @ApiResponse({
    status: 400,
    description: "Not enough payment history to detect rate changes",
  })
  @ApiResponse({ status: 404, description: "Account not found" })
  detect(@Request() req, @Param("accountId", ParseUUIDPipe) accountId: string) {
    return this.rateChangeInferenceService.detectAndPersist(
      req.user.id,
      accountId,
    );
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a rate change" })
  @ApiResponse({ status: 200, description: "Rate change updated successfully" })
  @ApiResponse({ status: 404, description: "Rate change not found" })
  @ApiResponse({
    status: 409,
    description: "A rate change already exists for that date",
  })
  update(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateLoanRateChangeDto,
  ) {
    return this.loanRateChangesService.update(
      req.user.id,
      accountId,
      id,
      updateDto,
    );
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a rate change" })
  @ApiResponse({ status: 200, description: "Rate change deleted successfully" })
  @ApiResponse({ status: 404, description: "Rate change not found" })
  remove(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.loanRateChangesService.remove(req.user.id, accountId, id);
  }
}
