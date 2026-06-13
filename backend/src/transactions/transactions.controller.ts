import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  UseInterceptors,
  Request,
  Query,
  ParseUUIDPipe,
  ParseBoolPipe,
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
import { TransactionsService } from "./transactions.service";
import {
  AllowDelegate,
  DelegatedAccountParam,
  DelegatedTransactionParam,
  DelegatedTransferBody,
  DelegatedTransferParam,
  DelegateRequires,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegateTransferMaskInterceptor } from "../delegation/interceptors/delegate-transfer-mask.interceptor";
import { DelegationService } from "../delegation/delegation.service";
import { TransactionStatus } from "./entities/transaction.entity";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { UpdateSplitsDto } from "./dto/update-splits.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { UpdateTransferDto } from "./dto/update-transfer.dto";
import { GetRecentTransactionsDto } from "./dto/get-recent-transactions.dto";
import { BulkReconcileDto } from "./dto/bulk-reconcile.dto";
import { BulkUpdateDto, BulkDeleteDto } from "./dto/bulk-update.dto";
import { MarkClearedDto } from "./dto/mark-cleared.dto";
import { UpdateTransactionStatusDto } from "./dto/update-transaction-status.dto";
import {
  parseIds,
  parseUuids,
  parseCategoryIds,
  validateDateParam,
  assertStringParam,
  UUID_REGEX,
  DATE_REGEX,
} from "../common/query-param-utils";
import { tr } from "../i18n/translate";

const ALL_TRANSACTION_STATUSES = new Set<string>(
  Object.values(TransactionStatus),
);

function parseTransactionStatuses(
  value?: string,
): TransactionStatus[] | undefined {
  if (!value) return undefined;
  const statuses = value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s);
  for (const status of statuses) {
    if (!ALL_TRANSACTION_STATUSES.has(status)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.invalidStatus",
          `Invalid transaction status: ${status}`,
          { status },
        ),
      );
    }
  }
  return statuses.length > 0 ? (statuses as TransactionStatus[]) : undefined;
}

