import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  ParseBoolPipe,
  DefaultValuePipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiBody,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { SecuritiesService } from "./securities.service";
import {
  SecurityPriceService,
  PriceRefreshSummary,
  HistoricalBackfillSummary,
  SecurityLookupResult,
} from "./security-price.service";
import { CreateSecurityDto } from "./dto/create-security.dto";
import { UpdateSecurityDto } from "./dto/update-security.dto";
import { Security } from "./entities/security.entity";

@ApiTags("securities")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("securities")
export class SecuritiesController {
  constructor(
    private readonly securitiesService: SecuritiesService,
    private readonly securityPriceService: SecurityPriceService,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a new security" })
  @ApiResponse({
    status: 201,
    description: "Security created successfully",
    type: Security,
  })
  @ApiResponse({
    status: 409,
    description: "Security with symbol already exists",
  })
  create(
    @Req() req,
    @Body() createSecurityDto: CreateSecurityDto,
  ): Promise<Security> {
    return this.securitiesService.create(req.user.id, createSecurityDto);
  }

  @Get()
  @ApiOperation({ summary: "Get all securities" })
  @ApiQuery({ name: "includeInactive", required: false, type: Boolean })
  @ApiResponse({
    status: 200,
    description: "List of securities",
    type: [Security],
  })
  findAll(
    @Req() req,
    @Query("includeInactive", new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
  ): Promise<Security[]> {
    return this.securitiesService.findAll(req.user.id, includeInactive);
  }

  @Get("search")
  @ApiOperation({ summary: "Search securities by symbol or name" })
  @ApiQuery({ name: "q", required: true, description: "Search query" })
  @ApiResponse({ status: 200, description: "Search results", type: [Security] })
  search(@Req() req, @Query("q") query: string): Promise<Security[]> {
    return this.securitiesService.search(req.user.id, query);
  }

  @Get("lookup")
  @ApiOperation({ summary: "Lookup security info from Yahoo Finance" })
  @ApiQuery({
    name: "q",
    required: true,
    description: "Symbol or name to lookup",
  })
  @ApiResponse({
    status: 200,
    description: "Security lookup result",
    schema: {
      type: "object",
      nullable: true,
      properties: {
        symbol: { type: "string" },
        name: { type: "string" },
        exchange: { type: "string", nullable: true },
        securityType: { type: "string", nullable: true },
        currencyCode: { type: "string", nullable: true },
      },
    },
  })
  lookup(@Query("q") query: string): Promise<SecurityLookupResult | null> {
    return this.securityPriceService.lookupSecurity(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get a security by ID" })
  @ApiResponse({ status: 200, description: "Security details", type: Security })
  @ApiResponse({ status: 404, description: "Security not found" })
  findOne(
    @Req() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Security> {
    return this.securitiesService.findOne(req.user.id, id);
  }

  @Get("symbol/:symbol")
  @ApiOperation({ summary: "Get a security by symbol" })
  @ApiResponse({ status: 200, description: "Security details", type: Security })
  @ApiResponse({ status: 404, description: "Security not found" })
  findBySymbol(@Req() req, @Param("symbol") symbol: string): Promise<Security> {
    return this.securitiesService.findBySymbol(req.user.id, symbol);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Update a security" })
  @ApiResponse({
    status: 200,
    description: "Security updated successfully",
    type: Security,
  })
  @ApiResponse({ status: 404, description: "Security not found" })
  update(
    @Req() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() updateSecurityDto: UpdateSecurityDto,
  ): Promise<Security> {
    return this.securitiesService.update(req.user.id, id, updateSecurityDto);
  }

  @Post(":id/deactivate")
  @ApiOperation({ summary: "Deactivate a security" })
  @ApiResponse({
    status: 200,
    description: "Security deactivated",
    type: Security,
  })
  deactivate(
    @Req() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Security> {
    return this.securitiesService.deactivate(req.user.id, id);
  }

  @Post(":id/activate")
  @ApiOperation({ summary: "Activate a security" })
  @ApiResponse({
    status: 200,
    description: "Security activated",
    type: Security,
  })
  activate(
    @Req() req,
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<Security> {
    return this.securitiesService.activate(req.user.id, id);
  }

  @Post("prices/refresh")
  @ApiOperation({
    summary: "Refresh prices for all active securities",
    description:
      "Fetches latest prices from Yahoo Finance for all active securities",
  })
  @ApiResponse({
    status: 200,
    description: "Price refresh completed",
    schema: {
      type: "object",
      properties: {
        totalSecurities: { type: "number" },
        updated: { type: "number" },
        failed: { type: "number" },
        skipped: { type: "number" },
        lastUpdated: { type: "string", format: "date-time" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              success: { type: "boolean" },
              price: { type: "number" },
              error: { type: "string" },
            },
          },
        },
      },
    },
  })
  refreshAllPrices(): Promise<PriceRefreshSummary> {
    return this.securityPriceService.refreshAllPrices();
  }

  @Post("prices/refresh/selected")
  @ApiOperation({
    summary: "Refresh prices for selected securities",
    description:
      "Fetches latest prices from Yahoo Finance for specific securities",
  })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        securityIds: {
          type: "array",
          items: { type: "string", format: "uuid" },
        },
      },
      required: ["securityIds"],
    },
  })
  @ApiResponse({ status: 200, description: "Price refresh completed" })
  async refreshSelectedPrices(
    @Req() req,
    @Body("securityIds") securityIds: string[],
  ): Promise<PriceRefreshSummary> {
    // Verify all security IDs belong to the requesting user
    for (const id of securityIds) {
      await this.securitiesService.findOne(req.user.id, id);
    }
    return this.securityPriceService.refreshPricesForSecurities(securityIds);
  }

  @Post("prices/backfill")
  @ApiOperation({
    summary: "Backfill historical prices for all active securities",
    description:
      "Fetches full price history from Yahoo Finance for all active securities",
  })
  @ApiResponse({ status: 200, description: "Historical backfill completed" })
  backfillHistoricalPrices(): Promise<HistoricalBackfillSummary> {
    return this.securityPriceService.backfillHistoricalPrices();
  }

  @Get("prices/status")
  @ApiOperation({ summary: "Get price update status" })
  @ApiResponse({
    status: 200,
    description: "Price update status",
    schema: {
      type: "object",
      properties: {
        lastUpdated: { type: "string", format: "date-time", nullable: true },
      },
    },
  })
  async getPriceStatus() {
    const lastUpdated = await this.securityPriceService.getLastUpdateTime();
    return { lastUpdated };
  }

  @Get(":id/prices")
  @ApiOperation({ summary: "Get price history for a security" })
  @ApiQuery({
    name: "limit",
    required: false,
    description: "Number of records (default: 365)",
  })
  @ApiResponse({ status: 200, description: "Price history" })
  async getPriceHistory(
    @Req() req,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("limit", new DefaultValuePipe(365)) limit: number,
  ) {
    // Verify security belongs to the requesting user
    await this.securitiesService.findOne(req.user.id, id);
    return this.securityPriceService.getPriceHistory(
      id,
      undefined,
      undefined,
      limit,
    );
  }
}
