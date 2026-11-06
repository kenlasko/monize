import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  Res,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Response } from "express";
import { Throttle } from "@nestjs/throttler";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Roles } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { todayYMD } from "../common/date-utils";
import { ParseCalendarDatePipe } from "../common/pipes/parse-calendar-date.pipe";
import { tr } from "../i18n/translate";
import { SeriesFetchError } from "./bond-adapter";
import { BondAuctions, BondAuctionsService } from "./bond-auctions.service";
import { BondCatalogService, BondProgramSummary } from "./bond-catalog.service";
import {
  BondDataInconsistentCode,
  BondDataInconsistentError,
  BondDataNotFoundCode,
  BondDataNotFoundError,
  BondErrorParams,
} from "./bond-errors";
import {
  BondHoldingsService,
  BondRedemptionSplit,
  ExpectedSeries,
  SeriesHolding,
} from "./bond-holdings.service";
import { BondPriceRecompute, BondPriceService } from "./bond-price.service";
import { seriesHttpException } from "./bond-series-errors";
import {
  BondSeriesResult,
  BondSeriesService,
  RefreshProgress,
} from "./bond-series.service";
import {
  BondInstrumentSummary,
  BondValuationService,
  SecurityValuation,
} from "./bond-valuation.service";
import { BondScenarios } from "./bond-scenarios";
import { BondHistory, BondOffer, BondOfferService } from "./bond-offer.service";
import {
  ParseAssumePipe,
  ParseBondAsOfPipe,
  ParseBondCountryCodePipe,
  ParseBenchmarkIdPipe,
  ParseBondQuantityPipe,
  ParseOptionalProgramCodePipe,
  ParseScenarioValuesPipe,
} from "./bond-query.pipes";
import { EnterBondSeriesDto } from "./dto/enter-bond-series.dto";
import { FetchBondSeriesDto } from "./dto/fetch-bond-series.dto";
import { BondEngineError, BondEngineErrorCode } from "./engine/bond-engine";

/**
 * The bond catalog, a linked security's lots valued on a day, and the on-demand
 * price recompute (spec 12.5). Owner-scoped: `userId` comes from the JWT only,
 * and another user's security answers 404 exactly as an unlinked one does.
 */
@ApiTags("Bonds")
@Controller("bonds")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
export class BondsController {
  constructor(
    private readonly catalog: BondCatalogService,
    private readonly valuation: BondValuationService,
    private readonly prices: BondPriceService,
    private readonly series: BondSeriesService,
    private readonly offers: BondOfferService,
    private readonly holdings: BondHoldingsService,
    private readonly auctions: BondAuctionsService,
  ) {}

  @Get("programs")
  @ApiOperation({
    summary: "List the bond programs a security can be linked to",
    description:
      "The deployment's catalog of programs (the product a person holds, of " +
      "which each issue is a series; global reference data), ordered by issuer country, issuer and " +
      "program code, each with its series count and its newest series, for " +
      "the program picker.",
  })
  @ApiResponse({ status: 200, description: "Bond programs" })
  listPrograms(): Promise<BondProgramSummary[]> {
    return this.catalog.listPrograms();
  }

  @Get("programs/:programId/refresh-progress")
  // A refresh takes about 40 s and the client polls every 1.5 s, so well under
  // 60 reads a run; the endpoint reads one row and fetches nothing.
  @Throttle({ default: { ttl: 60_000, limit: 120 } })
  @ApiOperation({
    summary: "How far a bond program's refresh has got",
    description:
      "Read from the program's job row, written by whichever replica runs the " +
      "refresh: `phase` offer, series (`done` of `total` history series tried, " +
      "`seriesCode` the last one) or done (`finishedAt` set). All empty (phase " +
      "null) when the program was never refreshed. Global reference data.",
  })
  @ApiResponse({ status: 200, description: "The refresh's progress" })
  @ApiResponse({ status: 404, description: "No such bond program" })
  refreshProgress(
    @Param("programId", ParseUUIDPipe) programId: string,
  ): Promise<RefreshProgress> {
    return this.mapBondErrors(() => this.series.readRefreshProgress(programId));
  }

  @Get("instruments")
  @ApiOperation({
    summary: "List the bond instruments a security can be linked to",
    description:
      "The deployment's catalog (global reference data), ordered by issuer " +
      "country, issuer and series, for the link picker.",
  })
  @ApiResponse({ status: 200, description: "Bond instruments" })
  listInstruments(): Promise<BondInstrumentSummary[]> {
    return this.catalog.listInstruments();
  }

