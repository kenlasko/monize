import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Request,
  UseGuards,
  DefaultValuePipe,
  ParseBoolPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import {
  ExchangeRateService,
  RateRefreshSummary,
  HistoricalRateBackfillSummary,
} from "./exchange-rate.service";
import {
  CurrenciesService,
  CurrencyLookupResult,
  CurrencyUsageMap,
} from "./currencies.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency } from "./entities/currency.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";

@ApiTags("currencies")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("currencies")
export class CurrenciesController {
  constructor(
    private readonly exchangeRateService: ExchangeRateService,
    private readonly currenciesService: CurrenciesService,
  ) {}

  // ── Currency list ───────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: "Get all currencies" })
  @ApiQuery({
    name: "includeInactive",
    required: false,
    type: Boolean,
    description: "Include inactive currencies (default: false)",
  })
  @ApiResponse({
    status: 200,
    description: "List of currencies",
    type: [Currency],
  })
  getCurrencies(
    @Query("includeInactive", new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
  ): Promise<Currency[]> {
    return this.currenciesService.findAll(includeInactive);
  }

  // ── Static-segment routes (must be BEFORE :code param route) ────

  @Get("lookup")
  @ApiOperation({ summary: "Lookup currency on Yahoo Finance" })
  @ApiQuery({ name: "q", required: true, type: String })
  @ApiResponse({ status: 200, description: "Currency lookup result" })
  lookupCurrency(
    @Query("q") query: string,
  ): Promise<CurrencyLookupResult | null> {
    return this.currenciesService.lookupCurrency(query);
  }

  @Get("usage")
  @ApiOperation({
    summary: "Get usage counts for all currencies",
  })
  @ApiResponse({
    status: 200,
    description: "Map of currency code to account/security counts",
  })
  getUsage(): Promise<CurrencyUsageMap> {
    return this.currenciesService.getUsage();
  }

  @Get("exchange-rates")
  @ApiOperation({ summary: "Get latest exchange rates" })
  @ApiResponse({
    status: 200,
    description: "Latest exchange rates per currency pair",
    type: [ExchangeRate],
  })
  getLatestRates(): Promise<ExchangeRate[]> {
    return this.exchangeRateService.getLatestRates();
  }

  @Get("exchange-rates/history")
  @ApiOperation({ summary: "Get exchange rates for a date range" })
  @ApiQuery({ name: "startDate", required: false, type: String })
  @ApiQuery({ name: "endDate", required: false, type: String })
  @ApiResponse({
    status: 200,
    description: "Exchange rates within the date range",
    type: [ExchangeRate],
  })
  getRateHistory(
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ): Promise<ExchangeRate[]> {
    return this.exchangeRateService.getRateHistory(startDate, endDate);
  }

  @Get("exchange-rates/status")
  @ApiOperation({ summary: "Get exchange rate update status" })
  @ApiResponse({ status: 200, description: "Last update time" })
  async getRateStatus(): Promise<{ lastUpdated: Date | null }> {
    const lastUpdated = await this.exchangeRateService.getLastUpdateTime();
    return { lastUpdated };
  }

  @Post("exchange-rates/refresh")
  @UseGuards(RolesGuard)
  @Roles("admin")
  @ApiOperation({
    summary: "Manually trigger exchange rate refresh (admin only)",
  })
  @ApiResponse({ status: 201, description: "Refresh summary" })
  refreshRates(): Promise<RateRefreshSummary> {
    return this.exchangeRateService.refreshAllRates();
  }

  @Post("exchange-rates/backfill")
  @UseGuards(RolesGuard)
  @Roles("admin")
  @ApiOperation({
    summary: "Manually trigger historical exchange rate backfill (admin only)",
  })
  @ApiResponse({ status: 201, description: "Backfill summary" })
  backfillHistoricalRates(
    @Request() req,
  ): Promise<HistoricalRateBackfillSummary> {
    return this.exchangeRateService.backfillHistoricalRates(req.user.id);
  }

  // ── Param routes (:code) ────────────────────────────────────────

  @Get(":code")
  @ApiOperation({ summary: "Get a single currency by code" })
  @ApiResponse({ status: 200, description: "Currency details", type: Currency })
  findOne(@Param("code") code: string): Promise<Currency> {
    return this.currenciesService.findOne(code);
  }

  @Post()
  @ApiOperation({ summary: "Create a new currency" })
  @ApiResponse({
    status: 201,
    description: "Currency created",
    type: Currency,
  })
  create(@Body() dto: CreateCurrencyDto): Promise<Currency> {
    return this.currenciesService.create(dto);
  }

  @Patch(":code")
  @ApiOperation({ summary: "Update a currency" })
  @ApiResponse({ status: 200, description: "Currency updated", type: Currency })
  update(
    @Param("code") code: string,
    @Body() dto: UpdateCurrencyDto,
  ): Promise<Currency> {
    return this.currenciesService.update(code, dto);
  }

  @Post(":code/deactivate")
  @ApiOperation({ summary: "Deactivate a currency" })
  @ApiResponse({
    status: 201,
    description: "Currency deactivated",
    type: Currency,
  })
  deactivate(@Param("code") code: string): Promise<Currency> {
    return this.currenciesService.deactivate(code);
  }

  @Post(":code/activate")
  @ApiOperation({ summary: "Activate a currency" })
  @ApiResponse({
    status: 201,
    description: "Currency activated",
    type: Currency,
  })
  activate(@Param("code") code: string): Promise<Currency> {
    return this.currenciesService.activate(code);
  }

  @Delete(":code")
  @ApiOperation({ summary: "Delete a currency (only if not in use)" })
  @ApiResponse({ status: 200, description: "Currency deleted" })
  @ApiResponse({
    status: 409,
    description: "Currency is in use and cannot be deleted",
  })
  remove(@Param("code") code: string): Promise<void> {
    return this.currenciesService.remove(code);
  }
}
