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
import { ParseOptionalCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";
import { isCalendarDate } from "../common/validators/is-calendar-date.validator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { Roles } from "../auth/decorators/roles.decorator";
import { AllowDelegate } from "../delegation/decorators/delegate-access.decorator";
import {
  ExchangeRateService,
  RateRefreshSummary,
  HistoricalRateBackfillSummary,
} from "./exchange-rate.service";
import {
  ExchangeRateHistoryService,
  RateCoverage,
  RateGapFill,
  StoredRateList,
} from "./exchange-rate-history.service";
import {
  CurrenciesService,
  CurrencyCatalogEntry,
  CurrencyLookupResult,
  CurrencyUsageMap,
  UserCurrencyView,
} from "./currencies.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { CreateCurrencyDto } from "./dto/create-currency.dto";
import { UpdateCurrencyDto } from "./dto/update-currency.dto";
import { FillRateGapsDto } from "./dto/fill-rate-gaps.dto";
import { tr } from "../i18n/translate";
import {
  FxProviderChain,
  FxProviderDescription,
} from "./providers/fx-provider-chain";

export interface ExchangeRateStatus {
  lastUpdated: Date | null;
  providers: FxProviderDescription[];
}

@ApiTags("Currencies")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("currencies")
export class CurrenciesController {
  constructor(
    private readonly exchangeRateService: ExchangeRateService,
    private readonly exchangeRateHistoryService: ExchangeRateHistoryService,
    private readonly currenciesService: CurrenciesService,
    private readonly fxProviders: FxProviderChain,
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
  getCatalog(): CurrencyCatalogEntry[] {
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
  @ApiOperation({
    summary: "Get latest exchange rates",
    description:
      "One row per currency pair: the newest stored observation of either direction, " +
      "no older than 45 days. A pair whose newest observation is older is omitted, " +
      "because its rate is unknown rather than the last one on file.",
  })
  @ApiResponse({
    status: 200,
    description: "Latest exchange rate per currency pair, one row per pair",
    type: [ExchangeRate],
  })
  getLatestRates(): Promise<ExchangeRate[]> {
    return this.exchangeRateService.getLatestRates();
  }

  @Get("exchange-rates/history")
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: 10 requests per minute
  @ApiOperation({ summary: "Get exchange rates for a date range" })
  @ApiQuery({
    name: "startDate",
    required: false,
    type: String,
    example: "2026-07-20",
  })
  @ApiQuery({
    name: "endDate",
    required: false,
    type: String,
    example: "2026-07-27",
  })
  @ApiResponse({
    status: 200,
    description: "Exchange rates within the date range",
    type: [ExchangeRate],
  })
  // Both bounds go into a `rate_date` comparison, so each is a day or it is
  // nothing: the pipe refuses the array Express parses a repeated key into
  // rather than letting it reach the query as a supposed string.
  getRateHistory(
    @Query("startDate", ParseOptionalCalendarDatePipe) startDate?: string,
    @Query("endDate", ParseOptionalCalendarDatePipe) endDate?: string,
  ): Promise<ExchangeRate[]> {
    return this.exchangeRateService.getRateHistory(startDate, endDate);
  }

  @Get("exchange-rates/rate")
  @AllowDelegate()
  // L2: 60 lookups per minute, matching securities/lookup. Ten was set when the
  // only caller was the transaction form's debounced single lookup; the post
  // dialog's date field is stepped with the arrow keys, and a user walking back
  // through a fortnight legitimately asks for a dozen dates. At ten the rest
  // came back 429 and the UI reported "no exchange rate found" for dates that
  // had one. The work behind a request is a single indexed read except on a
  // miss, and the route is authenticated, so the looser bound is still bounded.
  @Throttle({ default: { ttl: 60000, limit: 60 } })
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
    // `isCalendarDate`, not a bare regular expression on the raw value: Express
    // parses a repeated key (`?date=x&date=y`) into an array, and `.test` would
    // coerce that array to text and pass it through to the resolver as a
    // supposed string (CodeQL `js/type-confusion-through-parameter-tampering`).
    // It also rejects a day that does not exist, such as `2026-02-30`.
    if (!isCalendarDate(date)) {
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

  @Get("exchange-rates/coverage")
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: as `history`, one indexed aggregate per call
  @ApiOperation({
    summary: "Stored exchange rate coverage for a pair",
    description:
      "The first and last stored rate date, and the number of days covered, for the given currency against the caller's reporting currency. Both stored directions count as one pair.",
  })
  @ApiQuery({ name: "code", required: true, type: String, example: "EUR" })
  @ApiResponse({ status: 200, description: "Stored coverage for the pair" })
  @ApiResponse({
    status: 400,
    description: "The code is the caller's own reporting currency",
  })
  getRateCoverage(
    @Request() req,
    @Query("code", ParseCurrencyCodePipe) code: string,
  ): Promise<RateCoverage> {
    return this.exchangeRateHistoryService.getCoverage(req.user.id, code);
  }

  @Get("exchange-rates/stored")
  @AllowDelegate()
  @Throttle({ default: { ttl: 60000, limit: 10 } }) // L2: as `coverage`, one indexed read per call
  @ApiOperation({
    summary: "Stored exchange rates for a pair",
    description:
      "Every stored rate for the given currency against the caller's reporting currency, newest date first, one entry per date. A rate is stated as reporting-currency units per 1 unit of the code; a row stored in the other orientation is returned as its reciprocal with `inverted: true`. Bounded to the newest 2000 dates, and `truncated` says the pair holds more.",
  })
  @ApiQuery({ name: "code", required: true, type: String, example: "EUR" })
  @ApiResponse({ status: 200, description: "Stored rates for the pair" })
  @ApiResponse({
    status: 400,
    description: "The code is the caller's own reporting currency",
  })
  getStoredRates(
    @Request() req,
    @Query("code", ParseCurrencyCodePipe) code: string,
  ): Promise<StoredRateList> {
    return this.exchangeRateHistoryService.getStoredRates(req.user.id, code);
  }

  /**
   * Not admin-only, unlike the backfill above.
   *
   * The backfill walks every pair on the deployment; this one fetches only the
   * windows one pair -- the caller's own reporting currency against the code
   * they are looking at -- cannot answer, over the span their own data uses it.
   * The rows it writes are shared reference data with no owner, so the log line
   * names the user id, the same treatment the global refresh gets.
   */
  @Post("exchange-rates/fill-gaps")
  @Throttle({ default: { ttl: 60000, limit: 6 } }) // L2: each call is a bounded run of provider windows
  @ApiOperation({
    summary: "Fill the gaps in a pair's stored rate history",
    description:
      "Fetches the windows between the first date the caller's data uses the currency and today that no stored observation can answer. Bounded per request: `windowsRemaining` says another press has work to do.",
  })
  @ApiResponse({
    status: 201,
    description:
      "Fill summary; `usedFrom: null` means the currency is unused and nothing was fetched, and `providerHasNothingBefore` means the provider's history starts later than the data does",
  })
  @ApiResponse({
    status: 400,
    description:
      "The code is the caller's own reporting currency, or no configured provider carries the pair (a coin without a price symbol); nothing is recorded",
  })
  @ApiResponse({ status: 503, description: "The provider did not answer" })
  fillRateGaps(
    @Request() req,
    @Body() dto: FillRateGapsDto,
  ): Promise<RateGapFill> {
    return this.exchangeRateHistoryService.fillRateGaps(req.user.id, dto.code);
  }

  @Get("exchange-rates/status")
  @AllowDelegate()
  @ApiOperation({ summary: "Get exchange rate update status" })
  @ApiResponse({
    status: 200,
    description:
      "Last update time and the configured FX providers, in the order they are tried; `source` is the slug stored on each rate row, `name` identifies the provider itself.",
  })
  async getRateStatus(): Promise<ExchangeRateStatus> {
    const lastUpdated = await this.exchangeRateService.getLastUpdateTime();
    return { lastUpdated, providers: this.fxProviders.describe() };
  }

  /**
   * Counts only, deliberately.
   *
   * The refresh is global -- the pair set is assembled from every user's accounts,
   * securities and default currency -- and this endpoint is reachable by any
   * authenticated user, not just an admin. Returning the per-pair `results` told
   * the caller which currencies everybody else on the deployment transacts in,
   * which on a small self-hosted instance is an inference about named people's
   * finances. The UI shows `updated` and `failed` and nothing else; the per-pair
   * detail stays in the server log, where the operator can already see everything.
   */
  @Post("exchange-rates/refresh")
  @ApiOperation({
    summary: "Manually trigger exchange rate refresh",
  })
  @ApiResponse({ status: 201, description: "Refresh summary (counts only)" })
  async refreshRates(): Promise<Omit<RateRefreshSummary, "results">> {
    const { results: _results, ...counts } =
      await this.exchangeRateService.refreshAllRates();
    return counts;
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