  @Get("offer")
  @ApiOperation({
    summary: "The bonds on sale today, side by side",
    description:
      "Every stored series of the country whose newest terms version's sale " +
      "window contains the caller's financial today, with its terms and the " +
      "projection of one bond bought today and held to maturity: the cash " +
      "received (coupons not reinvested), the total return and the " +
      "annualized return (a comparison figure). `assume=<benchmarkId>:<fraction>` " +
      "replaces the benchmark for future periods of the series that read it; " +
      "known periods stay known. A figure is null when the engine cannot value " +
      "the bond, and `projectionMissing` says why. Reads stored reference data " +
      "only; nothing is fetched.",
  })
  @ApiQuery({ name: "countryCode", example: "<ISO 3166-1 alpha-2 code>" })
  @ApiQuery({
    name: "assume",
    required: false,
    example: "<benchmark series code>:0.025",
  })
  @ApiResponse({
    status: 200,
    description: "The series on sale and their projections",
  })
  @ApiResponse({ status: 400, description: "countryCode or assume is invalid" })
  offer(
    @Request() req,
    @Query("countryCode", new ParseBondCountryCodePipe()) countryCode: string,
    @Query("assume", new ParseAssumePipe())
    assume?: ReadonlyMap<string, string>,
  ): Promise<BondOffer> {
    return this.mapBondErrors(() =>
      this.offers.offer(req.user.id, countryCode, assume),
    );
  }

  @Get("history")
  @ApiOperation({
    summary:
      "How the terms of each product changed from one sale month to the next",
    description:
      "Every stored series of the country, by program (one program when " +
      "`programCode` is given), ordered by the start of the sale window: " +
      "first-period rate or annual rate, margin or spread, early redemption " +
      "fee, proceeds floor, terms version and source. `coverage` names the " +
      "months between the first and the last stored one that no stored series " +
      "was sold in. Reads stored reference data only; nothing is fetched.",
  })
  @ApiQuery({ name: "countryCode", example: "<ISO 3166-1 alpha-2 code>" })
  @ApiQuery({ name: "programCode", required: false, example: "<program code>" })
  @ApiResponse({
    status: 200,
    description: "The programs, their series and coverage",
  })
  @ApiResponse({
    status: 400,
    description: "countryCode or programCode is invalid",
  })
  history(
    @Query("countryCode", new ParseBondCountryCodePipe()) countryCode: string,
    @Query("programCode", new ParseOptionalProgramCodePipe())
    programCode?: string,
  ): Promise<BondHistory> {
    return this.mapBondErrors(() =>
      this.offers.history(countryCode, programCode),
    );
  }

  @Post("instruments/fetch")
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // L2: 10 fetches per minute per user; each reads the issuer's site
  @ApiOperation({
    summary: "Fetch a bond series from its official source",
    description:
      "Takes only a country and a series code. The terms are read from the " +
      "issuer's own source, cross-checked and stored as an immutable terms " +
      "version; the caller never supplies a rate, a margin, a fee or a date. " +
      "A series already stored is returned with `created: false` and nothing " +
      "is fetched.",
  })
  @ApiResponse({
    status: 201,
    description: "The instrument, and whether this call stored it",
  })
  @ApiResponse({ status: 404, description: "The series is not published" })
  @ApiResponse({ status: 409, description: "Stored with different terms" })
  @ApiResponse({
    status: 503,
    description: "The official source is unavailable",
  })
  fetchSeries(
    @Request() req,
    @Body() dto: FetchBondSeriesDto,
  ): Promise<BondSeriesResult> {
    return this.mapSeriesErrors(
      () =>
        this.series.fetchSeries(req.user.id, dto.countryCode, dto.seriesCode),
      false,
    );
  }

  @Post("instruments/manual")
  @UseGuards(RolesGuard)
  @Roles("admin")
  @ApiOperation({
    summary: "Enter a bond series by hand (admin only)",
    description:
      "For a series whose official source cannot be read: the per-series " +
      "values go on the adapter's product template, through the same bounds " +
      "and strict parser as a fetched series. The stored source is `manual`.",
  })
  @ApiResponse({
    status: 201,
    description: "The instrument, and whether this call stored it",
  })
  @ApiResponse({ status: 403, description: "Not an administrator" })
  @ApiResponse({ status: 409, description: "Stored with different terms" })
  @ApiResponse({ status: 422, description: "A value is out of bounds" })
  enterSeries(@Body() dto: EnterBondSeriesDto): Promise<BondSeriesResult> {
    return this.mapSeriesErrors(
      () =>
        this.series.enterManually(dto.countryCode, dto.seriesCode, {
          firstPeriodRate: dto.values.firstPeriodRate,
          addend: dto.values.addend ? dto.values.addend : null,
          fee: dto.values.fee ? dto.values.fee : null,
          saleWindow: {
            from: dto.values.saleWindow.from,
            to: dto.values.saleWindow.to,
          },
          letter: {
            number: dto.values.letter.number,
            date: dto.values.letter.date,
          },
        }),
      true,
    );
  }

