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
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
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
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./dto/update-scheduled-transaction.dto";
import { PostScheduledTransactionDto } from "./dto/post-scheduled-transaction.dto";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";

@ApiTags("Scheduled Transactions")
@Controller("scheduled-transactions")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class ScheduledTransactionsController {
  constructor(
    private readonly scheduledTransactionsService: ScheduledTransactionsService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new scheduled transaction" })
  @ApiResponse({
    status: 201,
    description: "Scheduled transaction created successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  create(@Request() req, @Body() createDto: CreateScheduledTransactionDto) {
    return this.scheduledTransactionsService.create(req.user.id, createDto);
  }

  @Get()
  @ApiOperation({
    summary: "Get all scheduled transactions for the authenticated user",
  })
  @ApiResponse({
    status: 200,
    description: "List of scheduled transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findAll(@Request() req) {
    return this.scheduledTransactionsService.findAll(req.user.id);
  }

  @Get("due")
  @ApiOperation({ summary: "Get all due scheduled transactions" })
  @ApiResponse({
    status: 200,
    description: "List of due scheduled transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findDue(@Request() req) {
    return this.scheduledTransactionsService.findDue(req.user.id);
  }

  @Get("upcoming")
  @ApiOperation({ summary: "Get upcoming scheduled transactions" })
  @ApiQuery({
    name: "days",
    required: false,
    description: "Number of days to look ahead (default: 30)",
  })
  @ApiResponse({
    status: 200,
    description:
      "List of upcoming scheduled transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findUpcoming(
    @Request() req,
    @Query("days", new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.scheduledTransactionsService.findUpcoming(req.user.id, days);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a specific scheduled transaction by ID" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Scheduled transaction retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - scheduled transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a scheduled transaction" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Scheduled transaction updated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - scheduled transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateScheduledTransactionDto,
  ) {
    return this.scheduledTransactionsService.update(req.user.id, id, updateDto);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a scheduled transaction" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Scheduled transaction deleted successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - scheduled transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.remove(req.user.id, id);
  }

  @Post(":id/post")
  @ApiOperation({
    summary: "Post a scheduled transaction (create actual transaction)",
  })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({ status: 200, description: "Transaction posted successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  post(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() postDto: PostScheduledTransactionDto,
  ) {
    return this.scheduledTransactionsService.post(req.user.id, id, postDto);
  }

  @Post(":id/skip")
  @ApiOperation({
    summary: "Skip this occurrence and advance to next due date",
  })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({ status: 200, description: "Occurrence skipped successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  skip(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.skip(req.user.id, id);
  }

  // ==================== Override Endpoints ====================

  @Get(":id/overrides")
  @ApiOperation({ summary: "Get all overrides for a scheduled transaction" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "List of overrides retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  findOverrides(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.findOverrides(req.user.id, id);
  }

  @Get(":id/overrides/check")
  @ApiOperation({
    summary: "Check if a scheduled transaction has any overrides",
  })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({ status: 200, description: "Override check completed" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  hasOverrides(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.hasOverrides(req.user.id, id);
  }

  @Get(":id/overrides/date/:date")
  @ApiOperation({ summary: "Get override for a specific date (if exists)" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiParam({ name: "date", description: "Date in YYYY-MM-DD format" })
  @ApiResponse({
    status: 200,
    description: "Override retrieved (or null if none exists)",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  findOverrideByDate(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("date") date: string,
  ) {
    return this.scheduledTransactionsService.findOverrideByDate(
      req.user.id,
      id,
      date,
    );
  }

  @Post(":id/overrides")
  @ApiOperation({ summary: "Create an override for a specific occurrence" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({ status: 201, description: "Override created successfully" })
  @ApiResponse({
    status: 400,
    description: "Bad request - override already exists for this date",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  createOverride(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() createDto: CreateScheduledTransactionOverrideDto,
  ) {
    return this.scheduledTransactionsService.createOverride(
      req.user.id,
      id,
      createDto,
    );
  }

  @Get(":id/overrides/:overrideId")
  @ApiOperation({ summary: "Get a specific override by ID" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiParam({ name: "overrideId", description: "Override UUID" })
  @ApiResponse({ status: 200, description: "Override retrieved successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Override not found" })
  findOverride(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("overrideId", ParseUUIDPipe) overrideId: string,
  ) {
    return this.scheduledTransactionsService.findOverride(
      req.user.id,
      id,
      overrideId,
    );
  }

  @Patch(":id/overrides/:overrideId")
  @ApiOperation({ summary: "Update an override" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiParam({ name: "overrideId", description: "Override UUID" })
  @ApiResponse({ status: 200, description: "Override updated successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Override not found" })
  updateOverride(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("overrideId", ParseUUIDPipe) overrideId: string,
    @Body() updateDto: UpdateScheduledTransactionOverrideDto,
  ) {
    return this.scheduledTransactionsService.updateOverride(
      req.user.id,
      id,
      overrideId,
      updateDto,
    );
  }

  @Delete(":id/overrides/:overrideId")
  @ApiOperation({ summary: "Delete an override" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiParam({ name: "overrideId", description: "Override UUID" })
  @ApiResponse({ status: 200, description: "Override deleted successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Override not found" })
  removeOverride(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("overrideId", ParseUUIDPipe) overrideId: string,
  ) {
    return this.scheduledTransactionsService.removeOverride(
      req.user.id,
      id,
      overrideId,
    );
  }

  @Delete(":id/overrides")
  @ApiOperation({ summary: "Delete all overrides for a scheduled transaction" })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "All overrides deleted successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  removeAllOverrides(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.removeAllOverrides(
      req.user.id,
      id,
    );
  }
}
