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
  Res,
  ParseBoolPipe,
  ParseUUIDPipe,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
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
import { DelegationService } from "../delegation/delegation.service";
import { CrossOwnerAccessService } from "../delegation/cross-owner-access.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";
import {
  AllowDelegate,
  DelegatedAccountParam,
} from "../delegation/decorators/delegate-access.decorator";
import { AccountExportService } from "./account-export.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { StatementCycleService } from "./statement-cycle.service";
import { BalanceForecastService } from "./balance-forecast.service";
import { DailyBalanceTotalsService } from "./daily-balance-totals.service";
import { AccountBalancesReportService } from "./account-balances-report.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { DailyBalanceTotalsQueryDto } from "./dto/daily-balance-totals-query.dto";
import { UpdateAccountDto } from "./dto/update-account.dto";
import { ReorderFavouriteAccountsDto } from "./dto/reorder-favourite-accounts.dto";
import { SetDelegateFavouriteDto } from "./dto/set-delegate-favourite.dto";
import { SetNetWorthExclusionDto } from "./dto/set-net-worth-exclusion.dto";
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
  PreviewLoanPaymentSetupDto,
  PreviewLoanPaymentSetupResponseDto,
  SetupLoanPaymentsResponseDto,
} from "./dto/setup-loan-payments.dto";
import {
  DetectMortgageTypeDto,
  MortgageTypeDetectionResponseDto,
  MortgageTypeHistoryDetectionResponseDto,
} from "./dto/detect-mortgage-type.dto";
import { PaymentFrequency } from "./loan-amortization.util";
import { formatDateYMD, todayYMD } from "../common/date-utils";
import { assertStringParam } from "../common/query-param-utils";
import { tr } from "../i18n/translate";

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
    throw new BadRequestException(
      tr("errors.params.isTooLong", 'The value of "dateFormat" is too long', {
        param: "dateFormat",
      }),
    );
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
    throw new BadRequestException(
      tr("errors.accounts.invalidDateFormat", "Invalid dateFormat"),
    );
  }
  return stripped;
}

/**
 * A UUID that cannot match any real account. An acting delegate with no
 * readable accounts gets a naturally-empty, correctly-shaped answer instead of
 * `undefined`, which every scope resolver reads as "all accounts".
 */
