import {
  Controller,
  Get,
  Post,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import {
  ExchangeRateService,
  RateRefreshSummary,
  HistoricalRateBackfillSummary,
} from "./exchange-rate.service";
import { ExchangeRate } from "./entities/exchange-rate.entity";
import { Currency } from "./entities/currency.entity";

@ApiTags("currencies")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("currencies")
export class CurrenciesController {
  constructor(private readonly exchangeRateService: ExchangeRateService) {}

  @Get()
  @ApiOperation({ summary: "Get all active currencies" })
  @ApiResponse({
    status: 200,
    description: "List of active currencies",
    type: [Currency],
  })
  getCurrencies(): Promise<Currency[]> {
    return this.exchangeRateService.getCurrencies();
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
  @ApiOperation({ summary: "Manually trigger exchange rate refresh" })
  @ApiResponse({ status: 201, description: "Refresh summary" })
  refreshRates(): Promise<RateRefreshSummary> {
    return this.exchangeRateService.refreshAllRates();
  }

  @Post("exchange-rates/backfill")
  @ApiOperation({
    summary: "Manually trigger historical exchange rate backfill",
  })
  @ApiResponse({ status: 201, description: "Backfill summary" })
  backfillHistoricalRates(
    @Request() req,
  ): Promise<HistoricalRateBackfillSummary> {
    return this.exchangeRateService.backfillHistoricalRates(req.user.id);
  }
}