  @Get("securities/:securityId/valuation")
  @ApiOperation({
    summary: "Value the lots of a bond-linked security on a day",
    description:
      "The open lots on `asOf` (default today), each with its series and its " +
      "valuation by that series' terms, the series held, the program and the " +
      "lot totals. A total is null unless every lot has the figure. " +
      "`refusal` names why the lots cannot be derived (a split, a fractional " +
      "quantity, a removal larger than the lots held).",
  })
  @ApiQuery({ name: "asOf", required: false, example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "The lots, valuations and totals" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async valuationOf(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("asOf", new ParseBondAsOfPipe()) asOf?: string,
    @Query("assume", new ParseAssumePipe())
    assume?: ReadonlyMap<string, string>,
  ): Promise<SecurityValuation> {
    return this.mapBondErrors(() =>
      this.valuation.valueSecurity(
        req.user.id,
        securityId,
        asOf ?? todayYMD(),
        assume,
      ),
    );
  }

  @Get("securities/:securityId/scenarios")
  @ApiOperation({
    summary: "Value a bond-linked security under assumed benchmark values",
    description:
      "As of `asOf` (default today, never later), the open lots valued with every future period of " +
      "`benchmarkId` projected at each of 1 to 6 `values` (fractions between " +
      "-0.5 and 1.0, comma-separated). Known periods stay known. Per scenario: " +
      "the lots' maturity value and total interest with its attribution, each " +
      "null if any lot cannot be valued.",
  })
  @ApiQuery({ name: "benchmarkId", example: "<benchmark series code>" })
  @ApiQuery({ name: "values", example: "0,0.025,0.05" })
  @ApiQuery({ name: "asOf", required: false, example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "One entry per assumed value" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async scenariosOf(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("benchmarkId", new ParseBenchmarkIdPipe()) benchmarkId: string,
    @Query("values", new ParseScenarioValuesPipe()) values: readonly string[],
    @Query("asOf", new ParseBondAsOfPipe()) asOf?: string,
  ): Promise<BondScenarios> {
    return this.mapBondErrors(() =>
      this.valuation.scenariosOf(
        req.user.id,
        securityId,
        benchmarkId,
        values,
        asOf ?? todayYMD(),
      ),
    );
  }

  @Get("securities/:securityId/series-on-sale")
  @ApiOperation({
    summary: "The series a purchase of this security on a date would be given",
    description:
      "The series the server would store for a BUY or REINVEST on `date` when " +
      "none is named: the one series of the security's program whose newest " +
      "terms' sale window contains the date (the same query the write runs). " +
      "The body is `{ instrumentId, seriesCode }`, or `null` when no single " +
      "stored series was on sale that day (the form then offers the fetch).",
  })
  @ApiQuery({ name: "date", example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "The series, or null" })
  @ApiResponse({ status: 400, description: "date is not a calendar date" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond program",
  })
  async seriesOnSale(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("date", new ParseCalendarDatePipe()) date: string,
    // `@Res()`: a handler's `null` is sent as an empty body by Nest; the
    // contract is the JSON literal `null`.
    @Res() res: Response,
  ): Promise<void> {
    const series = await this.mapBondErrors(() =>
      this.holdings.seriesOnSale(req.user.id, securityId, date),
    );
    res.json(series);
    return;
  }

  @Get("securities/:securityId/expected-series")
  @ApiOperation({
    summary:
      "The series code a purchase of this security on a date would carry",
    description:
      "By the grammar of the adapter of the security's program's country: " +
      "`{ seriesCode, countryCode, fetchable }`. `seriesCode` is null when the " +
      "adapter cannot name one; `fetchable` is true when the country can fetch " +
      'a series from its official source (the form then offers "Fetch <code>"). ' +
      "Nothing is fetched or stored.",
  })
  @ApiQuery({ name: "date", example: "2027-04-15" })
  @ApiResponse({ status: 200, description: "The expected series" })
  @ApiResponse({ status: 400, description: "date is not a calendar date" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond program",
  })
  expectedSeries(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("date", new ParseCalendarDatePipe()) date: string,
  ): Promise<ExpectedSeries> {
    return this.mapBondErrors(() =>
      this.holdings.expectedSeries(req.user.id, securityId, date),
    );
  }

  @Get("securities/:securityId/auctions")
  @Throttle({ default: { ttl: 60_000, limit: 10 } }) // each call reads the issuer's site, like a fetch
  @ApiOperation({
    summary: "The auctions a purchase of this security around a date could be",
    description:
      "For a country that sells by auction: the auctions of the security's " +
      "program the official source lists with an issue date within a month of " +
      "`date`, nearest first, each with the series code a fetch takes and the " +
      "catalog's `instrumentId` when stored. Read from the issuer when asked, " +
      "charged against the series fetch allowance, nothing stored. " +
      "`supported` is false (and nothing is requested) for a country that " +
      "sells in sale windows.",
  })
  @ApiQuery({ name: "date", example: "2026-11-06" })
  @ApiResponse({ status: 200, description: "The auctions" })
  @ApiResponse({ status: 400, description: "date is not a calendar date" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond program",
  })
  @ApiResponse({ status: 429, description: "Over the fetch allowance" })
  @ApiResponse({
    status: 503,
    description: "The official source is unavailable",
  })
  auctionsFor(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("date", new ParseCalendarDatePipe()) date: string,
  ): Promise<BondAuctions> {
    return this.mapSeriesErrors(
      () => this.auctions.auctionsFor(req.user.id, securityId, date),
      false,
    );
  }

  @Get("securities/:securityId/series-holdings")
  @ApiOperation({
    summary: "The series an account holds of this security on a date",
    description:
      "The open lots of `accountId` on `date` (the rows up to and including the " +
      "day, in replay order, without `excludeTransactionId`, the row being " +
      "edited), summed per series, oldest lot first, quantity above zero only: " +
      "`{ holdings: [{ instrumentId, seriesCode, quantity }] }`. A ledger whose " +
      "lots cannot be derived answers 422 with the refusal code as `errorCode`.",
  })
  @ApiQuery({ name: "accountId" })
  @ApiQuery({ name: "date", example: "2027-04-15" })
  @ApiQuery({ name: "excludeTransactionId", required: false })
  @ApiResponse({ status: 200, description: "The series held" })
  @ApiResponse({ status: 400, description: "A parameter is invalid" })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond program",
  })
  @ApiResponse({ status: 422, description: "The lots cannot be derived" })
  seriesHoldings(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("accountId", new ParseUUIDPipe()) accountId: string,
    @Query("date", new ParseCalendarDatePipe()) date: string,
    @Query("excludeTransactionId", new ParseUUIDPipe({ optional: true }))
    excludeTransactionId?: string,
  ): Promise<{ holdings: SeriesHolding[] }> {
    return this.mapBondErrors(() =>
      this.holdings.seriesHoldings(
        req.user.id,
        securityId,
        accountId,
        date,
        excludeTransactionId,
      ),
    );
  }

  @Get("securities/:securityId/redemption-split")
  @ApiOperation({
    summary: "What redeeming bonds of a series on a date pays, split",
    description:
      "The cash of redeeming `quantity` bonds of `bondInstrumentId` out of " +
      "`accountId` on `date`, as returned principal and interest: the lots the " +
      "removal takes are the ones the write's first-in first-out derivation " +
      "takes (without `excludeTransactionId`, the row being edited), each split by the " +
      "engine and the figures summed exactly. Figures are decimal strings, " +
      "null where unknown; `refusal` names why no split is given. Reads stored " +
      "terms only; nothing is written. A quantity above the series held answers " +
      "400 with the removal refusal as `errorCode`.",
  })
  @ApiQuery({ name: "date", example: "2027-04-15" })
  @ApiQuery({ name: "quantity", example: "10" })
  @ApiQuery({ name: "bondInstrumentId" })
  @ApiQuery({ name: "accountId" })
  @ApiQuery({ name: "excludeTransactionId", required: false })
  @ApiResponse({ status: 200, description: "The split" })
  @ApiResponse({
    status: 400,
    description: "A parameter is invalid, or more is redeemed than held",
  })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond program",
  })
  @ApiResponse({ status: 422, description: "The lots cannot be derived" })
  redemptionSplit(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
    @Query("date", new ParseCalendarDatePipe()) date: string,
    @Query("quantity", new ParseBondQuantityPipe()) quantity: number,
    @Query("bondInstrumentId", new ParseUUIDPipe()) bondInstrumentId: string,
    @Query("accountId", new ParseUUIDPipe()) accountId: string,
    @Query("excludeTransactionId", new ParseUUIDPipe({ optional: true }))
    excludeTransactionId?: string,
  ): Promise<BondRedemptionSplit> {
    return this.mapBondErrors(() =>
      this.holdings.redemptionSplit(
        req.user.id,
        securityId,
        accountId,
        bondInstrumentId,
        date,
        quantity,
        excludeTransactionId,
      ),
    );
  }

