import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Request,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { tr } from "../i18n/translate";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { MarketIndexService, MarketIndexView } from "./market-index.service";
import { PerformanceComparisonService } from "./performance-comparison.service";
import { PerformanceComparisonQueryDto } from "./dto/performance-comparison-query.dto";
import { PerformanceComparisonView } from "./performance-comparison.types";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * The Security Performance report's comparison chart and the benchmark catalog
 * behind it.
 *
 * Its own prefix rather than a route under `/securities`, so nothing has to be
 * declared before `GET /securities/:id` to keep a non-UUID path segment from
 * being parsed as an id.
 */
@ApiTags("Investment Performance")
@AllowPat()
@Controller("investments/performance")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
// Read-only investment data, so a delegate holding the investments section may
// see it, exactly as they may see the portfolio summary.
@DelegateRequiresSection("investments")
export class PerformanceComparisonController {
  constructor(
    private readonly marketIndexService: MarketIndexService,
    private readonly performanceComparisonService: PerformanceComparisonService,
  ) {}

  @Get("indexes")
  @AllowDelegate()
  @ApiOperation({
    summary: "List the market indexes available as a benchmark overlay",
    description:
      "The curated catalog with the history actually stored for each entry, so " +
      "a picker can grey out an index that cannot yet be drawn.",
  })
  @ApiResponse({ status: 200, description: "Market index catalog" })
  listIndexes(): Promise<MarketIndexView[]> {
    return this.marketIndexService.listCatalog();
  }

  @Get("comparison")
  @AllowDelegate()
  @ApiOperation({
    summary: "Cumulative percent return for securities and market indexes",
    description:
      "Every series is rebased at the window's start. A series with no usable " +
      "price at that boundary is returned in `excluded` with a reason rather " +
      "than drawn from its own later start.",
  })
  @ApiResponse({ status: 200, description: "Comparison series" })
  getComparison(
    @Request() req,
    @Query() query: PerformanceComparisonQueryDto,
  ): Promise<PerformanceComparisonView> {
    if (!query.hasSelection()) {
      throw new BadRequestException(
        tr(
          "errors.securities.comparisonSelectionEmpty",
          "Select at least one security or market index to compare",
        ),
      );
    }
    return this.performanceComparisonService.getComparison(req.user.id, {
      securityIds: query.securityIds ?? [],
      indexCodes: query.indexCodes ?? [],
      startDate: query.startDate || undefined,
      endDate: query.endDate || undefined,
    });
  }
}
