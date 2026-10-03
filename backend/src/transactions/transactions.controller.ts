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
  DelegatedBodyAccounts,
  DelegatedTransactionParam,
  DelegatedTransferBody,
  DelegatedTransferParam,
  DelegateRequires,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegateTransferMaskInterceptor } from "../delegation/interceptors/delegate-transfer-mask.interceptor";
import { DelegationService } from "../delegation/delegation.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { JointRegisterService } from "./joint-register.service";
import { TransactionStatus } from "./entities/transaction.entity";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { UpdateSplitsDto } from "./dto/update-splits.dto";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { UpdateTransferDto } from "./dto/update-transfer.dto";
import { TransferActor } from "./transaction-transfer.service";
import { GetRecentTransactionsDto } from "./dto/get-recent-transactions.dto";
import { BulkReconcileDto } from "./dto/bulk-reconcile.dto";
import { BulkUpdateDto, BulkDeleteDto } from "./dto/bulk-update.dto";
import { MarkClearedDto } from "./dto/mark-cleared.dto";
import { UpdateTransactionStatusDto } from "./dto/update-transaction-status.dto";
import {
  parseIds,
  parseUuids,
  parseCategoryIds,
  parseCurrencyCodes,
  validateDateParam,
  assertStringParam,
  UUID_REGEX,
  DATE_REGEX,
} from "../common/query-param-utils";
import { tr } from "../i18n/translate";
import {
  TagKeyFilter,
  TagKeyFilterOp,
  TAG_KEY_FILTER_OPS,
  tagKeyOpNeedsValue,
} from "./tag-key-filter.util";
import { parseTransactionSort } from "./register-sort-param";
import { TRANSACTION_SORT_FIELDS } from "./register-order";

const ALL_TRANSACTION_STATUSES = new Set<string>(
  Object.values(TransactionStatus),
);

/**
 * Build a KEY:VALUE tag filter from the `tagKey` / `tagKeyOp` / `tagKeyValue`
 * query params. Returns undefined when no key is given. Validates the operator
 * and that contains/notContains carry a term.
 */
function parseTagKeyFilter(
  tagKey?: string,
  tagKeyOp?: string,
  tagKeyValue?: string,
): TagKeyFilter | undefined {
  const key = (tagKey ?? "").trim();
  if (key === "") return undefined;
  if (key.length > 100) {
    throw new BadRequestException(
      tr(
        "errors.params.maxLength",
        'The value of "tagKey" must not exceed 100 characters',
        { param: "tagKey", max: "100" },
      ),
    );
  }

  const op = (tagKeyOp ?? "hasValue").trim() as TagKeyFilterOp;
  if (!TAG_KEY_FILTER_OPS.includes(op)) {
    throw new BadRequestException(
      tr("errors.transactions.invalidTagKeyOp", `Invalid tagKeyOp: ${op}`, {
        op,
      }),
    );
  }

  let value: string | undefined;
  if (tagKeyOpNeedsValue(op)) {
    value = (tagKeyValue ?? "").trim();
    if (value === "") {
      throw new BadRequestException(
        tr(
          "errors.params.isRequired",
          'A value for "tagKeyValue" is required',
          { param: "tagKeyValue" },
        ),
      );
    }
    value = value.slice(0, 200);
  }

  return { key, op, value };
}

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

/**
 * The acting identity for transfer endpoints: the effective user is the
 * ledger being operated on (the owner while a delegate is acting), the real
 * user is the authenticated human whose delegations decide cross-owner
 * access. For a normal user both are the same id.
 */