  @Post("securities/:securityId/recompute")
  @ApiOperation({
    summary: "Recompute the engine prices of a bond-linked security",
    description:
      "Writes the daily prices from the first transaction to today. A manual " +
      "price on a day is never overwritten; provider and transaction-derived " +
      "prices of the linked security are replaced by the engine's.",
  })
  @ApiResponse({
    status: 201,
    description: "Rows written and bond-engine rows deleted",
  })
  @ApiResponse({
    status: 404,
    description: "Not the caller's security, or not linked to a bond",
  })
  async recompute(
    @Request() req,
    @Param("securityId", ParseUUIDPipe) securityId: string,
  ): Promise<BondPriceRecompute> {
    return this.mapBondErrors(() =>
      this.prices.recomputeSecurity(req.user.id, securityId),
    );
  }

  /**
   * A refused series request becomes the HTTP error its code names, with the
   * message translated into the caller's language (`errors.bonds.<code>`);
   * anything else is not a refusal and passes through.
   */
  private async mapSeriesErrors<T>(
    run: () => Promise<T>,
    manual: boolean,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SeriesFetchError) {
        throw seriesHttpException(error, manual);
      }
      throw error;
    }
  }

  /**
   * The stored data is missing or contradicts itself, or the input is unusable.
   * Each error's `code` selects its own `errors.bonds.<code>` message and only
   * its `params` are interpolated; the English `error.message` is for the logs
   * and never reaches the client.
   */
  private async mapBondErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof BondDataNotFoundError) {
        throw new NotFoundException(bondErrorMessage(error));
      }
      if (error instanceof BondDataInconsistentError) {
        throw new UnprocessableEntityException(bondErrorMessage(error));
      }
      if (error instanceof BondEngineError) {
        throw new BadRequestException(bondErrorMessage(error));
      }
      throw error;
    }
  }
}

