import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  Request,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
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
import { AuthGuard } from "@nestjs/passport";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import { UpdateScheduledTransactionDto } from "./dto/update-scheduled-transaction.dto";
import { PostScheduledTransactionDto } from "./dto/post-scheduled-transaction.dto";
import { ScheduledOccurrencesQueryDto } from "./dto/scheduled-occurrences-query.dto";
import {
  CreateScheduledTransactionOverrideDto,
  UpdateScheduledTransactionOverrideDto,
} from "./dto/scheduled-transaction-override.dto";
import {
  AllowDelegate,
  DelegatedBodyAccounts,
  DelegatedTransferBody,
  DelegatedScheduledParam,
  DelegateRequires,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegateScheduledTransferMaskInterceptor } from "../delegation/interceptors/delegate-scheduled-transfer-mask.interceptor";
import { DelegationService } from "../delegation/delegation.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";
import { tr } from "../i18n/translate";

@ApiTags("Scheduled Transactions")
@Controller("scheduled-transactions")
@UseGuards(AuthGuard("jwt"))
@UseInterceptors(DelegateScheduledTransferMaskInterceptor)
@ApiBearerAuth()
export class ScheduledTransactionsController {
  constructor(
    private readonly scheduledTransactionsService: ScheduledTransactionsService,
    private readonly delegationService: DelegationService,
    private readonly jointAccounts: JointAccountsService,
  ) {}

  /**
   * Restrict a result set to scheduled rows the delegate may see: those on
   * an account they were granted READ on, OR transfers where the granted
   * account is the source or the recipient (the unreadable counterpart is
   * masked by DelegateScheduledTransferMaskInterceptor). Non-delegate
   * requests pass through unchanged.
   */
  private async filterForDelegate<
    T extends {
      accountId: string;
      transferAccountId?: string | null;
      isTransfer?: boolean;
    },
  >(
    req: { user: { isActing?: boolean; delegationId?: string } },
    rows: T[],
  ): Promise<T[]> {
    if (!req.user.isActing || !req.user.delegationId) return rows;
    const readable = new Set(
      await this.delegationService.readableAccountIds(req.user.delegationId),
    );
    return rows.filter(
      (r) =>
        readable.has(r.accountId) ||
        (!!r.isTransfer &&
          !!r.transferAccountId &&
          readable.has(r.transferAccountId)),
    );
  }