function transferActorFrom(req: {
  user: { id: string; realUserId?: string };
}): TransferActor {
  return {
    effectiveUserId: req.user.id,
    realUserId: req.user.realUserId ?? req.user.id,
  };
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
    private readonly jointAccounts: JointAccountsService,
    private readonly crossOwnerAccess: CrossOwnerAccessService,
    private readonly jointRegister: JointRegisterService,
  ) {}

  /**
   * The own-context read scope for a transaction query (joint-accounts spec):
   * which user id the query runs as, and the already-authorized joint account
   * ids its ownership predicate may be widened by. One definition on purpose
   * -- the register, its summary, its grouped totals and its monthly totals
   * must see the same rows, or a joint account's detail page shows a balance
   * chart with no cash flow, categories or payees beside it.
   *
   * A query filtered to exactly one joint account runs entirely as the OWNER,
   * so every derived value (category descendant expansion, number/date-format
   * parsing of the search term, the money math) behaves byte-identically to
   * the owner's own view. A mixed or unfiltered query keeps the caller's own
   * scope and widens it by exactly the authorized joint ids.
   *
   * Acting delegates never take this path: their scope is the delegation's
   * readable set, resolved by each endpoint that allows delegate access. The
   * guard is here rather than only at the call sites because widening an
   * OWNER-scoped query by the delegate's own joint ids would mix two ledgers.
   */
  private async resolveOwnContextJointScope(
    req: { user: { id: string; realUserId?: string; isActing?: boolean } },
    requestedAccountIds?: string[],
  ): Promise<{ userId: string; jointAccountIds: string[] }> {
    if (req.user.isActing) {
      return { userId: req.user.id, jointAccountIds: [] };
    }
    const realUserId = req.user.realUserId ?? req.user.id;
    const jointSet = await this.jointAccounts.jointAccountIdSetFor(realUserId);
    if (jointSet.size === 0) {
      return { userId: req.user.id, jointAccountIds: [] };
    }
    if (
      requestedAccountIds?.length === 1 &&
      jointSet.has(requestedAccountIds[0])
    ) {
      const access = await this.jointAccounts.jointAccessFor(
        realUserId,
        requestedAccountIds[0],
        "read",
      );
      return { userId: access.ownerUserId, jointAccountIds: [] };
    }
    return {
      userId: req.user.id,
      jointAccountIds:
        requestedAccountIds && requestedAccountIds.length > 0
          ? requestedAccountIds.filter((id) => jointSet.has(id))
          : [...jointSet],
    };
  }

  @Post()
  @ApiOperation({ summary: "Create a new transaction" })
  @ApiResponse({ status: 201, description: "Transaction created successfully" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  @DelegatedAccountParam("accountId")
  @DelegatedBodyAccounts("splits[].transferAccountId")
  @DelegateRequires("create")
  async create(
    @Request() req,
    @Body() createTransactionDto: CreateTransactionDto,
  ) {
    // Own context targeting an account the caller does not own: the joint
    // register path (authorizes the joint grant, then writes as the owner).
    if (
      !req.user.isActing &&
      !(await this.crossOwnerAccess.isAccountOwnedBy(
        createTransactionDto.accountId,
        req.user.id,
      ))
    ) {
      return this.jointRegister.create(
        req.user.realUserId ?? req.user.id,
        createTransactionDto,
      );
    }
    // An acting delegate writes as the owner but is not the owner: the owner's
    // structural rules would land in accounts the delegate guard never checked
    // (no moving money via an account the delegate cannot access).
    return this.transactionsService.create(req.user.id, createTransactionDto, {
      actorIsNotOwner: req.user.isActing === true,
    });
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
    name: "targetTransactionId",
    required: false,
    description:
      "Navigate to the page containing this transaction ID (overrides page parameter)",
  })
  @ApiQuery({
    name: "originalCurrencyCodes",
    required: false,
    description:
      "Filter by the currency a transaction was entered in (comma-separated ISO codes, foreign-currency entries only)",
  })
  @ApiQuery({
    name: "hasAttachments",
    required: false,
    description:
      "Filter by attachment presence (true = only with attachments, false = only without)",
  })
  @ApiQuery({
    name: "sortBy",
    required: false,
    description: `Column to sort the register by (default: date). One of: ${TRANSACTION_SORT_FIELDS.join(", ")}`,
  })
  @ApiQuery({
    name: "sortDirection",
    required: false,
    description: "Sort direction: asc or desc (default: desc)",
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
    @Query("tagKey") tagKey?: string,
    @Query("tagKeyOp") tagKeyOp?: string,
    @Query("tagKeyValue") tagKeyValue?: string,
    @Query("originalCurrencyCodes") originalCurrencyCodes?: string,
    @Query("hasAttachments", new ParseBoolPipe({ optional: true }))
    hasAttachments?: boolean,
    @Query("sortBy") sortBy?: string,
    @Query("sortDirection") sortDirection?: string,
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
          "errors.params.mustBeUuid",
          'The value of "targetTransactionId" must be a valid UUID',
          { param: "targetTransactionId" },
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
          "errors.params.mustBeNumber",
          'The value of "amountFrom" must be a number',
          { param: "amountFrom" },
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountTo" must be a number',
          { param: "amountTo" },
        ),
      );
    }

    const tagKeyFilter = parseTagKeyFilter(tagKey, tagKeyOp, tagKeyValue);
    const sort = parseTransactionSort(sortBy, sortDirection);

    let effectiveAccountIds = parseIds(accountIds, accountId);
    let registerUserId = req.user.id;
    let jointAccountIds: string[] = [];
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
    } else {
      // Own context: joint accounts read natively (joint-accounts spec).
      const scope = await this.resolveOwnContextJointScope(
        req,
        effectiveAccountIds,
      );
      registerUserId = scope.userId;
      jointAccountIds = scope.jointAccountIds;
    }

    return this.transactionsService.findAll(
      registerUserId,
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
      sort.sortBy,
      sort.sortDirection,
      tagKeyFilter,
      parseCurrencyCodes(originalCurrencyCodes),
      hasAttachments,
      jointAccountIds,
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
  async getSummary(
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
    @Query("tagIds") tagIdsParam?: string,
  ) {
    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountFrom" must be a number',
          { param: "amountFrom" },
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountTo" must be a number',
          { param: "amountTo" },
        ),
      );
    }

    const effectiveAccountIds = parseIds(accountIds, accountId);
    // Own context: a jointly shared account's money-in/money-out reads the
    // same rows its register does.
    const scope = await this.resolveOwnContextJointScope(
      req,
      effectiveAccountIds,
    );

    return this.transactionsService.getSummary(
      scope.userId,
      effectiveAccountIds,
      startDate,
      endDate,
      parseCategoryIds(categoryIds ?? categoryId),
      parseIds(payeeIds, payeeId),
      search,
      parsedAmountFrom,
      parsedAmountTo,
      parseUuids(tagIdsParam),
      scope.jointAccountIds,
    );
  }

  @Get("grouped-totals")
  @ApiOperation({
    summary:
      "Get transaction totals grouped by category or payee under the same filters as the summary",
  })
  @ApiQuery({
    name: "groupBy",
    required: true,
    enum: ["category", "payee"],
    description: "Group rows by category or payee",
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
    name: "categoryIds",
    required: false,
    description:
      "Filter by category IDs (comma-separated, supports the pseudo-ids 'uncategorized', 'transfer', 'income' and 'expense')",
  })
  @ApiQuery({
    name: "payeeIds",
    required: false,
    description: "Filter by payee IDs (comma-separated)",
  })
  @ApiQuery({
    name: "tagIds",
    required: false,
    description: "Filter by tag IDs (comma-separated)",
  })
  @ApiQuery({
    name: "search",
    required: false,
    description: "Search text (same fields as the summary endpoint)",
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
    name: "limit",
    required: false,
    description: "Maximum number of groups returned (default 100, max 500)",
  })
  @ApiQuery({
    name: "includeUnreconciledBeforeStart",
    required: false,
    description:
      "When true, also include transactions dated before startDate that are not yet reconciled (used by the credit-card cycle spending widget)",
  })
  @ApiResponse({
    status: 200,
    description: "Grouped totals retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getGroupedTotals(
    @Request() req,
    @Query("groupBy") groupBy?: string,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("payeeIds") payeeIds?: string,
    @Query("tagIds") tagIdsParam?: string,
    @Query("search") search?: string,
    @Query("amountFrom") amountFrom?: string,
    @Query("amountTo") amountTo?: string,
    @Query("limit") limit?: string,
    @Query("includeUnreconciledBeforeStart")
    includeUnreconciledBeforeStart?: string,
  ) {
    if (groupBy !== "category" && groupBy !== "payee") {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeOneOf",
          'The value of "groupBy" must be one of: category, payee',
          { param: "groupBy", options: "category, payee" },
        ),
      );
    }

    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountFrom" must be a number',
          { param: "amountFrom" },
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountTo" must be a number',
          { param: "amountTo" },
        ),
      );
    }

    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.limitMustBePositive",
          "limit must be a positive number",
        ),
      );
    }

    const effectiveAccountIds = parseUuids(accountIds);
    // Own context: a jointly shared account's top categories / top payees
    // read the same rows its register does.
    const scope = await this.resolveOwnContextJointScope(
      req,
      effectiveAccountIds,
    );

    return this.transactionsService.getGroupedTotals(scope.userId, {
      groupBy,
      accountIds: effectiveAccountIds,
      startDate,
      endDate,
      categoryIds: parseCategoryIds(categoryIds),
      payeeIds: parseUuids(payeeIds),
      tagIds: parseUuids(tagIdsParam),
      search,
      amountFrom: parsedAmountFrom,
      amountTo: parsedAmountTo,
      limit: parsedLimit,
      includeUnreconciledBeforeStart: includeUnreconciledBeforeStart === "true",
      jointAccountIds: scope.jointAccountIds,
    });
  }

  @Get("tag-key-breakdown")
  @ApiOperation({
    summary: "Spending broken down by the value of a KEY:VALUE tag key",
    description:
      "Value-weighted breakdown: each transaction's absolute amount is attributed to the value(s) of its `<key>:*` tags. Overlapping (a transaction tagged under several values counts under each). Rows are per-currency; the client converts to one display currency.",
  })
  @ApiQuery({
    name: "key",
    required: true,
    description: "Tag key (e.g. country)",
  })
  @ApiQuery({ name: "accountIds", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  @ApiQuery({ name: "categoryIds", required: false })
  @ApiQuery({ name: "payeeIds", required: false })
  @ApiQuery({ name: "tagIds", required: false })
  @ApiQuery({ name: "search", required: false })
  @ApiQuery({ name: "amountFrom", required: false })
  @ApiQuery({ name: "amountTo", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiResponse({ status: 200, description: "Breakdown retrieved successfully" })
  @ApiResponse({ status: 400, description: "Missing or invalid key" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getTagKeyBreakdown(
    @Request() req,
    @Query("key") key?: string,
    @Query("accountIds") accountIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("categoryIds") categoryIds?: string,
    @Query("payeeIds") payeeIds?: string,
    @Query("tagIds") tagIdsParam?: string,
    @Query("search") search?: string,
    @Query("amountFrom") amountFrom?: string,
    @Query("amountTo") amountTo?: string,
    @Query("limit") limit?: string,
  ) {
    const trimmedKey = (key ?? "").trim();
    if (trimmedKey === "" || trimmedKey.length > 100) {
      throw new BadRequestException(
        tr(
          "errors.transactions.tagKeyRequired",
          "A tag key (1-100 characters) is required",
        ),
      );
    }

    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    const parsedAmountFrom =
      amountFrom !== undefined ? parseFloat(amountFrom) : undefined;
    if (parsedAmountFrom !== undefined && isNaN(parsedAmountFrom)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountFrom" must be a number',
          { param: "amountFrom" },
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountTo" must be a number',
          { param: "amountTo" },
        ),
      );
    }

    const parsedLimit = limit !== undefined ? parseInt(limit, 10) : undefined;
    if (parsedLimit !== undefined && (isNaN(parsedLimit) || parsedLimit < 1)) {
      throw new BadRequestException(
        tr(
          "errors.transactions.limitMustBePositive",
          "limit must be a positive number",
        ),
      );
    }

    return this.transactionsService.getTagKeyBreakdown(
      req.user.id,
      trimmedKey,
      {
        accountIds: parseUuids(accountIds),
        startDate,
        endDate,
        categoryIds: parseCategoryIds(categoryIds),
        payeeIds: parseUuids(payeeIds),
        tagIds: parseUuids(tagIdsParam),
        search,
        amountFrom: parsedAmountFrom,
        amountTo: parsedAmountTo,
        limit: parsedLimit,
      },
    );
  }

  @Get("recurring-charges")
  @ApiOperation({
    summary:
      "Detect recurring charges (cadence and typical amount) within a date range, either on one account or for the given payees",
  })
  @ApiQuery({
    name: "accountId",
    required: false,
    description:
      "Detect charges recurring on this account (UUID). One of accountId or payeeIds is required.",
  })
  @ApiQuery({
    name: "payeeIds",
    required: false,
    description:
      "Payee IDs to inspect (comma-separated UUIDs). One of accountId or payeeIds is required.",
  })
  @ApiQuery({
    name: "startDate",
    required: true,
    description: "Start of the detection window (YYYY-MM-DD)",
  })
  @ApiQuery({
    name: "endDate",
    required: true,
    description: "End of the detection window (YYYY-MM-DD)",
  })
  @ApiResponse({
    status: 200,
    description: "Recurring charges retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getRecurringCharges(
    @Request() req,
    @Query("payeeIds") payeeIds?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountId") accountId?: string,
  ) {
    const parsedPayeeIds = parseUuids(payeeIds);
    const hasPayeeIds = !!parsedPayeeIds && parsedPayeeIds.length > 0;
    if (accountId !== undefined && !UUID_REGEX.test(accountId)) {
      throw new BadRequestException(
        tr("errors.common.invalidUuid", `Invalid UUID: ${accountId}`, {
          id: accountId,
        }),
      );
    }
    // Neither filter means "every payee in the ledger", which is a different
    // and far heavier question than either caller is asking; refuse rather
    // than answer it by accident.
    if (!hasPayeeIds && !accountId) {
      throw new BadRequestException(
        tr(
          "errors.params.eitherRequired",
          'A value for either "accountId" or "payeeIds" is required',
          { param: "accountId", other: "payeeIds" },
        ),
      );
    }
    if (!startDate || !endDate) {
      throw new BadRequestException(
        tr(
          "errors.params.bothRequired",
          'Values for both "startDate" and "endDate" are required',
          { param: "startDate", other: "endDate" },
        ),
      );
    }
    validateDateParam(startDate, "startDate");
    validateDateParam(endDate, "endDate");

    // A joint account reads natively in own context but its rows belong to the
    // owner, so detection has to run as them -- the same resolution the
    // register uses, and the reason an accountId cannot simply be pasted into
    // the caller's own query. `jointAccessFor` refuses an account the caller
    // has no read grant on. A delegate never reaches this handler: there is no
    // @AllowDelegate() here, so AccountDelegateGuard has already refused.
    const scope = accountId
      ? await this.resolveOwnContextJointScope(req, [accountId])
      : null;

    return this.transactionsService.getRecurringCharges(
      scope?.userId ?? req.user.id,
      startDate,
      endDate,
      { payeeIds: hasPayeeIds ? parsedPayeeIds : undefined, accountId },
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
      "Filter by category IDs (comma-separated, supports the pseudo-ids 'uncategorized', 'transfer', 'income' and 'expense')",
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
          "errors.params.mustBeNumber",
          'The value of "amountFrom" must be a number',
          { param: "amountFrom" },
        ),
      );
    }

    const parsedAmountTo =
      amountTo !== undefined ? parseFloat(amountTo) : undefined;
    if (parsedAmountTo !== undefined && isNaN(parsedAmountTo)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "amountTo" must be a number',
          { param: "amountTo" },
        ),
      );
    }

    let effectiveAccountIds = parseUuids(accountIds);
    let totalsUserId = req.user.id;
    let jointAccountIds: string[] = [];
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
    } else {
      // Own context: a jointly shared account's cash flow reads the same rows
      // its register does.
      const scope = await this.resolveOwnContextJointScope(
        req,
        effectiveAccountIds,
      );
      totalsUserId = scope.userId;
      jointAccountIds = scope.jointAccountIds;
    }

    return this.transactionsService.getMonthlyTotals(
      totalsUserId,
      effectiveAccountIds,
      startDate,
      endDate,
      parseCategoryIds(categoryIds),
      parseUuids(payeeIds),
      search,
      parsedAmountFrom,
      parsedAmountTo,
      parseUuids(tagIdsParam),
      jointAccountIds,
    );
  }

  @Get("fx-fee-summary")
  @ApiOperation({
    summary:
      "Get monthly foreign-transaction fee totals for an account, grouped by the currency the transaction was paid in",
  })
  @ApiQuery({
    name: "accountId",
    required: true,
    description: "Account UUID",
  })
  @ApiResponse({
    status: 200,
    description:
      "Monthly foreign-transaction fee totals retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  async getFxFeeSummary(
    @Request() req,
    @Query("accountId", ParseUUIDPipe) accountId: string,
  ) {
    if (req.user.isActing) {
      // A delegate only sees fee analytics for accounts they can READ.
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      if (!readable.includes(accountId)) return [];
    }
    return this.transactionsService.getFxFeeSummary(req.user.id, accountId);
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

  @Get("filter-options")
  @ApiOperation({
    summary:
      "Payees and categories used by the rows in the given accounts, for a register's filter pickers",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Restrict to these account IDs (comma-separated). Omitted: every account the caller can read.",
  })
  @ApiResponse({ status: 200, description: "Filter options retrieved" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getFilterOptions(
    @Request() req,
    @Query("accountIds") accountIds?: string,
  ) {
    const requested = parseUuids(accountIds);
    if (req.user.isActing) {
      // A delegate sees the payees and categories of the accounts they were
      // granted READ on, and no others. An empty readable set is an empty
      // picker, never an unfiltered query over the owner's whole ledger.
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      const readableSet = new Set(readable);
      const scopedIds =
        requested && requested.length > 0
          ? requested.filter((id) => readableSet.has(id))
          : readable;
      if (scopedIds.length === 0) {
        return { payees: [], categories: [] };
      }
      return this.transactionsService.getRegisterFilterOptions(req.user.id, {
        accountIds: scopedIds,
      });
    }
    const scope = await this.resolveOwnContextJointScope(req, requested);
    return this.transactionsService.getRegisterFilterOptions(scope.userId, {
      accountIds: requested,
      jointAccountIds: scope.jointAccountIds,
    });
  }

  // ==================== Reconciliation Endpoints ====================
  // NOTE: These static-segment routes MUST be declared before the generic
  // :id param route below, otherwise NestJS matches "reconcile" as an :id
  // value and returns a 400 (ParseUUIDPipe rejects non-UUID strings).

  @Get("reconcile/stale")
  @ApiOperation({
    summary: "Accounts the user reconciles that have outstanding register rows",
  })
  @ApiResponse({ status: 200, description: "Stale reconciliation summary" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getStaleUnreconciled(@Request() req) {
    return this.transactionsService.getStaleUnreconciled(req.user.id);
  }

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
          "errors.params.mustBeCalendarDate",
          'The value of "statementDate" must be a date in YYYY-MM-DD format',
          { param: "statementDate" },
        ),
      );
    }
    const balance = parseFloat(statementBalance);
    if (isNaN(balance)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeNumber",
          'The value of "statementBalance" must be a number',
          { param: "statementBalance" },
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
      transferActorFrom(req),
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
  async findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    const jointIds = req.user.isActing
      ? []
      : [
          ...(await this.jointAccounts.jointAccountIdSetFor(
            req.user.realUserId ?? req.user.id,
          )),
        ];
    return this.transactionsService.findOne(req.user.id, id, jointIds);
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
  @DelegatedBodyAccounts("accountId", "splits[].transferAccountId")
  @DelegateRequires("edit")
  async update(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateTransactionDto: UpdateTransactionDto,
  ) {
    // Own context on a row the caller does not own: the joint register path
    // (authorizes the joint grant, then writes as the owner). An explicit
    // ownership probe, not a NotFound catch -- the owner-scoped update also
    // 404s on missing categories/payees, which must not be misrouted.
    if (
      !req.user.isActing &&
      !(await this.jointRegister.ownsRow(req.user.id, id))
    ) {
      return this.jointRegister.update(
        req.user.realUserId ?? req.user.id,
        id,
        updateTransactionDto,
      );
    }
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
  async remove(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    if (
      !req.user.isActing &&
      !(await this.jointRegister.ownsRow(req.user.id, id))
    ) {
      return this.jointRegister.remove(req.user.realUserId ?? req.user.id, id);
    }
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
  async markCleared(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() markClearedDto: MarkClearedDto,
  ) {
    if (
      !req.user.isActing &&
      !(await this.jointRegister.ownsRow(req.user.id, id))
    ) {
      return this.jointRegister.markCleared(
        req.user.realUserId ?? req.user.id,
        id,
        markClearedDto.isCleared,
      );
    }
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
    return this.transactionsService.getLinkedTransaction(
      req.user.id,
      id,
      transferActorFrom(req),
    );
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
    return this.transactionsService.removeTransfer(
      req.user.id,
      id,
      transferActorFrom(req),
    );
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
  @DelegatedTransferBody()
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
      transferActorFrom(req),
    );
  }
}