type BondErrorCode =
  BondEngineErrorCode | BondDataNotFoundCode | BondDataInconsistentCode;

/** The English source of each message, with the same `{{ param }}` names as the catalogue. */
export const BOND_ERROR_FALLBACKS: Readonly<
  Record<BondErrorCode, (p: BondErrorParams) => string>
> = {
  QUANTITY_INVALID: (p) =>
    `The quantity must be a positive whole number of bonds: ${p.quantity}`,
  DATE_INVALID: (p) =>
    `The purchase date (${p.purchaseDate}) and the valuation date (${p.asOf}) must be valid YYYY-MM-DD dates`,
  AS_OF_BEFORE_PURCHASE: (p) =>
    `The valuation date ${p.asOf} is before the purchase date ${p.purchaseDate}`,
  BENCHMARK_NOT_READ: (p) =>
    `Series ${p.series} does not read the benchmark ${p.benchmarkId}`,
  DECIMAL_INVALID: (p) =>
    `A stored or supplied value is not a valid decimal: ${p.field} = ${p.value}`,
  INSTRUMENT_NOT_FOUND: (p) =>
    `No bond instrument is stored for ${p.country} ${p.issuer} ${p.series}`,
  INSTRUMENT_ID_NOT_FOUND: (p) =>
    `No bond instrument is stored with id ${p.id}`,
  PROGRAM_NOT_FOUND: (p) => `No bond program is stored with id ${p.id}`,
  TERMS_NOT_FOUND: (p) => `No terms version is stored for series ${p.series}`,
  TERMS_VERSION_NOT_FOUND: (p) =>
    `Terms version ${p.version} is not stored for series ${p.series}`,
  BENCHMARK_UNIT_MISMATCH: (p) =>
    `The benchmark ${p.benchmarkId} is stored as ${p.unit}, but the terms read it as ${p.expected}`,
  TERMS_MISMATCH: (p) =>
    `Terms version ${p.version} of series ${p.series} describe ${p.claimedSeries} in ${p.claimedCurrency}, but the instrument is ${p.storedSeries} in ${p.storedCurrency}`,
};

function bondErrorMessage(error: {
  code: BondErrorCode;
  params: BondErrorParams;
}): string {
  return tr(
    `errors.bonds.${error.code}`,
    BOND_ERROR_FALLBACKS[error.code](error.params),
    { ...error.params },
  );
}
