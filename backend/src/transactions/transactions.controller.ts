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
  Request,
  Query,
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
import { AuthGuard } from "@nestjs/passport";
import { TransactionsService } from "./transactions.service";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { BulkReconcileDto } from "./dto/bulk-reconcile.dto";
import { BulkUpdateDto } from "./dto/bulk-update.dto";
import { MarkClearedDto } from "./dto/mark-cleared.dto";
import { UpdateTransactionStatusDto } from "./dto/update-transaction-status.dto";

@ApiTags("Transactions")
@Controller("transactions")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiOperation({ summary: "Create a new transaction" })
  @ApiResponse({ status: 201, description: "Transaction created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
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
      "Search text to filter by description, payee name, or split memo",
  })
  @ApiQuery({
    name: "targetTransactionId",
    required: false,
    description:
      "Navigate to the page containing this transaction ID (overrides page parameter)",
  })
  @ApiResponse({
    status: 200,
    description: "List of transactions retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  findAll(
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
    @Query("includeInvestmentBrokerage") includeInvestmentBrokerage?: string,
    @Query("search") search?: string,
    @Query("targetTransactionId") targetTransactionId?: string,
  ) {
    // Validate pagination parameters
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (page !== undefined) {
      const pageNum = parseInt(page, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        throw new BadRequestException("page must be a positive integer");
      }
    }

    if (limit !== undefined) {
      const limitNum = parseInt(limit, 10);
      if (isNaN(limitNum) || limitNum < 1) {
        throw new BadRequestException("limit must be a positive integer");
      }
      if (limitNum > 200) {
        throw new BadRequestException("limit must not exceed 200");
      }
    }

    // Validate date parameters
    if (startDate !== undefined && !dateRegex.test(startDate)) {
      throw new BadRequestException(
        "startDate must be a valid date in YYYY-MM-DD format",
      );
    }
    if (endDate !== undefined && !dateRegex.test(endDate)) {
      throw new BadRequestException(
        "endDate must be a valid date in YYYY-MM-DD format",
      );
    }

    // Parse comma-separated IDs into arrays, with backward compatibility for singular params
    const parseIds = (
      plural?: string,
      singular?: string,
    ): string[] | undefined => {
      if (plural) {
        const ids = plural
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id);
        for (const id of ids) {
          if (!uuidRegex.test(id)) {
            throw new BadRequestException(`Invalid UUID: ${id}`);
          }
        }
        return ids;
      }
      if (singular) {
        if (!uuidRegex.test(singular)) {
          throw new BadRequestException(`Invalid UUID: ${singular}`);
        }
        return [singular];
      }
      return undefined;
    };

    // Validate targetTransactionId
    if (targetTransactionId && !uuidRegex.test(targetTransactionId)) {
      throw new BadRequestException(
        "targetTransactionId must be a valid UUID",
      );
    }

    return this.transactionsService.findAll(
      req.user.id,
      parseIds(accountIds, accountId),
      startDate,
      endDate,
      parseIds(categoryIds, categoryId),
      parseIds(payeeIds, payeeId),
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      includeInvestmentBrokerage === "true",
      search,
      targetTransactionId,
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
      "Search text to filter by description, payee name, or split memo",
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
  ) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    // Validate date parameters
    if (startDate !== undefined && !dateRegex.test(startDate)) {
      throw new BadRequestException(
        "startDate must be a valid date in YYYY-MM-DD format",
      );
    }
    if (endDate !== undefined && !dateRegex.test(endDate)) {
      throw new BadRequestException(
        "endDate must be a valid date in YYYY-MM-DD format",
      );
    }

    // Parse comma-separated IDs into arrays, with backward compatibility for singular params
    const parseIds = (
      plural?: string,
      singular?: string,
    ): string[] | undefined => {
      if (plural) {
        const ids = plural
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id);
        for (const id of ids) {
          if (!uuidRegex.test(id)) {
            throw new BadRequestException(`Invalid UUID: ${id}`);
          }
        }
        return ids;
      }
      if (singular) {
        if (!uuidRegex.test(singular)) {
          throw new BadRequestException(`Invalid UUID: ${singular}`);
        }
        return [singular];
      }
      return undefined;
    };

    return this.transactionsService.getSummary(
      req.user.id,
      parseIds(accountIds, accountId),
      startDate,
      endDate,
      parseIds(categoryIds, categoryId),
      parseIds(payeeIds, payeeId),
      search,
    );
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
    return this.transactionsService.getReconciliationData(
      req.user.id,
      accountId,
      statementDate,
      parseFloat(statementBalance),
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
    @Body() splits: CreateTransactionSplitDto[],
  ) {
    return this.transactionsService.updateSplits(req.user.id, id, splits);
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
  updateTransfer(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTransferDto: Partial<CreateTransferDto>,
  ) {
    return this.transactionsService.updateTransfer(
      req.user.id,
      id,
      updateTransferDto,
    );
  }
}
