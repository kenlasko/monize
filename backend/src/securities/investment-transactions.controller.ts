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
import { tr } from "../i18n/translate";
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
import { UpdateTransactionStatusDto } from "../transactions/dto/update-transaction-status.dto";
import { TransferSecurityDto } from "./dto/transfer-security.dto";
import { LinkTransferPairDto } from "./dto/link-transfer-pair.dto";
import { TransferPairLinkService } from "./transfer-pair-link.service";
import {
  InvestmentTransaction,
  InvestmentAction,
} from "./entities/investment-transaction.entity";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";
import { AllowPat, NoPat } from "../auth/pat-access/pat-access.decorator";

// A UUID that cannot match any real account: forces a naturally-empty,
// correctly-shaped result for an acting delegate with no readable accounts
// (instead of passing undefined, which the service treats as "all").
const NO_READABLE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

@ApiTags("Investment Transactions")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@AllowPat()
@Controller("investment-transactions")
export class InvestmentTransactionsController {
  constructor(
    private readonly investmentTransactionsService: InvestmentTransactionsService,
    private readonly delegationService: DelegationService,
    private readonly transferPairLinks: TransferPairLinkService,
  ) {}

  /**
   * The share transfers whose two legs the ledger never paired.
   *
   * A suggestion, not a finding: an unpaired `TRANSFER_IN` cannot take the
   * basis its source released, so the destination reports its cost -- and the
   * gain over it -- as unknown, and pairing the legs is the repair. Which two
   * rows are one transfer is still a person's call, so nothing is linked here
   * and no measure reads this.
   */
  @Get("unlinked-transfer-pairs")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Share transfers whose two legs were never linked to each other",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to look within (linked pairs included); the whole portfolio when omitted",
  })
  @ApiResponse({ status: 200, description: "The candidate pairs" })
  async getUnlinkedTransferPairs(
    @Request() req,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids =
      typeof accountIds === "string" && accountIds.length > 0
        ? accountIds.split(",").filter(Boolean)
        : undefined;
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const id of ids ?? []) {
      if (!uuidRegex.test(id))
        throw new BadRequestException(
          tr(
            "errors.params.mustBeCsvUuids",
            'The value of "accountIds" must be a comma-separated list of UUIDs',
            { param: "accountIds" },
          ),
        );
    }
    return this.transferPairLinks.findCandidates(
      req.user.id,
      await this.scopeIds(req, ids),
    );
  }

  /**
   * Pair two legs a person confirmed are one transfer, and rebuild the basis
   * the pairing lets the destination carry.
   *
   * Not `@AllowDelegate`: this writes, and a delegate's investment grant is a
   * read of the section.
   */
  @Post("link-transfer-pair")
  @ApiOperation({
    summary: "Link the two legs of one share transfer to each other",
  })
  @ApiResponse({ status: 200, description: "The legs are linked" })
  @ApiResponse({
    status: 400,
    description: "The two rows are not the legs of one transfer",
  })
  async linkTransferPair(@Request() req, @Body() dto: LinkTransferPairDto) {
    return this.transferPairLinks.linkPair(
      req.user.id,
      dto.outTransactionId,
      dto.inTransactionId,
    );
  }

  /**
   * For an acting delegate, restrict the account-id filter to the accounts
   * they were granted READ on (intersecting any explicit request). Returns
   * the original ids unchanged for non-delegate requests so owner behaviour
   * (undefined = all accounts) is preserved.
   */
  private async scopeIds(
    req: { user: { isActing?: boolean; delegationId?: string } },
    ids?: string[],
  ): Promise<string[] | undefined> {
    if (!req.user.isActing || !req.user.delegationId) return ids;
    const readable = new Set(
      await this.delegationService.readableAccountIds(req.user.delegationId),
    );
    const eff =
      ids && ids.length > 0
        ? ids.filter((i) => readable.has(i))
        : [...readable];
    return eff.length > 0 ? eff : [NO_READABLE_ACCOUNT];
  }

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

  @Post("transfer-security")
  @ApiOperation({
    summary:
      "Transfer a security between two investment accounts, preserving cost basis",
  })
  @ApiResponse({
    status: 201,
    description:
      "Both transfer legs (TRANSFER_OUT in source, TRANSFER_IN in destination) created",
  })
  @ApiResponse({ status: 400, description: "Invalid request data" })
  transferSecurity(@Request() req, @Body() dto: TransferSecurityDto) {
    return this.investmentTransactionsService.transferSecurity(
      req.user.id,
      dto,
    );
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
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  async findAll(
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
          throw new BadRequestException(
            tr(
              "errors.securities.invalidAccountUuid",
              `Invalid account UUID: ${id}`,
              { id },
            ),
          );
        }
      }
    }

    if (startDate !== undefined && !dateRegex.test(startDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "startDate" must be a date in YYYY-MM-DD format',
          { param: "startDate" },
        ),
      );
    }
    if (endDate !== undefined && !dateRegex.test(endDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "endDate" must be a date in YYYY-MM-DD format',
          { param: "endDate" },
        ),
      );
    }

    if (page !== undefined) {
      const pageNum = parseInt(page, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        throw new BadRequestException(
          tr(
            "errors.securities.pagePositiveInteger",
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
            "errors.securities.limitPositiveInteger",
            "limit must be a positive integer",
          ),
        );
      }
      if (limitNum > 200) {
        throw new BadRequestException(
          tr("errors.securities.limitMax200", "limit must not exceed 200"),
        );
      }
    }

    // M15: Validate action against enum values
    if (action !== undefined) {
      const validActions = Object.values(InvestmentAction);
      if (!validActions.includes(action as InvestmentAction)) {
        throw new BadRequestException(
          tr(
            "errors.securities.invalidAction",
            `Invalid action: ${action}. Must be one of: ${validActions.join(", ")}`,
            { action, validActions: validActions.join(", ") },
          ),
        );
      }
    }

    return this.investmentTransactionsService.findAll(
      req.user.id,
      await this.scopeIds(req, ids),
      startDate,
      endDate,
      page ? parseInt(page, 10) : undefined,
      limit ? parseInt(limit, 10) : undefined,
      symbol,
      action,
    );
  }

  @Get("filter-options")
  @ApiOperation({
    summary:
      "The investment actions in use on the given accounts, for the register's Action filter",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @ApiResponse({ status: 200, description: "Filter options retrieved" })
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  async getFilterOptions(
    @Request() req,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          throw new BadRequestException(
            tr(
              "errors.securities.invalidAccountUuid",
              `Invalid account UUID: ${id}`,
              { id },
            ),
          );
        }
      }
    }
    return this.investmentTransactionsService.getRegisterFilterOptions(
      req.user.id,
      await this.scopeIds(req, ids),
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
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  async getSummary(@Request() req, @Query("accountIds") accountIds?: string) {
    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    return this.investmentTransactionsService.getSummary(
      req.user.id,
      await this.scopeIds(req, ids),
    );
  }

  @Get("realized-gains")
  @ApiOperation({
    summary:
      "Realized gains for each SELL transaction, using average-cost basis replay",
  })
  @ApiQuery({ name: "accountIds", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  @ApiResponse({ status: 200, description: "List of SELLs with realized gain" })
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  async getRealizedGains(
    @Request() req,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          throw new BadRequestException(
            tr(
              "errors.securities.invalidAccountUuid",
              `Invalid account UUID: ${id}`,
              { id },
            ),
          );
        }
      }
    }
    if (startDate !== undefined && !dateRegex.test(startDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "startDate" must be a date in YYYY-MM-DD format',
          { param: "startDate" },
        ),
      );
    }
    if (endDate !== undefined && !dateRegex.test(endDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "endDate" must be a date in YYYY-MM-DD format',
          { param: "endDate" },
        ),
      );
    }

    return this.investmentTransactionsService.getRealizedGains(req.user.id, {
      accountIds: await this.scopeIds(req, ids),
      startDate,
      endDate,
    });
  }

  @Get("capital-gains")
  @ApiOperation({
    summary:
      "Per-period capital gains (realized + unrealized) by security across the window",
    description:
      "Returns per (account, security, period) capital gain entries combining realized SELL gains and the unrealized mark-to-market change on the position. Requires startDate and endDate. Use granularity=day for daily breakdown (default: month).",
  })
  @ApiQuery({ name: "accountIds", required: false })
  @ApiQuery({ name: "startDate", required: true })
  @ApiQuery({ name: "endDate", required: true })
  @ApiQuery({ name: "granularity", required: false, enum: ["month", "day"] })
  @ApiResponse({
    status: 200,
    description: "List of capital gain entries per period",
  })
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  async getCapitalGains(
    @Request() req,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate: string,
    @Query("accountIds") accountIds?: string,
    @Query("granularity") granularity?: string,
  ) {
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (!startDate || !dateRegex.test(startDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.requiredCalendarDate",
          'A value for "startDate" is required, as a date in YYYY-MM-DD format',
          { param: "startDate" },
        ),
      );
    }
    if (!endDate || !dateRegex.test(endDate)) {
      throw new BadRequestException(
        tr(
          "errors.params.requiredCalendarDate",
          'A value for "endDate" is required, as a date in YYYY-MM-DD format',
          { param: "endDate" },
        ),
      );
    }
    if (startDate > endDate) {
      throw new BadRequestException(
        tr(
          "errors.params.onOrBefore",
          'The value of "startDate" must be on or before "endDate"',
          { param: "startDate", other: "endDate" },
        ),
      );
    }
    if (granularity && granularity !== "month" && granularity !== "day") {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeOneOf",
          'The value of "granularity" must be one of: month, day',
          { param: "granularity", options: "month, day" },
        ),
      );
    }

    const ids = accountIds ? accountIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id)) {
          throw new BadRequestException(
            tr(
              "errors.securities.invalidAccountUuid",
              `Invalid account UUID: ${id}`,
              { id },
            ),
          );
        }
      }
    }

    const scoped = await this.scopeIds(req, ids);

    if (granularity === "day") {
      return this.investmentTransactionsService.getCapitalGainsByDay(
        req.user.id,
        { accountIds: scoped, startDate, endDate },
      );
    }

    return this.investmentTransactionsService.getCapitalGainsByMonth(
      req.user.id,
      { accountIds: scoped, startDate, endDate },
    );
  }

  @Get("security/:securityId/history")
  @ApiOperation({
    summary:
      "Transaction history for a security with running share totals and the accounts (including closed) it was used in",
  })
  @ApiResponse({
    status: 200,
    description:
      "Security transaction history with per-account and cross-account running share balances",
  })
  @ApiResponse({ status: 404, description: "Security not found" })
  getSecurityTransactionHistory(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
  ) {
    return this.investmentTransactionsService.getSecurityTransactionHistory(
      req.user.id,
      securityId,
    );
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

  @Patch(":id/status")
  @ApiOperation({
    summary: "Update only the status of an investment transaction",
    description:
      "UNRECONCILED/CLEARED/RECONCILED changes are presentational. Crossing the VOID boundary applies or reverses the row's holdings effect and carries the linked cash transaction (and a linked transfer leg) across with it.",
  })
  @ApiResponse({
    status: 200,
    description: "Status updated successfully",
    type: InvestmentTransaction,
  })
  @ApiResponse({ status: 404, description: "Investment transaction not found" })
  updateStatus(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransactionStatusDto,
  ): Promise<InvestmentTransaction> {
    return this.investmentTransactionsService.updateStatus(
      req.user.id,
      id,
      dto.status,
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
  @NoPat()
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
