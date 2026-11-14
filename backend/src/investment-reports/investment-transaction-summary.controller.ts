import { Controller, Get, Query, Request, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { InvestmentTransactionSummaryService } from "./investment-transaction-summary.service";
import {
  InvestmentTransactionSummary,
  InvestmentTransactionSummaryQueryDto,
} from "./dto/investment-transaction-summary.dto";
import {
  AllowDelegate,
  DelegateRequiresSection,
} from "../delegation/decorators/delegate-access.decorator";
import { AllowPat } from "../auth/pat-access/pat-access.decorator";

/**
 * Its own controller rather than a route on `InvestmentReportsController`:
 * that one is CRUD over saved reports and owns `GET /reports/investment/:id`,
 * which any sibling literal path would have to be declared ahead of.
 *
 * A delegate reaches this GET under the `reports` section, as every read-only
 * report route does, while the rows it summarizes come from
 * `GET /investment-transactions` under the `investments` section. The two
 * grants are deliberately separate -- each route takes its own subject area's
 * section -- so a delegate holding `reports` but not `investments` sees the
 * KPI cards over a table the API gives them no rows for. That is the section
 * grants speaking, not a figure about somebody else's portfolio: both routes
 * read the owner's rows under the owner's identity, and the summary answers
 * over exactly the row set the list route would return.
 */
@ApiTags("Investment Reports")
@AllowPat()
@Controller("reports/investment-transactions")
@UseGuards(AuthGuard("jwt"))
@ApiBearerAuth()
@DelegateRequiresSection("reports")
export class InvestmentTransactionSummaryController {
  constructor(
    private readonly summaryService: InvestmentTransactionSummaryService,
  ) {}

  @Get("summary")
  @AllowDelegate()
  @ApiOperation({
    summary:
      "Volume, count and by-action subtotals over every investment transaction matching the filter, converted into the reporting currency",
  })
  summary(
    @Request() req,
    @Query() query: InvestmentTransactionSummaryQueryDto,
  ): Promise<InvestmentTransactionSummary> {
    return this.summaryService.summarize(req.user.id, query);
  }
}
