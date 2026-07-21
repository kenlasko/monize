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
import { Throttle } from "@nestjs/throttler";
import { ParseCurrencyCodePipe } from "../common/pipes/parse-currency-code.pipe";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import {
  ExchangeRateService,
  RateRefreshSummary,
  HistoricalRateBackfillSummary,
} from "./exchange-rate.service";
import {
  CurrenciesService,
  CurrencyLookupResult,
  CurrencyUsageMap,
  UserCurrencyView,
} from "./currencies.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";
import { tr } from "../i18n/translate";

@ApiTags("Currencies")
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
  @AllowDelegate()
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
  })
  getCurrencies(
    @Request() req,
    @Query("includeInactive", new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
  ): Promise<UserCurrencyView[]> {
    return this.currenciesService.findAll(req.user.id, includeInactive);
  }

  // ── Static-segment routes (must be BEFORE :code param route) ────

  @Get("catalog")
  @AllowDelegate()
  @ApiOperation({
    summary: "Get the catalog of known currencies",
    description:
      "Curated currency metadata (code, name, symbol, decimal places) used to pick a currency before any are installed, e.g. at onboarding.",
  })
  @ApiResponse({ status: 200, description: "Known currency catalog" })
  getCatalog(): CurrencyLookupResult[] {
    return this.currenciesService.getCatalog();
  }

  @Get("lookup")
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: 10 lookups per minute
  @ApiOperation({ summary: "Lookup currency on Yahoo Finance" })
  @ApiQuery({ name: "q", required: true, type: String })
  @ApiResponse({ status: 200, description: "Currency lookup result" })
  lookupCurrency(
    @Query("q") query: string,
  ): Promise<CurrencyLookupResult | null> {
    return this.currenciesService.lookupCurrency(query);
  }

  @Get("usage")
  @AllowDelegate()
  @ApiOperation({
    summary: "Get usage counts for all currencies",
  })
  @ApiResponse({
    status: 200,
    description: "Map of currency code to account/security counts",
  })
  getUsage(@Request() req): Promise<CurrencyUsageMap> {
    return this.currenciesService.getUsage(req.user.id);
  }

  @Get("exchange-rates")
  @AllowDelegate()
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
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: 10 requests per minute
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

  @Get("exchange-rates/rate")
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: 10 requests per minute
  @ApiOperation({
    summary: "Get the exchange rate for a specific currency pair and date",
    description:
      "Returns account-currency units per 1 unit of the from currency on the given date, using carry-forward and Yahoo backfill. Returns null when no rate can be determined.",
  })
  @ApiQuery({ name: "from", required: true, type: String })
  @ApiQuery({ name: "to", required: true, type: String })
  @ApiQuery({
    name: "date",
    required: true,
    type: String,
    example: "2026-07-20",
  })
  @ApiResponse({ status: 200, description: "Rate for the requested date" })
  async getRateForDate(
    @Query("from", ParseCurrencyCodePipe) from: string,
    @Query("to", ParseCurrencyCodePipe) to: string,
    @Query("date") date: string,
  ): Promise<{ rate: number | null }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
      throw new BadRequestException(
        tr(
          "errors.currencies.invalidRateDate",
          "date must be in YYYY-MM-DD format",
        ),
      );
    }
    const rate = await this.exchangeRateService.getRateForDate(from, to, date);
    return { rate };
  }

  @Get("exchange-rates/status")
  @AllowDelegate()
  @ApiOperation({ summary: "Get exchange rate update status" })
  @ApiResponse({ status: 200, description: "Last update time" })
  async getRateStatus(): Promise<{ lastUpdated: Date | null }> {
    const lastUpdated = await this.exchangeRateService.getLastUpdateTime();
    return { lastUpdated };
  }

  @Post("exchange-rates/refresh")
  @ApiOperation({
    summary: "Manually trigger exchange rate refresh",
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
  @AllowDelegate()
  @ApiOperation({ summary: "Get a single currency by code" })
  @ApiResponse({ status: 200, description: "Currency details" })
  findOne(@Param("code", ParseCurrencyCodePipe) code: string) {
    return this.currenciesService.findOne(code);
  }

  @Post()
  @ApiOperation({ summary: "Create a new currency" })
  @ApiResponse({
    status: 201,
    description: "Currency created",
  })
  create(
    @Request() req,
    @Body() dto: CreateCurrencyDto,
  ): Promise<UserCurrencyView> {
    return this.currenciesService.create(req.user.id, dto);
  }

  @Patch(":code")
  @ApiOperation({ summary: "Update a currency" })
  @ApiResponse({ status: 200, description: "Currency updated" })
  update(
    @Request() req,
    @Param("code", ParseCurrencyCodePipe) code: string,
    @Body() dto: UpdateCurrencyDto,
  ): Promise<UserCurrencyView> {
    return this.currenciesService.update(req.user.id, code, dto);
  }

  @Post(":code/deactivate")
  @ApiOperation({ summary: "Deactivate a currency" })
  @ApiResponse({
    status: 201,
    description: "Currency deactivated",
  })
  deactivate(
    @Request() req,
    @Param("code", ParseCurrencyCodePipe) code: string,
  ): Promise<UserCurrencyView> {
    return this.currenciesService.deactivate(req.user.id, code);
  }

  @Post(":code/activate")
  @ApiOperation({ summary: "Activate a currency" })
  @ApiResponse({
    status: 201,
    description: "Currency activated",
  })
  activate(
    @Request() req,
    @Param("code", ParseCurrencyCodePipe) code: string,
  ): Promise<UserCurrencyView> {
    return this.currenciesService.activate(req.user.id, code);
  }

  @Delete(":code")
  @ApiOperation({ summary: "Delete a currency (only if not in use)" })
  @ApiResponse({ status: 200, description: "Currency deleted" })
  @ApiResponse({
    status: 409,
    description: "Currency is in use and cannot be deleted",
  })
  remove(
    @Request() req,
    @Param("code", ParseCurrencyCodePipe) code: string,
  ): Promise<void> {
    return this.currenciesService.remove(req.user.id, code);
  }
}