@ApiTags("Transactions")
@Controller("transactions")
@UseGuards(AuthGuard("jwt"))
@UseInterceptors(DelegateTransferMaskInterceptor)
@ApiBearerAuth()
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly delegationService: DelegationService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new transaction" })
  @ApiResponse({ status: 201, description: "Transaction created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegatedAccountParam("accountId")
  @DelegateRequires("create")
  create(@Request() req, @Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(req.user.id, createTransactionDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all transactions for the authenticated user" })
  @ApiQuery({
    name: "accountId",
    required: false,
    description:
      "Filter by account ID (single value, deprecated - use accountIds)",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Filter by account IDs (comma-separated)",
  })
  @ApiQuery({
    name: "startDate",
    required: false,
    description: "Filter by start date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "endDate",
    required: false,
    description: "Filter by end date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "categoryId",
    required: false,
    description:
      "Filter by category ID (single value, deprecated - use categoryIds)",
  })
  @ApiQuery({
    name: "categoryIds",
    required: false,
    description:
      "Filter by category IDs (comma-separated, also matches split transactions)",
  })
  @ApiQuery({
    name: "payeeId",
    required: false,
    description: "Filter by payee ID (single value, deprecated - use payeeIds)",
  })
  @ApiQuery({
    name: "payeeIds",
    required: false,
    description: "Filter by payee IDs (comma-separated)",
  })
  @ApiQuery({
    name: "page",
    required: false,
    description: "Page number (1-indexed, default: 1)",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Number of transactions per page (default: 50, max: 200)",
  })
  @ApiQuery({
    name: "includeInvestmentBrokerage",
    required: false,
    description:
      "Include transactions from investment brokerage accounts (default: false)",
  })
  @ApiQuery({
    name: "search",
    required: false,
    description:
      "Search text matched against description, payee, category, subcategory, amount, reference number, split memo, and tag",
  })
  @ApiQuery({
    name: "amountFrom",
    required: false,
    description: "Filter by minimum amount (inclusive)",
  })
  @ApiQuery({
    name: "amountTo",
    required: false,
    description: "Filter by maximum amount (inclusive)",
  })
  @ApiQuery({
    name: "tagIds",
    required: false,
    description: "Filter by tag IDs (comma-separated)",
  })
  @ApiQuery({
    name: "statuses",
    required: false,
    description:
      "Filter by reconciliation statuses (comma-separated: UNRECONCILED, CLEARED, RECONCILED, VOID)",
  })
  @ApiQuery({
    name: "sortBy",
    required: false,
    description: "Field to sort by (date, account, payee, category, description, refNumber, amount, status, tags)",
  })
  @ApiQuery({
    name: "sortOrder",
    required: false,
    description: "Sort order (ASC, DESC)",
  })
  @ApiResponse({
    status: 200,
    description: "List of transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  async findAll(
    @Request() req,
    @Query("accountId") accountId?: string,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("categoryId") categoryId?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("payeeId") payeeId?: string,
    @Query("payeeIds") payeeIds?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("includeInvestmentBrokerage", new ParseBoolPipe({ optional: true }))
    includeInvestmentBrokerage?: boolean,
    @Query("search") search?: string,
    @Query("targetTransactionId") targetTransactionId?: string,
    @Query("amountFrom") amountFrom?: string,
    @Query("amountTo") amountTo?: string,
    @Query("tagIds") tagIdsParam?: string,
    @Query("statuses") statusesParam?: string,
    @Query("sortBy") sortBy?: string,
    @Query("sortOrder") sortOrder?: string,
  ) {
    // Validate pagination parameters
    if (page !== undefined) {
      const pageNum = parseInt(page, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        throw new BadRequestException(
          tr(
            "errors.transactions.pagePositiveInteger",
            "page must be a positive integer",
          ),
        );
      }
    }

    if (limit !== undefined) {
      const limitNum = parseInt(limit, 10);
      if (isNaN(limitNum) || limitNum < 1) {
        throw new BadRequestException(
          tr(
            "errors.transactions.limitPositiveInteger",
            "limit must be a positive integer",
          ),
        );
      }
      if (limitNum > 200) {
        throw new BadRequestException(
          tr("errors.transactions.limitMax200", "limit must not exceed 200"),
        );
      }
    }

    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    if (targetTransactionId && !UUID_REGEX.test(targetTransactionId)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.targetTransactionIdInvalidUuid",
          "targetTransactionId must be a valid UUID",
        ),
      );
    }

    // Truncate search to prevent excessive ILIKE query length
    const searchStr = assertStringParam(search, "search");
    const sanitizedSearch = searchStr ? searchStr.slice(0, 200) : undefined;

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountFromMustBeNumber",
          "amountFrom must be a number",
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountToMustBeNumber",
          "amountTo must be a number",
        ),
      );
    }

    let effectiveAccountIds = parseIds(accountIds, accountId);
    if (req.user.isActing) {
      // A delegate only ever sees transactions for the accounts they were
      // granted READ on. Intersect any requested ids with the readable set;
      // an empty result means "no visible accounts" -> empty page (NOT an
      // unfiltered query, which would leak the whole owner ledger).
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      const readableSet = new Set(readable);
      effectiveAccountIds =
        effectiveAccountIds && effectiveAccountIds.length > 0
          ? effectiveAccountIds.filter((id) => readableSet.has(id))
          : readable;
      if (effectiveAccountIds.length === 0) {
        const safeLimit = limit ? parseInt(limit, 10) : 50;
        const safePage = page ? parseInt(page, 10) : 1;
        return {
          data: [],
          pagination: {
            page: safePage,
            limit: safeLimit,
            total: 0,
            totalPages: 0,
            hasMore: false,
          },
        };
      }
    }

    let validatedSortOrder: "ASC" | "DESC" | undefined;
    if (sortOrder !== undefined) {
      const upper = sortOrder.trim().toUpperCase();
      if (upper === "ASC" || upper === "DESC") {
        validatedSortOrder = upper as "ASC" | "DESC";
      } else {
        throw new BadRequestException(
          tr("errors.transactions.invalidSortOrder", "sortOrder must be ASC or DESC"),
        );
      }
    }

    return this.transactionsService.findAll(
      req.user.id,
      effectiveAccountIds,
      startDate,
      endDate,
      parseCategoryIds(categoryIds ?? categoryId),
      parseIds(payeeIds, payeeId),
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      includeInvestmentBrokerage === true,
      sanitizedSearch,
      targetTransactionId,
      parsedAmountFrom,
      parsedAmountTo,
      parseUuids(tagIdsParam),
      parseTransactionStatuses(statusesParam),
      sortBy,
      validatedSortOrder,
    );
  }

  @Get("summary")
  @ApiOperation({ summary: "Get transaction summary statistics" })
  @ApiQuery({
    name: "accountId",
    required: false,
    description: "Filter by account ID (deprecated - use accountIds)",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Filter by account IDs (comma-separated)",
  })
  @ApiQuery({
    name: "startDate",
    required: false,
    description: "Filter by start date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "endDate",
    required: false,
    description: "Filter by end date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "categoryId",
    required: false,
    description: "Filter by category ID (deprecated - use categoryIds)",
  })
  @ApiQuery({
    name: "categoryIds",
    required: false,
    description: "Filter by category IDs (comma-separated)",
  })
  @ApiQuery({
    name: "payeeId",
    required: false,
    description: "Filter by payee ID (deprecated - use payeeIds)",
  })
  @ApiQuery({
    name: "payeeIds",
    required: false,
    description: "Filter by payee IDs (comma-separated)",
  })
  @ApiQuery({
    name: "search",
    required: false,
    description:
      "Search text matched against description, payee, category, subcategory, amount, reference number, split memo, and tag",
  })
  @ApiQuery({
    name: "amountFrom",
    required: false,
    description: "Filter by minimum amount (inclusive)",
  })
  @ApiQuery({
    name: "amountTo",
    required: false,
    description: "Filter by maximum amount (inclusive)",
  })
  @ApiResponse({
    status: 200,
    description: "Transaction summary retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getSummary(
    @Request() req,
    @Query("accountId") accountId?: string,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("categoryId") categoryId?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("payeeId") payeeId?: string,
    @Query("payeeIds") payeeIds?: string,
    @Query("search") search?: string,
    @Query("amountFrom") amountFrom?: string,
    @Query("amountTo") amountTo?: string,
  ) {
    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountFromMustBeNumber",
          "amountFrom must be a number",
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountToMustBeNumber",
          "amountTo must be a number",
        ),
      );
    }

    return this.transactionsService.getSummary(
      req.user.id,
      parseIds(accountIds, accountId),
      startDate,
      endDate,
      parseCategoryIds(categoryIds ?? categoryId),
      parseIds(payeeIds, payeeId),
      search,
      parsedAmountFrom,
      parsedAmountTo,
    );
  }

  @Get("monthly-totals")
  @ApiOperation({ summary: "Get monthly transaction totals" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Filter by account IDs (comma-separated)",
  })
  @ApiQuery({
    name: "startDate",
    required: false,
    description: "Filter by start date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "endDate",
    required: false,
    description: "Filter by end date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "categoryIds",
    required: false,
    description:
      "Filter by category IDs (comma-separated, supports 'uncategorized' and 'transfer')",
  })
  @ApiQuery({
    name: "payeeIds",
    required: false,
    description: "Filter by payee IDs (comma-separated)",
  })
  @ApiQuery({
    name: "search",
    required: false,
    description:
      "Search text matched against description, payee, category, subcategory, amount, reference number, split memo, and tag",
  })
  @ApiQuery({
    name: "amountFrom",
    required: false,
    description: "Filter by minimum amount (inclusive)",
  })
  @ApiQuery({
    name: "amountTo",
    required: false,
    description: "Filter by maximum amount (inclusive)",
  })
  @ApiResponse({
    status: 200,
    description: "Monthly totals retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  async getMonthlyTotals(
    @Request() req,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("payeeIds") payeeIds?: string,
    @Query("search") search?: string,
    @Query("amountFrom") amountFrom?: string,
    @Query("amountTo") amountTo?: string,
    @Query("tagIds") tagIdsParam?: string,
  ) {
    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountFromMustBeNumber",
          "amountFrom must be a number",
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.amountToMustBeNumber",
          "amountTo must be a number",
        ),
      );
    }

    let effectiveAccountIds = parseUuids(accountIds);
    if (req.user.isActing) {
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      const readableSet = new Set(readable);
      effectiveAccountIds =
        effectiveAccountIds && effectiveAccountIds.length > 0
          ? effectiveAccountIds.filter((id) => readableSet.has(id))
          : readable;
      if (effectiveAccountIds.length === 0) return [];
    }

    return this.transactionsService.getMonthlyTotals(
      req.user.id,
      effectiveAccountIds,
      startDate,
      endDate,
      parseCategoryIds(categoryIds),
      parseUuids(payeeIds),
      search,
      parsedAmountFrom,
      parsedAmountTo,
      parseUuids(tagIdsParam),
    );
  }

  @Get("recent")
  @ApiOperation({
    summary:
      "Get recent transactions for quick-fill. Without a payee filter, returns last-N distinct (deduped by payee+category). With payeeId or payeeName, returns the raw last-N entries for that payee.",
  })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Number of recent transactions (1-20, default 5)",
  })
  @ApiQuery({
    name: "payeeId",
    required: false,
    description: "Filter to transactions for this payee (UUID); disables dedup",
  })
  @ApiQuery({
    name: "payeeName",
    required: false,
    description:
      "Filter to transactions with this exact free-text payeeName; disables dedup",
  })
  @ApiResponse({
    status: 200,
    description: "Recent transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getRecent(@Request() req, @Query() query: GetRecentTransactionsDto) {
    return this.transactionsService.getRecent(req.user.id, query.limit ?? 5, {
      payeeId: query.payeeId,
      payeeName: query.payeeName,
    });
  }

  // ==================== Reconciliation Endpoints ====================
  // NOTE: These static-segment routes MUST be declared before the generic
  // :id param route below, otherwise NestJS matches "reconcile" as an :id
  // value and returns a 400 (ParseUUIDPipe rejects non-UUID strings).

  @Get("reconcile/:accountId")
  @ApiOperation({ summary: "Get reconciliation data for an account" })
  @ApiParam({ name: "accountId", description: "Account UUID" })
  @ApiQuery({
    name: "statementDate",
    required: true,
    description: "Statement date (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "statementBalance",
    required: true,
    description: "Statement ending balance",
  })
  @ApiResponse({
    status: 200,
    description: "Reconciliation data retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  getReconciliationData(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Query("statementDate") statementDate: string,
    @Query("statementBalance") statementBalance: string,
  ) {
    if (!statementDate || !DATE_REGEX.test(statementDate)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.statementDateFormat",
          "statementDate must be YYYY-MM-DD",
        ),
      );
    }
    const balance = parseFloat(statementBalance);
    if (isNaN(balance)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.statementBalanceMustBeNumber",
          "statementBalance must be a number",
        ),
      );
    }
    return this.transactionsService.getReconciliationData(
      req.user.id,
      accountId,
      statementDate,
      balance,
    );
  }

  @Post("reconcile/:accountId")
  @ApiOperation({ summary: "Bulk reconcile transactions for an account" })
  @ApiParam({ name: "accountId", description: "Account UUID" })
  @ApiResponse({
    status: 200,
    description: "Transactions reconciled successfully",
  })
  @ApiResponse({ status: 400, description: "Invalid transaction IDs" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  bulkReconcile(
    @Request() req,
    @Param("accountId", ParseUUIDPipe) accountId: string,
    @Body() bulkReconcileDto: BulkReconcileDto,
  ) {
    return this.transactionsService.bulkReconcile(
      req.user.id,
      accountId,
      bulkReconcileDto.transactionIds,
      bulkReconcileDto.reconciledDate,
    );
  }

  // ==================== Transfer Endpoints ====================
  // NOTE: Static "transfer" route must be before :id param route.

  @Post("transfer")
  @ApiOperation({ summary: "Create a transfer between two accounts" })
  @ApiResponse({ status: 201, description: "Transfer created successfully" })
  @ApiResponse({
    status: 400,
    description: "Bad request - invalid transfer data",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  @AllowDelegate()
  @DelegatedTransferBody()
  @DelegateRequires("create")
  createTransfer(@Request() req, @Body() createTransferDto: CreateTransferDto) {
    return this.transactionsService.createTransfer(
      req.user.id,
      createTransferDto,
    );
  }

  @Post("bulk-update")
  @ApiOperation({ summary: "Bulk update transactions by IDs or filters" })
  @ApiResponse({
    status: 200,
    description: "Transactions updated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  bulkUpdate(@Request() req, @Body() bulkUpdateDto: BulkUpdateDto) {
    return this.transactionsService.bulkUpdate(req.user.id, bulkUpdateDto);
  }

  @Post("bulk-delete")
  @ApiOperation({ summary: "Bulk delete transactions by IDs or filters" })
  @ApiResponse({
    status: 200,
    description: "Transactions deleted successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  bulkDelete(@Request() req, @Body() bulkDeleteDto: BulkDeleteDto) {
    return this.transactionsService.bulkDelete(req.user.id, bulkDeleteDto);
  }

  // ==================== Single Transaction CRUD (:id param routes) ====================

  @Get(":id")
  @ApiOperation({ summary: "Get a specific transaction by ID" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransactionParam("id")
  findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction updated successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransactionParam("id")
  @DelegateRequires("edit")
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTransactionDto: UpdateTransactionDto,
  ) {
    return this.transactionsService.update(
      req.user.id,
      id,
      updateTransactionDto,
    );
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 200, description: "Transaction deleted successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({
    status: 403,
    description: "Forbidden - transaction does not belong to user",
  })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransactionParam("id")
  @DelegateRequires("delete")
  remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.remove(req.user.id, id);
  }

  @Post(":id/clear")
  @ApiOperation({ summary: "Mark transaction as cleared or uncleared" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction cleared status updated",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  markCleared(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() markClearedDto: MarkClearedDto,
  ) {
    return this.transactionsService.markCleared(
      req.user.id,
      id,
      markClearedDto.isCleared,
    );
  }

  @Post(":id/reconcile")
  @ApiOperation({ summary: "Reconcile a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction reconciled successfully",
  })
  @ApiResponse({ status: 400, description: "Transaction already reconciled" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  reconcile(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.reconcile(req.user.id, id);
  }

  @Post(":id/unreconcile")
  @ApiOperation({ summary: "Unreconcile a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction unreconciled successfully",
  })
  @ApiResponse({ status: 400, description: "Transaction is not reconciled" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  unreconcile(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.unreconcile(req.user.id, id);
  }

  @Patch(":id/status")
  @ApiOperation({ summary: "Update transaction status" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Transaction status updated successfully",
  })
  @ApiResponse({ status: 400, description: "Invalid status" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  updateStatus(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateStatusDto: UpdateTransactionStatusDto,
  ) {
    return this.transactionsService.updateStatus(
      req.user.id,
      id,
      updateStatusDto.status,
    );
  }

  // ==================== Split Transaction Endpoints ====================

  @Get(":id/splits")
  @ApiOperation({ summary: "Get all splits for a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 200, description: "Splits retrieved successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  getSplits(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.getSplits(req.user.id, id);
  }

  @Put(":id/splits")
  @ApiOperation({
    summary: "Replace all splits for a transaction (atomic update)",
  })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 200, description: "Splits updated successfully" })
  @ApiResponse({ status: 400, description: "Invalid splits data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  updateSplits(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateSplitsDto,
  ) {
    return this.transactionsService.updateSplits(req.user.id, id, dto.splits);
  }

  @Post(":id/splits")
  @ApiOperation({ summary: "Add a single split to a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 201, description: "Split added successfully" })
  @ApiResponse({ status: 400, description: "Invalid split data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  addSplit(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() splitDto: CreateTransactionSplitDto,
  ) {
    return this.transactionsService.addSplit(req.user.id, id, splitDto);
  }

  @Delete(":id/splits/:splitId")
  @ApiOperation({ summary: "Remove a split from a transaction" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiParam({ name: "splitId", description: "Split UUID" })
  @ApiResponse({ status: 200, description: "Split removed successfully" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction or split not found" })
  removeSplit(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("splitId", ParseUUIDPipe) splitId: string,
  ) {
    return this.transactionsService.removeSplit(req.user.id, id, splitId);
  }

  @Get(":id/linked")
  @ApiOperation({ summary: "Get the linked transaction for a transfer" })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({
    status: 200,
    description: "Linked transaction retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransactionParam("id")
  getLinkedTransaction(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.getLinkedTransaction(req.user.id, id);
  }

  @Delete(":id/transfer")
  @ApiOperation({
    summary: "Delete a transfer (deletes both linked transactions)",
  })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 200, description: "Transfer deleted successfully" })
  @ApiResponse({ status: 400, description: "Transaction is not a transfer" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransferParam("id")
  @DelegateRequires("delete")
  removeTransfer(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.transactionsService.removeTransfer(req.user.id, id);
  }

  @Patch(":id/transfer")
  @ApiOperation({
    summary: "Update a transfer (updates both linked transactions)",
  })
  @ApiParam({ name: "id", description: "Transaction UUID" })
  @ApiResponse({ status: 200, description: "Transfer updated successfully" })
  @ApiResponse({
    status: 400,
    description: "Transaction is not a transfer or invalid data",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Transaction not found" })
  @AllowDelegate()
  @DelegatedTransferParam("id")
  @DelegateRequires("edit")
  updateTransfer(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTransferDto: UpdateTransferDto,
  ) {
    return this.transactionsService.updateTransfer(
      req.user.id,
      id,
      updateTransferDto,
    );
  }
}
