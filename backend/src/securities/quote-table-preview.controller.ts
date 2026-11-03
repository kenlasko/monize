import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { tr } from "../i18n/translate";
import { DemoRestricted } from "../common/decorators/demo-restricted.decorator";
import { describeFetchFailure } from "../common/http/fetch-failure.util";
import {
  HtmlTableFinanceService,
  QuoteTableError,
} from "./html-table-finance.service";
import { QuoteTablePreviewDto } from "./dto/quote-table-preview.dto";
import { QuoteTableField } from "./html-table-quote.parser";

/** Rows returned to the preview, newest first. */
const PREVIEW_ROWS = 15;

export interface QuoteTablePreviewRow {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

export interface QuoteTablePreview {
  columns: Partial<Record<QuoteTableField, string>>;
  currencyCode: string | null;
  totalRows: number;
  skippedRows: number;
  firstDate: string;
  lastDate: string;
  rows: QuoteTablePreviewRow[];
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Reads a page the way the `html_table` provider will and shows what it found,
 * so a person can check an address before saving it on a security (Portfolio
 * Performance's "Show server response"). Nothing is stored.
 */
@ApiTags("Securities")
@ApiBearerAuth()
@UseGuards(AuthGuard("jwt"))
@Controller("quote-tables")
export class QuoteTablePreviewController {
  private readonly logger = new Logger(QuoteTablePreviewController.name);

  constructor(private readonly htmlTable: HtmlTableFinanceService) {}

  @Post("preview")
  // It fetches any public address a person types, like the payee-lookup and
  // bank-sync connection tests, so a demo instance's shared login cannot use
  // it as a fetcher.
  @DemoRestricted()
  @HttpCode(200)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: "Preview the price table read from a web page" })
  async preview(@Body() dto: QuoteTablePreviewDto): Promise<QuoteTablePreview> {
    let table;
    try {
      table = await this.htmlTable.loadTable(dto.url, new Date(), {
        preview: true,
      });
    } catch (error) {
      throw this.toHttpError(error);
    }
    const prices = table.prices;
    return {
      columns: table.columns,
      currencyCode: table.currencyCode,
      totalRows: prices.length,
      skippedRows: table.skippedRows,
      firstDate: ymd(prices[0].date),
      lastDate: ymd(prices[prices.length - 1].date),
      rows: prices
        .slice(-PREVIEW_ROWS)
        .reverse()
        .map((p) => ({
          date: ymd(p.date),
          open: p.open,
          high: p.high,
          low: p.low,
          close: p.close,
          volume: p.volume,
        })),
    };
  }

  private toHttpError(error: unknown): Error {
    if (!(error instanceof QuoteTableError)) {
      // Everything the provider expects arrives as a QuoteTableError, so this
      // is a defect, not an unreachable site: say so, and leave the cause in
      // the log where an administrator will look for it.
      this.logger.error(
        `Quote table preview failed unexpectedly: ${describeFetchFailure(error)}`,
      );
      return new BadGatewayException(
        tr(
          "errors.securities.quoteTableFailed",
          "The page could not be read because of an unexpected error. Try again later, and tell an administrator if it keeps happening.",
        ),
      );
    }
    this.logger.warn(`Quote table preview refused: ${error.message}`);
    switch (error.reason) {
      case "invalid-url":
        return new BadRequestException(
          tr(
            "errors.securities.quoteTableInvalidUrl",
            "Enter a full http or https address without a user name or password.",
          ),
        );
      case "private-address":
        return new BadRequestException(
          tr(
            "errors.securities.quoteTablePrivateAddress",
            "The address points to a private or local network, which is not allowed.",
          ),
        );
      case "too-many-redirects":
        return new BadGatewayException(
          tr(
            "errors.securities.quoteTableTooManyRedirects",
            "The page redirected too many times.",
          ),
        );
      case "http-status":
        return new BadGatewayException(
          tr(
            "errors.securities.quoteTableHttpStatus",
            `The site answered with HTTP status ${error.detail ?? ""}.`,
            { status: error.detail ?? "" },
          ),
        );
      case "too-large":
        return new BadGatewayException(
          tr(
            "errors.securities.quoteTableTooLarge",
            "The page is too large to read.",
          ),
        );
      case "no-table":
        return new UnprocessableEntityException(
          tr(
            "errors.securities.quoteTableNotFound",
            "No price table was found on the page: it needs a header row with a date column and a closing price column.",
          ),
        );
      case "ambiguous":
        return new UnprocessableEntityException(
          tr(
            "errors.securities.quoteTableAmbiguous",
            "The page's numbers or dates can be read in more than one way (for example 102,345 or 01/02/2026), so it was not used. Choose a page that writes its decimal separator and dates unambiguously.",
          ),
        );
      default:
        return new BadGatewayException(
          tr(
            "errors.securities.quoteTableUnreachable",
            "The page could not be reached. Check the address or try again later.",
          ),
        );
    }
  }
}
