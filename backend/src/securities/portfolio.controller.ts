import {
  Controller,
  Get,
  UseGuards,
  Request,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { tr } from "../i18n/translate";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { PortfolioService } from "./portfolio.service";
import { SectorWeightingService } from "./sector-weighting.service";
import { IntradayValueQueryDto } from "./dto/intraday-value.dto";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { DelegationService } from "../delegation/delegation.service";

// A UUID that cannot match any real account: forces a naturally-empty,
// correctly-shaped result for an acting delegate with no readable accounts
// (instead of passing undefined, which the service treats as "all").
const NO_READABLE_ACCOUNT = "00000000-0000-0000-0000-000000000000";

@ApiTags("Portfolio")
@Controller("portfolio")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class PortfolioController {
  private static readonly UUID_REGEX =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(
    private readonly portfolioService: PortfolioService,
    private readonly sectorWeightingService: SectorWeightingService,
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

  private parseUuidList(
    csv: string | undefined,
    label: string,
  ): string[] | undefined {
    if (!csv) return undefined;
    const ids = csv.split(",").filter(Boolean);
    for (const id of ids) {
      if (!PortfolioController.UUID_REGEX.test(id)) {
        throw new BadRequestException(
          tr("errors.securities.invalidUuid", `Invalid ${label} UUID: ${id}`, {
            label,
            id,
          }),
        );
      }
    }
    return ids;
  }

  @Get("summary")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get portfolio summary with holdings and market values",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiResponse({
    status: 200,
    description: "Portfolio summary retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getSummary(@Request() req, @Query("accountIds") accountIds?: string) {
    const ids = this.parseUuidList(accountIds, "account");
    return this.portfolioService.getPortfolioSummary(
      req.user.id,
      await this.scopeIds(req, ids),
    );
  }

  @Get("allocation")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get asset allocation breakdown",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiResponse({
    status: 200,
    description: "Asset allocation retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getAllocation(
    @Request() req,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids = this.parseUuidList(accountIds, "account");
    return this.portfolioService.getAssetAllocation(
      req.user.id,
      await this.scopeIds(req, ids),
    );
  }

  @Get("allocation/by-tag")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get portfolio exposure grouped by user-defined tags",
    description:
      "Overlapping exposure: a multi-tagged holding counts in full under each tag, so percentages can sum to more than 100%. Cash and untagged holdings are explicit slices.",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description:
      "Comma-separated account IDs to filter by (will include linked pairs)",
  })
  @ApiResponse({
    status: 200,
    description: "Tag allocation retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getAllocationByTag(
    @Request() req,
    @Query("accountIds") accountIds?: string,
  ) {
    const ids = this.parseUuidList(accountIds, "account");
    return this.portfolioService.getAllocationByTag(
      req.user.id,
      await this.scopeIds(req, ids),
    );
  }

  @Get("top-movers")
  @ApiOperation({
    summary: "Get top daily movers among held securities",
  })
  @ApiResponse({
    status: 200,
    description: "Top movers retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  getTopMovers(@Request() req) {
    return this.portfolioService.getTopMovers(req.user.id);
  }

  @Get("accounts")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get all investment accounts for the user",
  })
  @ApiResponse({
    status: 200,
    description: "Investment accounts retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getInvestmentAccounts(@Request() req) {
    const accounts = await this.portfolioService.getInvestmentAccounts(
      req.user.id,
    );
    if (!req.user.isActing || !req.user.delegationId) return accounts;
    const readable = new Set(
      await this.delegationService.readableAccountIds(req.user.delegationId),
    );
    return accounts.filter((a) => readable.has(a.id));
  }

  @Get("intraday-value")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary:
      "Get intraday portfolio value series for the 1D / 1W / 1M chart ranges",
  })
  @ApiResponse({
    status: 200,
    description: "Intraday portfolio value retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getIntradayValue(
    @Request() req,
    @Query() query: IntradayValueQueryDto,
  ) {
    const ids = this.parseUuidList(query.accountIds, "account");
    return this.portfolioService.getIntradayValueSeries(req.user.id, {
      range: query.range,
      accountIds: await this.scopeIds(req, ids),
      displayCurrency: query.displayCurrency,
    });
  }

  @Get("sector-weightings")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary: "Get sector weightings breakdown for investment portfolio",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @ApiQuery({
    name: "securityIds",
    required: false,
    description: "Comma-separated security IDs to filter by",
  })
  @ApiResponse({
    status: 200,
    description: "Sector weightings retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getSectorWeightings(
    @Request() req,
    @Query("accountIds") accountIds?: string,
    @Query("securityIds") securityIds?: string,
  ) {
    const aIds = this.parseUuidList(accountIds, "account");
    const sIds = this.parseUuidList(securityIds, "security");
    return this.sectorWeightingService.getSectorWeightings(
      req.user.id,
      await this.scopeIds(req, aIds),
      sIds,
    );
  }

  @Get("country-weightings")
  @AllowDelegate()
  @DelegateRequiresSection("investments")
  @ApiOperation({
    summary:
      "Get the country (geographic look-through) breakdown for the portfolio",
  })
  @ApiQuery({
    name: "accountIds",
    required: false,
    description: "Comma-separated account IDs to filter by",
  })
  @ApiQuery({
    name: "securityIds",
    required: false,
    description: "Comma-separated security IDs to filter by",
  })
  @ApiResponse({
    status: 200,
    description: "Country weightings retrieved successfully",
  })
  @ApiResponse({ status: 401, description: "Unauthorized" })
  async getCountryWeightings(
    @Request() req,
    @Query("accountIds") accountIds?: string,
    @Query("securityIds") securityIds?: string,
  ) {
    const aIds = this.parseUuidList(accountIds, "account");
    const sIds = this.parseUuidList(securityIds, "security");
    return this.sectorWeightingService.getCountryWeightings(
      req.user.id,
      await this.scopeIds(req, aIds),
      sIds,
    );
  }
}