  @Post()
  @ApiOperation({ summary: "Create a new scheduled transaction" })
  @ApiResponse({
    status: 201,
    description: "Scheduled transaction created successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedTransferBody("accountId", "transferAccountId")
  @DelegatedBodyAccounts(
    "investmentFundingAccountId",
    "splits[].transferAccountId",
  )
  @DelegateRequires("create")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  async findAll(@Request() req) {
    const rows = await this.scheduledTransactionsService.findAll(req.user.id);
    return this.filterForDelegate(req, rows);
  }

  @Get("due")
  @ApiOperation({ summary: "Get all due scheduled transactions" })
  @ApiResponse({
    status: 200,
    description: "List of due scheduled transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  async findDue(@Request() req) {
    const rows = await this.scheduledTransactionsService.findDue(req.user.id);
    return this.filterForDelegate(req, rows);
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  async findUpcoming(
    @Request() req,
    @Query("days", new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    const rows = await this.scheduledTransactionsService.findUpcoming(
      req.user.id,
      days,
    );
    return this.filterForDelegate(req, rows);
  }

  // Declared before `:id` on purpose: Nest matches in declaration order, and a
  // parameterised route above this one would swallow the literal path.
  @Get("occurrences")
  @ApiOperation({
    summary:
      "Get scheduled occurrences due through a date, priced at what each would post today",
  })
  @ApiResponse({
    status: 200,
    description: "List of effective scheduled occurrences",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  async findOccurrences(
    @Request() req,
    @Query() query: ScheduledOccurrencesQueryDto,
  ) {
    const rows =
      await this.scheduledTransactionsService.findEffectiveOccurrences(
        req.user.id,
        { through: query.through, maxPerSchedule: query.maxPerSchedule },
      );
    return this.filterForDelegate(req, rows);
  }

  // Also before `:id`: "loan-anchor" is a literal path segment.
  @Get("loan-anchor/:accountId")
  @ApiOperation({
    summary: "Get the next-installment projection anchor for a loan account",
    description:
      "The next scheduled installment's due date and the loan's debt measured " +
      "from the ledger through that date -- the same balance boundary the " +
      "scheduled bill's interest is calculated from, so an amortization " +
      "projection anchored here agrees with the next bill (issue #1253). " +
      "Both fields are null when the account has no active scheduled payment.",
  })
  @ApiParam({ name: "accountId", description: "Loan account UUID" })
  @ApiResponse({ status: 200, description: "Projection anchor retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  // The amortization report is a `reports` surface a delegate can hold, and it
  // fetches this anchor in the same request as the loan's history. Without the
  // annotation `AccountDelegateGuard` fails an acting session closed, the
  // report's Promise.all rejects, and the WHOLE report is replaced by its error
  // state -- for a report that rendered before this endpoint existed. Its
  // sibling, GET /accounts/:accountId/rate-changes, is annotated for exactly
  // the same reason.
  @AllowDelegate()
  @DelegateRequiresSection("reports")
  async getLoanProjectionAnchor(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
  ) {
    const anchor =
      await this.scheduledTransactionsService.getLoanProjectionAnchor(
        req.user.id,
        accountId,
      );
    if (anchor.nextDueDate !== null || req.user.isActing) {
      return anchor;
    }
    // Joint fallback, as on `GET /accounts/:id/balance`: the report's account
    // list is a union of owned and jointly shared accounts, so a shared loan
    // resolves to nothing under the caller's own scope. Authorize first, then
    // read with the owner's -- otherwise "not shared with me" and "this loan
    // has no scheduled payment" come back as the same answer, and the report
    // silently falls back to projecting from today.
    const jointIds = await this.jointAccounts.jointAccountIdSetFor(
      req.user.realUserId ?? req.user.id,
    );
    if (!jointIds.has(accountId)) {
      return anchor;
    }
    const access = await this.jointAccounts.jointAccessFor(
      req.user.realUserId ?? req.user.id,
      accountId,
      "read",
    );
    return this.scheduledTransactionsService.getLoanProjectionAnchor(
      access.ownerUserId,
      accountId,
    );
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegatedTransferBody("accountId", "transferAccountId")
  @DelegatedBodyAccounts(
    "investmentFundingAccountId",
    "splits[].transferAccountId",
  )
  @DelegateRequires("edit")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegateRequires("delete")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegatedBodyAccounts("splits[].transferAccountId")
  @DelegateRequires("edit")
  post(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() postDto: PostScheduledTransactionDto,
  ) {
    // A delegate acting as the owner posts the owner's bill but is not the
    // owner: the owner's structural rules must not run on the posted row.
    return this.scheduledTransactionsService.post(req.user.id, id, postDto, {
      actorIsNotOwner: req.user.isActing === true,
    });
  }

  @Post(":id/skip")
  @ApiOperation({
    summary: "Skip this occurrence and advance to next due date",
  })
  @ApiParam({ name: "id", description: "Scheduled transaction UUID" })
  @ApiResponse({ status: 200, description: "Occurrence skipped successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Scheduled transaction not found" })
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegateRequires("edit")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  findOverrideByDate(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("date") date: string,
  ) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException(
        tr(
          "errors.scheduled.dateMustBeYMD",
          "date must be in YYYY-MM-DD format",
        ),
      );
    }
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegatedBodyAccounts("splits[].transferAccountId")
  @DelegateRequires("edit")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegatedBodyAccounts("splits[].transferAccountId")
  @DelegateRequires("edit")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegateRequires("delete")
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
  @AllowDelegate()
  @DelegateRequiresSection("bills")
  @DelegatedScheduledParam("id")
  @DelegateRequires("delete")
  removeAllOverrides(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.scheduledTransactionsService.removeAllOverrides(
      req.user.id,
      id,
    );
  }
}
