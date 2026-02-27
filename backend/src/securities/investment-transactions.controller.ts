import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  BadRequestException,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { InvestmentTransactionsService } from "./investment-transactions.service";
import { CreateInvestmentTransactionDto } from "./dto/create-investment-transaction.dto";
import { UpdateInvestmentTransactionDto } from "./dto/update-investment-transaction.dto";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";

@ApiTags("Investment Transactions")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("investment-transactions")
export class InvestmentTransactionsController {
  constructor(
    private readonly investmentTransactionsService: InvestmentTransactionsService,
  ) {}

  @Post()
  @ApiOperation({
    summary: "Create an investment transaction (buy, sell, dividend, etc.)",
  })
  @ApiResponse({
    status: 201,
    description: "Investment transaction created successfully",
    type: InvestmentTransaction,
  })
  @ApiResponse({ status: 400, description: "Invalid request data" })
  create(
    @Request() req,
    @Body() createDto: CreateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    return this.investmentTransactionsService.create(req.user.id, createDto);
  }

  @Get()
  @ApiOperation({
    summary: "Get all investment transactions for the authenticated user",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
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
    name: "symbol",
    required: false,
    description: "Filter by security symbol",
  })
  @ApiQuery({
    name: "action",
    required: false,
    description: "Filter by action type (BUY, SELL, DIVIDEND, etc.)",
  })
  @ApiResponse({
    status: 200,
    description: "List of investment transactions with pagination",
  })
  findAll(
    @Request() req,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("symbol") symbol?: string,
    @Query("action") action?: string,
  ) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          throw new BadRequestException(`Invalid account UUID: ${id}`);
        }
      }
    }

    if (startDate !== undefined && !dateRegex.test(startDate)) {
      throw new BadRequestException("startDate must be in YYYY-MM-DD format");
    }
    if (endDate !== undefined && !dateRegex.test(endDate)) {
      throw new BadRequestException("endDate must be in YYYY-MM-DD format");
    }

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

    // M15: Validate action against enum values
    if (action !== undefined) {
      const validActions = Object.values(InvestmentAction);
      if (!validActions.includes(action as InvestmentAction)) {
        throw new BadRequestException(
          `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`,
        );
      }
    }

    return this.investmentTransactionsService.findAll(
      req.user.id,
      ids,
      startDate,
      endDate,
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      symbol,
      action,
    );
  }

  @Get("summary")
  @ApiOperation({ summary: "Get investment transaction summary" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @ApiResponse({ status: 200, description: "Investment transaction summary" })
  getSummary(@Request() req, @Query("accountIds") accountIds?: string) {
    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    return this.investmentTransactionsService.getSummary(req.user.id, ids);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get an investment transaction by ID" })
  @ApiResponse({
    status: 200,
    description: "Investment transaction details",
    type: InvestmentTransaction,
  })
  @ApiResponse({ status: 404, description: "Investment transaction not found" })
  findOne(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<InvestmentTransaction> {
    return this.investmentTransactionsService.findOne(req.user.id, id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update an investment transaction" })
  @ApiResponse({
    status: 200,
    description: "Investment transaction updated successfully",
    type: InvestmentTransaction,
  })
  @ApiResponse({ status: 404, description: "Investment transaction not found" })
  update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateDto: UpdateInvestmentTransactionDto,
  ): Promise<InvestmentTransaction> {
    return this.investmentTransactionsService.update(
      req.user.id,
      id,
      updateDto,
    );
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete an investment transaction" })
  @ApiResponse({
    status: 200,
    description: "Investment transaction deleted successfully",
  })
  @ApiResponse({ status: 404, description: "Investment transaction not found" })
  remove(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.investmentTransactionsService.remove(req.user.id, id);
  }

  @Delete()
  @ApiOperation({
    summary: "Delete ALL investment transactions and holdings",
    description:
      "DESTRUCTIVE: Deletes all investment transactions, holdings, and resets brokerage account balances to 0.",
  })
  @ApiResponse({
    status: 200,
    description: "All investment data deleted successfully",
    schema: {
      type: "object",
      properties: {
        transactionsDeleted: { type: "number" },
        holdingsDeleted: { type: "number" },
        accountsReset: { type: "number" },
      },
    },
  })
  removeAll(@Request() req) {
    return this.investmentTransactionsService.removeAll(req.user.id);
  }
}
