import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Request,
  BadRequestException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { tr } from "../i18n/translate";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { assertStringParam } from "../common/query-param-utils";
import { NetWorthService } from "./net-worth.service";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";

// A UUID that cannot match any real account: forces a naturally-empty,
// correctly-shaped result for an acting delegate with no readable accounts
// (instead of passing undefined, which the service treats as "all").
const NO_READABLE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

@ApiTags("Net Worth")
@Controller("net-worth")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class NetWorthController {
  constructor(
    private readonly netWorthService: NetWorthService,
    private readonly delegationService: DelegationService,
  ) {}

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

  @Get("monthly")
  @ApiOperation({ summary: "Get monthly net worth data" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiResponse({ status: 200, description: "Monthly net worth data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getMonthlyNetWorth(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (startDate && !dateRegex.test(startDate))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (endDate && !dateRegex.test(endDate))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    return this.netWorthService.getMonthlyNetWorth(
      req.user.id,
      startDate,
      endDate,
    );
  }

  @Get("investments-monthly")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({ summary: "Get monthly investment portfolio value" })
  @ApiQuery({ name: "startDate", required: false, example: "2023-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "Monthly investment value data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getMonthlyInvestments(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getMonthlyInvestments(
      req.user.id,
      sd,
      ed,
      await this.scopeIds(req, ids),
      safeCurrency,
    );
  }

  @Get("investments-daily")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({ summary: "Get daily investment portfolio value" })
  @ApiQuery({ name: "startDate", required: false, example: "2025-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2025-03-04" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({ status: 200, description: "Daily investment value data" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getDailyInvestments(
    @Request() req,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getDailyInvestments(
      req.user.id,
      sd,
      ed,
      await this.scopeIds(req, ids),
      safeCurrency,
    );
  }

  @Get("investments-breakdown")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get portfolio value over time broken down by security",
  })
  @ApiQuery({
    name: "granularity",
    required: true,
    description: "'daily' or 'monthly' point resolution",
  })
  @ApiQuery({ name: "startDate", required: false, example: "2024-01-01" })
  @ApiQuery({ name: "endDate", required: false, example: "2024-12-31" })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiQuery({
    name: "displayCurrency",
    required: false,
    description:
      "Currency code to display values in (defaults to user preference)",
  })
  @ApiResponse({
    status: 200,
    description: "Per-security portfolio value series",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getInvestmentBreakdown(
    @Request() req,
    @Query("granularity") granularity?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("accountIds") accountIds?: string,
    @Query("displayCurrency") displayCurrency?: string,
  ) {
    const gran = assertStringParam(granularity, "granularity");
    if (gran !== "daily" && gran !== "monthly") {
      throw new BadRequestException(
        tr(
          "errors.netWorth.invalidGranularity",
          "granularity must be 'daily' or 'monthly'",
        ),
      );
    }
    const sd = assertStringParam(startDate, "startDate");
    const ed = assertStringParam(endDate, "endDate");
    const aIds = assertStringParam(accountIds, "accountIds");
    const curr = assertStringParam(displayCurrency, "displayCurrency");
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (sd && !dateRegex.test(sd))
      throw new BadRequestException(
        tr("errors.netWorth.invalidStartDate", "startDate must be YYYY-MM-DD"),
      );
    if (ed && !dateRegex.test(ed))
      throw new BadRequestException(
        tr("errors.netWorth.invalidEndDate", "endDate must be YYYY-MM-DD"),
      );
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = aIds ? aIds.split(",").filter(Boolean) : undefined;
    if (ids) {
      for (const id of ids) {
        if (!uuidRegex.test(id))
          throw new BadRequestException(
            tr(
              "errors.netWorth.invalidAccountIds",
              "accountIds must be comma-separated UUIDs",
            ),
          );
      }
    }
    const safeCurrency = curr ? curr.slice(0, 3).toUpperCase() : undefined;
    return this.netWorthService.getInvestmentBreakdown(req.user.id, {
      granularity: gran,
      startDate: sd,
      endDate: ed,
      accountIds: await this.scopeIds(req, ids),
      displayCurrency: safeCurrency,
    });
  }

  @Post("recalculate")
  @ApiOperation({ summary: "Trigger full net worth recalculation" })
  @ApiResponse({ status: 201, description: "Recalculation triggered" })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async recalculate(@Request() req) {
    await this.netWorthService.recalculateAllAccounts(req.user.id);
    return { success: true };
  }
}