const NO_SCOPED_ACCOUNT = "00000000-0000-0000-0000-000000000000";

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
    private readonly statementCycleService: StatementCycleService,
    private readonly balanceForecastService: BalanceForecastService,
    private readonly dailyBalanceTotalsService: DailyBalanceTotalsService,
    private readonly accountBalancesReport: AccountBalancesReportService,
    private readonly delegationService: DelegationService,
    private readonly crossOwnerAccess: CrossOwnerAccessService,
    private readonly jointAccounts: JointAccountsService,
  ) {}

  // NOTE: static route -- must be declared before the :id param routes.
  @Get("transfer-candidates")
  @ApiOperation({
    summary:
      "Accounts the real user can use as the other side of a cross-owner transfer",
  })
  @ApiResponse({
    status: 200,
    description:
      "Own context: accounts shared to the user (with per-op grant flags). Acting context: the user's own accounts.",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  getTransferCandidates(@Request() req) {
    return this.crossOwnerAccess.transferCandidatesFor(
      req.user.realUserId ?? req.user.id,
      req.user.id,
    );
  }

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
  @AllowDelegate()
  async findAll(
    @Request() req,
    @Query("includeInactive", new ParseBoolPipe({ optional: true }))
    includeInactive?: boolean,
  ) {
    const accounts = await this.accountsService.findAll(
      req.user.id,
      includeInactive || false,
    );
    if (!req.user.isActing) {
      // Own context: the union list -- own accounts (with the owner-side
      // joint share counts) plus accounts jointly shared to the caller,
      // carrying the caller's favourites overlay.
      const [shareCounts, jointRows] = await Promise.all([
        this.jointAccounts.jointShareCountsForOwner(req.user.id),
        this.jointAccounts.jointAccountsFor(req.user.realUserId ?? req.user.id),
      ]);
      const own =
        shareCounts.size === 0
          ? accounts
          : accounts.map((a) =>
              shareCounts.has(a.id)
                ? { ...a, jointGranteeCount: shareCounts.get(a.id) }
                : a,
            );
      const joint = includeInactive
        ? jointRows
        : jointRows.filter((a) => !a.isClosed);
      if (joint.length === 0) return own;
      return [
        ...own,
        ...(await this.applyDelegateFavourites(
          req.user.realUserId ?? req.user.id,
          joint,
        )),
      ];
    }
    // Delegate: restrict to READ-granted accounts only (Phase 1).
    const readable = new Set(
      await this.delegationService.readableAccountIds(req.user.delegationId),
    );
    const visible = accounts.filter((a) => readable.has(a.id));
    return this.applyDelegateFavourites(req.user.realUserId, visible);
  }

  /**
   * Account favourites are owner-scoped on the accounts row. A delegate
   * keeps their own, so when acting we replace isFavourite /
   * favouriteSortOrder with the delegate's overlay (never the owner's).
   */
  private async applyDelegateFavourites<
    T extends { id: string; isFavourite: boolean; favouriteSortOrder: number },
  >(delegateUserId: string, accounts: T[]): Promise<T[]> {
    const overlay =
      await this.delegationService.getDelegateFavourites(delegateUserId);
    return accounts.map((a) => ({
      ...a,
      isFavourite: overlay.has(a.id),
      favouriteSortOrder: overlay.get(a.id) ?? 0,
    }));
  }

  @Patch("reorder-favourites")
  @AllowDelegate()
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
    // A delegate reorders their own favourites overlay, never the owner's.
    if (req.user.isActing) {
      return this.delegationService.reorderDelegateFavourites(
        req.user.realUserId,
        dto.accountIds,
      );
    }
    return this.accountsService.reorderFavourites(req.user.id, dto.accountIds);
  }

  @Put(":id/favourite")
  @AllowDelegate()
  @DelegatedAccountParam("id")
  @ApiOperation({
    summary: "Set the acting delegate's own favourite flag for an account",
  })
  @ApiResponse({ status: 200, description: "Favourite updated" })
  @ApiResponse({ status: 400, description: "Bad request" })
  async setDelegateFavourite(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetDelegateFavouriteDto,
  ): Promise<{ isFavourite: boolean }> {
    // Owners manage favourites through the normal account update; this
    // endpoint exists only for the delegate's independent overlay -- while
    // acting, or natively on a joint account. jointAccessFor 400s the
    // caller's own accounts and 404s everything not jointly shared.
    if (!req.user.isActing) {
      await this.jointAccounts.jointAccessFor(
        req.user.realUserId ?? req.user.id,
        id,
        "read",
      );
    }
    await this.delegationService.setDelegateFavourite(
      req.user.realUserId,
      id,
      dto.isFavourite,
    );
    return { isFavourite: dto.isFavourite };
  }

  @Put(":id/net-worth-exclusion")
  @ApiOperation({
    summary:
      "Set the caller's own net-worth exclusion for a joint account shared to them",
  })
  @ApiResponse({ status: 200, description: "Exclusion updated" })
  @ApiResponse({ status: 400, description: "Bad request" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async setNetWorthExclusion(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: SetNetWorthExclusionDto,
  ): Promise<{ excluded: boolean }> {
    await this.jointAccounts.setNetWorthExclusion(
      req.user.id,
      id,
      dto.excluded,
    );
    return { excluded: dto.excluded };
  }

  /**
   * Declared before every `:id` route: "daily-balance-totals" is a literal path
   * segment, and a `:id` route above it would swallow it as an account id.
   */
  @Get("daily-balance-totals")
  @ApiOperation({
    summary: "Get the scope's end-of-day total for every day of a date range",
    description:
      "One total per calendar day across the accounts in scope, in one " +
      "currency: actual through the server's today, projected after it. " +
      "Complements GET /accounts/daily-balances, which is per account, per " +
      "account currency and history only.",
  })
  @ApiResponse({
    status: 200,
    description: "Daily balance totals computed successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  async getDailyBalanceTotals(
    @Request() req,
    @Query() query: DailyBalanceTotalsQueryDto,
  ) {
    let ids = query.accountIds;
    let jointIds: string[] = [];
    if (req.user.isActing) {
      // Restrict to the delegate's READ-granted accounts (never an
      // unfiltered owner-wide query), exactly as daily-balances does.
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      const readableSet = new Set(readable);
      ids =
        ids && ids.length > 0
          ? ids.filter((id) => readableSet.has(id))
          : readable;
      if (ids.length === 0) ids = [NO_SCOPED_ACCOUNT];
    } else {
      // Own context: joint accounts participate exactly like own accounts.
      // The set is what authorizes them -- the service widens its ownership
      // predicate to these exact ids and nothing else.
      const jointSet = await this.jointAccounts.jointAccountIdSetFor(
        req.user.realUserId ?? req.user.id,
      );
      jointIds =
        ids && ids.length > 0
          ? ids.filter((id) => jointSet.has(id))
          : [...jointSet];
    }
    return this.dailyBalanceTotalsService.getDailyBalanceTotals(
      req.user.id,
      query.startDate,
      query.endDate,
      ids,
      query.displayCurrency,
      jointIds,
    );
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
  @AllowDelegate()
  async getDailyBalances(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("allTime") allTime?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const allTimeFlag = assertStringParam(allTime, "allTime") === "true";
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "startDate" must be a date in YYYY-MM-DD format',
          { param: "startDate" },
        ),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "endDate" must be a date in YYYY-MM-DD format',
          { param: "endDate" },
        ),
      );
    let ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    let jointIds: string[] = [];
    if (req.user.isActing) {
      // Restrict to the delegate's READ-granted accounts (never an
      // unfiltered owner-wide query).
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      const readableSet = new Set(readable);
      ids =
        ids && ids.length > 0
          ? ids.filter((id) => readableSet.has(id))
          : readable;
      if (ids.length === 0) return [];
    } else {
      // Own context: joint accounts participate exactly like own accounts.
      // The set is what authorizes them -- the service widens its ownership
      // predicate to these exact ids and nothing else.
      const jointSet = await this.jointAccounts.jointAccountIdSetFor(
        req.user.realUserId ?? req.user.id,
      );
      jointIds =
        ids && ids.length > 0
          ? ids.filter((id) => jointSet.has(id))
          : [...jointSet];
    }
    return this.accountsService.getDailyBalances(
      req.user.id,
      sd,
      ed,
      ids,
      allTimeFlag,
      jointIds,
    );
  }

  @Get("balances-as-of")
  @ApiOperation({
    summary: "Get every account's balance measured at a single date",
    description:
      "A balance is measured at one instant. Returns the ledger balance and, " +
      "for accounts holding securities, the market value at the end of the " +
      "requested date -- any date, past or future. See " +
      "docs/specs/account-balances-as-of.md.",
  })
  @ApiQuery({
    name: "asOfDate",
    required: false,
    example: "2026-08-18",
    description: "YYYY-MM-DD; defaults to today.",
  })
  @ApiResponse({ status: 200, description: "Balances retrieved successfully" })
  @ApiResponse({ status: 400, description: "asOfDate is not YYYY-MM-DD" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @AllowDelegate()
  async getBalancesAsOf(@Request() req, @Query("asOfDate") asOfDate?: string) {
    const requested = assertStringParam(asOfDate, "asOfDate");
    if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "asOfDate" must be a date in YYYY-MM-DD format',
          { param: "asOfDate" },
        ),
      );
    }
    const date = requested || todayYMD();

    if (req.user.isActing) {
      // A delegate sees the accounts their grant names and nothing else. The
      // set restricts the query rather than filtering its result, so the
      // owner's other balances are never read in the first place.
      const readable = await this.delegationService.readableAccountIds(
        req.user.delegationId,
      );
      return this.accountBalancesReport.getBalancesAsOf(
        req.user.id,
        date,
        [],
        readable,
      );
    }

    // Own context: a joint account participates exactly like an own account.
    const jointIds = [
      ...(await this.jointAccounts.jointAccountIdSetFor(
        req.user.realUserId ?? req.user.id,
      )),
    ];
    return this.accountBalancesReport.getBalancesAsOf(
      req.user.id,
      date,
      jointIds,
    );
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
      mortgagePreviewDto.paymentFrequency,
      new Date(mortgagePreviewDto.paymentStartDate),
      // A preview has no stored row, so a request naming no type is the
      // default type.
      mortgagePreviewDto.mortgageType ?? "ANNUITY",
    );
    return {
      ...result,
      endDate: formatDateYMD(result.endDate),
    };
  }

  @Post("mortgage-type/detect")
  @ApiOperation({
    summary: "Suggest a mortgage type from sample installments",
    description:
      "Suggests ANNUITY, CANADIAN_FIXED, LINEAR or INTEREST_ONLY from two or three consecutive installments (principal and interest, optionally the balance each was charged on), the quoted rate and the payment frequency. A suggestion only: nothing is read or written. Fewer than two samples, or samples that fit no rule, answer type null with a reason.",
  })
  @ApiResponse({
    status: 201,
    description: "Suggestion computed",
    type: MortgageTypeDetectionResponseDto,
  })
  @ApiResponse({ status: 400, description: "Bad request - invalid samples" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  detectMortgageType(
    @Body() dto: DetectMortgageTypeDto,
  ): MortgageTypeDetectionResponseDto {
    return this.accountsService.detectMortgageTypeFromSamples(dto);
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
      throw new BadRequestException(
        tr("errors.accounts.invalidExportFormat", "Format must be csv or qif"),
      );
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
        req.user.realUserId ?? req.user.id,
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
        req.user.realUserId ?? req.user.id,
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
  @AllowDelegate()
  @DelegatedAccountParam("id")
  async findOne(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    let account: Awaited<ReturnType<AccountsService["findOne"]>>;
    try {
      account = await this.accountsService.findOne(req.user.id, id);
    } catch (err) {
      // Own context: an owner-scoped miss may be a joint account shared to
      // the caller; jointAccessFor re-raises the same 404 shape otherwise.
      if (!(err instanceof NotFoundException) || req.user.isActing) throw err;
      const jointRow = (
        await this.jointAccounts.jointAccountsFor(
          req.user.realUserId ?? req.user.id,
        )
      ).find((a) => a.id === id);
      if (!jointRow) throw err;
      const [overlaid] = await this.applyDelegateFavourites(
        req.user.realUserId ?? req.user.id,
        [jointRow],
      );
      return overlaid;
    }
    if (!req.user.isActing) return account;
    const [overlaid] = await this.applyDelegateFavourites(req.user.realUserId, [
      account,
    ]);
    return overlaid;
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
  @AllowDelegate()
  @DelegatedAccountParam("id")
  async getBalance(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    try {
      return await this.accountsService.getBalance(req.user.id, id);
    } catch (err) {
      if (!(err instanceof NotFoundException) || req.user.isActing) throw err;
      // Joint fallback: authorize, then read with the owner's scope.
      const access = await this.jointAccounts.jointAccessFor(
        req.user.realUserId ?? req.user.id,
        id,
        "read",
      );
      return this.accountsService.getBalance(access.ownerUserId, id);
    }
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

  @Get(":id/statement-cycle")
  @ApiOperation({
    summary: "Get the current statement cycle for a credit card",
    description:
      "Computes the current statement-cycle window, statement balance as of the last settlement, next settlement/payment due dates, and amount paid since the statement, from the card's day-of-month statement fields and its transactions.",
  })
  @ApiParam({ name: "id", description: "Credit card account UUID" })
  @ApiResponse({
    status: 200,
    description: "Statement cycle computed successfully",
  })
  @ApiResponse({
    status: 400,
    description:
      "Bad request - not a credit card or no settlement day configured",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  getStatementCycle(@Request() req, @Param("id", ParseUUIDPipe) id: string) {
    return this.statementCycleService.getStatementCycle(req.user.id, id);
  }

  @Get(":id/balance-forecast")
  @ApiOperation({
    summary:
      "Project an account's balance forward including scheduled transactions",
    description:
      "Returns a forecast balance series from today through the given horizon, applying future-dated transactions and expanded scheduled-transaction occurrences. Complements GET /accounts/daily-balances (history only).",
  })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiQuery({
    name: "days",
    required: false,
    type: Number,
    description: "Forecast horizon in days (default 90, max 730)",
  })
  @ApiResponse({
    status: 200,
    description: "Balance forecast computed successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  async getBalanceForecast(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("days", new ParseIntPipe({ optional: true })) days?: number,
  ) {
    const horizon = Math.min(Math.max(days ?? 90, 1), 730);
    try {
      return await this.balanceForecastService.getBalanceForecast(
        req.user.id,
        id,
        horizon,
      );
    } catch (err) {
      if (!(err instanceof NotFoundException) || req.user.isActing) throw err;
      // Joint fallback (same shape as getBalance): authorize, then project
      // with the owner's scope so the grantee's balance chart carries the
      // same forward line the owner's does instead of stopping at today.
      const access = await this.jointAccounts.jointAccessFor(
        req.user.realUserId ?? req.user.id,
        id,
        "read",
      );
      return this.balanceForecastService.getBalanceForecast(
        access.ownerUserId,
        id,
        horizon,
      );
    }
  }

  @Get(":id/interest-paid")
  @ApiOperation({
    summary: "Get interest/fees charged to a card in a date range",
    description:
      "Sums transactions in interest categories (detected by name) on the account within the given date range. Returns the charged amount as a positive magnitude and the transaction count.",
  })
  @ApiParam({ name: "id", description: "Account UUID" })
  @ApiQuery({ name: "startDate", required: true, example: "2026-01-01" })
  @ApiQuery({ name: "endDate", required: true, example: "2026-12-31" })
  @ApiResponse({
    status: 200,
    description: "Interest paid computed successfully",
  })
  @ApiResponse({ status: 400, description: "Bad request - invalid date range" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  getInterestPaid(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!sd || !dateRegex.test(sd)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "startDate" must be a date in YYYY-MM-DD format',
          { param: "startDate" },
        ),
      );
    }
    if (!ed || !dateRegex.test(ed)) {
      throw new BadRequestException(
        tr(
          "errors.params.mustBeCalendarDate",
          'The value of "endDate" must be a date in YYYY-MM-DD format',
          { param: "endDate" },
        ),
      );
    }
    return this.statementCycleService.getInterestPaid(req.user.id, id, sd, ed);
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

  @Post(":id/mortgage-type/detect")
  @ApiOperation({
    summary: "Suggest a mortgage type from the loan's posted installments",
    description:
      "Reads the mortgage's latest posted installments at one rate (paired with their interest the way rate-change detection pairs them, each with the ledger balance before its date) and suggests a type from them. A suggestion only: the account's type is not changed and nothing is written.",
  })
  @ApiParam({
    name: "id",
    description: "Mortgage account UUID",
  })
  @ApiResponse({
    status: 201,
    description: "Suggestion computed, with the installments it was read from",
    type: MortgageTypeHistoryDetectionResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: "Bad request - not a mortgage account",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  detectMortgageTypeFromHistory(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<MortgageTypeHistoryDetectionResponseDto> {
    return this.accountsService.detectMortgageTypeFromHistory(req.user.id, id);
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

  @Post(":id/setup-loan-payments/preview")
  @ApiOperation({
    summary: "Preview the first installment of a loan payment setup",
    description:
      "For a LINEAR or INTEREST_ONLY mortgage, prices the first installment a setup with these terms would schedule -- from the ledger debt through the due date, the rate and the amortization -- through the same code the setup checks its paymentAmount against. Writes nothing. An annuity mortgage or a loan answers derivesInstallment false.",
  })
  @ApiParam({
    name: "id",
    description: "Loan or mortgage account UUID",
  })
  @ApiResponse({
    status: 201,
    description: "First installment priced",
    type: PreviewLoanPaymentSetupResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      "Bad request - a term the mortgage's method needs is missing, or an accelerated frequency",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  @ApiResponse({ status: 404, description: "Account not found" })
  previewLoanPaymentSetup(
    @Request() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: PreviewLoanPaymentSetupDto,
  ): Promise<PreviewLoanPaymentSetupResponseDto> {
    return this.loanPaymentSetupService.previewFirstInstallment(
      req.user.id,
      id,
      dto,
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
